#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

"""The dashboard's HTTP request handler: static file serving, the
token-based auth check, and every /api/* route."""

import http.server
import json
import os
import re
import secrets
import subprocess
import time
import urllib.parse

from . import settings
from . import auth
from .scripts import run_script, log_action
from .parsers import parse_status, parse_clients, parse_doctor
from .config_store import parse_config, write_config, validate_config_update
from .network_info import (
    read_log_tail,
    read_traffic_stats,
    list_wifi_interfaces,
    generate_qr_png,
    check_5ghz_support,
)

CONTENT_TYPES = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
}

MAC_RE = re.compile(r'^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$')


class OShotspotHandler(http.server.BaseHTTPRequestHandler):
    """Handles every incoming request. Kept intentionally dependency-free
    (stdlib only) so the dashboard runs on a bare device image without
    needing pip installs."""

    def log_message(self, fmt, *args):
        # Silence the default stderr access log; we keep our own log
        # via scripts.log_action() for the actions that matter.
        pass

    def send_security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")

    def check_token(self):
        """Validate the request's auth token (query string or Bearer
        header) against the one generated at startup. Sends a 401 and
        returns False on failure."""
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        auth_token = params.get("token", [None])[0]
        if not auth_token:
            auth_header = self.headers.get("Authorization", "")
            if auth_header.startswith("Bearer "):
                auth_token = auth_header[7:]
        if auth_token and auth.TOKEN and secrets.compare_digest(auth_token, auth.TOKEN):
            return True
        self.send_response(401)
        self.send_header("Content-Type", "application/json")
        self.send_security_headers()
        self.end_headers()
        self.wfile.write(json.dumps({"error": "Unauthorized"}).encode())
        return False

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_security_headers()
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def send_static_file(self, path):
        if not os.path.isfile(path):
            self.send_response(404)
            self.end_headers()
            return
        ext = os.path.splitext(path)[1]
        ct = CONTENT_TYPES.get(ext, "application/octet-stream")
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(body)))
        self.send_security_headers()
        self.end_headers()
        self.wfile.write(body)

    # ------------------------------------------------------------------
    # GET routes
    # ------------------------------------------------------------------

    def do_GET(self):
        auth.touch_activity()
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/":
            self._serve_index(parsed)
        elif path == "/style.css":
            self.send_static_file(os.path.join(settings.STATIC_DIR, "style.css"))
        elif path == "/app.js":
            self.send_static_file(os.path.join(settings.STATIC_DIR, "js", "app.js"))
        elif path.startswith("/js/"):
            # Individual JS modules loaded by app.js via <script> tags.
            filename = os.path.basename(path)
            self.send_static_file(os.path.join(settings.STATIC_DIR, "js", filename))
        elif path == "/api/status":
            self._get_status()
        elif path == "/api/clients":
            self._get_clients()
        elif path == "/api/config":
            self._get_config()
        elif path == "/api/qr":
            self._get_qr()
        elif path == "/api/doctor":
            self._get_doctor()
        elif path == "/api/logs":
            self._get_logs(parsed)
        elif path == "/api/traffic":
            self._get_traffic()
        elif path == "/api/interfaces":
            self._get_interfaces()
        elif path == "/api/version":
            self._get_version()
        elif path == "/api/blocked":
            self._get_blocked()

        else:
            self.send_response(404)
            self.end_headers()

    def _serve_index(self, parsed):
        # The landing page itself is gated by the token too, so a stolen
        # link without the token can't even load the shell.
        params = urllib.parse.parse_qs(parsed.query)
        req_token = params.get("token", [None])[0]
        if not req_token or not secrets.compare_digest(req_token, auth.TOKEN):
            self.send_response(403)
            self.send_header("Content-Type", "text/plain")
            self.send_security_headers()
            self.end_headers()
            self.wfile.write(b"Access denied: invalid or missing token.")
            return
        self.send_static_file(os.path.join(settings.STATIC_DIR, "index.html"))

    def _get_status(self):
        if not self.check_token():
            return
        code, stdout, _ = run_script("status.sh")
        data = parse_status(stdout) if code == 0 else {"error": stdout}
        # status.sh's own client count can lag; clients.sh reads the
        # DHCP lease file directly so we trust it for the final number.
        clients_code, clients_stdout, _ = run_script("clients.sh")
        if clients_code == 0:
            all_clients = parse_clients(clients_stdout)
            data["clients"] = sum(1 for c in all_clients if c.get("status") == "active")
        self.send_json(data)

    def _get_clients(self):
        if not self.check_token():
            return
        code, stdout, _ = run_script("clients.sh")
        clients = parse_clients(stdout) if code == 0 else []
        self.send_json(clients)

    def _get_config(self):
        if not self.check_token():
            return
        config = parse_config()
        response = {}
        for k, v in config.items():
            if k == "PASSWORD":
                # Never echo the password back; just tell the UI one is set.
                response["password_set"] = bool(v)
            else:
                response[k.lower()] = v
        response["supports_5ghz"] = check_5ghz_support()
        self.send_json(response)

    def _get_qr(self):
        if not self.check_token():
            return
        png_data = generate_qr_png()
        if png_data:
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(png_data)))
            self.send_security_headers()
            self.end_headers()
            self.wfile.write(png_data)
        else:
            self.send_response(500)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"Could not generate QR code")

    def _get_doctor(self):
        if not self.check_token():
            return
        code, stdout, _ = run_script("doctor.sh")
        checks = parse_doctor(stdout) if code == 0 else []
        self.send_json(checks)

    def _get_logs(self, parsed):
        if not self.check_token():
            return
        params = urllib.parse.parse_qs(parsed.query)
        component = params.get("component", ["all"])[0]
        if component not in ("hostapd", "dnsmasq", "web", "all"):
            self.send_json({"error": "Invalid component"}, 400)
            return
        lines_q = params.get("lines", ["200"])[0]
        try:
            line_count = max(10, min(int(lines_q), 1000))
        except ValueError:
            line_count = 200
        if component == "all":
            logs = {k: read_log_tail(k, line_count) for k in ("hostapd", "dnsmasq", "web")}
            self.send_json(logs)
        else:
            self.send_json(read_log_tail(component, line_count))

    def _get_traffic(self):
        if not self.check_token():
            return
        config = parse_config()
        wifi_iface = config.get("WIFI_IFACE", "")
        data = {
            "ap": read_traffic_stats("ap0"),
            "wifi": read_traffic_stats(wifi_iface) if wifi_iface
                    else {"rx_bytes": 0, "tx_bytes": 0, "iface": ""},
            "timestamp": int(time.time()),
        }
        self.send_json(data)

    def _get_interfaces(self):
        if not self.check_token():
            return
        config = parse_config()
        self.send_json({
            "wifi_interfaces": list_wifi_interfaces(),
            "current_wifi_iface": config.get("WIFI_IFACE", ""),
            "ap_iface": "ap0",
        })

    def _get_version(self):
        if not self.check_token():
            return
        self.send_json({
            "name": "OSHotspot",
            "version": "1.0",
            "author": "OLOJEDE Samuel",
            "license": "Apache-2.0",
            "homepage": "https://github.com/King03-sam/OSHotspot",
        })



    # ------------------------------------------------------------------
    # POST routes
    # ------------------------------------------------------------------

    def do_POST(self):
        auth.touch_activity()
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if not self.check_token():
            return

        if path == "/api/start":
            self._run_action("start.sh")
        elif path == "/api/stop":
            self._run_action("stop.sh")
        elif path == "/api/restart":
            self._restart()
        elif path == "/api/repair":
            self._repair()
        elif path == "/api/config":
            self._update_config()
        elif path == "/api/kick":
            self._kick_client()
        elif path == "/api/unblock":
            self._unblock_client()

        else:
            self.send_json({"error": "Not found"}, 404)

    def _run_action(self, script_name):
        code, stdout, stderr = run_script(script_name, timeout=90)
        log_action(f"web:{script_name.replace('.sh', '')}")
        self.send_json(
            {"ok": code == 0, "output": stdout, "error": stderr},
            200 if code == 0 else 500,
        )

    def _restart(self):
        stop_code, stop_out, stop_err = run_script("stop.sh", timeout=60)
        code, stdout, stderr = run_script("start.sh", timeout=90)
        log_action("web:restart")
        self.send_json(
            {"ok": code == 0, "output": stdout, "error": stderr},
            200 if code == 0 else 500,
        )

    def _repair(self):
        code, stdout, stderr = run_script("repair.sh", timeout=60)
        log_action("web:repair")
        self.send_json(
            {"ok": code == 0, "output": stdout, "error": stderr},
            200 if code == 0 else 500,
        )

    def _update_config(self):
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length > 4096:
            self.send_json({"error": "Request too large"}, 413)
            return
        body = self.rfile.read(content_length)
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self.send_json({"error": "Invalid JSON"}, 400)
            return

        validated, errors = validate_config_update(data)
        if errors:
            self.send_json({"errors": errors}, 400)
            return
        if not validated:
            self.send_json({"error": "No valid fields to update"}, 400)
            return

        write_config(validated)
        log_action(f"web:config:{list(validated.keys())}")
        # Keep a second entry that omits the password, safe to grep/share.
        log_action(f"web:config_updated:{','.join(k for k in validated.keys() if k != 'PASSWORD')}")

        # A config change only takes effect on the running hotspot after
        # a restart, so bounce it if it's currently up.
        is_running = os.path.isfile("/run/oshotspot-hostapd.pid")
        if is_running:
            run_script("stop.sh")
            time.sleep(1)  # give hostapd/dnsmasq time to release the interface
            run_script("start.sh")

        self.send_json({"ok": True, "updated": list(validated.keys())})

    DENY_LIST_FILE = "/etc/oshotspot/deny_maclist.conf"

    def _kick_client(self):
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length > 1024:
            self.send_json({"error": "Request too large"}, 413)
            return
        body = self.rfile.read(content_length)
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self.send_json({"error": "Invalid JSON"}, 400)
            return
        mac = data.get("mac", "").strip()
        if not mac:
            self.send_json({"error": "MAC address required"}, 400)
            return

        # 1) Persist MAC to deny list file
        existing = ""
        if os.path.isfile(self.DENY_LIST_FILE):
            with open(self.DENY_LIST_FILE, "r") as f:
                existing = f.read()
        if mac.lower() not in existing.lower():
            with open(self.DENY_LIST_FILE, "a") as f:
                f.write(mac + "\n")

        # 2) Restart hostapd so it re-reads the deny list from file
        run_script("stop.sh")
        time.sleep(1)
        code, stdout, stderr = run_script("start.sh")

        log_action(f"web:kick:{mac}")
        self.send_json({
            "ok": code == 0,
            "output": stdout,
            "error": stderr if code != 0 else ""
        })

    def _get_blocked(self):
        if not self.check_token():
            return
        config = parse_config()
        ap_iface = config.get("AP_IFACE", "ap0")
        try:
            result = subprocess.run(
                ["hostapd_cli", "-i", ap_iface, "deny_acl", "show"],
                capture_output=True, text=True, timeout=10
            )
            macs = []
            if result.returncode == 0:
                for line in result.stdout.splitlines():
                    line = line.strip()
                    if MAC_RE.match(line):
                        macs.append(line.upper())
            if not macs and os.path.isfile(self.DENY_LIST_FILE):
                with open(self.DENY_LIST_FILE, "r") as f:
                    for line in f:
                        line = line.strip()
                        if MAC_RE.match(line):
                            macs.append(line.upper())
            self.send_json(macs)
        except FileNotFoundError:
            macs = []
            if os.path.isfile(self.DENY_LIST_FILE):
                with open(self.DENY_LIST_FILE, "r") as f:
                    for line in f:
                        line = line.strip()
                        if MAC_RE.match(line):
                            macs.append(line.upper())
            self.send_json(macs)
        except subprocess.TimeoutExpired:
            self.send_json([])

    def _unblock_client(self):
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length > 1024:
            self.send_json({"error": "Request too large"}, 413)
            return
        body = self.rfile.read(content_length)
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self.send_json({"error": "Invalid JSON"}, 400)
            return
        mac = data.get("mac", "").strip()
        if not mac:
            self.send_json({"error": "MAC address required"}, 400)
            return

        # 1) Remove from persistent deny list file
        if os.path.isfile(self.DENY_LIST_FILE):
            with open(self.DENY_LIST_FILE, "r") as f:
                lines = f.readlines()
            mac_lower = mac.lower()
            with open(self.DENY_LIST_FILE, "w") as f:
                for line in lines:
                    if line.strip().lower() != mac_lower:
                        f.write(line)

        # 2) Restart hostapd so it re-reads the updated deny list
        run_script("stop.sh")
        time.sleep(1)
        code, stdout, stderr = run_script("start.sh")

        log_action(f"web:unblock:{mac}")
        self.send_json({
            "ok": code == 0,
            "output": stdout,
            "error": stderr if code != 0 else ""
        })


