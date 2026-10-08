#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

"""Captive Portal HTTP Server.

Runs on port 80 (or configured captive port) to intercept unauthenticated
HTTP requests from hotspot clients and serve the login / TOS page.
"""

import http.server
import json
import logging
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
from datetime import datetime

from . import settings
from .config_store import parse_config

DEFAULT_ICON_FILENAME = "default-icon.svg"

IMAGE_CONTENT_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".gif": "image/gif",
}


def _image_content_type(filename):
    ext = os.path.splitext(filename)[1].lower()
    return IMAGE_CONTENT_TYPES.get(ext, "image/png")


def _file_dir_exists(filename):
    """True when the default icon (or any logo) exists in one of the
    persistent/static image locations."""
    for base in (
        getattr(settings, "PERSISTENT_IMAGE_DIR", "/var/lib/oshotspot/images"),
        getattr(settings, "ETC_IMAGE_DIR", "/etc/oshotspot/images"),
        os.path.join(settings.STATIC_DIR, "images"),
    ):
        if os.path.isfile(os.path.join(base, filename)):
            return True
    return False


class CleanThreadingHTTPServer(http.server.ThreadingHTTPServer):
    """ThreadingHTTPServer that silences socket disconnects and logs errors cleanly."""
    def handle_error(self, request, client_address):
        exc_type, exc_val, exc_tb = sys.exc_info()
        if exc_type in (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
            return
        logging.error("Captive Server Error from %s: %s", client_address, exc_val)

CAPTIVE_PORT = 80
AUTHENTICATED_MACS_FILE = "/run/oshotspot-captive-authenticated.list"

_server_instance = None
_server_thread = None
_sweep_thread = None

def get_authenticated_macs():
    """Return set of lower-cased MAC addresses that have passed authentication."""
    if not os.path.isfile(AUTHENTICATED_MACS_FILE):
        return set()
    try:
        with open(AUTHENTICATED_MACS_FILE, "r") as f:
            return {line.strip().lower() for line in f if line.strip()}
    except Exception:
        return set()

def add_authenticated_mac(mac):
    """Add MAC address to authenticated whitelist and update firewall."""
    mac = mac.strip().lower()
    if not mac:
        return False
    macs = get_authenticated_macs()
    macs.add(mac)
    try:
        with open(AUTHENTICATED_MACS_FILE, "w") as f:
            for m in macs:
                f.write(m + "\n")
        # Invoke firewall script to whitelist MAC
        subprocess.run(
            ["bash", os.path.join(settings.SCRIPTS_DIR, "firewall.sh"), "captive_whitelist", mac],
            capture_output=True, text=True, timeout=10
        )
        try:
            from events import live_bus
            live_bus.publish({
                "type": "captive_auth",
                "subtype": "login",
                "client_mac": mac,
                "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            })
        except Exception:
            pass
        return True
    except Exception:
        return False

def revoke_authenticated_mac(mac):
    """Remove MAC address from authenticated whitelist and update firewall."""
    mac = mac.strip().lower()
    macs = get_authenticated_macs()
    if mac in macs:
        macs.remove(mac)
    try:
        with open(AUTHENTICATED_MACS_FILE, "w") as f:
            for m in macs:
                f.write(m + "\n")
        subprocess.run(
            ["bash", os.path.join(settings.SCRIPTS_DIR, "firewall.sh"), "captive_revoke", mac],
            capture_output=True, text=True, timeout=10
        )
        try:
            from events import live_bus
            live_bus.publish({
                "type": "captive_auth",
                "subtype": "revoke",
                "client_mac": mac,
                "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            })
        except Exception:
            pass
        return True
    except Exception:
        return False


def load_captive_codes():
    """Load temporary captive portal codes from the JSON file."""
    path = settings.CAPTIVE_CODES_FILE
    if not os.path.isfile(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data.get("codes", [])
    except Exception:
        return []


def save_captive_codes(codes):
    """Write temporary codes to the JSON file. Returns True on success."""
    path = settings.CAPTIVE_CODES_FILE
    try:
        parent = os.path.dirname(path)
        os.makedirs(parent, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"codes": codes}, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        try:
            os.chmod(path, 0o600)
        except Exception:
            pass
        return True
    except Exception as e:
        logging.error("Failed to save captive codes to %s: %s", path, e)
        return False


def load_sessions():
    """Load active captive portal sessions from the JSON file."""
    path = settings.CAPTIVE_SESSIONS_FILE
    if not os.path.isfile(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data.get("sessions", [])
    except Exception:
        return []


def save_sessions(sessions):
    """Atomically write sessions to the JSON file. Returns True on success."""
    path = settings.CAPTIVE_SESSIONS_FILE
    tmp = path + ".tmp"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"sessions": sessions}, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        return True
    except Exception as e:
        logging.error("Failed to save captive sessions to %s: %s", path, e)
        return False


def cleanup_expired_sessions():
    """Remove expired sessions and revoke their MACs from the firewall."""
    now = time.time()
    sessions = load_sessions()
    active = []
    for s in sessions:
        try:
            expires_at = s.get("expires_at", "")
            if expires_at and now > datetime.fromisoformat(expires_at).timestamp():
                mac = s.get("mac", "")
                if mac:
                    revoke_authenticated_mac(mac)
                continue
        except Exception:
            pass
        active.append(s)
    if len(active) != len(sessions):
        save_sessions(active)


def cleanup_expired_codes():
    """Remove expired or revoked temporary codes from the list."""
    now = time.time()
    codes = load_captive_codes()
    active = []
    changed = False
    for c in codes:
        if c.get("status") == "revoked":
            changed = True
            continue
        if c.get("status") != "active":
            continue
        try:
            if c.get("expires_at") and now > datetime.fromisoformat(c["expires_at"]).timestamp():
                changed = True
                continue
        except Exception:
            pass
        active.append(c)
    if changed:
        save_captive_codes(active)


def _find_matching_temp_code(code, mac):
    """Return the first valid temporary code matching the given code and MAC."""
    if not code:
        return None
    now = time.time()
    mac_lower = (mac or "").lower()
    clean_code = (code or "").strip().upper()
    for c in load_captive_codes():
        if c.get("status") != "active":
            continue
        c_code = (c.get("code") or "").strip().upper()
        if c_code != clean_code:
            continue
        expires_at = c.get("expires_at", "")
        if expires_at:
            try:
                if now > datetime.fromisoformat(expires_at).timestamp():
                    continue
            except Exception:
                continue
        bound_mac = (c.get("bound_mac") or "").lower()
        if bound_mac and bound_mac != mac_lower:
            continue
        return c
    return None


def _create_session(mac, code, is_permanent, code_id, duration_hours, lease_hours):
    """Create or renew a session for the given MAC."""
    if not mac:
        return
    now = time.time()
    if lease_hours > 0 and duration_hours > 0:
        expires_at = now + min(lease_hours, duration_hours) * 3600
    elif lease_hours > 0:
        expires_at = now + lease_hours * 3600
    elif duration_hours > 0:
        expires_at = now + duration_hours * 3600
    else:
        expires_at = None
    sessions = load_sessions()
    sessions = [s for s in sessions if s.get("mac", "").lower() != mac.lower()]
    sessions.append({
        "mac": mac.lower(),
        "code": code,
        "is_permanent": is_permanent,
        "code_id": code_id,
        "expires_at": datetime.fromtimestamp(expires_at).isoformat() if expires_at else "",
    })
    save_sessions(sessions)


def _sweep_expired_loop():
    """Background thread that periodically cleans up expired codes and sessions."""
    while True:
        time.sleep(5)
        try:
            cleanup_expired_sessions()
            cleanup_expired_codes()
        except Exception:
            pass


# Rate-limiting / brute-force protection
FAIL_LIMIT = 5                       # failed attempts per lockout tier
LOCKOUT_STEP_SECONDS = 60            # seconds added per lockout tier
LOCKOUT_CAP_SECONDS = 3600           # maximum cooldown (1 hour)
ATTEMPT_RETRY_DELAY = 1.0            # server-side delay after each failure (seconds)
ATTEMPT_ENTRY_TTL = 3600.0           # drop idle attempt tracking after 1 hour

LOGIN_ATTEMPTS = {}
_ATTEMPT_LOCK = threading.Lock()

def _lockout_for(failures):
    """Progressive cooldown: +60s per tier of FAIL_LIMIT failures, capped at 1 hour."""
    return min(LOCKOUT_STEP_SECONDS * (failures // FAIL_LIMIT), LOCKOUT_CAP_SECONDS)

class CaptivePortalHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def _get_client_ip(self):
        return self.client_address[0] if self.client_address else "127.0.0.1"

    def _get_client_mac(self):
        ip = self._get_client_ip()
        if ip in ("127.0.0.1", "::1"):
            return ""
        try:
            with open("/proc/net/arp", "r") as f:
                for line in f.readlines()[1:]:
                    parts = line.split()
                    if len(parts) >= 4 and parts[0] == ip:
                        mac = parts[3].lower()
                        if mac != "00:00:00:00:00:00":
                            return mac
        except Exception:
            pass
        try:
            out = subprocess.run(["ip", "neighbor", "show", ip], capture_output=True, text=True, timeout=2).stdout
            for line in out.splitlines():
                parts = line.split()
                if "lladdr" in parts:
                    idx = parts.index("lladdr")
                    if idx + 1 < len(parts):
                        return parts[idx + 1].lower()
        except Exception:
            pass
        return ""

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # Serve uploaded custom logo image if requested
        if path.startswith("/images/") or path in ("/captive_logo.png", "/app_logo.png"):
            filename = os.path.basename(path)
            candidate_paths = [
                os.path.join(getattr(settings, "PERSISTENT_IMAGE_DIR", "/var/lib/oshotspot/images"), filename),
                os.path.join(getattr(settings, "ETC_IMAGE_DIR", "/etc/oshotspot/images"), filename),
                os.path.join(settings.STATIC_DIR, "images", filename),
            ]
            for logo_path in candidate_paths:
                if os.path.isfile(logo_path):
                    try:
                        with open(logo_path, "rb") as f:
                            data = f.read()
                        self.send_response(200)
                        self.send_header("Content-Type", _image_content_type(filename))
                        self.send_header("Content-Length", str(len(data)))
                        self.send_header("Cache-Control", "public, max-age=3600")
                        self.end_headers()
                        self.wfile.write(data)
                        return
                    except Exception:
                        pass

        client_mac = self._get_client_mac()
        authenticated = client_mac in get_authenticated_macs() if client_mac else False

        # If client is already authenticated, allow probes to return success so OS knows internet works
        if authenticated:
            if path in ("/generate_204", "/gen_204"):
                self.send_response(204)
                self.end_headers()
                return
            if path in ("/hotspot-detect.html", "/canonical.html", "/success.html", "/library/test/success.html"):
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(b"<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>")
                return
            if path in ("/ncsi.txt", "/connecttest.txt"):
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"Microsoft NCSI")
                return
        else:
            # Unauthenticated client handling (revoked, expired, or initial connection)
            # 1. API status call must return JSON so the status page can detect loss of auth
            if path == "/api/portal/status":
                self._serve_portal_status()
                return

            # 2. Direct requests to the AP IP or custom domain root serve the portal HTML page
            cfg = parse_config()
            ap_ip = cfg.get("AP_IP", "192.168.50.1")
            raw_domain = cfg.get("CAPTIVE_DOMAIN", "").strip().lower()
            custom_domain = re.sub(r"^(https?://)+", "", raw_domain).split("/")[0].split(":")[0].strip()
            host_hdr = (self.headers.get("Host") or "").split(":")[0].lower()

            if path in ("/", "/index.html", "/status", "/status.html", "/portal/status"):
                self._serve_portal_page()
                return

            # 3. For any external domain or captive detection probe, send a 302 Redirect
            # so mobile OS (iOS, Android, Windows) triggers captive portal UI
            valid_hosts = (ap_ip, custom_domain) if custom_domain else (ap_ip,)
            if host_hdr not in valid_hosts or path not in ("/", "/index.html"):
                self._redirect_to_portal()
                return

        if path in ("/", "/index.html", "/status", "/status.html", "/portal/status", "/api/portal/auth"):
            self._serve_portal_page()
            return

        if path == "/api/portal/status":
            self._serve_portal_status()
            return

        # Serve static captive portal page for all HTTP requests
        self._serve_portal_page()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/portal/logout":
            self._handle_portal_logout()
            return

        if path == "/api/portal/login":
            try:
                content_length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_length) if content_length else b"{}"
                try:
                    data = json.loads(body)
                except Exception:
                    data = {}

                code = (data.get("code") or "").strip()
                cfg = parse_config()
                required_code = cfg.get("CAPTIVE_CODE", "").strip()
                lease_hours = int(cfg.get("CAPTIVE_LEASE_HOURS", "0") or 0)

                client_key = self._get_client_mac() or self._get_client_ip()
                client_mac = self._get_client_mac()
                now = time.time()

                # Prune stale attempt entries and load/init client state atomically
                with _ATTEMPT_LOCK:
                    for stale_key in [k for k, v in LOGIN_ATTEMPTS.items()
                                      if now - v.get("last_ts", 0) > ATTEMPT_ENTRY_TTL]:
                        del LOGIN_ATTEMPTS[stale_key]
                    att = LOGIN_ATTEMPTS.get(client_key, {"failures": 0, "locked_until": 0.0, "last_ts": now})
                    LOGIN_ATTEMPTS[client_key] = att

                # Check active cooldown
                if now < att.get("locked_until", 0):
                    remaining = int(att["locked_until"] - now)
                    self.send_response(429)
                    self.send_header("Content-Type", "application/json")
                    self._send_cors_headers()
                    self.end_headers()
                    self.wfile.write(json.dumps({
                        "ok": False,
                        "error": f"Too many failed attempts. Cooldown active for {remaining}s.",
                        "cooldown": remaining
                    }).encode())
                    return

                clean_code = code.strip().upper()
                clean_req = required_code.strip().upper()

                matched_temp = None

                # Try permanent code first
                if clean_req and clean_code == clean_req:
                    pass  # matched below
                else:
                    # Try temporary codes
                    matched_temp = _find_matching_temp_code(code, client_mac)
                    if not matched_temp:
                        # Slow down brute-force attempts on every failure
                        time.sleep(ATTEMPT_RETRY_DELAY)
                        with _ATTEMPT_LOCK:
                            att["last_ts"] = time.time()
                            att["failures"] += 1
                            failures = att["failures"]
                            if failures % FAIL_LIMIT == 0:
                                lock_seconds = _lockout_for(failures)
                                att["locked_until"] = time.time() + lock_seconds
                        if failures % FAIL_LIMIT == 0:
                            try:
                                from events import alert as email_alert
                                email_alert.alert(
                                    f"Captive portal brute-force lockout: client {client_ip or client_mac or 'unknown'} banned for {lock_seconds}s after {failures} failed attempts",
                                    level="ALERT",
                                    extra={
                                        "attacker_ip": client_ip or "",
                                        "client_mac": client_mac or "",
                                        "failure_count": failures,
                                        "lockout_duration": f"{lock_seconds}s",
                                        "service_name": "Captive Portal",
                                        "category": "admin_lockout",
                                    },
                                    category="admin_lockout",
                                )
                            except Exception:
                                pass
                            self.send_response(429)
                            self.send_header("Content-Type", "application/json")
                            self._send_cors_headers()
                            self.end_headers()
                            self.wfile.write(json.dumps({
                                "ok": False,
                                "error": f"Too many failed attempts. Please wait {lock_seconds} seconds before trying again.",
                                "cooldown": lock_seconds
                            }).encode())
                        else:
                            self.send_response(401)
                            self.send_header("Content-Type", "application/json")
                            self._send_cors_headers()
                            self.end_headers()
                            self.wfile.write(json.dumps({
                                "ok": False,
                                "error": "Invalid access code."
                            }).encode())
                        return

                # Success -> clear attempt count
                with _ATTEMPT_LOCK:
                    att["failures"] = 0
                    att["locked_until"] = 0.0
                    att["last_ts"] = time.time()
                if client_mac:
                    add_authenticated_mac(client_mac)
                    if matched_temp:
                        duration_hours = matched_temp.get("duration_hours", 0) or 0
                        _create_session(
                            client_mac,
                            matched_temp.get("code", ""),
                            False,
                            matched_temp.get("id", ""),
                            duration_hours,
                            lease_hours,
                        )
                        # Bind MAC to code and activate expiration timer upon first login
                        codes = load_captive_codes()
                        target_id = matched_temp.get("id")
                        for c in codes:
                            if c.get("id") == target_id:
                                if not c.get("bound_mac"):
                                    c["bound_mac"] = client_mac.lower()
                                if not c.get("activated_at"):
                                    act_now = time.time()
                                    dur = c.get("duration_hours", 0) or 0
                                    c["activated_at"] = datetime.fromtimestamp(act_now).isoformat()
                                    if dur > 0 and not c.get("expires_at"):
                                        c["expires_at"] = datetime.fromtimestamp(act_now + dur * 3600).isoformat()
                                break
                        save_captive_codes(codes)
                    else:
                        _create_session(
                            client_mac,
                            required_code,
                            True,
                            "permanent",
                            0,
                            lease_hours,
                        )

                # Calculate session details for instant status page rendering
                resp_dur_sec = (duration_hours * 3600) if (matched_temp and duration_hours > 0) else ((lease_hours * 3600) if lease_hours > 0 else None)
                resp_exp_str = ""
                if resp_dur_sec:
                    resp_exp_str = datetime.fromtimestamp(now + resp_dur_sec).isoformat()

                resp_data = {
                    "ok": True,
                    "authenticated": True,
                    "mac": client_mac or self._get_client_ip(),
                    "ip": self._get_client_ip(),
                    "ssid": cfg.get("SSID", "OSHotspot"),
                    "ap_ip": cfg.get("AP_IP", "192.168.50.1"),
                    "status_url": f"http://{cfg.get('AP_IP', '192.168.50.1')}/",
                    "session": {
                        "code": matched_temp.get("code", "") if matched_temp else required_code,
                        "is_permanent": not bool(matched_temp),
                        "expires_at": resp_exp_str,
                        "remaining_seconds": resp_dur_sec,
                        "duration_hours": duration_hours if matched_temp else lease_hours,
                        "total_seconds": resp_dur_sec,
                    }
                }

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self._send_cors_headers()
                self.end_headers()
                self.wfile.write(json.dumps(resp_data).encode())
                return
            except Exception as exc:
                logging.getLogger("oshotspot").error(f"Captive portal login error: {exc}", exc_info=True)
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self._send_cors_headers()
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "error": f"Server error: {exc}"}).encode())
                return

        self.send_response(404)
        self.end_headers()

    def _serve_portal_status(self):
        client_mac = self._get_client_mac()
        client_ip = self._get_client_ip()
        authenticated = client_mac in get_authenticated_macs() if client_mac else False

        cfg = parse_config()
        ssid = cfg.get("SSID", "OSHotspot")
        bg_color = cfg.get("CAPTIVE_BG_COLOR", "#ad0b0b").strip() or "#ad0b0b"
        logo_url = cfg.get("CAPTIVE_LOGO_URL", "").strip()

        logo_file = os.path.join(settings.STATIC_DIR, "images", "captive_logo.png")
        if not logo_url and os.path.isfile(logo_file):
            logo_url = "/images/captive_logo.png"

        if not logo_url and _file_dir_exists(DEFAULT_ICON_FILENAME):
            logo_url = "/images/" + DEFAULT_ICON_FILENAME

        session_info = None
        if authenticated and client_mac:
            now = time.time()
            sessions = load_sessions()
            for s in sessions:
                if s.get("mac", "").lower() == client_mac.lower():
                    expires_at_str = s.get("expires_at", "")
                    remaining = None
                    total_sec = None
                    if expires_at_str:
                        try:
                            exp_ts = datetime.fromisoformat(expires_at_str).timestamp()
                            remaining = max(0, int(exp_ts - now))
                        except Exception:
                            pass

                    code_val = s.get("code", "")
                    dur_hours = 0
                    if not s.get("is_permanent"):
                        codes = load_captive_codes()
                        for c in codes:
                            if c.get("id") == s.get("code_id") or c.get("code") == code_val:
                                dur_hours = c.get("duration_hours", 0)
                                if dur_hours > 0:
                                    total_sec = dur_hours * 3600
                                break

                    session_info = {
                        "code": code_val,
                        "is_permanent": s.get("is_permanent", False),
                        "expires_at": expires_at_str,
                        "remaining_seconds": remaining,
                        "duration_hours": dur_hours,
                        "total_seconds": total_sec,
                    }
                    break

        ap_ip = cfg.get("AP_IP", "192.168.50.1")
        resp = {
            "authenticated": authenticated,
            "mac": client_mac,
            "ip": client_ip,
            "ssid": ssid,
            "bg_color": bg_color,
            "logo_url": logo_url,
            "ap_ip": ap_ip,
            "status_url": f"http://{ap_ip}/",
            "session": session_info,
        }

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps(resp).encode("utf-8"))

    def _handle_portal_logout(self):
        client_mac = self._get_client_mac()
        if client_mac:
            revoke_authenticated_mac(client_mac)
            try:
                sessions = load_sessions()
                new_sessions = [s for s in sessions if s.get("mac", "").lower() != client_mac.lower()]
                if len(new_sessions) != len(sessions):
                    save_sessions(new_sessions)
            except Exception:
                pass
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True}).encode("utf-8"))

    def _redirect_to_portal(self):
        cfg = parse_config()
        ap_ip = cfg.get("AP_IP", "192.168.50.1")
        raw_domain = cfg.get("CAPTIVE_DOMAIN", "").strip().lower()
        custom_domain = re.sub(r"^(https?://)+", "", raw_domain).split("/")[0].split(":")[0].strip()
        host = custom_domain if custom_domain else ap_ip
        portal_url = f"http://{host}/"
        self.send_response(302)
        self.send_header("Location", portal_url)
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    def _serve_portal_page(self):
        portal_path = os.path.join(settings.STATIC_DIR, "captive_portal.html")
        if not os.path.isfile(portal_path):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.end_headers()
            self.wfile.write(b"<h1>OSHotspot Captive Portal</h1><p>Please authenticate to access the Internet.</p>")
            return

        cfg = parse_config()
        ssid = cfg.get("SSID", "OSHotspot")
        message = cfg.get("CAPTIVE_MESSAGE", "Enter access code to connect.")
        code_required = bool(cfg.get("CAPTIVE_CODE", "").strip())
        bg_color = cfg.get("CAPTIVE_BG_COLOR", "#ad0b0b").strip() or "#ad0b0b"
        logo_url = cfg.get("CAPTIVE_LOGO_URL", "").strip()

        # Check for uploaded custom logo file
        logo_file = os.path.join(settings.STATIC_DIR, "images", "captive_logo.png")
        if not logo_url and os.path.isfile(logo_file):
            logo_url = "/images/captive_logo.png"

        # Fall back to the shipped default icon
        if not logo_url and _file_dir_exists(DEFAULT_ICON_FILENAME):
            logo_url = "/images/" + DEFAULT_ICON_FILENAME

        # Favicon: same admin logo as the dashboard (ADMIN_LOGO_URL / app_logo.png)
        default_favicon = (
            "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' "
            "fill='none' stroke='%23fff' stroke-width='2' stroke-linecap='round' "
            "stroke-linejoin='round'%3E%3Cpath d='M5 12.55a11 11 0 0 1 14.08 0'/%3E"
            "%3Cpath d='M1.42 9a16 16 0 0 1 21.16 0'/%3E"
            "%3Cpath d='M8.53 16.11a6 6 0 0 1 6.95 0'/%3E"
            "%3Cline x1='12' y1='20' x2='12.01' y2='20'/%3E%3C/svg%3E"
        )
        favicon_href = cfg.get("ADMIN_LOGO_URL", "").strip()
        if not favicon_href:
            for base in (
                getattr(settings, "PERSISTENT_IMAGE_DIR", "/var/lib/oshotspot/images"),
                getattr(settings, "ETC_IMAGE_DIR", "/etc/oshotspot/images"),
                os.path.join(settings.STATIC_DIR, "images"),
            ):
                if os.path.isfile(os.path.join(base, "app_logo.png")):
                    favicon_href = "/images/app_logo.png"
                    break
            if not favicon_href and _file_dir_exists(DEFAULT_ICON_FILENAME):
                favicon_href = "/images/" + DEFAULT_ICON_FILENAME
        if favicon_href:
            if favicon_href.startswith("data:image/svg"):
                favicon_type = "image/svg+xml"
            elif favicon_href.startswith("data:"):
                favicon_type = "image/png"
            elif favicon_href.lower().endswith(".svg"):
                favicon_type = "image/svg+xml"
                if "?" not in favicon_href:
                    favicon_href = favicon_href + "?t=" + str(int(time.time()))
            else:
                favicon_type = "image/png"
                if "?" not in favicon_href:
                    favicon_href = favicon_href + "?t=" + str(int(time.time()))
        else:
            favicon_href = default_favicon
            favicon_type = "image/svg+xml"

        if logo_url:
            logo_html = f'''<div class="logo-wrapper" style="margin-bottom: 24px; text-align: center;">
                <img src="{logo_url}" alt="Logo" style="max-width: 140px; max-height: 80px; object-fit: contain; filter: drop-shadow(0 4px 12px rgba(0,0,0,0.5));">
            </div>'''
        else:
            logo_html = '''<div class="wifi-icon-wrapper">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M5 12.55a11 11 0 0 1 14.08 0"/>
                    <path d="M1.42 9a16 16 0 0 1 21.16 0"/>
                    <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
                    <line x1="12" y1="20" x2="12.01" y2="20"/>
                </svg>
            </div>'''

        try:
            ap_ip = cfg.get("AP_IP", "192.168.50.1")
            with open(portal_path, "r", encoding="utf-8") as f:
                content = f.read()
            
            content = content.replace("{{SSID}}", ssid)
            content = content.replace("{{MESSAGE}}", message)
            content = content.replace("{{CODE_REQUIRED}}", "true" if code_required else "false")
            content = content.replace("{{BG_COLOR}}", bg_color)
            content = content.replace("{{LOGO_HTML}}", logo_html)
            content = content.replace("{{AP_IP}}", ap_ip)
            content = content.replace("{{FAVICON_HREF}}", favicon_href)
            content = content.replace("{{FAVICON_TYPE}}", favicon_type)
            
            body = content.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(str(e).encode())

