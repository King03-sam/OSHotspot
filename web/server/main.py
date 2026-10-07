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
import logging
import os
import signal
import socket
import subprocess
import sys
import time

from . import settings
from . import auth
from .handler import OShotspotHandler


def find_free_port(preferred, host=None):
    """Try `preferred` first, then scan upward until one is free."""
    bind_ip = host or settings.get_bind_host()
    if preferred:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((bind_ip, preferred))
            s.close()
            return preferred
        except OSError:
            pass
    for port in range(settings.PORT, settings.PORT + 100):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((bind_ip, port))
            s.close()
            return port
        except OSError:
            continue
    print("Error: no free port found", file=sys.stderr)
    sys.exit(1)


_watchdog = None


def spawn_watchdog():
    """Launch a standalone subprocess that shuts the dashboard down once
    it has been idle for INACTIVITY_TIMEOUT seconds.

    This runs out-of-process (rather than as a thread) so it keeps
    ticking even if the main server loop gets stuck handling a request.
    The watchdog reads the shared activity file updated by auth.touch_activity()
    so it always reflects real user traffic, not just server uptime.

    It signals the dashboard PID directly (SIGTERM, then SIGKILL if the
    main loop is stuck and doesn't finish a graceful shutdown in time) and
    lives in its own process group so it never takes down unrelated
    processes or its own children.
    """
    parent_pid = os.getpid()
    return subprocess.Popen(
        ["python3", "-c", f"""
import os, signal, time
timeout = {settings.INACTIVITY_TIMEOUT}
activity_file = {repr(auth.ACTIVITY_FILE)}
parent = {parent_pid}
while True:
    time.sleep(60)
    try:
        if time.time() - os.path.getmtime(activity_file) > timeout:
            os.kill(parent, signal.SIGTERM)
            time.sleep(10)
            try:
                os.kill(parent, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os._exit(0)
    except Exception:
        pass
"""],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        preexec_fn=os.setpgrp
    )


def set_watchdog(w):
    """Update the module-level watchdog reference so the main loop can
    manage it when the inactivity timeout changes at runtime."""
    global _watchdog
    _watchdog = w


def open_browser(url):
    """Try to launch the system's default browser at `url`. Returns
    True if a launcher command was found, False otherwise (headless
    environments, containers, etc.)."""
    sudo_user = os.environ.get("SUDO_USER")
    for cmd in (["xdg-open", url], ["open", url]):
        try:
            if sudo_user:
                # Run xdg-open as the original user so it inherits the
                # correct DISPLAY, XAUTHORITY, and DBUS env vars.
                
                subprocess.Popen(
                    ["sudo", "-u", sudo_user] + cmd,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                )
            else:
                subprocess.Popen(
                    cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                )
            return True
        except FileNotFoundError:
            continue
    return False


def main():
    if os.geteuid() != 0:
        print("Warning: not running as root. Hotspot scripts may fail.", file=sys.stderr)

    bind_host = settings.get_bind_host()
    port = find_free_port(settings.PORT, host=bind_host)
    auth.touch_activity()
    open(auth.ACTIVITY_FILE, "a").close()

    # Ensure the events DB schema exists (new columns, etc.) before the
    # server starts accepting requests.  Normally the tailer calls this
    # at startup, but the web server may be launched first.
    try:
        from events import db as _events_db
        _events_db.init_if_needed()
    except Exception:
        pass

    try:
        from . import auth_db as _auth_db
        _auth_db.cleanup_old_audit()
        _auth_db.cleanup_expired_sessions()
        _auth_db.cleanup_old_notifications()
    except Exception:
        pass

    try:
        from .config_store import parse_config
        cfg = parse_config()
        if cfg.get("CAPTIVE_PORTAL", "false").lower() == "true":
            from . import captive
            captive.start_captive_server()
        if cfg.get("SPAN_ENABLED", "false").lower() == "true":
            span_iface = cfg.get("SPAN_INTERFACE", "").strip()
            if span_iface:
                try:
                    from events import span_analyzer
                    span_analyzer.start_span_analyzer(span_iface)
                except Exception:
                    pass
    except Exception:
        pass

    set_watchdog(spawn_watchdog() if settings.INACTIVITY_TIMEOUT > 0 else None)

  
    from http.server import ThreadingHTTPServer
    import threading

    class CleanThreadingHTTPServer(ThreadingHTTPServer):
        def handle_error(self, request, client_address):
            exc_type, exc_val, exc_tb = sys.exc_info()
            if exc_type in (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
                return
            logging.error("Dashboard Error from %s: %s", client_address, exc_val)

    server = CleanThreadingHTTPServer((bind_host, port), OShotspotHandler)
    server.daemon_threads = True

    server_thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.5})
    server_thread.daemon = True
    server_thread.start()

    # Periodic audit cleanup: delete entries older than 90 days every 72 hours.
    def _audit_cleanup_loop():
        while True:
            time.sleep(259200)  # 72 hours
            try:
                from . import auth_db as _adb
                _adb.cleanup_old_audit()
            except Exception:
                pass

    _cleanup_thread = threading.Thread(target=_audit_cleanup_loop, daemon=True)
    _cleanup_thread.start()

    local_url = f"http://127.0.0.1:{port}/"
    url = f"http://{bind_host}:{port}/"

    print(f"\n  OSHotspot Web Dashboard")
    print(f"  Listening on {bind_host}:{port}")
    print(f"  Local access: {local_url}\n")

    if not open_browser(url):
        print(f"  Open this URL in your browser:\n")
        print(f"  {url}\n")

    print("  Press Ctrl+C to stop.\n")

    def shutdown_handler(sig, frame):
        print("\nShutting down...")
        if _watchdog:
            try:
                _watchdog.kill()
            except Exception:
                pass
        try:
            server.shutdown()
            server.server_close()
        except Exception:
            pass
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown_handler)
    signal.signal(signal.SIGTERM, shutdown_handler)

    # The HTTP server now runs its own accept loop on server_thread, so this
    # loop only needs to watch for inactivity and hand control back on exit.
    # The timeout value is re-read periodically so that changes made from
    # the dashboard (2h/5h/10h/Never) take effect without a restart.
    _cfg_reload_every = 5
    _last_reload = 0.0
    try:
        while True:
            time.sleep(1)
            now = time.time()
            if now - _last_reload >= _cfg_reload_every:
                _last_reload = now
                settings.reload_inactivity_timeout()
                if settings.INACTIVITY_TIMEOUT > 0:
                    if _watchdog is None or _watchdog.poll() is not None:
                        set_watchdog(spawn_watchdog())
                else:
                    if _watchdog is not None:
                        try:
                            _watchdog.kill()
                        except Exception:
                            pass
                        set_watchdog(None)
            if settings.INACTIVITY_TIMEOUT > 0:
                if auth.seconds_since_activity() > settings.INACTIVITY_TIMEOUT:
                    break
    except KeyboardInterrupt:
        pass
    finally:
        if _watchdog:
            try:
                _watchdog.kill()
            except Exception:
                pass
        try:
            server.shutdown()
        except Exception:
            pass
        server.server_close()
        print("Dashboard stopped.")


if __name__ == "__main__":
    main()
