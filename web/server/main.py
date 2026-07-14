#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

"""Entry point for the dashboard: picks a free port, generates a fresh
session token, starts the inactivity watchdog, and runs the HTTP server
until it's stopped or the user walks away."""

import http.server
import os
import secrets
import signal
import socket
import subprocess
import sys
import time

from . import settings
from . import auth
from .handler import OShotspotHandler


def find_free_port(preferred):
    """Try `preferred` first, then scan upward until one is free."""
    if preferred:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((settings.HOST, preferred))
            s.close()
            return preferred
        except OSError:
            pass
    for port in range(settings.PORT, settings.PORT + 100):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((settings.HOST, port))
            s.close()
            return port
        except OSError:
            continue
    print("Error: no free port found", file=sys.stderr)
    sys.exit(1)


def spawn_watchdog(started_at):
    """Launch a standalone subprocess that kills the whole process tree
    once the dashboard has been idle for INACTIVITY_TIMEOUT seconds.

    This runs out-of-process (rather than as a thread) so it keeps
    ticking even if the main server loop gets stuck handling a request.
    """
    return subprocess.Popen(
        ["python3", "-c", f"""
import time, os
timeout = {settings.INACTIVITY_TIMEOUT}
started = {started_at}
while True:
    time.sleep(60)
    if time.time() - started > timeout:
        print(f'Inactivity timeout ({{timeout}}s). Shutting down.')
        os._exit(0)
"""],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )


def open_browser(url):
    """Try to launch the system's default browser at `url`. Returns
    True if a launcher command was found, False otherwise (headless
    environments, containers, etc.)."""
    for cmd in (["xdg-open", url], ["open", url]):
        try:
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True
        except FileNotFoundError:
            continue
    return False


def main():
    auth.TOKEN = secrets.token_hex(32)

    if os.geteuid() != 0:
        print("Warning: not running as root. Hotspot scripts may fail.", file=sys.stderr)

    port = find_free_port(settings.PORT)
    auth.touch_activity()

    watchdog = spawn_watchdog(time.time())

    # Use ThreadingHTTPServer so that long-running scripts (start.sh,
    # repair.sh, etc.) don't block every other request.  This keeps
    # the status polling and UI responsive while an action executes.
    from http.server import ThreadingHTTPServer
    server = ThreadingHTTPServer((settings.HOST, port), OShotspotHandler)
    server.timeout = 1

    url = f"http://{settings.HOST}:{port}/?token={auth.TOKEN}"

    print(f"\n  OSHotspot Web Dashboard")
    print(f"  Listening on {url}\n")

    if not open_browser(url):
        print(f"  Open this URL in your browser:\n")
        print(f"  {url}\n")

    print("  Press Ctrl+C to stop.\n")

    def shutdown_handler(sig, frame):
        print("\nShutting down...")
        try:
            watchdog.kill()
        except Exception:
            pass
        server.server_close()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown_handler)
    signal.signal(signal.SIGTERM, shutdown_handler)

    try:
        while True:
            server.handle_request()
            if auth.seconds_since_activity() > settings.INACTIVITY_TIMEOUT:
                break
    except KeyboardInterrupt:
        pass
    finally:
        try:
            watchdog.kill()
        except Exception:
            pass
        server.server_close()
        print("Dashboard stopped.")


if __name__ == "__main__":
    main()