def start_captive_server():
    global _server_instance, _server_thread
    if _server_instance is not None:
        return True

    cfg = parse_config()
    ap_ip = cfg.get("AP_IP", "192.168.50.1")

    # Bind to 0.0.0.0:80 so redirected traffic on ap0 or ap_ip is caught cleanly
    for bind_addr in ("0.0.0.0", ap_ip):
        try:
            _server_instance = CleanThreadingHTTPServer((bind_addr, CAPTIVE_PORT), CaptivePortalHandler)
            _server_thread = threading.Thread(target=_server_instance.serve_forever)
            _server_thread.daemon = True
            _server_thread.start()

            # Restore persistent whitelist from sessions on boot
            try:
                now = time.time()
                for s in load_sessions():
                    mac = s.get("mac", "")
                    if not mac:
                        continue
                    expires_at = s.get("expires_at", "")
                    if expires_at:
                        try:
                            if now > datetime.fromisoformat(expires_at).timestamp():
                                continue
                        except Exception:
                            pass
                    add_authenticated_mac(mac)
            except Exception:
                pass

            # Background sweep: clean up expired codes and sessions every 60s
            global _sweep_thread
            _sweep_thread = threading.Thread(target=_sweep_expired_loop, daemon=True)
            _sweep_thread.start()

            return True
        except Exception:
            _server_instance = None
            _server_thread = None

    return False

def stop_captive_server():
    global _server_instance, _server_thread
    if _server_instance is not None:
        try:
            _server_instance.shutdown()
            _server_instance.server_close()
        except Exception:
            pass
        _server_instance = None
        _server_thread = None
