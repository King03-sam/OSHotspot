#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

"""The dashboard's HTTP request handler: static file serving, the
token-based auth check, and every /api/* route."""

import http.server
import io
import json
import logging
import os
import re
import sqlite3
import subprocess
import time
import urllib.parse
from datetime import datetime, date

from . import settings
from . import auth
from .scripts import run_script, log_action
from .parsers import parse_status, parse_clients, parse_doctor, get_hostapd_uptime
from .config_store import parse_config, write_config, validate_config_update
from .network_info import (
    read_log_tail,
    read_traffic_stats,
    list_wifi_interfaces,
    generate_qr_png,
    check_5ghz_support,
)

# The event collector is an optional, additive component.  If it hasn't
# been installed the dashboard still works, it just reports the events
# page as unavailable instead of crashing the whole server.
try:
    from events import db as events_db
except ImportError:
    events_db = None

try:
    from events import classify as events_classify
except ImportError:
    events_classify = None

try:
    from events import live_bus
except ImportError:
    live_bus = None

from . import live_stream
from . import auth_db
try:
    from . import captive
except ImportError:
    captive = None

try:
    from events import span_analyzer
except ImportError:
    span_analyzer = None

CONTENT_TYPES = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".gif": "image/gif",
}

MAC_RE = re.compile(r'^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$')


def get_logo_path(filename):
    candidate_paths = [
        os.path.join(getattr(settings, "PERSISTENT_IMAGE_DIR", "/var/lib/oshotspot/images"), filename),
        os.path.join(getattr(settings, "ETC_IMAGE_DIR", "/etc/oshotspot/images"), filename),
        os.path.join(settings.STATIC_DIR, "images", filename),
    ]
    for p in candidate_paths:
        if os.path.isfile(p):
            return p
    return None


DEFAULT_ICON_FILENAME = "default-icon.svg"


def default_logo_url():
    """URL of the shipped default icon when no custom logo is defined.
    Returns '' if the default icon file is missing so callers can fall
    back to their existing last-resort placeholder."""
    if get_logo_path(DEFAULT_ICON_FILENAME):
        return "/images/" + DEFAULT_ICON_FILENAME
    return ""


def save_persistent_logo(filename, img_data):
    dirs = [
        getattr(settings, "PERSISTENT_IMAGE_DIR", "/var/lib/oshotspot/images"),
        getattr(settings, "ETC_IMAGE_DIR", "/etc/oshotspot/images"),
        os.path.join(settings.STATIC_DIR, "images"),
    ]
    for d in dirs:
        try:
            os.makedirs(d, exist_ok=True)
            target = os.path.join(d, filename)
            with open(target, "wb") as f:
                f.write(img_data)
        except Exception:
            pass


def remove_persistent_logo(filename):
    dirs = [
        getattr(settings, "PERSISTENT_IMAGE_DIR", "/var/lib/oshotspot/images"),
        getattr(settings, "ETC_IMAGE_DIR", "/etc/oshotspot/images"),
        os.path.join(settings.STATIC_DIR, "images"),
    ]
    for d in dirs:
        target = os.path.join(d, filename)
        if os.path.isfile(target):
            try:
                os.remove(target)
            except Exception:
                pass


def is_local_request(handler_obj):
    """True when the TCP connection originates from 127.0.0.1 or ::1.
    Used to restrict first-time setup to the host machine."""
    try:
        return handler_obj.client_address[0] in ("127.0.0.1", "::1", "localhost")
    except Exception:
        return False


def hex_to_rgb(hex_str, default=(79, 70, 229)):
    if not hex_str:
        return default
    hex_str = str(hex_str).lstrip("#").strip()
    if len(hex_str) == 6:
        try:
            return (int(hex_str[0:2], 16), int(hex_str[2:4], 16), int(hex_str[4:6], 16))
        except ValueError:
            pass
    return default


def _build_captive_codes_pdf(ssid, codes, now, bg_color=None, ap_ip="192.168.50.1"):
    try:
        from fpdf import FPDF
    except ImportError:
        logging.getLogger("oshotspot").error("fpdf2 is not installed. Run: pip3 install fpdf2")
        raise RuntimeError("PDF export unavailable: fpdf2 module missing. Install it with: pip3 install fpdf2")

    """Build a professional PDF listing active unused temporary captive portal codes as printable vouchers."""

    class VoucherPDF(FPDF):
        def header(self):
            # Header dark banner background
            self.set_fill_color(15, 23, 42)  # Slate Dark 900
            self.rect(0, 0, 210, 24, "F")
            
            # Resolve custom logo defined by admin
            logo_path = get_logo_path("captive_logo.png") or get_logo_path("app_logo.png") or get_logo_path("logo.png")
            has_logo = False
            if logo_path and os.path.isfile(logo_path):
                try:
                    self.image(logo_path, x=10, y=3, h=18)
                    has_logo = True
                except Exception:
                    has_logo = False

            start_x = 38 if has_logo else 12
            self.set_xy(start_x, 4)
            self.set_font("Helvetica", "B", 13)
            self.set_text_color(255, 255, 255)
            self.cell(0, 6, "OSHotspot  |  WiFi Guest Access Vouchers", new_x="LMARGIN", new_y="NEXT")

            self.set_x(start_x)
            self.set_font("Helvetica", "", 9)
            self.set_text_color(203, 213, 225)  # Slate 300
            gen_time = datetime.fromtimestamp(now).strftime("%Y-%m-%d %H:%M")
            self.cell(0, 5, f"Network (SSID): {ssid}   |   Generated: {gen_time}   |   Total Vouchers: {len(codes)}")
            self.set_y(28)

        def footer(self):
            self.set_y(-12)
            self.set_font("Helvetica", "I", 8)
            self.set_text_color(148, 163, 184)
            self.cell(0, 5, f"Page {self.page_no()} - Confidential WiFi Vouchers - Generated by OSHotspot", align="C")

    pdf = VoucherPDF(orientation="P", unit="mm", format="A4")
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()

    if not codes:
        pdf.set_font("Helvetica", "I", 11)
        pdf.set_text_color(100, 116, 139)
        pdf.cell(0, 12, "No active unused temporary codes available.", align="C")
        return pdf

    # 1. Render Voucher Ticket Grid (2 columns x 4 rows per page = 8 per page)
    card_w = 90
    card_h = 56
    margin_x = 10
    gap_x = 10
    gap_y = 6

    pdf.set_font("Helvetica", "B", 11)
    pdf.set_text_color(15, 23, 42)
    pdf.cell(0, 6, "Printable Guest Access Tickets", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(1)
    y_start = pdf.get_y()

    col = 0
    row = 0

    for idx, c in enumerate(codes):
        if idx > 0 and idx % 8 == 0:
            pdf.add_page()
            pdf.set_font("Helvetica", "B", 11)
            pdf.set_text_color(15, 23, 42)
            pdf.cell(0, 6, "Printable Guest Access Tickets (Cont.)", new_x="LMARGIN", new_y="NEXT")
            pdf.ln(1)
            y_start = pdf.get_y()
            col = 0
            row = 0

        x = margin_x + col * (card_w + gap_x)
        current_y = y_start + row * (card_h + gap_y)

        # Draw Cut Border (Dashed line)
        pdf.set_draw_color(180, 185, 195)
        pdf.set_line_width(0.35)
        pdf.set_dash_pattern(dash=2, gap=1.5)
        pdf.rect(x, current_y, card_w, card_h, "D")
        pdf.set_dash_pattern()  # Reset to solid line

        # Card Header Bar (using admin defined captive portal background color)
        hdr_rgb = hex_to_rgb(bg_color, default=(79, 70, 229))
        luminance = (0.299 * hdr_rgb[0] + 0.587 * hdr_rgb[1] + 0.114 * hdr_rgb[2])
        text_rgb = (15, 23, 42) if luminance > 180 else (255, 255, 255)

        pdf.set_fill_color(hdr_rgb[0], hdr_rgb[1], hdr_rgb[2])
        pdf.rect(x, current_y, card_w, 9.5, "F")
        pdf.set_xy(x + 3.5, current_y + 1.8)
        pdf.set_font("Helvetica", "B", 8.5)
        pdf.set_text_color(text_rgb[0], text_rgb[1], text_rgb[2])
        pdf.cell(card_w - 7, 6, "WIFI ACCESS VOUCHER", align="L")
        pdf.set_xy(x + 3.5, current_y + 1.8)
        pdf.set_font("Helvetica", "", 8)
        pdf.cell(card_w - 7, 6, f"SSID: {ssid}", align="R")

        # Card Body Fill
        pdf.set_fill_color(248, 250, 252)  # Slate 50
        pdf.rect(x, current_y + 9.5, card_w, card_h - 9.5, "F")

        # Prominent Access Code Display Box
        code_box_w = card_w - 12
        code_box_h = 13.5
        code_x = x + 6
        code_y = current_y + 12.5
        pdf.set_fill_color(238, 242, 255)  # Indigo 50
        pdf.set_draw_color(199, 210, 254)  # Indigo 200
        pdf.set_line_width(0.3)
        pdf.rect(code_x, code_y, code_box_w, code_box_h, "DF")

        pdf.set_xy(code_x, code_y + 1.8)
        pdf.set_font("Courier", "B", 15)
        pdf.set_text_color(30, 27, 75)  # Indigo 950
        pdf.cell(code_box_w, 10, c.get("code", ""), align="C")

        # Duration & Expiration Details
        dur_val = c.get("duration_hours", 0)
        if dur_val == 0.0833 or dur_val == "0.0833":
            dur = "5 mins"
        elif dur_val == 0.1667 or dur_val == "0.1667":
            dur = "10 mins"
        elif dur_val == 0.5 or dur_val == "0.5":
            dur = "30 mins"
        elif dur_val:
            dur = f"{dur_val}h"
        else:
            dur = "N/A"
        exp = "Starts on 1st use"
        if c.get("expires_at"):
            try:
                exp = datetime.fromisoformat(c["expires_at"]).strftime("%d/%m %H:%M")
            except Exception:
                exp = c["expires_at"]

        pdf.set_xy(x + 4, current_y + 27.5)
        pdf.set_font("Helvetica", "B", 7.5)
        pdf.set_text_color(51, 65, 85)  # Slate 700
        pdf.cell(card_w - 8, 4, f"Duration: {dur}   |   Expires: {exp}", align="C")

        lbl = c.get("label") or "Guest Access"
        pdf.set_xy(x + 4, current_y + 31.8)
        pdf.set_font("Helvetica", "I", 7)
        pdf.set_text_color(100, 116, 139)  # Slate 500
        pdf.cell(card_w - 8, 4, f"Label: {lbl}", align="C")

        # Divider line
        pdf.set_draw_color(226, 232, 240)
        pdf.line(x + 6, current_y + 36.5, x + card_w - 6, current_y + 36.5)

        try:
            cfg = parse_config()
        except Exception:
            cfg = {}
        portal_host = cfg.get("CAPTIVE_DOMAIN", "").strip() or ap_ip

        pdf.set_xy(x + 2, current_y + 38)
        pdf.set_font("Helvetica", "", 6)
        pdf.set_text_color(71, 85, 105)
        pdf.cell(card_w - 4, 3.5, f"1. Connect to '{ssid}'   2. Enter code on portal", align="C")

        if portal_host != ap_ip:
            pdf.set_xy(x + 2, current_y + 42)
            pdf.set_font("Helvetica", "B", 6)
            pdf.set_text_color(79, 70, 229)
            pdf.cell(card_w - 4, 3.5, f"Check status: http://{portal_host}/status", align="C")
            pdf.set_xy(x + 2, current_y + 46.2)
            pdf.set_font("Helvetica", "", 5.5)
            pdf.set_text_color(100, 116, 139)
            pdf.cell(card_w - 4, 3.5, f"IP status: http://{ap_ip}/status", align="C")
        else:
            pdf.set_xy(x + 2, current_y + 43.5)
            pdf.set_font("Helvetica", "B", 6.5)
            pdf.set_text_color(79, 70, 229)
            pdf.cell(card_w - 4, 4, f"Check status: http://{ap_ip}/status", align="C")

        col += 1
        if col >= 2:
            col = 0
            row += 1

    # 2. Render Summary Table on separate page
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 12)
    pdf.set_text_color(15, 23, 42)
    pdf.cell(0, 8, "Vouchers Audit List & Summary", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)

    col_widths = [50, 30, 50, 60]
    headers = ["Access Code", "Duration", "Expiration Date", "Label / Description"]

    # Table Header
    pdf.set_fill_color(30, 41, 59)
    pdf.set_draw_color(30, 41, 59)
    pdf.set_font("Helvetica", "B", 9)
    pdf.set_text_color(255, 255, 255)
    for i, h in enumerate(headers):
        pdf.cell(col_widths[i], 8, h, border=1, align="C", fill=True)
    pdf.ln()

    # Table Body
    pdf.set_font("Helvetica", "", 9)
    pdf.set_draw_color(226, 232, 240)
    for idx, c in enumerate(codes):
        fill = (idx % 2 == 1)
        if fill:
            pdf.set_fill_color(248, 250, 252)
        else:
            pdf.set_fill_color(255, 255, 255)

        exp = "-"
        if c.get("expires_at"):
            try:
                exp = datetime.fromisoformat(c["expires_at"]).strftime("%Y-%m-%d %H:%M")
            except Exception:
                exp = c["expires_at"]

        d_val = c.get("duration_hours", 0)
        if d_val == 0.0833 or d_val == "0.0833":
            d_lbl = "5m"
        elif d_val == 0.1667 or d_val == "0.1667":
            d_lbl = "10m"
        elif d_val == 0.5 or d_val == "0.5":
            d_lbl = "30m"
        else:
            d_lbl = f"{d_val}h"

        pdf.set_text_color(15, 23, 42)
        pdf.set_font("Courier", "B", 10)
        pdf.cell(col_widths[0], 7, c.get("code", ""), border=1, align="C", fill=fill)

        pdf.set_font("Helvetica", "", 9)
        pdf.cell(col_widths[1], 7, d_lbl, border=1, align="C", fill=fill)
        pdf.cell(col_widths[2], 7, exp, border=1, align="C", fill=fill)
        pdf.cell(col_widths[3], 7, c.get("label") or "-", border=1, align="L", fill=fill)
        pdf.ln()

    return pdf


class OShotspotHandler(http.server.BaseHTTPRequestHandler):
    """Handles every incoming request. Kept intentionally dependency-free
    (stdlib only) so the dashboard runs on a bare device image without
    needing pip installs.  (The event collector, a separate component,
    uses the project's only two pip deps: pygtail and tenacity.)"""

    def log_message(self, fmt, *args):
        # Silence the default stderr access log; we keep our own log
        # via scripts.log_action() for the actions that matter.
        pass

    def send_security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")

    def check_token(self):
        """Validate the request's session cookie.  Sends a 401 and
        returns False on failure."""
        session_token = auth.get_session_from_cookie(self)
        if session_token and auth_db.get_session(session_token):
            return True
        self.send_response(401)
        self.send_header("Content-Type", "application/json")
        self.send_security_headers()
        self.end_headers()
        self.wfile.write(json.dumps({"error": "Unauthorized"}).encode())
        return False

    def check_session(self):
        """Validate the session cookie.  Returns the session dict on
        success, or sends a 401 and returns None on failure."""
        token = auth.get_session_from_cookie(self)
        session = auth_db.get_session(token) if token else None
        if session:
            self._resolved_session = session
            return session
        self.send_response(401)
        self.send_header("Content-Type", "application/json")
        self.send_security_headers()
        self.end_headers()
        self.wfile.write(json.dumps({"error": "Unauthorized"}).encode())
        return None

    def check_session_role(self, required_role):
        """Validate session and require a specific role.  Returns the
        session dict on success, or sends 403 and returns None."""
        session = self.check_session()
        if not session:
            return None
        user = auth_db.get_user_by_id(session["user_id"])
        if not user or user["role"] != required_role:
            self.send_response(403)
            self.send_header("Content-Type", "application/json")
            self.send_security_headers()
            self.end_headers()
            self.wfile.write(
                json.dumps({"error": "Forbidden: insufficient privileges"}).encode()
            )
            return None
        return session

    def check_session_audit(self):
        """Validate session and allow superadmin or users with
        can_view_audit=1.  Returns session dict or sends 403."""
        session = self.check_session()
        if not session:
            return None
        user = auth_db.get_user_by_id(session["user_id"])
        if not user:
            self.send_response(403)
            self.send_header("Content-Type", "application/json")
            self.send_security_headers()
            self.end_headers()
            self.wfile.write(
                json.dumps({"error": "Forbidden: insufficient privileges"}).encode()
            )
            return None
        if user["role"] != "superadmin" and not user.get("can_view_audit"):
            self.send_response(403)
            self.send_header("Content-Type", "application/json")
            self.send_security_headers()
            self.end_headers()
            self.wfile.write(
                json.dumps({"error": "Forbidden: insufficient privileges"}).encode()
            )
            return None
        return session

    def _get_audit_user(self):
        """Return (username, role) for the current request.  Uses the
        cached session if available, otherwise returns ('local', 'local')."""
        session = getattr(self, "_resolved_session", None)
        if not session:
            try:
                token = auth.get_session_from_cookie(self)
                session = auth_db.get_session(token) if token else None
            except Exception:
                pass
        if session:
            try:
                user = auth_db.get_user_by_id(session["user_id"])
                if user:
                    return user.get("username", "unknown"), user.get("role", "admin")
            except Exception:
                pass
        return "local", "local"

    def _get_session_user(self):
        """Return the current session's username, or ''."""
        session = getattr(self, "_resolved_session", None)
        if not session:
            try:
                token = auth.get_session_from_cookie(self)
                session = auth_db.get_session(token) if token else None
            except Exception:
                pass
        if session:
            try:
                user = auth_db.get_user_by_id(session["user_id"])
                if user:
                    return user.get("username", "")
            except Exception:
                pass
        return ""

    def _audit(self, action, detail="", success=True):
        """Convenience: write an audit log entry for the current request."""
        username, role = self._get_audit_user()
        ip = self.client_address[0] if self.client_address else ""
        auth_db.audit_log(username, role, action, detail, ip, success)

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        body = json.dumps(data).encode()
        self.send_header("Content-Length", str(len(body)))
        self.send_security_headers()
        self.end_headers()
        try:
            self.wfile.write(body)
            self.wfile.flush()
        except BrokenPipeError:
            pass

    def send_static_file(self, path, no_store=False):
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
        if no_store:
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
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
        elif path.startswith("/images/"):
            filename = os.path.basename(path)
            logo_path = get_logo_path(filename)
            if logo_path:
                self.send_static_file(logo_path)
            else:
                self.send_static_file(os.path.join(settings.STATIC_DIR, "images", filename))
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
        elif path == "/api/events":
            self._get_events(parsed)
        elif path == "/api/traffic":
            self._get_traffic()
        elif path == "/api/interfaces":
            self._get_interfaces()
        elif path == "/api/version":
            self._get_version()
        elif path == "/api/blocked":
            self._get_blocked()
        elif path == "/api/known-devices":
            self._get_known_devices()
        elif path == "/api/domain-policy":
            self._get_domain_policy()
        elif path == "/api/events-status":
            self._get_events_status()
        elif path == "/api/live-stream":
            self._get_live_stream()
        elif path == "/api/auth/status":
            self._get_auth_status(parsed)
        elif path == "/api/auth/logout":
            self._get_auth_logout(parsed)
        elif path == "/api/notifications":
            self._get_notifications(parsed)
        elif path == "/api/notifications/unread-count":
            self._get_notifications_unread_count()
        elif path == "/api/scan":
            self._get_scan()
        elif path == "/api/users":
            self._get_users()
        elif path == "/api/captive":
            self._get_captive_config()
        elif path == "/api/captive/clients":
            self._get_captive_clients()
        elif path == "/api/captive/codes":
            if self.command == "GET":
                self._get_captive_codes()
            elif self.command == "POST":
                self._post_captive_code_create()
            else:
                self.send_response(405)
                self.end_headers()
        elif path == "/api/captive/codes/generate":
            if self.command == "POST":
                self._post_captive_code_generate()
            else:
                self.send_response(405)
                self.end_headers()
        elif path == "/api/captive/codes/revoke":
            if self.command == "POST":
                self._post_captive_code_revoke()
            else:
                self.send_response(405)
                self.end_headers()
        elif path == "/api/captive/codes/export-pdf":
            self._get_captive_codes_export_pdf()
        elif path == "/api/span":
            self._get_span_config()
        elif path == "/api/span/interfaces":
            self._get_span_interfaces()
        elif path == "/api/span/anomalies":
            self._get_span_anomalies()
        elif path == "/api/vpn/status":
            self._get_vpn_status()
        elif path == "/api/wifi-info":
            self._get_wifi_info()
        elif path == "/api/audit-log":
            self._get_audit_log(parsed)
        elif path == "/api/auth/status":
            self._get_auth_status()
        elif path == "/api/app-block":
            self._get_app_block()
        elif path == "/api/mail/preview":
            self._get_mail_preview()

        else:
            self.send_response(404)
            self.end_headers()

    def _serve_index(self, parsed):
        existing_token = auth.get_session_from_cookie(self)
        if existing_token and auth_db.get_session(existing_token):
            self.send_static_file(os.path.join(settings.STATIC_DIR, "index.html"), no_store=True)
            return
        self.send_static_file(os.path.join(settings.STATIC_DIR, "index.html"), no_store=True)

    def _get_status(self):
        if not self.check_token():
            return
        code, stdout, _ = run_script("status.sh")
        data = parse_status(stdout) if code == 0 else {"error": stdout}
        # Enrich with hostapd uptime if we have a PID.
        pid = data.get("hostapd_pid")
        if pid:
            data["hostapd_uptime"] = get_hostapd_uptime(pid)
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
        if component not in ("hostapd", "dnsmasq", "web", "events", "all"):
            self.send_json({"error": "Invalid component"}, 400)
            return
        lines_q = params.get("lines", ["200"])[0]
        try:
            line_count = max(10, min(int(lines_q), 1000))
        except ValueError:
            line_count = 200
        if component == "all":
            logs = {k: read_log_tail(k, line_count) for k in ("hostapd", "dnsmasq", "web", "events")}
            self.send_json(logs)
        else:
            self.send_json(read_log_tail(component, line_count))

    def _get_events(self, parsed):
        if not self.check_token():
            return
        if events_db is None:
            self.send_json({
                "events": [], "known_devices": [], "event_types": [],
                "total": 0, "filters": {},
                "error": "Events storage unavailable (event collector not installed)",
            })
            return
        params = urllib.parse.parse_qs(parsed.query)
        event_type = params.get("type", [""])[0] or None
        mac = params.get("mac", [""])[0] or None
        from_ts = params.get("from", [""])[0] or None
        to_ts = params.get("to", [""])[0] or None
        try:
            limit = max(1, min(int(params.get("limit", ["200"])[0]), 500))
        except ValueError:
            limit = 200
        try:
            events = events_db.query_events(
                event_type=event_type, mac=mac,
                from_ts=from_ts, to_ts=to_ts, limit=limit,
            )
            known_devices = self._enrich_known_devices(events_db.list_known_devices())
            self._enrich_event_clients(events, known_devices)
            self.send_json({
                "events": events,
                "db_ok": events_db.db_reachable(),
                "known_devices": known_devices,
                "event_types": events_db.list_event_types(),
                "total": events_db.count_events(event_type=event_type, mac=mac),
                "filters": {
                    "type": event_type or "",
                    "mac": mac or "",
                    "from": from_ts or "",
                    "to": to_ts or "",
                },
            })
        except Exception:
            self.send_json({
                "events": [], "known_devices": [], "event_types": [],
                "total": 0, "filters": {},
                "error": "Failed to query events database",
            })

    def _lease_clients_by_mac(self):
        """Return current DHCP lease metadata keyed by lower-case MAC."""
        leases = {}
        lease_file = "/run/oshotspot-dnsmasq.leases"
        try:
            with open(lease_file, "r", errors="replace") as f:
                for line in f:
                    parts = line.split()
                    if len(parts) < 4:
                        continue
                    mac = parts[1].strip().lower()
                    if not MAC_RE.match(mac):
                        continue
                    hostname = "" if parts[3] == "*" else parts[3]
                    leases[mac] = {"ip": parts[2], "hostname": hostname}
        except OSError:
            pass
        return leases

    def _enrich_known_devices(self, devices):
        leases = self._lease_clients_by_mac()
        enriched = []
        for d in devices or []:
            item = dict(d)
            mac = (item.get("mac") or "").strip().lower()
            lease = leases.get(mac, {})
            item["hostname"] = lease.get("hostname", "")
            item["ip"] = lease.get("ip", "")
            enriched.append(item)
        return enriched

    def _enrich_event_clients(self, events, known_devices):
        leases = self._lease_clients_by_mac()
        known = {
            (d.get("mac") or "").strip().lower(): d
            for d in (known_devices or [])
            if d.get("mac")
        }
        for event in events or []:
            mac = (event.get("client_mac") or "").strip().lower()
            detail = event.get("detail") if isinstance(event.get("detail"), dict) else {}
            lease = leases.get(mac, {})
            device = known.get(mac, {})
            event["hostname"] = detail.get("hostname") or lease.get("hostname", "")
            event["known_label"] = device.get("label", "")
            event["known_device"] = device

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

    def _get_scan(self):
        """GET /api/scan -- run a WiFi channel occupancy scan and return
        the results.  This is a slow synchronous operation (iw scan takes
        several seconds) so it blocks the worker thread."""
        if not self.check_token():
            return
        code, stdout, stderr = run_script("scan.sh", timeout=30)
        scan_file = "/run/oshotspot-scan-results.json"
        if os.path.isfile(scan_file):
            try:
                with open(scan_file, "r") as f:
                    data = json.load(f)
                self.send_json(data)
                return
            except (json.JSONDecodeError, OSError):
                pass
        # Fallback: parse stdout or return error
        if code == 0 and stdout.strip():
            self.send_json({"ok": True, "output": stdout})
        else:
            self.send_json({
                "ok": False,
                "error": stderr or stdout or "Scan failed",
            })

    def _get_version(self):
        if not self.check_token():
            return
        version = "unknown"
        try:
            with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "VERSION")) as f:
                version = f.read().strip()
        except Exception:
            pass
        self.send_json({
            "name": "OSHotspot",
            "version": version,
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

        # Auth routes don't require the launch token -- they are the
        # entry point for unauthenticated users.
        if path == "/api/auth/login":
            self._post_auth_login()
            return
        elif path == "/api/auth/setup":
            self._post_auth_setup()
            return

        # All other POST routes require the launch token.
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
        elif path == "/api/known-devices":
            self._set_known_device()
        elif path == "/api/known-devices/delete":
            self._delete_known_device()
        elif path == "/api/known-devices/bulk":
            self._bulk_import_known()
        elif path == "/api/domain-policy":
            self._update_domain_policy()
        elif path == "/api/app-block":
            self._update_app_block()
        elif path == "/api/events-test":
            self._create_test_event()
        elif path == "/api/events/delete":
            self._post_delete_events()
        elif path == "/api/notifications/read":
            self._post_notifications_read()
        elif path == "/api/notifications/read-all":
            self._post_notifications_read_all()
        elif path == "/api/notifications/delete-read":
            self._post_notifications_delete_read()
        elif path == "/api/users":
            self._post_create_user()
        elif path == "/api/users/delete":
            self._post_delete_user()
        elif path == "/api/users/reset-password":
            self._post_reset_user_password()
        elif path == "/api/users/role":
            self._post_set_user_role()
        elif path == "/api/captive/revoke":
            self._post_captive_revoke()
        elif path == "/api/captive/logo":
            self._post_captive_logo()
        elif path == "/api/captive/codes":
            self._post_captive_code_create()
        elif path == "/api/captive/codes/generate":
            self._post_captive_code_generate()
        elif path == "/api/captive/codes/revoke":
            self._post_captive_code_revoke()
        elif path == "/api/app/logo":
            self._post_app_logo()
        elif path == "/api/mail/test":
            self._post_mail_test()
        elif path == "/api/vpn/start":
            self._post_vpn_start()
        elif path == "/api/vpn/stop":
            self._post_vpn_stop()
        elif path == "/api/vpn/restart":
            self._post_vpn_restart()
        elif path == "/api/audit-log/delete":
            self._post_delete_audit()
        elif path == "/api/users/audit-access":
            self._post_set_audit_access()

        else:
            self.send_json({"error": "Not found"}, 404)

    def _run_action(self, script_name):
        code, stdout, stderr = run_script(script_name, timeout=90)
        log_action(f"web:{script_name.replace('.sh', '')}")
        self._audit(script_name.replace(".sh", ""))
        self.send_json(
            {"ok": code == 0, "output": stdout, "error": stderr},
            200 if code == 0 else 500,
        )

    def _restart(self):
        stop_code, stop_out, stop_err = run_script("stop.sh", timeout=60)
        code, stdout, stderr = run_script("start.sh", timeout=90)
        log_action("web:restart")
        self._audit("restart")
        self.send_json(
            {"ok": code == 0, "output": stdout, "error": stderr},
            200 if code == 0 else 500,
        )

    def _reload_captive_domain_dns(self, cfg=None):
        """Rewrite the captive-domain dnsmasq include file and hot-reload
        dnsmasq via SIGHUP so the custom domain resolves to the AP immediately,
        without disconnecting any client or restarting hostapd."""
        import signal
        import subprocess
        try:
            if cfg is None:
                cfg = parse_config()
            ap_ip = cfg.get("AP_IP", "192.168.50.1")
            raw_domain = cfg.get("CAPTIVE_DOMAIN", "").strip().lower()
            # Strip protocol, path, port, trailing slashes
            domain = re.sub(r"^(https?://)+", "", raw_domain)
            domain = domain.split("/")[0].split(":")[0].strip()

            domain_file = "/etc/oshotspot/dnsmasq-captive-domain.conf"
            os.makedirs(os.path.dirname(domain_file), exist_ok=True)
            if domain:
                lines = [
                    "# Custom captive portal domain (auto-generated by OSHotspot)",
                    f"# Resolves {domain} to the AP so portal opens on any HTTP request",
                    # Authoritative local zone so AAAA is not forwarded upstream.
                    # Avoid address=/domain/:: (Happy Eyeballs prefers :: and breaks access).
                    f"local=/{domain}/",
                    f"address=/{domain}/{ap_ip}",
                ]
                # If specified with www., also include the root domain so both resolve
                if domain.startswith("www.") and len(domain) > 4:
                    root_dom = domain[4:]
                    lines.append(f"local=/{root_dom}/")
                    lines.append(f"address=/{root_dom}/{ap_ip}")
                content = "\n".join(lines) + "\n"
            else:
                content = "# No custom captive portal domain configured\n"
            with open(domain_file, "w") as f:
                f.write(content)
            os.chmod(domain_file, 0o644)

            # Restart dnsmasq process so conf-file includes are re-read
            reloaded = False
            pid_file = "/run/oshotspot-dnsmasq.pid"
            # Try the installed helper script first, then fall back to
            # signalling the daemon directly.
            restart_script = "/usr/lib/oshotspot/scripts/reload-dns-blocking.sh"
            if os.path.isfile(restart_script):
                res = subprocess.run(["bash", restart_script, "restart_dnsmasq"], check=False)
                if res.returncode == 0:
                    reloaded = True

            if not reloaded and os.path.isfile(pid_file):
                try:
                    with open(pid_file) as pf:
                        pid = int(pf.read().strip())
                    os.kill(pid, signal.SIGTERM)
                    reloaded = True
                except Exception as p_err:
                    logging.getLogger("oshotspot").warning("PID SIGTERM failed: %s", p_err)

            if not reloaded:
                subprocess.run(["pkill", "-TERM", "-f", "dnsmasq"], check=False)

            # Optional: flush DNS conntrack so clients re-resolve immediately.
            # conntrack is not installed on all systems, skip quietly.
            try:
                import shutil
                if shutil.which("conntrack"):
                    subprocess.run(
                        ["conntrack", "-D", "-p", "udp", "--dport", "53"],
                        check=False,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
            except (FileNotFoundError, OSError):
                pass

            logging.getLogger("oshotspot").info(
                "Captive domain DNS updated: %s -> %s (dnsmasq restarted)",
                domain or "(cleared)", ap_ip
            )
        except Exception as exc:
            logging.getLogger("oshotspot").warning(
                "Could not reload captive domain DNS: %s", exc
            )

    def _repair(self):
        code, stdout, stderr = run_script("repair.sh", timeout=60)
        log_action("web:repair")
        self._audit("repair")
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
        if "INACTIVITY_TIMEOUT" in validated:
            settings.reload_inactivity_timeout()
        log_action(f"web:config:{list(validated.keys())}")
        # Keep a second entry that omits the password, safe to grep/share.
        log_action(f"web:config_updated:{','.join(k for k in validated.keys() if k != 'PASSWORD')}")
        self._audit("config_update", "keys:" + ",".join(validated.keys()))

        # Check if the updated keys are ONLY non-AP parameter changes (captive portal or SPAN settings)
        hotspot_free_keys = {
            "CAPTIVE_PORTAL", "CAPTIVE_CODE", "CAPTIVE_MESSAGE", "CAPTIVE_BG_COLOR", "CAPTIVE_LOGO_URL",
            "CAPTIVE_DOMAIN",
            "SPAN_ENABLED", "SPAN_INTERFACE", "ADMIN_LOGO_URL", "ADMIN_LOGIN_BG_COLOR",
            "INACTIVITY_TIMEOUT",
            "ALERT_EMAIL_ENABLED", "ALERT_EMAIL_SMTP_MODE", "ALERT_EMAIL_TO", "ALERT_EMAIL_FROM",
            "ALERT_EMAIL_SMTP_HOST", "ALERT_EMAIL_SMTP_PORT", "ALERT_EMAIL_USERNAME", "ALERT_EMAIL_PASSWORD",
            "ALERT_EMAIL_TEMPLATE", "ALERT_EMAIL_CATEGORIES",
        }
        updated_keys = set(validated.keys())
        only_hotspot_free = updated_keys.issubset(hotspot_free_keys)

        # Apply captive server state and firewall rules dynamically
        cfg = parse_config()
        cap_val = cfg.get("CAPTIVE_PORTAL", "false").lower() == "true"
        if captive is not None:
            if cap_val:
                captive.start_captive_server()
                run_script("firewall.sh captive_setup", timeout=15)
            else:
                captive.stop_captive_server()
                run_script("firewall.sh captive_teardown", timeout=15)
                try:
                    if os.path.exists(captive.AUTHENTICATED_MACS_FILE):
                        os.remove(captive.AUTHENTICATED_MACS_FILE)
                except Exception:
                    pass

        # If CAPTIVE_DOMAIN changed, rewrite its dnsmasq conf and hot-reload
        # dnsmasq (SIGHUP) so clients can resolve the domain instantly without
        # a full hotspot restart or any client disconnection.
        if "CAPTIVE_DOMAIN" in validated:
            self._reload_captive_domain_dns(cfg)

        # Apply SPAN analyzer state dynamically
        try:
            from events import span_analyzer
            span_val = cfg.get("SPAN_ENABLED", "false").lower() == "true"
            span_iface = cfg.get("SPAN_INTERFACE", "").strip()
            if span_val and span_iface:
                span_analyzer.stop_span_analyzer()
                span_analyzer.start_span_analyzer(span_iface)
            else:
                span_analyzer.stop_span_analyzer()
        except Exception:
            pass

        # Network/WiFi changes (SSID, password, channel, etc.) require hostapd restart.
        # Captive portal and SPAN configuration changes take effect INSTANTLY without AP disconnection!
        if not only_hotspot_free:
            is_running = os.path.isfile("/run/oshotspot-hostapd.pid")
            if is_running:
                run_script("stop.sh", timeout=60)
                time.sleep(1)
                code, stdout, stderr = run_script("start.sh", timeout=90)
                if code != 0:
                    self.send_json(
                        {"ok": False, "error": stderr or "Restart failed after config update",
                         "updated": list(validated.keys())},
                        500,
                    )
                    return

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
        run_script("stop.sh", timeout=60)
        time.sleep(1)
        code, stdout, stderr = run_script("start.sh", timeout=90)

        log_action(f"web:kick:{mac}")
        self._audit("kick", "mac:" + mac)
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
        run_script("stop.sh", timeout=60)
        time.sleep(1)
        code, stdout, stderr = run_script("start.sh", timeout=90)

        log_action(f"web:unblock:{mac}")
        self._audit("unblock", "mac:" + mac)
        self.send_json({
            "ok": code == 0,
            "output": stdout,
            "error": stderr if code != 0 else ""
        })

    # ------------------------------------------------------------------
    # New: Known Devices API + Domain Policy API + SSE live stream
    # ------------------------------------------------------------------

    def _get_known_devices(self):
        """GET /api/known-devices -- returns the full known-devices
        inventory as a list of dicts.  Used by the Clients page to
        decorate rows with a "known" / "unknown" badge and a friendly
        label."""
        if not self.check_token():
            return
        if events_db is None:
            self.send_json([])
            return
        try:
            self.send_json(self._enrich_known_devices(events_db.list_known_devices()))
        except Exception:
            self.send_json([])

    def _set_known_device(self):
        """POST /api/known-devices -- mark a MAC as known or update
        its label and optional metadata.

        Body: {"mac": "aa:bb:..", "label": "My Phone",
               "device_type": "phone", "notes": "..."}."""
        if not self.check_session():
            return
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
        mac = (data.get("mac") or "").strip()
        label = (data.get("label") or "").strip()
        device_type = (data.get("device_type") or "").strip()
        notes = (data.get("notes") or "").strip()
        if not mac or not MAC_RE.match(mac):
            self.send_json({"error": "Valid MAC address required"}, 400)
            return
        if not label:
            label = "known device"
        if events_db is None:
            self.send_json({"error": "Events storage unavailable"}, 500)
            return
        added_by = self._get_session_user() or ""
        try:
            ok = events_db.set_known_label(mac, label, device_type=device_type,
                                           notes=notes, added_by=added_by)
        except Exception as exc:
            logging.warning("mark_known DB error for %s: %s", mac, exc)
            self.send_json({"error": "Database busy, please retry"}, 503)
            return
        log_action(f"web:mark_known:{mac}")
        if live_bus is not None and ok:
            try:
                lease = self._lease_clients_by_mac().get(mac.lower(), {})
                live_bus.publish({
                    "type": "client_change",
                    "subtype": "marked_known",
                    "client_mac": mac.lower(),
                    "hostname": lease.get("hostname", ""),
                    "known_label": label,
                    "label": label,
                })
            except Exception:
                pass
        self.send_json({"ok": ok, "mac": mac.lower(), "label": label})

    def _delete_known_device(self):
        """POST /api/known-devices/delete -- remove a device from the
        known inventory so it is re-classified as unknown.

        Body: {"mac": "aa:bb:.."}."""
        if not self.check_session():
            return
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
        mac = (data.get("mac") or "").strip()
        if not mac or not MAC_RE.match(mac):
            self.send_json({"error": "Valid MAC address required"}, 400)
            return
        if events_db is None:
            self.send_json({"error": "Events storage unavailable"}, 500)
            return
        ok = events_db.remove_known(mac)
        log_action(f"web:remove_known:{mac}")
        if live_bus is not None and ok:
            try:
                live_bus.publish({
                    "type": "client_change",
                    "subtype": "removed_known",
                    "client_mac": mac.lower(),
                })
            except Exception:
                pass
        self.send_json({"ok": ok, "mac": mac.lower()})

    def _bulk_import_known(self):
        """POST /api/known-devices/bulk -- import multiple devices.

        Body: {"devices": [{"mac": "aa:bb:..", "label": "My Phone",
               "device_type": "phone", "notes": ""}, ...]}.

        Returns a summary of how many were added/updated/failed."""
        if not self.check_session():
            return
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length > 65536:
            self.send_json({"error": "Request too large"}, 413)
            return
        body = self.rfile.read(content_length)
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self.send_json({"error": "Invalid JSON"}, 400)
            return
        devices = data.get("devices")
        if not isinstance(devices, list):
            self.send_json({"error": "devices must be an array"}, 400)
            return
        if events_db is None:
            self.send_json({"error": "Events storage unavailable"}, 500)
            return
        added_by = self._get_session_user() or ""
        added = 0
        failed = 0
        for d in devices:
            mac = (d.get("mac") or "").strip()
            label = (d.get("label") or "").strip() or "known device"
            device_type = (d.get("device_type") or "").strip()
            notes = (d.get("notes") or "").strip()
            if not mac or not MAC_RE.match(mac):
                failed += 1
                continue
            ok = events_db.set_known_label(mac, label, device_type=device_type,
                                           notes=notes, added_by=added_by)
            if ok:
                added += 1
            else:
                failed += 1
        log_action(f"web:bulk_import_known:{added}:{failed}")
        self.send_json({"ok": True, "added": added, "failed": failed})

    def _get_domain_policy(self):
        """GET /api/domain-policy -- returns all three policy lists in
        one envelope so the Domain Policy page can render them in a
        single fetch."""
        if not self.check_token():
            return
        if events_classify is None or events_db is None:
            self.send_json({
                "noise_patterns": [],
                "forbidden_domains": [],
                "watched_domains": [],
                "error": "Domain policy storage unavailable",
            })
            return
        try:
            db_path = events_db.EVENTS_DB
            self.send_json({
                "noise_patterns": events_classify.list_patterns(db_path, "noise_patterns"),
                "forbidden_domains": events_classify.list_patterns(db_path, "forbidden_domains"),
                "watched_domains": events_classify.list_patterns(db_path, "watched_domains"),
            })
        except Exception:
            self.send_json({
                "noise_patterns": [],
                "forbidden_domains": [],
                "watched_domains": [],
                "error": "Failed to read domain policy tables",
            })

    def _update_domain_policy(self):
        """POST /api/domain-policy -- add or remove a pattern from one
        of the three policy lists.

        Body: ``{"action": "add"|"remove"|"bulk_import", "table":
        "forbidden_domains"|"watched_domains"|"noise_patterns",
        "pattern": "*.example.com", "label": "reason"}``.

        For ``bulk_import``, ``patterns`` (a list of strings) is used
        instead of ``pattern``.

        On a successful add or remove the response includes the updated
        list for that table so the frontend can re-render without an
        extra round-trip.  When the forbidden_domains table is changed,
        the dnsmasq block file is regenerated and dnsmasq is restarted
        so the change takes effect immediately."""
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length > 512 * 1024:  # 512KB for bulk imports
            self.send_json({"error": "Request too large"}, 413)
            return
        body = self.rfile.read(content_length)
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self.send_json({"error": "Invalid JSON"}, 400)
            return
        action = (data.get("action") or "").strip().lower()
        table = (data.get("table") or "").strip().lower()
        pattern = (data.get("pattern") or "").strip()
        label = (data.get("label") or "").strip()
        if action not in ("add", "remove", "bulk_import"):
            self.send_json({"error": "action must be 'add', 'remove', or 'bulk_import'"}, 400)
            return
        if table not in ("noise_patterns", "forbidden_domains", "watched_domains"):
            self.send_json({"error": "Invalid table name"}, 400)
            return
        if events_classify is None or events_db is None:
            self.send_json({"error": "Domain policy storage unavailable"}, 500)
            return
        db_path = events_db.EVENTS_DB

        if action == "bulk_import":
            # Bulk import: add many patterns at once.
            patterns = data.get("patterns") or []
            if not isinstance(patterns, list) or not patterns:
                self.send_json({"error": "patterns (non-empty list) required for bulk_import"}, 400)
                return
            added = 0
            skipped = 0
            for p in patterns:
                p = str(p or "").strip()
                if not p:
                    continue
                if events_classify.add_pattern(db_path, table, p, label):
                    added += 1
                else:
                    skipped += 1
            log_action(f"web:domain_policy:bulk_import:{table}:{added}added/{skipped}skipped")
            self._audit("domain_policy", "bulk:" + table + ":" + str(added) + "added")
            # Push live update
            if live_bus is not None:
                try:
                    live_bus.publish({
                        "type": "policy_change",
                        "action": "bulk_import",
                        "table": table,
                        "pattern": "{} patterns".format(added),
                        "label": label,
                    })
                except Exception:
                    pass
            # Reload DNS blocking if forbidden_domains was changed
            dns_reloaded = False
            if table == "forbidden_domains":
                dns_reloaded = self._reload_dns_blocking()
            self.send_json({
                "ok": True,
                "action": "bulk_import",
                "table": table,
                "added": added,
                "skipped": skipped,
                "dns_reloaded": dns_reloaded,
                "updated_list": events_classify.list_patterns(db_path, table),
            })
            return

        if not pattern:
            self.send_json({"error": "pattern required"}, 400)
            return
        if action == "remove" and table == "noise_patterns":
            session = self.check_session()
            if not session:
                return
            user = auth_db.get_user_by_id(session["user_id"])
            password = data.get("admin_password") or ""
            if not user or not password:
                self.send_json({"error": "Admin password required"}, 400)
                return
            verified = auth_db.verify_password(user["username"], password)
            if verified.get("error"):
                self.send_json({"error": "Invalid admin password"}, 403)
                return
        if action == "add":
            ok = events_classify.add_pattern(db_path, table, pattern, label)
        else:
            ok = events_classify.remove_pattern(db_path, table, pattern)
        if not ok:
            self.send_json({"ok": False, "error": "Operation failed"}, 500)
            return
        log_action(f"web:domain_policy:{action}:{table}:{pattern}")
        self._audit("domain_policy", action + ":" + table + ":" + pattern)
        # Push a live update so any open dashboard tab refreshes the
        # Domain Policy view instantly.
        if live_bus is not None:
            try:
                live_bus.publish({
                    "type": "policy_change",
                    "action": action,
                    "table": table,
                    "pattern": pattern,
                    "label": label,
                })
            except Exception:
                pass
        # Reload DNS blocking if forbidden_domains was changed
        dns_reloaded = False
        if table == "forbidden_domains":
            dns_reloaded = self._reload_dns_blocking()
        self.send_json({
            "ok": True,
            "action": action,
            "table": table,
            "pattern": pattern,
            "dns_reloaded": dns_reloaded,
            "updated_list": events_classify.list_patterns(db_path, table),
        })

    def _reload_dns_blocking(self):
        """Regenerate /etc/oshotspot/dnsmasq-blocked.conf from the
        forbidden_domains table and restart dnsmasq.  Returns True on
        success, False on failure.  Never raises."""
        try:
            code, stdout, stderr = run_script("reload-dns-blocking.sh", timeout=30)
            if code == 0:
                log_action("web:reload_dns_blocking:ok")
            else:
                log_action(f"web:reload_dns_blocking:fail:{stderr.strip()}")
            return code == 0
        except Exception as e:
            log_action(f"web:reload_dns_blocking:error:{e}")
            return False

    # ------------------------------------------------------------------
    # Application Category Blocking API
    # ------------------------------------------------------------------

    APP_BLOCK_STATE_FILE = "/run/oshotspot-app-block.conf"

    VALID_CATEGORIES = [
        "messaging", "gaming"
    ]

    CATEGORY_LABELS = {
        "messaging": "Messaging (WhatsApp, Telegram, Signal, Discord, Viber, Snapchat, Skype)",
        "gaming": "Gaming (Steam, Epic Games)",
    }

    def _read_app_block_state(self):
        """Read the current active categories from the state file."""
        categories = []
        try:
            if os.path.isfile(self.APP_BLOCK_STATE_FILE):
                with open(self.APP_BLOCK_STATE_FILE, "r") as f:
                    for line in f:
                        line = line.strip()
                        if line.startswith("APP_BLOCK_CATEGORIES="):
                            val = line.split("=", 1)[1].strip().strip('"')
                            categories = [c.strip() for c in val.split() if c.strip()]
                            break
        except Exception:
            pass
        return categories

    def _write_app_block_state(self, categories):
        """Write the active categories to the state file."""
        try:
            with open(self.APP_BLOCK_STATE_FILE, "w") as f:
                f.write(f"APP_BLOCK_CATEGORIES=\"{' '.join(categories)}\"\n")
            return True
        except Exception:
            return False

    def _get_app_block(self):
        """GET /api/app-block -- returns the current app blocking state."""
        if not self.check_token():
            return
        categories = self._read_app_block_state()
        self.send_json({
            "active_categories": categories,
            "available_categories": [
                {"id": cid, "label": self.CATEGORY_LABELS.get(cid, cid), "active": cid in categories}
                for cid in self.VALID_CATEGORIES
            ],
        })

    def _update_app_block(self):
        """POST /api/app-block -- update the set of blocked app categories.

        Body: {"categories": ["messaging", "social"]}

        Writes the categories to /run/oshotspot-app-block.conf and
        invokes firewall.sh app_block_apply to install SNI + port rules.
        An empty list removes all app blocking."""
        if not self.check_token():
            return
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

        requested = data.get("categories", [])
        if not isinstance(requested, list):
            self.send_json({"error": "categories must be a list"}, 400)
            return

        # Validate
        valid = []
        for c in requested:
            c = str(c).strip().lower()
            if c in self.VALID_CATEGORIES:
                valid.append(c)
            else:
                self.send_json(
                    {"error": f"Unknown category: {c}. Valid: {', '.join(self.VALID_CATEGORIES)}"},
                    400,
                )
                return

        # Write state -- fail fast if the state file can't be written,
        # otherwise firewall.sh would apply stale/empty categories.
        if not self._write_app_block_state(valid):
            self.send_json({"error": "Cannot write app block state file"}, 500)
            return
        log_action(f"web:app_block:update:{','.join(valid) or 'none'}")
        self._audit("app_block", "categories:" + ",".join(valid) if valid else "none")

        # Apply firewall rules
        if valid:
            code, stdout, stderr = run_script("firewall.sh", timeout=30, args=["app_block_apply"])
        else:
            code, stdout, stderr = run_script("firewall.sh", timeout=30, args=["app_block_cleanup"])

        log_action(f"web:app_block:apply:{'ok' if code == 0 else 'fail'}:{','.join(valid) or 'none'}")
        if code != 0:
            if stderr.strip():
                log_action(f"web:app_block:stderr:{stderr.strip()[:500]}")
            elif stdout.strip():
                log_action(f"web:app_block:stdout:{stdout.strip()[:500]}")

        self.send_json({
            "ok": code == 0,
            "active_categories": valid,
            "output": stdout,
            "error": stderr if code != 0 else "",
        })

    def _get_events_status(self):
        """GET /api/events-status -- diagnostic endpoint that returns
        the health of the event collection pipeline so the dashboard
        can show a helpful message when something is wrong.

        Returns:
          - tailer_running: bool
          - db_exists: bool
          - db_path: str
          - event_count: int
          - last_event_timestamp: str (or "")
          - dnsmasq_log_exists: bool
          - dnsmasq_log_size: int (bytes)
          - dnsmasq_log_last_line: str (or "")
          - live_db_exists: bool
          - suggestions: list of str (human-readable hints)"""
        if not self.check_token():
            return
        import subprocess as _sp
        status = {
            "tailer_running": False,
            "db_exists": False,
            "db_ok": False,
            "db_path": "",
            "event_count": 0,
            "last_event_timestamp": "",
            "dnsmasq_log_exists": False,
            "dnsmasq_log_size": 0,
            "dnsmasq_log_last_line": "",
            "live_db_exists": False,
            "live_db_writable": False,
            "live_ring_count": 0,
            "live_ring_latest_id": 0,
            "events_latest_id": 0,
            "sse_id_mismatch_warning": False,
            "last_ring_event_ts": "",
            "suggestions": [],
        }
        suggestions = []

        # Check tailer process
        try:
            result = _sp.run(["pgrep", "-f", "events/tailer.py"],
                             capture_output=True, text=True, timeout=5)
            status["tailer_running"] = result.returncode == 0 and bool(result.stdout.strip())
        except Exception:
            status["tailer_running"] = False

        # Check events DB
        if events_db is not None:
            db_path = events_db.EVENTS_DB
            status["db_path"] = db_path
            status["db_exists"] = os.path.isfile(db_path)
            status["db_ok"] = events_db.db_reachable()
            if status["db_exists"]:
                try:
                    count = events_db.count_events()
                    status["event_count"] = count
                    events = events_db.query_events(limit=1)
                    if events:
                        status["last_event_timestamp"] = events[0].get("timestamp", "")
                        status["events_latest_id"] = int(events[0].get("id") or 0)
                except Exception:
                    status["db_ok"] = False
                    pass

        # Check dnsmasq log
        dnsmasq_log = "/var/log/oshotspot/dnsmasq.log"
        status["dnsmasq_log_exists"] = os.path.isfile(dnsmasq_log)
        if status["dnsmasq_log_exists"]:
            try:
                status["dnsmasq_log_size"] = os.path.getsize(dnsmasq_log)
                # Read last line
                with open(dnsmasq_log, "r", errors="replace") as f:
                    lines = f.readlines()
                    if lines:
                        status["dnsmasq_log_last_line"] = lines[-1].strip()[:200]
            except Exception:
                pass

        # Check live DB (ring buffer)
        live_db_path = os.environ.get("OSHOTSPOT_LIVE_DB", "/var/log/oshotspot/live.db")
        status["live_db_exists"] = os.path.isfile(live_db_path)
        if status["live_db_exists"]:
            status["live_db_writable"] = os.access(live_db_path, os.R_OK | os.W_OK)
            try:
                conn = sqlite3.connect(live_db_path, timeout=3)
                try:
                    row = conn.execute(
                        "SELECT COUNT(*) AS n, MAX(ts) AS last_ts, MAX(id) AS max_id "
                        "FROM live_stream_events"
                    ).fetchone()
                    if row:
                        status["live_ring_count"] = int(row[0] or 0)
                        status["live_ring_latest_id"] = int(row[2] or 0)
                        if row[1]:
                            try:
                                status["last_ring_event_ts"] = time.strftime(
                                    "%Y-%m-%d %H:%M:%S", time.localtime(float(row[1]))
                                )
                            except Exception:
                                status["last_ring_event_ts"] = str(row[1])
                finally:
                    conn.close()
            except Exception:
                status["live_db_writable"] = False

        ring_id = status.get("live_ring_latest_id") or 0
        events_id = status.get("events_latest_id") or 0
        if ring_id > 0 and events_id > 0 and ring_id > events_id * 100:
            status["sse_id_mismatch_warning"] = True

        # Generate suggestions
        if not status["tailer_running"]:
            suggestions.append(
                "Event collector (tailer) is not running. Start the hotspot with "
                "'sudo oshotspot start' to begin collecting DNS/DHCP events."
            )
        if not status["db_exists"]:
            suggestions.append(
                "Events database does not exist yet. The tailer will create it "
                "automatically on first run."
            )
        elif not status["db_ok"]:
            suggestions.append(
                "Events database exists but cannot be read (permissions or "
                "corruption). Check the owner/mode of " + events_db.EVENTS_DB +
                " and that the web server can open it."
            )
        elif status["event_count"] == 0:
            suggestions.append(
                "Events database exists but is empty. Make sure clients are "
                "connected and browsing -- their DNS queries should appear here "
                "within a few seconds."
            )
        if not status["live_db_exists"]:
            suggestions.append(
                "Live stream ring buffer does not exist yet at " + live_db_path +
                ". If Live Activity stays empty, verify the tailer can publish live events."
            )
        elif not status["live_db_writable"]:
            suggestions.append(
                "Live stream ring buffer exists but is not writable/readable by the current process. "
                "Check the owner/mode of " + live_db_path + "."
            )
        elif status["live_ring_count"] == 0 and status["event_count"] > 0:
            suggestions.append(
                "Structured events exist, but the live ring buffer is empty. Live Activity may stop updating until the tailer publishes to live.db again."
            )
        if status.get("sse_id_mismatch_warning"):
            suggestions.append(
                "Live stream ring buffer has many more entries than recent session rows. "
                "If Live Activity goes silent after a phone connects, refresh the dashboard page to reset the SSE connection."
            )
            if status.get("last_ring_event_ts"):
                try:
                    ring_ts = time.mktime(time.strptime(
                        status["last_ring_event_ts"], "%Y-%m-%d %H:%M:%S"))
                    if time.time() - ring_ts < 120:
                        suggestions.append(
                            "Ring buffer received events in the last 2 minutes but the UI may be stuck. "
                            "Refresh the dashboard page to reset the SSE connection."
                        )
                except Exception:
                    pass
        if not status["dnsmasq_log_exists"]:
            suggestions.append(
                "dnsmasq log file not found at " + dnsmasq_log + ". "
                "This means dnsmasq is not running or was never started."
            )
        elif status["dnsmasq_log_size"] == 0:
            suggestions.append(
                "dnsmasq log file is empty. dnsmasq is running but no DNS "
                "queries have been logged yet -- connect a client and try "
                "browsing a website."
            )
        if not suggestions:
            suggestions.append(
                "Event pipeline looks healthy. If events are still not "
                "showing, check the Events page filters (time range, type, MAC)."
            )

        status["suggestions"] = suggestions
        self.send_json(status)

    def _create_test_event(self):
        """POST /api/events-test -- insert a synthetic test event into
        the events DB and publish it on the live bus.  Used by the
        'Test pipeline' button on the Events page to verify that the
        DB is writable and the SSE stream is delivering messages.

        Body: ``{"domain": "test.example.com"}`` (optional)."""
        if not self.check_token():
            return
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length else b"{}"
        try:
            data = json.loads(body) if body else {}
        except json.JSONDecodeError:
            data = {}
        domain = (data.get("domain") or "test.example.com").strip()

        import time as _time, hashlib as _hashlib
        ts = _time.strftime("%Y-%m-%d %H:%M:%S")
        mac = "00:00:00:00:00:00"

        if events_db is not None:
            try:
                conn = events_db.connect()
                try:
                    events_db.insert_event(conn, {
                        "timestamp": ts,
                        "first_seen": ts,
                        "last_seen": ts,
                        "client_mac": mac,
                        "event_type": "dns_query",
                        "detail": {
                            "domain": domain,
                            "query_type": "TEST",
                            "ip": "0.0.0.0",
                            "category": "browsing",
                            "test_event": True,
                        },
                        "category": "browsing",
                        "request_count": 1,
                        "priority": "",
                        "alert_type": "",
                        "source_hash": _hashlib.sha1(
                            ("test:" + domain + ":" + ts).encode()
                        ).hexdigest(),
                    })
                finally:
                    conn.close()
            except Exception:
                pass

        # Publish on the live bus so the SSE stream delivers it
        if live_bus is not None:
            try:
                live_bus.publish({
                    "type": "dns_event",
                    "id": None,
                    "is_update": False,
                    "timestamp": ts,
                    "client_mac": mac,
                    "event_type": "dns_query",
                    "detail": {"domain": domain, "query_type": "TEST",
                               "ip": "0.0.0.0", "category": "browsing",
                               "test_event": True},
                    "category": "browsing",
                    "first_seen": ts,
                    "last_seen": ts,
                    "request_count": 1,
                    "priority": "",
                    "alert_type": "",
                })
            except Exception:
                pass

        log_action("web:events_test")
        self.send_json({"ok": True, "domain": domain, "timestamp": ts})

    def _post_delete_events(self):
        """POST /api/events/delete, delete N oldest events (superadmin
        only).  Body: {count: N}"""
        session = self.check_session_role("superadmin")
        if not session:
            return
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self.send_json({"error": "Invalid JSON"}, 400)
            return
        count = data.get("count")
        if not isinstance(count, int) or count < 1:
            self.send_json({"error": "count must be a positive integer"}, 400)
            return
        if count > 10000:
            self.send_json({"error": "Maximum 10,000 events per deletion"}, 400)
            return
        if events_db is None:
            self.send_json({"error": "Events module not available"}, 500)
            return
        deleted, max_id = events_db.delete_oldest_events(count)
        self._audit("events_delete", "count:" + str(deleted))
        self.send_json({"ok": True, "deleted": deleted})

    def _get_live_stream(self):
        """GET /api/live-stream -- the unified SSE endpoint.

        The token check is done inside ``live_stream.stream`` (we can't
        use ``check_token`` here because that would write a 401 body
        and end the response before we even start the SSE framing).

        Once authed, this method blocks the worker thread until the
        client disconnects.  Because the server is a
        ThreadingHTTPServer, each browser tab gets its own thread so
        this doesn't block other clients."""
        if not self.check_token():
            return
        try:
            live_stream.stream(self)
        except Exception:
            # Any unexpected error -- the connection is already over,
            # just make sure we don't propagate the exception to the
            # server's request handler which would log a stack trace.
            pass

    # ------------------------------------------------------------------
    # Auth routes (login, setup, status, logout)
    # ------------------------------------------------------------------

    def _get_auth_status(self, parsed):
        """GET /api/auth/status -- returns setup/login state and current
        session info."""
        needs = auth_db.needs_setup()
        is_local = is_local_request(self)
        session_token = auth.get_session_from_cookie(self)
        session = auth_db.get_session(session_token) if session_token else None
        user = auth_db.get_user_by_id(session["user_id"]) if session else None
        cfg = parse_config()
        logo_url = cfg.get("ADMIN_LOGO_URL", "")
        if not logo_url:
            if get_logo_path("app_logo.png"):
                logo_url = "/images/app_logo.png"
            else:
                logo_url = default_logo_url()

        self.send_json({
            "needs_setup": needs,
            "can_setup": needs and is_local,
            "is_local": is_local,
            "authenticated": session is not None,
            "role": user["role"] if user else None,
            "username": user["username"] if user else None,
            "can_view_audit": bool(user.get("can_view_audit")) if user else False,
            "admin_logo_url": logo_url,
            "admin_login_bg_color": cfg.get("ADMIN_LOGIN_BG_COLOR", ""),
        })

    def _get_auth_logout(self, parsed):
        """GET /api/auth/logout -- clear session and redirect to login."""
        params = urllib.parse.parse_qs(parsed.query)
        req_token = params.get("token", [None])[0]
        session_token = auth.get_session_from_cookie(self)
        if session_token:
            session = auth_db.get_session(session_token)
            if session:
                user = auth_db.get_user_by_id(session["user_id"])
                username = user.get("username", "unknown") if user else "unknown"
                role = user.get("role", "admin") if user else "admin"
            else:
                username, role = "unknown", "unknown"
            auth_db.delete_session(session_token)
            ip = self.client_address[0] if self.client_address else ""
            auth_db.audit_log(username, role, "logout", "", ip)
        self.send_response(302)
        self.send_header("Location", "/")
        auth.clear_session_cookie(self)
        self.send_security_headers()
        self.end_headers()

    def _post_auth_login(self):
        """POST /api/auth/login -- authenticate and issue session cookie."""
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
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        if not username or not password:
            self.send_json({"error": "Username and password are required"}, 400)
            return
        result = auth_db.verify_password(username, password, self.client_address[0] if self.client_address else None)
        if "error" in result:
            status = 423 if result["error"] == "locked" else 401
            ip = self.client_address[0] if self.client_address else ""
            user = auth_db.get_user(username)
            auth_db.audit_log(
                username,
                user["role"] if user else "unknown",
                "login_" + result["error"],
                "", ip, False)
            self.send_json(result, status)
            return
        # Create session and set cookie
        session_token = auth_db.create_session(result["id"])
        ip = self.client_address[0] if self.client_address else ""
        auth_db.audit_log(username, result.get("role", "admin"),
                          "login_success", "", ip)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        auth.set_session_cookie(self, session_token)
        self.send_security_headers()
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True}).encode())

    def _post_auth_setup(self):
        """POST /api/auth/setup -- first-run superadmin creation."""
        if not auth_db.needs_setup():
            self.send_json({"error": "Setup already completed"}, 400)
            return
        if not is_local_request(self):
            self.send_json({"error": "First-time setup must be performed directly on the hotspot host computer."}, 403)
            return
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
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        if not username or not password:
            self.send_json({"error": "Username and password are required"}, 400)
            return
        try:
            user_id = auth_db.create_user(username, password, role="superadmin")
        except ValueError as e:
            self.send_json({"error": str(e)}, 400)
            return
        except Exception:
            self.send_json({"error": "Username already exists"}, 409)
            return
        # Auto-login after setup
        session_token = auth_db.create_session(user_id)
        ip = self.client_address[0] if self.client_address else ""
        auth_db.audit_log(username, "superadmin", "setup_superadmin", "", ip)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        auth.set_session_cookie(self, session_token)
        self.send_security_headers()
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True}).encode())

    # ------------------------------------------------------------------
    # Notification routes
    # ------------------------------------------------------------------

    def _get_notifications(self, parsed):
        """GET /api/notifications -- list notifications."""
        if not self.check_session():
            return
        params = urllib.parse.parse_qs(parsed.query)
        try:
            limit = int(params.get("limit", [50])[0])
        except (TypeError, ValueError):
            limit = 50
        limit = max(1, min(limit, 100))
        unread_only = params.get("unread_only", ["false"])[0].lower() == "true"
        notifications = auth_db.get_notifications(limit=limit, unread_only=unread_only)
        self._enrich_policy_notifications(notifications)
        self.send_json(notifications)

    def _enrich_policy_notifications(self, notifications):
        """Add client identity to forbidden/watched notification messages.

        Older persisted notifications only stored the policy hit text.
        When they have related_event_id, rebuild the display message from
        the event row so the admin sees the hostname and known-device label.
        """
        if events_db is None or not notifications:
            return

        policy_notifications = [
            n for n in notifications
            if n.get("type") in ("forbidden_domain", "watched_domain")
            and n.get("related_event_id")
        ]
        if not policy_notifications:
            return

        ids = []
        for n in policy_notifications:
            try:
                ids.append(int(n.get("related_event_id")))
            except (TypeError, ValueError):
                pass
        if not ids:
            return

        placeholders = ",".join(["?"] * len(ids))
        try:
            conn = events_db.connect()
            try:
                rows = conn.execute(
                    "SELECT id, timestamp, client_mac, event_type, detail, "
                    "category, first_seen, last_seen, request_count, "
                    "alert_type, priority FROM events WHERE id IN ({})".format(
                        placeholders
                    ),
                    ids,
                ).fetchall()
            finally:
                conn.close()
        except Exception:
            return

        events_by_id = {}
        for r in rows:
            event = {
                "id": r["id"],
                "timestamp": r["timestamp"],
                "client_mac": r["client_mac"],
                "event_type": r["event_type"],
                "category": r["category"] if "category" in r.keys() else "",
                "first_seen": r["first_seen"] if "first_seen" in r.keys() else "",
                "last_seen": r["last_seen"] if "last_seen" in r.keys() else "",
                "request_count": r["request_count"] if "request_count" in r.keys() else 1,
                "alert_type": r["alert_type"] if "alert_type" in r.keys() else "",
                "priority": r["priority"] if "priority" in r.keys() else "",
            }
            try:
                event["detail"] = json.loads(r["detail"]) if r["detail"] else {}
            except (ValueError, TypeError):
                event["detail"] = {}
            events_by_id[event["id"]] = event

        events = list(events_by_id.values())
        try:
            known_devices = self._enrich_known_devices(events_db.list_known_devices())
            self._enrich_event_clients(events, known_devices)
        except Exception:
            pass

        for n in policy_notifications:
            try:
                event = events_by_id.get(int(n.get("related_event_id")))
            except (TypeError, ValueError):
                event = None
            if not event:
                continue
            detail = event.get("detail") or {}
            alert_type = (event.get("alert_type") or "").upper()
            domain = detail.get("domain") or ""
            matched = detail.get("matched_pattern") or ""
            label = event.get("known_label") or "unknown device"
            hostname = event.get("hostname") or "no hostname"
            client_id = event.get("client_mac") or detail.get("ip") or "unknown"
            if not alert_type or not domain:
                continue
            n["message"] = "{} domain hit: {} ({}) by {} / {} ({})".format(
                alert_type, domain, matched, label, hostname, client_id
            )

    def _get_notifications_unread_count(self):
        """GET /api/notifications/unread-count -- return unread count."""
        if not self.check_session():
            return
        count = auth_db.count_unread_notifications()
        self.send_json({"count": count})

    def _post_notifications_read(self):
        """POST /api/notifications/read -- mark notification(s) as read."""
        if not self.check_session():
            return
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self.send_json({"error": "Invalid JSON"}, 400)
            return
        nid = data.get("id")
        if nid:
            auth_db.mark_notification_read(nid)
        self.send_json({"ok": True})

    def _post_notifications_read_all(self):
        """POST /api/notifications/read-all -- mark all as read."""
        if not self.check_session():
            return
        auth_db.mark_all_notifications_read()
        self.send_json({"ok": True})

    def _post_notifications_delete_read(self):
        """POST /api/notifications/delete-read -- delete read notifications."""
        if not self.check_session():
            return
        deleted = auth_db.delete_read_notifications()
        self.send_json({"ok": True, "deleted": deleted})

    # ------------------------------------------------------------------
    # User management routes (superadmin only)
    # ------------------------------------------------------------------

    def _get_users(self):
        """GET /api/users -- list all users (superadmin only)."""
        if not self.check_session_role("superadmin"):
            return
        users = auth_db.list_users()
        self.send_json(users)

    def _post_create_user(self):
        """POST /api/users -- create a new user (superadmin only)."""
        session = self.check_session_role("superadmin")
        if not session:
            return
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
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        role = data.get("role", "admin")
        if not username or not password:
            self.send_json({"error": "Username and password are required"}, 400)
            return
        try:
            user_id = auth_db.create_user(
                username, password, role=role, created_by=session["user_id"]
            )
            self._audit("create_user", "target:" + username)
            self.send_json({"ok": True, "id": user_id, "username": username, "role": role})
        except ValueError as e:
            self.send_json({"error": str(e)}, 400)
        except Exception:
            self.send_json({"error": "Username already exists"}, 409)

    def _post_delete_user(self):
        """POST /api/users/delete -- delete a user (superadmin only)."""
        session = self.check_session_role("superadmin")
        if not session:
            return
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self.send_json({"error": "Invalid JSON"}, 400)
            return
        user_id = data.get("id")
        if not user_id:
            self.send_json({"error": "User id is required"}, 400)
            return
        # Prevent self-deletion
        if user_id == session["user_id"]:
            self.send_json({"error": "Cannot delete your own account"}, 400)
            return
        # Resolve username before deletion
        target_user = auth_db.get_user_by_id(user_id)
        target_name = target_user.get("username", str(user_id)) if target_user else str(user_id)
        ok, err = auth_db.delete_user(user_id)
        if ok:
            self._audit("delete_user", "target:" + target_name)
            self.send_json({"ok": True})
        else:
            self.send_json({"error": err}, 400)

    def _post_reset_user_password(self):
        """POST /api/users/reset-password -- reset a user's password
        (superadmin only)."""
        session = self.check_session_role("superadmin")
        if not session:
            return
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self.send_json({"error": "Invalid JSON"}, 400)
            return
        user_id = data.get("id")
        new_password = data.get("password")  # optional, generates random if None
        if not user_id:
            self.send_json({"error": "User id is required"}, 400)
            return
        target_user = auth_db.get_user_by_id(user_id)
        target_name = target_user.get("username", str(user_id)) if target_user else str(user_id)
        user, pw = auth_db.reset_user_password(user_id, new_password)
        if user:
            self._audit("reset_password", "target:" + target_name)
            self.send_json({"ok": True, "new_password": pw})
        else:
            self.send_json({"error": pw}, 400)

    def _post_set_user_role(self):
        """POST /api/users/role -- change a user's role (superadmin only)."""
        session = self.check_session_role("superadmin")
        if not session:
            return
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self.send_json({"error": "Invalid JSON"}, 400)
            return
        user_id = data.get("id")
        role = data.get("role")
        if not user_id or not role:
            self.send_json({"error": "User id and role are required"}, 400)
            return
        # Prevent demoting the last superadmin
        if role == "admin":
            target = auth_db.get_user_by_id(user_id)
            if target and target["role"] == "superadmin":
                count_data = auth_db.list_users()
                superadmin_count = sum(1 for u in count_data if u["role"] == "superadmin")
                if superadmin_count <= 1:
                    self.send_json(
                        {"error": "Cannot demote the last superadmin"}, 400
                    )
                    return
        ok, err = auth_db.set_user_role(user_id, role)
        if ok:
            target_user = auth_db.get_user_by_id(user_id)
            target_name = target_user.get("username", str(user_id)) if target_user else str(user_id)
            self._audit("set_role", "target:" + target_name + " -> " + role)
            self.send_json({"ok": True})
        else:
            self.send_json({"error": err}, 400)

    def _get_captive_config(self):
        if not self.check_token():
            return
        config = parse_config()
        active = config.get("CAPTIVE_PORTAL", "false").lower() == "true"
        code = config.get("CAPTIVE_CODE", "")
        msg = config.get("CAPTIVE_MESSAGE", "Welcome to OSHotspot!")
        bg_color = config.get("CAPTIVE_BG_COLOR", "#050505")
        logo_url = config.get("CAPTIVE_LOGO_URL", "")
        if not logo_url:
            if get_logo_path("captive_logo.png"):
                logo_url = "/images/captive_logo.png"

        domain = config.get("CAPTIVE_DOMAIN", "")
        self.send_json({
            "active": active,
            "code": code,
            "code_set": bool(code),
            "message": msg,
            "domain": domain,
            "bg_color": bg_color,
            "logo_url": logo_url,
        })

    def _resolve_mac_info(self, macs):
        info_map = {}
        lease_paths = [
            "/run/oshotspot-dnsmasq.leases",
            "/var/lib/misc/dnsmasq.leases",
            "/var/lib/dnsmasq/dnsmasq.leases",
        ]
        for p in lease_paths:
            if os.path.isfile(p):
                try:
                    with open(p, "r", errors="replace") as f:
                        for line in f:
                            parts = line.split()
                            if len(parts) >= 4:
                                m, ip, host = parts[1].lower(), parts[2], parts[3]
                                if host == "*":
                                    host = ""
                                info_map[m] = {"mac": m, "hostname": host, "ip": ip}
                except Exception:
                    pass

        if events_db is not None:
            try:
                known_list = events_db.list_known_devices()
                for d in known_list:
                    m = (d.get("mac") or "").lower()
                    if m:
                        if m not in info_map:
                            info_map[m] = {"mac": m, "hostname": d.get("hostname") or "", "ip": d.get("ip") or ""}
                        elif not info_map[m].get("hostname") and d.get("hostname"):
                            info_map[m]["hostname"] = d["hostname"]
            except Exception:
                pass

        res = []
        for mac in macs:
            m_lower = mac.lower()
            if m_lower in info_map:
                res.append(info_map[m_lower])
            else:
                res.append({"mac": mac, "hostname": "", "ip": ""})
        return res

    def _get_captive_clients(self):
        if not self.check_token():
            return
        if captive is not None:
            macs = list(captive.get_authenticated_macs())
        else:
            macs = []
        clients = self._resolve_mac_info(macs)
        self.send_json(clients)

    def _post_captive_revoke(self):
        if not self.check_token():
            return
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length else b"{}"
        try:
            data = json.loads(body)
        except Exception:
            data = {}
        mac = (data.get("mac") or "").strip()
        if not mac:
            self.send_json({"error": "MAC required"}, 400)
            return
        if captive is not None:
            ok = captive.revoke_authenticated_mac(mac)
        else:
            ok = False
        self.send_json({"ok": ok, "mac": mac})

    def _post_captive_logo(self):
        if not self.check_token():
            return
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length else b"{}"
        try:
            data = json.loads(body)
        except Exception:
            data = {}

        action = data.get("action")
        if action == "remove":
            remove_persistent_logo("captive_logo.png")
            write_config({"CAPTIVE_LOGO_URL": ""})
            self.send_json({"ok": True, "logo_url": ""})
            return

        logo_b64 = data.get("logo_base64") or ""
        if logo_b64 and "," in logo_b64:
            logo_b64 = logo_b64.split(",", 1)[1]

        if logo_b64:
            try:
                import base64
                img_data = base64.b64decode(logo_b64)
                save_persistent_logo("captive_logo.png", img_data)
                write_config({"CAPTIVE_LOGO_URL": "/images/captive_logo.png"})
                self.send_json({"ok": True, "logo_url": "/images/captive_logo.png"})
                return
            except Exception as e:
                self.send_json({"error": f"Failed to save logo: {str(e)}"}, 500)
                return

        self.send_json({"error": "No logo provided"}, 400)

    def _get_captive_codes(self):
        if not self.check_token():
            return
        cfg = parse_config()
        permanent_code = cfg.get("CAPTIVE_CODE", "")
        lease_hours = int(cfg.get("CAPTIVE_LEASE_HOURS", "0") or 0)
        temp_codes = captive.load_captive_codes()

        bound_macs = [c["bound_mac"].lower() for c in temp_codes if c.get("bound_mac")]
        mac_info_map = {}
        if bound_macs and captive is not None:
            try:
                for info in self._resolve_mac_info(bound_macs):
                    mac_info_map[info["mac"].lower()] = info
            except Exception:
                pass

        now = time.time()
        formatted = []
        for c in temp_codes:
            if c.get("status") != "active":
                continue
            bm = (c.get("bound_mac") or "").lower()
            info = mac_info_map.get(bm, {})
            try:
                expires_ts = datetime.fromisoformat(c.get("expires_at", "")).timestamp() if c.get("expires_at") else 0
            except Exception:
                expires_ts = 0
            formatted.append({
                "id": c.get("id", ""),
                "code": c.get("code", ""),
                "duration_hours": c.get("duration_hours", 0),
                "label": c.get("label", ""),
                "status": c.get("status", "active"),
                "bound_mac": bm,
                "bound_hostname": info.get("hostname", ""),
                "bound_ip": info.get("ip", ""),
                "activated_at": c.get("activated_at", ""),
                "expires_at": c.get("expires_at", ""),
                "remaining_seconds": max(0, int(expires_ts - now)) if expires_ts else None,
            })

        self.send_json({
            "permanent_code": permanent_code,
            "permanent_active": bool(permanent_code),
            "lease_hours": lease_hours,
            "temporary_codes": formatted,
        })

    def _post_captive_code_create(self):
        if not self.check_token():
            return
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length else b"{}"
        try:
            data = json.loads(body)
        except Exception:
            data = {}

        code = (data.get("code") or "").strip()
        try:
            duration_hours = float(data.get("duration_hours") or 0)
        except Exception:
            self.send_json({"error": "Invalid duration"}, 400)
            return
        label = (data.get("label") or "").strip()

        if not code:
            self.send_json({"error": "Code is required"}, 400)
            return
        if duration_hours <= 0:
            self.send_json({"error": "Duration must be greater than 0"}, 400)
            return

        codes = captive.load_captive_codes()
        if any(c.get("code") == code for c in codes if c.get("status") == "active"):
            self.send_json({"error": "Code already exists"}, 400)
            return

        now = time.time()
        new_code = {
            "id": str(int(now * 1000)),
            "code": code,
            "duration_hours": duration_hours,
            "label": label,
            "created_at": datetime.fromtimestamp(now).isoformat(),
            "activated_at": None,
            "expires_at": None,
            "bound_mac": None,
            "status": "active",
        }
        codes.append(new_code)
        if not captive.save_captive_codes(codes):
            self.send_json({"error": "Failed to persist code, check /etc/oshotspot permissions"}, 500)
            return

        self.send_json({"ok": True, "code": new_code})

    def _post_captive_code_generate(self):
        if not self.check_token():
            return
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length else b"{}"
        try:
            data = json.loads(body)
        except Exception:
            data = {}

        try:
            count = int(data.get("count") or 10)
            length = int(data.get("length") or 8)
            duration_hours = float(data.get("duration_hours") or 24)
        except Exception:
            self.send_json({"error": "Invalid numerical parameters"}, 400)
            return

        label = (data.get("label") or "").strip()
        prefix = (data.get("prefix") or "").strip().upper()

        if count < 1 or count > 50:
            self.send_json({"error": "Count must be between 1 and 50"}, 400)
            return
        if length < 4 or length > 12:
            self.send_json({"error": "Length must be between 4 and 12"}, 400)
            return
        if duration_hours <= 0:
            self.send_json({"error": "Duration must be greater than 0"}, 400)
            return

        import secrets
        alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        codes = captive.load_captive_codes()
        existing = {c.get("code") for c in codes if c.get("status") == "active"}

        now = time.time()
        created = []

        for i in range(count):
            attempts = 0
            while attempts < 100:
                attempts += 1
                random_str = "".join(secrets.choice(alphabet) for _ in range(length))
                code_val = (prefix + random_str) if prefix else random_str
                if code_val not in existing:
                    existing.add(code_val)
                    new_code = {
                        "id": str(int(now * 1000) + i),
                        "code": code_val,
                        "duration_hours": duration_hours,
                        "label": label,
                        "created_at": datetime.fromtimestamp(now).isoformat(),
                        "activated_at": None,
                        "expires_at": None,
                        "bound_mac": None,
                        "status": "active",
                    }
                    created.append(new_code)
                    codes.append(new_code)
                    break

        if not captive.save_captive_codes(codes):
            self.send_json({"error": "Failed to persist codes, check /etc/oshotspot permissions"}, 500)
            return

        self.send_json({"ok": True, "count": len(created), "codes": created})

    def _post_captive_code_revoke(self):
        if not self.check_token():
            return
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length else b"{}"
        try:
            data = json.loads(body)
        except Exception:
            data = {}

        code_id = (data.get("id") or "").strip()
        if not code_id:
            self.send_json({"error": "Code id is required"}, 400)
            return

        codes = captive.load_captive_codes()
        found = None
        for c in codes:
            if c.get("id") == code_id:
                found = c
                break

        if not found:
            self.send_json({"error": "Code not found"}, 404)
            return

        if found.get("status") == "revoked":
            self.send_json({"ok": True, "code": found})
            return

        codes = [c for c in codes if c.get("id") != code_id]
        if not captive.save_captive_codes(codes):
            self.send_json({"error": "Failed to persist revoke, check /etc/oshotspot permissions"}, 500)
            return

        mac = (found.get("bound_mac") or "").lower()
        if mac and captive is not None:
            captive.revoke_authenticated_mac(mac)

        # Clear matching active session if present
        try:
            sessions = captive.load_sessions()
            active_sessions = [s for s in sessions if s.get("code_id") != code_id and (not mac or s.get("mac", "").lower() != mac)]
            if len(active_sessions) != len(sessions):
                captive.save_sessions(active_sessions)
        except Exception:
            pass

        self.send_json({"ok": True})

    def _get_captive_codes_export_pdf(self):
        if not self.check_token():
            return
        cfg = parse_config()
        ssid = cfg.get("SSID", "Hotspot")
        ap_ip = cfg.get("AP_IP", "192.168.50.1").strip() or "192.168.50.1"
        bg_color = cfg.get("CAPTIVE_BG_COLOR", "#4F46E5").strip() or "#4F46E5"
        try:
            pdf = _build_captive_codes_pdf(
                ssid,
                [
                    {
                        "code": c.get("code", ""),
                        "duration_hours": c.get("duration_hours", 0),
                        "expires_at": c.get("expires_at", ""),
                        "label": c.get("label", ""),
                    }
                    for c in captive.load_captive_codes()
                    if c.get("status") == "active" and not c.get("bound_mac")
                ],
                time.time(),
                bg_color=bg_color,
                ap_ip=ap_ip,
            )
        except RuntimeError as exc:
            self.send_json({"error": str(exc)}, 500)
            return

        pdf_bytes = pdf.output()
        filename = "oshotspot-code-" + date.fromtimestamp(time.time()).isoformat() + ".pdf"
        body = bytes(pdf_bytes)
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Disposition", "attachment; filename=" + filename)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        try:
            self.wfile.write(body)
            self.wfile.flush()
        except BrokenPipeError:
            pass

    def _post_app_logo(self):
        if not self.check_token():
            return
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length else b"{}"
        try:
            data = json.loads(body)
        except Exception:
            data = {}

        action = data.get("action")
        if action == "remove":
            remove_persistent_logo("app_logo.png")
            write_config({"ADMIN_LOGO_URL": ""})
            self.send_json({"ok": True, "logo_url": ""})
            return

        logo_b64 = data.get("logo_base64") or ""
        if logo_b64 and "," in logo_b64:
            logo_b64 = logo_b64.split(",", 1)[1]

        if logo_b64:
            try:
                import base64
                img_data = base64.b64decode(logo_b64)
                save_persistent_logo("app_logo.png", img_data)
                write_config({"ADMIN_LOGO_URL": "/images/app_logo.png"})
                self.send_json({"ok": True, "logo_url": "/images/app_logo.png"})
                return
            except Exception as e:
                self.send_json({"error": f"Failed to save app logo: {str(e)}"}, 500)
                return

        self.send_json({"error": "No logo provided"}, 400)

    def _post_mail_test(self):
        """POST /api/mail/test -- send a test email to verify the
        email alert configuration.  Reads SMTP settings from config.conf."""
        if not self.check_token():
            return
        try:
            from events import alert as email_alert
        except ImportError:
            self.send_json({"error": "Alert module not available"}, 500)
            return
        cfg = email_alert.load_config()
        if not email_alert.email_enabled(cfg):
            self.send_json({"error": "Email alerts are not enabled. Enable them first."}, 400)
            return
        to = str(cfg.get("ALERT_EMAIL_TO", "")).strip()
        if not to:
            self.send_json({"error": "No recipient configured. Set ALERT_EMAIL_TO first."}, 400)
            return
        sys_info = email_alert._get_system_info(cfg)
        hostname = sys_info.get("hostname", "oshotspot")
        subject = "[OSHotspot @ {}] Email Alert Notification System Operational".format(hostname)
        plain = email_alert._build_test_plain_body(cfg, sys_info)
        logo_uri = "cid:oshotspot_logo"
        html = email_alert._build_test_email_html(cfg, sys_info, logo_uri)
        ok = email_alert._send_email(cfg, subject, plain, html, sys_info=sys_info)
        log_action("web:mail_test")
        self._audit("mail_test")
        if ok:
            self.send_json({"ok": True, "message": "Test email sent to {}".format(to), "hostname": hostname})
        else:
            mode = cfg.get("ALERT_EMAIL_SMTP_MODE", "msmtp")
            hint = ""
            if mode == "msmtp":
                hint = " Run 'sudo oshotspot setup-mail' to configure msmtp first."
            self.send_json({"ok": False, "error": "Failed to send test email. Check SMTP configuration." + hint}, 500)

    def _get_mail_preview(self):
        """GET /api/mail/preview?type=alert|test -- preview email rendering HTML."""
        if not self.check_token():
            return
        try:
            from events import alert as email_alert
        except ImportError:
            self.send_json({"error": "Alert module not available"}, 500)
            return

        cfg = email_alert.load_config()
        sys_info = email_alert._get_system_info(cfg)
        logo_uri = email_alert._get_logo_data_uri()

        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        preview_type = (qs.get("type", ["alert"])[0]).lower()

        if preview_type == "test":
            html = email_alert._build_test_email_html(cfg, sys_info, logo_uri)
        else:
            now_iso = time.strftime("%Y-%m-%d %H:%M:%S")
            mock_alerts = [
                {
                    "level": "ALERT",
                    "message": "Forbidden domain match: example-social.com (social) for client 192.168.50.42",
                    "extra": {
                        "client_mac": "AA:BB:CC:DD:EE:01",
                        "client_ip": "192.168.50.42",
                        "client_hostname": "Phone-Demo",
                        "known_label": "Demo Device",
                        "domain": "example-social.com",
                        "matched_pattern": "*.example-social.com",
                        "rule_type": "FORBIDDEN",
                        "category": "forbidden_domain",
                    },
                    "timestamp": now_iso,
                    "category": "forbidden_domain",
                },
                {
                    "level": "ALERT",
                    "message": "DNS query flood from client 192.168.50.88 (>50 queries in 5s)",
                    "extra": {
                        "client_mac": "AA:BB:CC:DD:EE:02",
                        "client_ip": "192.168.50.88",
                        "client_hostname": "Laptop-Demo",
                        "known_label": "Demo PC",
                        "query_count": 142,
                        "threshold": 50,
                        "window": 5,
                        "category": "dns_flood",
                    },
                    "timestamp": now_iso,
                    "category": "dns_flood",
                },
                {
                    "level": "ALERT",
                    "message": "Unknown device joined the hotspot: AA:BB:CC:DD:EE:03 (Tablet-Guest)",
                    "extra": {
                        "client_mac": "AA:BB:CC:DD:EE:03",
                        "client_ip": "192.168.50.105",
                        "client_hostname": "Tablet-Guest",
                        "known_label": "unknown device",
                        "category": "unknown_device",
                    },
                    "timestamp": now_iso,
                    "category": "unknown_device",
                },
            ]
            html = email_alert._build_html_body(mock_alerts, logo_uri, sys_info, cfg=cfg)

        if "cid:oshotspot_logo" in html:
            html = html.replace("cid:oshotspot_logo", logo_uri)

        data = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.end_headers()
        self.wfile.write(data)

    def _get_span_config(self):
        if not self.check_token():
            return
        config = parse_config()
        self.send_json({
            "enabled": config.get("SPAN_ENABLED", "false").lower() == "true",
            "interface": config.get("SPAN_INTERFACE", ""),
        })

    def _get_span_interfaces(self):
        if not self.check_token():
            return
        interfaces = []
        sys_net = "/sys/class/net"
        try:
            if os.path.isdir(sys_net):
                for name in os.listdir(sys_net):
                    if name in ("lo", "ap0"):
                        continue
                    state = "unknown"
                    try:
                        with open(os.path.join(sys_net, name, "operstate")) as f:
                            state = f.read().strip()
                    except Exception:
                        pass
                    mac = ""
                    try:
                        with open(os.path.join(sys_net, name, "address")) as f:
                            mac = f.read().strip()
                    except Exception:
                        pass
                    interfaces.append({"name": name, "state": state, "mac": mac})
        except Exception:
            pass
        self.send_json({"interfaces": interfaces})

    def _get_span_anomalies(self):
        if not self.check_token():
            return
        from events import live_bus
        anomalies = live_bus.query_span_anomalies(limit=100)
        self.send_json({"anomalies": anomalies})

    def _get_wifi_info(self):
        if not self.check_token():
            return
        config = parse_config()
        wifi_iface = config.get("WIFI_IFACE", "")
        channel = config.get("CHANNEL", "6")
        hw_mode = config.get("HW_MODE", "g")

        # Read wireless link status if available
        signal = 0
        link_ssid = ""
        try:
            if wifi_iface and os.path.isfile("/proc/net/wireless"):
                with open("/proc/net/wireless", "r") as f:
                    for line in f.readlines()[2:]:
                        parts = line.split(":")
                        if len(parts) >= 2 and parts[0].strip() == wifi_iface:
                            fields = parts[1].split()
                            signal = float(fields[2].replace(".", "")) if len(fields) > 2 else 0
        except Exception:
            pass

        self.send_json({
            "wifi_iface": wifi_iface,
            "channel": channel,
            "hw_mode": hw_mode,
            "signal": signal,
            "ap_iface": config.get("AP_IFACE", "ap0"),
        })

    # --- Audit log ---

    def _get_audit_log(self, parsed):
        """GET /api/audit-log -- query audit entries (superadmin or
        can_view_audit=1)."""
        session = self.check_session_audit()
        if not session:
            return
        params = urllib.parse.parse_qs(parsed.query)
        limit = min(int(params.get("limit", [50])[0]), 200)
        offset = int(params.get("offset", [0])[0])
        user = params.get("user", [None])[0]
        action = params.get("action", [None])[0]
        date_from = params.get("from", [None])[0]
        date_to = params.get("to", [None])[0]
        entries, total = auth_db.get_audit_log(
            limit=limit, offset=offset, user=user,
            action=action, date_from=date_from, date_to=date_to,
        )
        self.send_json({"entries": entries, "total": total})

    def _post_delete_audit(self):
        """POST /api/audit-log/delete -- delete audit entries (superadmin
        only).  Body: {ids: [1, 2, 3]}."""
        session = self.check_session_role("superadmin")
        if not session:
            return
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self.send_json({"error": "Invalid JSON"}, 400)
            return
        ids = data.get("ids", [])
        if not ids:
            self.send_json({"error": "ids list is required"}, 400)
            return
        deleted = auth_db.delete_audit_entries(ids)
        self._audit("audit_delete", "count:" + str(deleted))
        self.send_json({"ok": True, "deleted": deleted})

    def _post_set_audit_access(self):
        """POST /api/users/audit-access -- toggle audit page access for a
        user (superadmin only).  Body: {user_id: N, enabled: true/false}."""
        session = self.check_session_role("superadmin")
        if not session:
            return
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self.send_json({"error": "Invalid JSON"}, 400)
            return
        user_id = data.get("user_id")
        enabled = data.get("enabled")
        if user_id is None or enabled is None:
            self.send_json({"error": "user_id and enabled are required"}, 400)
            return
        ok, err = auth_db.set_can_view_audit(user_id, enabled)
        if ok:
            target_user = auth_db.get_user_by_id(user_id)
            target_name = target_user.get("username", str(user_id)) if target_user else str(user_id)
            state = "on" if enabled else "off"
            self._audit("audit_access", "target:" + target_name + " -> " + state)
            self.send_json({"ok": True})
        else:
            self.send_json({"error": err}, 400)

    # --- VPN (Tailscale) ---

    def _get_vpn_status(self):
        """GET /api/vpn/status, return Tailscale VPN status."""
        if not self.check_token():
            return
        try:
            from . import vpn as vpn_module
            status = vpn_module.vpn.status()
            self.send_json(status)
        except Exception as exc:
            self.send_json({"error": str(exc)}, 500)

    def _post_vpn_start(self):
        """POST /api/vpn/start, start Tailscale."""
        if not self.check_token():
            return
        try:
            from . import vpn as vpn_module
            result = vpn_module.vpn.start()
            log_action("web:vpn_start")
            self._audit("vpn_start")
            self.send_json(result)
        except Exception as exc:
            self.send_json({"ok": False, "error": str(exc)}, 500)

    def _post_vpn_stop(self):
        """POST /api/vpn/stop, stop Tailscale."""
        if not self.check_token():
            return
        try:
            from . import vpn as vpn_module
            ok = vpn_module.vpn.stop()
            log_action("web:vpn_stop")
            self._audit("vpn_stop")
            self.send_json({"ok": ok})
        except Exception as exc:
            self.send_json({"ok": False, "error": str(exc)}, 500)

    def _post_vpn_restart(self):
        """POST /api/vpn/restart, restart Tailscale."""
        if not self.check_token():
            return
        try:
            from . import vpn as vpn_module
            result = vpn_module.vpn.restart()
            log_action("web:vpn_restart")
            self._audit("vpn_restart")
            self.send_json(result)
        except Exception as exc:
            self.send_json({"ok": False, "error": str(exc)}, 500)
