#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

"""Alerting for OSHotspot events.

Every alert is always recorded as a clearly flagged entry in the events
log (/var/log/oshotspot/events.log).  If email is enabled in
/etc/oshotspot/config.conf, a short message is also emailed.

Two SMTP modes are supported:

  msmtp (recommended), sends via the local ``sendmail`` command
    (msmtp as MTA).  SMTP auth/TLS are handled by msmtp, OSHotspot
    never sees the password.

  direct, connects to an external SMTP server using Python's smtplib.
    Requires SMTP_HOST, SMTP_PORT, and optionally USERNAME/PASSWORD
    in config.conf.

Email alerts are buffered into digests: up to 10 alerts or 60 seconds,
whichever comes first, to avoid inbox flooding.  HTML emails include the
dashboard logo when available.

Email is optional and disabled by default.  Any failure here, missing
mail host, no network, bad credentials, is swallowed so the event
collector never crashes because of a mail server hiccup.
"""

import base64
import os
import re
import smtplib
import socket
import subprocess
import threading
import time
from email.message import EmailMessage
from html import escape as _h

EVENTS_LOG = os.environ.get("OSHOTSPOT_EVENTS_LOG", "/var/log/oshotspot/events.log")
CONFIG_FILE = os.environ.get("OSHOTSPOT_CONFIG_FILE", "/etc/oshotspot/config.conf")

# Digest buffering: batch alerts to avoid inbox flooding
_DIGEST_MAX = 10          # flush immediately when buffer reaches this size
_DIGEST_TIMEOUT = 60      # seconds, flush after this even if fewer alerts
_MAX_LOGO_BYTES = 100 * 1024  # skip logo embedding if file exceeds this

DEFAULTS = {
    "ALERT_EMAIL_ENABLED": "false",
    "ALERT_EMAIL_SMTP_MODE": "msmtp",
    "ALERT_EMAIL_TO": "",
    "ALERT_EMAIL_FROM": "",
    "ALERT_EMAIL_SMTP_HOST": "",
    "ALERT_EMAIL_SMTP_PORT": "587",
    "ALERT_EMAIL_USERNAME": "",
    "ALERT_EMAIL_PASSWORD": "",
    "ALERT_EMAIL_TEMPLATE": "",
    "ALERT_EMAIL_CATEGORIES": "forbidden_domain,unknown_device,admin_lockout,critical_service",
}

CATEGORY_ALIASES = {
    "forbidden": "forbidden_domain",
    "forbidden_domain": "forbidden_domain",
    "unknown_device": "unknown_device",
    "unknown_client": "unknown_device",
    "rogue_device": "unknown_device",
    "admin_lockout": "admin_lockout",
    "lockout": "admin_lockout",
    "brute_force": "admin_lockout",
    "critical_service": "critical_service",
    "service": "critical_service",
    "service_failure": "critical_service",
    "watched": "watched_domain",
    "watched_domain": "watched_domain",
    "dns_flood": "dns_flood",
    "flood": "dns_flood",
}


def _normalize_category(cat):
    """Return canonical category name."""
    if not cat:
        return "security_alert"
    c = str(cat).strip().lower()
    return CATEGORY_ALIASES.get(c, c)


def get_enabled_categories(cfg=None):
    """Return set of normalized enabled category strings."""
    if cfg is None:
        cfg = load_config()
    raw = cfg.get("ALERT_EMAIL_CATEGORIES")
    if raw is None:
        raw = cfg.get("alert_email_categories")
    if raw is None or str(raw).strip() == "":
        raw = DEFAULTS.get("ALERT_EMAIL_CATEGORIES", "")
    enabled_set = set()
    for item in str(raw).split(","):
        normalized = _normalize_category(item)
        if normalized:
            enabled_set.add(normalized)
    return enabled_set


def is_category_enabled_for_email(category, cfg=None):
    """Check if the category is enabled for email dispatch."""
    enabled_set = get_enabled_categories(cfg)
    target = _normalize_category(category)
    return target in enabled_set

# ---------------------------------------------------------------------------
# Digest buffer state (module-level, shared across the tailer process)
# ---------------------------------------------------------------------------
_alert_buffer = []        # list of alert dicts or (level, message) tuples
_alert_timer = None       # threading.Timer for flush
_timer_lock = threading.Lock()


def load_config(path=None):
    """Read the alerting subset of config.conf (KEY="value" format)."""
    cfg = dict(DEFAULTS)
    try:
        with open(path or CONFIG_FILE, "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                m = re.match(r'^([A-Z_]+)\s*=\s*"?([^"]*)"?$', line)
                if m and m.group(1) in cfg:
                    cfg[m.group(1)] = m.group(2)
    except OSError:
        pass
    return cfg


def _read_raw_key(key, path=None):
    """Read an arbitrary uppercase key from config.conf (not in DEFAULTS)."""
    try:
        with open(path or CONFIG_FILE, "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                m = re.match(r'^([A-Z_]+)\s*=\s*"?([^"]*)"?$', line)
                if m and m.group(1) == key:
                    return m.group(2)
    except OSError:
        pass
    return ""


def _get_system_info(cfg=None):
    """Extract gateway and system identification for email headers and footers."""
    raw_hostname = _read_raw_key("HOSTNAME")
    if not raw_hostname:
        try:
            raw_hostname = socket.gethostname()
        except Exception:
            raw_hostname = "oshotspot"
    hostname = raw_hostname.strip() or "oshotspot"

    ap_ip = _read_raw_key("AP_IP").strip() or "192.168.50.1"
    ssid = _read_raw_key("SSID").strip() or "OSHotspot"
    ap_iface = _read_raw_key("AP_IFACE").strip() or "ap0"
    dashboard_port = _read_raw_key("DASHBOARD_PORT").strip() or "8073"

    custom_url = _read_raw_key("ADMIN_DASHBOARD_URL").strip()
    if custom_url:
        admin_url = custom_url
    else:
        admin_url = "http://{}:{}".format(ap_ip, dashboard_port)

    version = "5.1"
    v_path = os.path.join(os.path.dirname(__file__), "..", "VERSION")
    try:
        if os.path.isfile(v_path):
            with open(v_path, "r") as f:
                v = f.read().strip()
                if v:
                    version = v
    except Exception:
        pass

    return {
        "hostname": hostname,
        "ap_ip": ap_ip,
        "ssid": ssid,
        "ap_iface": ap_iface,
        "dashboard_port": dashboard_port,
        "admin_url": admin_url,
        "version": version,
    }


def log_line(level, message):
    """Append one flagged entry to the events log. Failures are non-fatal."""
    try:
        os.makedirs(os.path.dirname(EVENTS_LOG), exist_ok=True)
        with open(EVENTS_LOG, "a") as f:
            f.write("[{}] {} {}\n".format(
                level, time.strftime("%Y-%m-%d %H:%M:%S"), message
            ))
    except OSError:
        pass


def email_enabled(cfg):
    return str(cfg.get("ALERT_EMAIL_ENABLED", "false")).strip().lower() == "true"


# ---------------------------------------------------------------------------
# Logo helpers
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Logo helpers
# ---------------------------------------------------------------------------

def _get_logo_file_info(cfg=None):
    """Locate logo image file on disk or HTTP URL."""
    logo_cfg = _read_raw_key("ADMIN_LOGO_URL").strip()
    if logo_cfg.startswith("http://") or logo_cfg.startswith("https://"):
        return logo_cfg, "image/png", False

    candidate_paths = []
    if logo_cfg:
        if logo_cfg.startswith("/"):
            candidate_paths.append(logo_cfg)
            filename = os.path.basename(logo_cfg)
            candidate_paths.extend([
                os.path.join("/var/lib/oshotspot/images", filename),
                os.path.join("/etc/oshotspot/images", filename),
                os.path.join(os.path.dirname(__file__), "..", "web", "static", "images", filename),
            ])
        else:
            candidate_paths.extend([
                os.path.join("/var/lib/oshotspot/images", logo_cfg),
                os.path.join("/etc/oshotspot/images", logo_cfg),
                os.path.join(os.path.dirname(__file__), "..", "web", "static", "images", logo_cfg),
            ])

    # Custom uploaded app_logo
    candidate_paths.extend([
        "/var/lib/oshotspot/images/app_logo.png",
        "/etc/oshotspot/images/app_logo.png",
        os.path.join(os.path.dirname(__file__), "..", "web", "static", "images", "app_logo.png"),
    ])

    # Real shipped default OSHotspot PNG logo files
    candidate_paths.extend([
        os.path.join(os.path.dirname(__file__), "..", "web", "static", "images", "default-logo.png"),
        "/var/lib/oshotspot/images/default-logo.png",
        "/etc/oshotspot/images/default-logo.png",
        os.path.join(os.path.dirname(__file__), "..", "public", "OSHotspot-icon", "icon-logo.png"),
        os.path.join(os.path.dirname(__file__), "..", "web", "static", "images", "default-icon.svg"),
    ])

    mime_map = {
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "gif": "image/gif", "svg": "image/svg+xml", "webp": "image/webp",
    }

    for path in candidate_paths:
        try:
            if os.path.isfile(path) and os.path.getsize(path) <= _MAX_LOGO_BYTES:
                ext = path.rsplit(".", 1)[-1].lower()
                mime = mime_map.get(ext, "image/png")
                return path, mime, True
        except Exception:
            continue

    return "", "image/png", False


def _get_logo_data_uri():
    """Return a base64 data: URI for web dashboard preview."""
    path_or_url, mime, is_file = _get_logo_file_info()
    if not is_file or not path_or_url:
        if path_or_url:
            return path_or_url
        return ""
    try:
        with open(path_or_url, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")
            return "data:{};base64,{}".format(mime, b64)
    except Exception:
        return ""


def _format_extra(extra):
    """Turn a dict/list extra payload into clean key: value lines."""
    if isinstance(extra, dict):
        return "\n".join("{}: {}".format(k, v) for k, v in extra.items())
    if isinstance(extra, list):
        return "\n".join(str(i) for i in extra)
    return str(extra)


def _detect_category(message, extra=None):
    """Infer event category for badge styling and icon rendering."""
    msg_l = str(message or "").lower()
    if isinstance(extra, dict):
        cat = extra.get("category") or extra.get("alert_type") or extra.get("event_type")
        if cat:
            cat = str(cat).lower()
            if "forbidden" in cat:
                return "forbidden_domain"
            if "watched" in cat:
                return "watched_domain"
            if "flood" in cat:
                return "dns_flood"
            if "unknown_device" in cat or "unknown_client" in cat:
                return "unknown_device"
            if "lockout" in cat or "brute" in cat:
                return "admin_lockout"
            if "critical_service" in cat or "service" in cat:
                return "critical_service"
            return _normalize_category(cat)

    if "forbidden domain" in msg_l:
        return "forbidden_domain"
    if "watched domain" in msg_l:
        return "watched_domain"
    if "flood" in msg_l:
        return "dns_flood"
    if "unknown device" in msg_l or "unregistered device" in msg_l:
        return "unknown_device"
    if "lockout" in msg_l or "brute force" in msg_l or "banned" in msg_l:
        return "admin_lockout"
    if "critical service" in msg_l or ("service" in msg_l and ("fail" in msg_l or "crash" in msg_l)):
        return "critical_service"
    if "test email" in msg_l:
        return "test_email"
    return "security_alert"


def _normalize_alert(item):
    """Normalize alerts into a standard dictionary structure."""
    if isinstance(item, dict):
        level = item.get("level", "ALERT")
        message = item.get("message", "")
        extra = item.get("extra") if isinstance(item.get("extra"), dict) else {}
        ts = item.get("timestamp") or time.strftime("%Y-%m-%d %H:%M:%S")
        cat = item.get("category") or _detect_category(message, extra)
        return {
            "level": level,
            "message": message,
            "extra": extra,
            "raw_extra": item.get("raw_extra"),
            "timestamp": ts,
            "category": cat,
        }
    if isinstance(item, (tuple, list)):
        level = item[0] if len(item) > 0 else "ALERT"
        msg = item[1] if len(item) > 1 else ""
        extra = item[2] if len(item) > 2 and isinstance(item[2], dict) else {}
        ts = item[3] if len(item) > 3 else time.strftime("%Y-%m-%d %H:%M:%S")
        cat = item[4] if len(item) > 4 else None
        return {
            "level": level,
            "message": msg,
            "extra": extra,
            "raw_extra": None,
            "timestamp": ts,
            "category": cat or _detect_category(msg, extra),
        }
    return {
        "level": "ALERT",
        "message": str(item),
        "extra": {},
        "raw_extra": None,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "category": "security_alert",
    }


# ---------------------------------------------------------------------------
# HTML email builder
# ---------------------------------------------------------------------------

def _render_default_logo_svg():
    """Return the real OSHotspot application icon SVG."""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="36" height="36" style="vertical-align:middle;flex-shrink:0;">'
        '<path fill="#FF0000" d="M118 45 C82 45 55 74 55 111 V401 C55 439 84 467 119 467 C132 467 145 463 157 456 L448 287 C480 268 480 225 448 206 L157 56 C145 49 132 45 118 45Z"/>'
        '<path fill="#FFFFFF" d="M121 75 C101 75 82 91 82 113 V399 C82 422 102 438 122 438 C130 438 137 436 145 431 L421 271 C441 259 441 234 421 222 L145 82 C137 77 130 75 121 75Z"/>'
        '<path fill="#000000" d="M123 103 C113 103 107 111 107 122 V390 C107 401 114 409 124 409 C128 409 132 408 136 405 L399 254 C410 248 410 239 399 233 L136 107 C132 104 128 103 123 103Z"/>'
        '<circle cx="225" cy="256" r="78" fill="#FFFFFF"/>'
        '<circle cx="225" cy="256" r="48" fill="#000000"/>'
        '</svg>'
    )


def _render_brand_header(logo_uri="cid:oshotspot_logo"):
    """Render the dashboard-style brand header with logo beside OSHotspot title."""
    if not logo_uri:
        logo_uri = "cid:oshotspot_logo"

    if logo_uri.startswith("<svg"):
        logo_html = logo_uri
    else:
        logo_html = (
            '<img src="{}" alt="OSHotspot Logo" width="38" height="38" style="height:38px;width:38px;max-width:38px;object-fit:contain;border-radius:6px;vertical-align:middle;display:block;border:0;">'
            .format(logo_uri)
        )

    return (
        '<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:0 auto 24px auto;border-collapse:collapse;">'
        '<tr>'
        '<td style="vertical-align:middle;padding-right:12px;">'
        '{}'
        '</td>'
        '<td style="vertical-align:middle;text-align:left;line-height:1.25;">'
        '<div style="font-family:\'Inter\',-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;font-size:19px;font-weight:800;letter-spacing:-0.4px;color:#000000;">OSHotspot</div>'
        '<div style="font-family:\'Inter\',-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;font-size:11px;font-weight:600;color:#777777;letter-spacing:0.5px;text-transform:uppercase;">Control Center</div>'
        '</td>'
        '</tr>'
        '</table>'
    ).format(logo_html)


def _load_custom_template_raw(cfg=None):
    """Attempt to load a custom HTML email template file if configured or present."""
    template_path = ""
    if cfg and cfg.get("ALERT_EMAIL_TEMPLATE"):
        template_path = str(cfg.get("ALERT_EMAIL_TEMPLATE")).strip()
    if not template_path:
        template_path = _read_raw_key("ALERT_EMAIL_TEMPLATE").strip()

    candidate_paths = []
    if template_path:
        candidate_paths.append(template_path)

    candidate_paths.extend([
        "/etc/oshotspot/email_template.html",
        "/etc/oshotspot/alert_template.html",
        "/var/lib/oshotspot/templates/email_template.html",
        "/var/lib/oshotspot/templates/alert_template.html",
    ])

    for path in candidate_paths:
        try:
            if path and os.path.isfile(path):
                with open(path, "r", encoding="utf-8") as f:
                    content = f.read().strip()
                    if content:
                        return content, path
        except Exception:
            continue
    return "", ""


def _build_html_body(alerts, logo_uri="", sys_info=None, cfg=None):
    """Build a modern HTML email body matching the dashboard's light theme (or render custom template if set)."""
    if sys_info is None:
        sys_info = _get_system_info(cfg)

    hostname = sys_info.get("hostname", "oshotspot")
    ap_ip = sys_info.get("ap_ip", "192.168.50.1")
    ssid = sys_info.get("ssid", "OSHotspot")
    admin_url = sys_info.get("admin_url", "http://{}:8073".format(ap_ip))
    version = sys_info.get("version", "5.1")
    now = time.strftime("%Y-%m-%d %H:%M:%S")

    normalized_alerts = [_normalize_alert(a) for a in alerts]
    count = len(normalized_alerts)
    plural = "s" if count != 1 else ""

    # Count breakdown
    crit_count = sum(1 for a in normalized_alerts if a["category"] in ("forbidden_domain", "admin_lockout", "critical_service", "dns_flood") or a["level"] in ("ALERT", "CRITICAL"))
    warn_count = sum(1 for a in normalized_alerts if a["category"] == "watched_domain" or a["level"] in ("WARN", "WARNING"))
    info_count = count - (crit_count + warn_count)

    if not logo_uri:
        logo_uri = "cid:oshotspot_logo"
    brand_header = _render_brand_header(logo_uri)

    cards_html = ""
    for idx, item in enumerate(normalized_alerts, start=1):
        level = item["level"]
        category = item["category"]
        msg = item["message"]
        extra = item["extra"]
        timestamp = item["timestamp"]

        # Determine badge styling & human label (matching dashboard light theme tokens)
        if category == "forbidden_domain":
            badge_color = "#dc2626"
            badge_bg = "rgba(220,38,38,0.08)"
            badge_border = "rgba(220,38,38,0.25)"
            badge_label = "CRITICAL"
            card_title = "Forbidden Domain Policy Violation"
        elif category == "admin_lockout":
            badge_color = "#dc2626"
            badge_bg = "rgba(220,38,38,0.12)"
            badge_border = "rgba(220,38,38,0.30)"
            badge_label = "CRITICAL"
            card_title = "Security Intrusion Lockout Detected"
        elif category == "critical_service":
            badge_color = "#dc2626"
            badge_bg = "rgba(220,38,38,0.12)"
            badge_border = "rgba(220,38,38,0.30)"
            badge_label = "SERVICE CRASH"
            card_title = "Critical Gateway Service Failure"
        elif category == "dns_flood":
            badge_color = "#d97706"
            badge_bg = "rgba(217,119,6,0.08)"
            badge_border = "rgba(217,119,6,0.25)"
            badge_label = "WARNING"
            card_title = "DNS Query Flood Attack"
        elif category == "watched_domain":
            badge_color = "#d97706"
            badge_bg = "rgba(217,119,6,0.08)"
            badge_border = "rgba(217,119,6,0.25)"
            badge_label = "WARNING"
            card_title = "Watched Domain Monitored"
        elif category == "unknown_device":
            badge_color = "#2563eb"
            badge_bg = "rgba(37,99,235,0.08)"
            badge_border = "rgba(37,99,235,0.25)"
            badge_label = "NOTICE"
            card_title = "Unregistered Device Joined Hotspot"
        else:
            badge_color = "#dc2626" if level in ("ALERT", "CRITICAL") else "#d97706"
            badge_bg = "rgba(220,38,38,0.08)" if level in ("ALERT", "CRITICAL") else "rgba(217,119,6,0.08)"
            badge_border = "rgba(220,38,38,0.25)" if level in ("ALERT", "CRITICAL") else "rgba(217,119,6,0.25)"
            badge_label = _h(level)
            card_title = "Security Alert"

        # Client / Attacker / Target details
        client_hostname = extra.get("client_hostname") or extra.get("hostname") or ""
        client_label = extra.get("known_label") or extra.get("label") or ""
        client_mac = extra.get("client_mac") or extra.get("mac") or ""
        client_ip = extra.get("client_ip") or extra.get("ip") or ""
        attacker_ip = extra.get("attacker_ip") or ""
        service_name = extra.get("service_name") or extra.get("service") or ""
        user_target = extra.get("user_target") or ""
        failure_count = extra.get("failure_count") or ""
        lockout_duration = extra.get("lockout_duration") or ""

        # Specific details
        domain = extra.get("domain", "")
        matched_rule = extra.get("matched_pattern") or extra.get("matched", "")
        rule_type = extra.get("rule_type", "")
        query_count = extra.get("query_count") or extra.get("count") or ""
        threshold = extra.get("threshold", "")
        window = extra.get("window", "")

        # Key-value rows for client
        kv_rows = []
        if client_hostname:
            kv_rows.append(
                '<tr>'
                '<td style="padding:4px 0;color:#777777;font-size:12px;width:130px;">Client Hostname:</td>'
                '<td style="padding:4px 0;color:#000000;font-size:12px;font-weight:600;">{}</td>'
                '</tr>'.format(_h(client_hostname))
            )
        else:
            kv_rows.append(
                '<tr>'
                '<td style="padding:4px 0;color:#777777;font-size:12px;width:130px;">Client Hostname:</td>'
                '<td style="padding:4px 0;color:#999999;font-size:12px;font-style:italic;">None (DHCP unadvertised)</td>'
                '</tr>'
            )

        if client_label:
            kv_rows.append(
                '<tr>'
                '<td style="padding:4px 0;color:#777777;font-size:12px;">Device Label:</td>'
                '<td style="padding:4px 0;color:#2563eb;font-size:12px;font-weight:600;">{}</td>'
                '</tr>'.format(_h(client_label))
            )

        if client_mac:
            kv_rows.append(
                '<tr>'
                '<td style="padding:4px 0;color:#777777;font-size:12px;">MAC Address:</td>'
                '<td style="padding:4px 0;font-family:monospace,Consolas,Courier;font-size:12px;color:#000000;">'
                '<span style="background:#f0f0f0;padding:2px 6px;border-radius:4px;border:1px solid rgba(0,0,0,0.1);">{}</span>'
                '</td></tr>'.format(_h(client_mac))
            )

        if client_ip:
            kv_rows.append(
                '<tr>'
                '<td style="padding:4px 0;color:#777777;font-size:12px;">IP Address:</td>'
                '<td style="padding:4px 0;font-family:monospace,Consolas,Courier;font-size:12px;color:#222222;">{}</td>'
                '</tr>'.format(_h(client_ip))
            )

        if attacker_ip and attacker_ip != client_ip:
            kv_rows.append(
                '<tr>'
                '<td style="padding:4px 0;color:#777777;font-size:12px;">Attacker IP:</td>'
                '<td style="padding:4px 0;font-family:monospace,Consolas,Courier;font-size:12px;font-weight:700;color:#dc2626;">{}</td>'
                '</tr>'.format(_h(attacker_ip))
            )

        if service_name:
            kv_rows.append(
                '<tr>'
                '<td style="padding:4px 0;color:#777777;font-size:12px;">Target Service:</td>'
                '<td style="padding:4px 0;color:#000000;font-size:12px;font-weight:600;">{}</td>'
                '</tr>'.format(_h(service_name))
            )

        if user_target:
            kv_rows.append(
                '<tr>'
                '<td style="padding:4px 0;color:#777777;font-size:12px;">Account Target:</td>'
                '<td style="padding:4px 0;color:#000000;font-size:12px;font-weight:600;">{}</td>'
                '</tr>'.format(_h(user_target))
            )

        if lockout_duration:
            kv_rows.append(
                '<tr>'
                '<td style="padding:4px 0;color:#777777;font-size:12px;">Action Taken:</td>'
                '<td style="padding:4px 0;color:#dc2626;font-size:12px;font-weight:600;">IP Locked for {} ({} failed attempts)</td>'
                '</tr>'.format(_h(str(lockout_duration)), _h(str(failure_count or "multiple")))
            )

        if domain:
            kv_rows.append(
                '<tr>'
                '<td style="padding:4px 0;color:#777777;font-size:12px;">Target Domain:</td>'
                '<td style="padding:4px 0;font-family:monospace,Consolas,Courier;font-size:12px;font-weight:700;color:#dc2626;">{}</td>'
                '</tr>'.format(_h(domain))
            )

        if matched_rule:
            kv_rows.append(
                '<tr>'
                '<td style="padding:4px 0;color:#777777;font-size:12px;">Triggered Rule:</td>'
                '<td style="padding:4px 0;color:#222222;font-size:12px;">{} {}</td>'
                '</tr>'.format(_h(matched_rule), "({})".format(_h(rule_type)) if rule_type else "")
            )

        if query_count:
            kv_rows.append(
                '<tr>'
                '<td style="padding:4px 0;color:#777777;font-size:12px;">Query Rate:</td>'
                '<td style="padding:4px 0;color:#dc2626;font-size:12px;font-weight:600;">{} queries in {}s (threshold: {})</td>'
                '</tr>'.format(_h(str(query_count)), _h(str(window or "5")), _h(str(threshold or "50")))
            )

        # Fallback raw message if no details parsed
        raw_msg_html = ""
        if "\n\n" in msg:
            extra_lines = msg.split("\n\n", 1)[1]
            raw_msg_html = (
                '<div style="margin-top:10px;padding:8px 12px;background:#f4f4f4;border-radius:6px;border:1px solid rgba(0,0,0,0.08);color:#555555;font-size:11px;font-family:monospace;white-space:pre-wrap;">'
                '{}'
                '</div>'.format(_h(extra_lines))
            )

        cards_html += (
            '<div style="background:#ffffff;border:1px solid rgba(0,0,0,0.09);border-radius:10px;padding:16px 18px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,0.03);">'
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;border-bottom:1px solid rgba(0,0,0,0.06);padding-bottom:8px;">'
            '<div>'
            '<span style="background:{};color:{};border:1px solid {};padding:3px 8px;border-radius:4px;font-size:11px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;">{}</span>'
            '<span style="color:#000000;font-size:14px;font-weight:600;margin-left:8px;">{}</span>'
            '</div>'
            '<span style="color:#777777;font-size:11px;font-family:monospace;">{}</span>'
            '</div>'
            '<p style="color:#222222;font-size:13px;line-height:1.5;margin:0 0 10px;">{}</p>'
            '<div style="background:#fafafa;border:1px solid rgba(0,0,0,0.06);border-radius:8px;padding:10px 14px;">'
            '<table style="width:100%;border-collapse:collapse;">'
            '{}'
            '</table>'
            '</div>'
            '{}'
            '</div>'.format(
                badge_bg, badge_color, badge_border, badge_label,
                card_title, _h(timestamp), _h(msg.split("\n\n", 1)[0]),
                "".join(kv_rows), raw_msg_html
            )
        )

    # Summary tags matching dashboard tokens
    summary_chips = (
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 6px;">'
        '<span style="background:#f4f4f5;border:1px solid rgba(0,0,0,0.08);color:#555555;padding:4px 10px;border-radius:6px;font-size:12px;">Total: <strong style="color:#000000;">{}</strong></span>'
        .format(count)
    )
    if crit_count:
        summary_chips += '<span style="background:rgba(220,38,38,0.10);color:#dc2626;border:1px solid rgba(220,38,38,0.25);padding:4px 10px;border-radius:6px;font-size:12px;">Critical: <strong style="color:#dc2626;">{}</strong></span>'.format(crit_count)
    if warn_count:
        summary_chips += '<span style="background:rgba(217,119,6,0.10);color:#d97706;border:1px solid rgba(217,119,6,0.25);padding:4px 10px;border-radius:6px;font-size:12px;">Warning: <strong style="color:#d97706;">{}</strong></span>'.format(warn_count)
    if info_count:
        summary_chips += '<span style="background:rgba(37,99,235,0.10);color:#2563eb;border:1px solid rgba(37,99,235,0.25);padding:4px 10px;border-radius:6px;font-size:12px;">Notice: <strong style="color:#2563eb;">{}</strong></span>'.format(info_count)
    summary_chips += '</div>'

    raw_template, tpl_path = _load_custom_template_raw(cfg)
    if raw_template:
        replacements = {
            "BRAND_HEADER": brand_header,
            "LOGO_URI": logo_uri,
            "HOSTNAME": _h(hostname),
            "SSID": _h(ssid),
            "AP_IP": _h(ap_ip),
            "ADMIN_URL": admin_url,
            "VERSION": _h(version),
            "COUNT": str(count),
            "PLURAL": plural,
            "DATE": _h(now),
            "TIMESTAMP": _h(now),
            "NOW": _h(now),
            "CARDS_HTML": cards_html,
            "ALERTS_HTML": cards_html,
            "CONTENT": cards_html,
            "SUMMARY_CHIPS": summary_chips,
        }
        res = raw_template
        for k, v in replacements.items():
            res = res.replace("{{" + k + "}}", str(v))
        if "{{CARDS_HTML}}" not in raw_template and "{{CONTENT}}" not in raw_template and "{{ALERTS_HTML}}" not in raw_template:
            if "</body>" in res:
                res = res.replace("</body>", '<div style="padding:20px;">' + cards_html + '</div></body>')
            else:
                res += cards_html
        return res

    return (
        '<!DOCTYPE html>'
        '<html lang="en">'
        '<head>'
        '<meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
        '<meta name="color-scheme" content="light">'
        '<title>OSHotspot Security Alert Digest</title>'
        '</head>'
        '<body style="margin:0;padding:24px 12px;background:#f6f7f9;font-family:\'Inter\',-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;color:#000000;-webkit-font-smoothing:antialiased;">'
        '<div style="max-width:600px;margin:0 auto;">'
        '{}'
        '<div style="background:#ffffff;border:1px solid rgba(0,0,0,0.09);border-radius:12px;padding:26px 24px;box-shadow:0 4px 20px rgba(0,0,0,0.04);">'
        '<div style="border-bottom:1px solid rgba(0,0,0,0.08);padding-bottom:16px;margin-bottom:18px;">'
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;">'
        '<div>'
        '<h1 style="color:#000000;font-size:20px;font-weight:700;margin:0 0 4px;letter-spacing:-0.3px;">Security Alert Digest</h1>'
        '<p style="color:#777777;font-size:13px;margin:0;">{} incident{} recorded on gateway</p>'
        '</div>'
        '<div style="text-align:right;">'
        '<span style="display:inline-block;background:#f4f4f4;border:1px solid rgba(0,0,0,0.08);border-radius:6px;padding:4px 10px;color:#222222;font-size:11px;font-family:monospace;">{}</span>'
        '</div>'
        '</div>'
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:12px;">'
        '<span style="background:#f4f4f5;border:1px solid rgba(0,0,0,0.08);border-radius:4px;padding:3px 8px;font-size:11px;color:#555555;">Gateway: <strong style="color:#000000;">{}</strong></span>'
        '<span style="background:#f4f4f5;border:1px solid rgba(0,0,0,0.08);border-radius:4px;padding:3px 8px;font-size:11px;color:#555555;">SSID: <strong style="color:#000000;">{}</strong></span>'
        '<span style="background:#f4f4f5;border:1px solid rgba(0,0,0,0.08);border-radius:4px;padding:3px 8px;font-size:11px;color:#555555;">IP: <strong style="color:#000000;">{}</strong></span>'
        '</div>'
        '{}'
        '</div>'
        '<div>{}</div>'
        '<div style="text-align:center;margin:26px 0 12px;">'
        '<a href="{}" target="_blank" style="display:inline-block;background:#000000;color:#ffffff;font-size:13px;font-weight:600;padding:12px 26px;border-radius:6px;text-decoration:none;letter-spacing:0.2px;box-shadow:0 2px 8px rgba(0,0,0,0.12);">'
        'Open Admin Dashboard &rarr;'
        '</a>'
        '</div>'
        '<div style="text-align:center;margin-top:16px;border-top:1px solid rgba(0,0,0,0.08);padding-top:14px;">'
        '<p style="color:#777777;font-size:12px;margin:0 0 6px;">'
        '<a href="{}#policy" style="color:#000000;text-decoration:underline;text-underline-offset:2px;">Domain Policies</a> &bull; '
        '<a href="{}#clients" style="color:#000000;text-decoration:underline;text-underline-offset:2px;">Known Devices</a> &bull; '
        '<a href="{}#audit" style="color:#000000;text-decoration:underline;text-underline-offset:2px;">Audit Trail</a>'
        '</p>'
        '</div>'
        '</div>'
        '<div style="text-align:center;margin-top:20px;">'
        '<p style="color:#888888;font-size:11px;line-height:1.6;margin:0;">'
        'Automated security dispatch from OSHotspot v{} running on gateway <strong style="color:#555555;">{}</strong> ({})<br>'
        'To change notification rules, log in to your dashboard and go to Email Alerts.'
        '</p>'
        '</div>'
        '</div>'
        '</body>'
        '</html>'
    ).format(
        brand_header, count, plural, _h(now),
        _h(hostname), _h(ssid), _h(ap_ip),
        summary_chips, cards_html, admin_url,
        admin_url, admin_url, admin_url,
        _h(version), _h(hostname), _h(ap_ip)
    )


def _build_test_email_html(cfg, sys_info=None, logo_uri=""):
    """Build a dedicated diagnostic HTML email matching the dashboard's light theme."""
    if sys_info is None:
        sys_info = _get_system_info(cfg)

    hostname = sys_info.get("hostname", "oshotspot")
    ap_ip = sys_info.get("ap_ip", "192.168.50.1")
    ssid = sys_info.get("ssid", "OSHotspot")
    admin_url = sys_info.get("admin_url", "http://{}:8073".format(ap_ip))
    version = sys_info.get("version", "5.1")
    now = time.strftime("%Y-%m-%d %H:%M:%S")

    smtp_mode = str(cfg.get("ALERT_EMAIL_SMTP_MODE", "msmtp")).strip()
    to_email = str(cfg.get("ALERT_EMAIL_TO", "")).strip()
    from_email = str(cfg.get("ALERT_EMAIL_FROM", "")).strip() or "oshotspot@localhost"
    smtp_host = str(cfg.get("ALERT_EMAIL_SMTP_HOST", "")).strip() or "localhost"
    smtp_port = str(cfg.get("ALERT_EMAIL_SMTP_PORT", "587")).strip()

    if smtp_mode == "msmtp":
        relay_label = "Local MTA (msmtp / sendmail relay)"
        relay_detail = "/etc/oshotspot/msmtprc"
    else:
        relay_label = "Direct Python SMTP"
        relay_detail = "{}:{}".format(smtp_host, smtp_port)

    if not logo_uri:
        logo_uri = "cid:oshotspot_logo"
    brand_header = _render_brand_header(logo_uri)

    raw_template, tpl_path = _load_custom_template_raw(cfg)
    if raw_template:
        replacements = {
            "BRAND_HEADER": brand_header,
            "LOGO_URI": logo_uri,
            "HOSTNAME": _h(hostname),
            "SSID": _h(ssid),
            "AP_IP": _h(ap_ip),
            "ADMIN_URL": admin_url,
            "VERSION": _h(version),
            "DATE": _h(now),
            "TIMESTAMP": _h(now),
            "NOW": _h(now),
            "RELAY_LABEL": _h(relay_label),
            "RELAY_DETAIL": _h(relay_detail),
            "FROM_EMAIL": _h(from_email),
            "SENDER": _h(from_email),
            "TO_EMAIL": _h(to_email),
            "RECIPIENT": _h(to_email),
            "CONTENT": '<div style="background:rgba(22,163,74,0.08);border:1px solid rgba(22,163,74,0.25);border-radius:8px;padding:12px 16px;margin-bottom:18px;"><h2 style="color:#16a34a;margin:0;">Email Notification System Operational</h2><p style="margin:4px 0 0;font-size:13px;">Test email delivered successfully from gateway <strong>' + _h(hostname) + '</strong>.</p></div>',
        }
        res = raw_template
        for k, v in replacements.items():
            res = res.replace("{{" + k + "}}", str(v))
        return res

    return (
        '<!DOCTYPE html>'
        '<html lang="en">'
        '<head>'
        '<meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
        '<meta name="color-scheme" content="light">'
        '<title>OSHotspot Email Diagnostic Test</title>'
        '</head>'
        '<body style="margin:0;padding:24px 12px;background:#f6f7f9;font-family:\'Inter\',-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;color:#000000;-webkit-font-smoothing:antialiased;">'
        '<div style="max-width:600px;margin:0 auto;">'
        '{}'
        '<div style="background:#ffffff;border:1px solid rgba(0,0,0,0.09);border-radius:12px;padding:26px 24px;box-shadow:0 4px 20px rgba(0,0,0,0.04);">'
        '<div style="background:rgba(22,163,74,0.08);border:1px solid rgba(22,163,74,0.25);border-radius:8px;padding:12px 16px;margin-bottom:18px;display:flex;align-items:center;gap:12px;">'
        '<div style="background:#16a34a;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;color:#ffffff;font-weight:bold;font-size:12px;flex-shrink:0;">&#10003;</div>'
        '<div>'
        '<h2 style="color:#16a34a;font-size:14px;font-weight:700;margin:0;">Email Notification System Operational</h2>'
        '<p style="color:#15803d;font-size:12px;margin:2px 0 0;">SMTP relay credentials verified successfully</p>'
        '</div>'
        '</div>'
        '<h1 style="color:#000000;font-size:18px;font-weight:700;margin:0 0 6px;">Diagnostic Report</h1>'
        '<p style="color:#555555;font-size:13px;line-height:1.5;margin:0 0 16px;">'
        'This test email confirms that OSHotspot has successfully connected to your configured mail relay and can deliver security alerts and policy notifications to your inbox.'
        '</p>'
        '<div style="background:#fafafa;border:1px solid rgba(0,0,0,0.07);border-radius:10px;padding:16px 18px;margin-bottom:20px;">'
        '<h3 style="color:#000000;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 12px;border-bottom:1px solid rgba(0,0,0,0.06);padding-bottom:6px;">Gateway &amp; Mail Relay Configuration</h3>'
        '<table style="width:100%;border-collapse:collapse;">'
        '<tr><td style="padding:5px 0;color:#777777;font-size:12px;width:140px;">Gateway Hostname:</td><td style="padding:5px 0;color:#000000;font-size:12px;font-weight:600;">{}</td></tr>'
        '<tr><td style="padding:5px 0;color:#777777;font-size:12px;">Gateway IP:</td><td style="padding:5px 0;color:#222222;font-size:12px;font-family:monospace;">{}</td></tr>'
        '<tr><td style="padding:5px 0;color:#777777;font-size:12px;">WiFi Hotspot SSID:</td><td style="padding:5px 0;color:#222222;font-size:12px;">{}</td></tr>'
        '<tr><td style="padding:5px 0;color:#777777;font-size:12px;">SMTP Relay Mode:</td><td style="padding:5px 0;color:#2563eb;font-size:12px;font-weight:600;">{}</td></tr>'
        '<tr><td style="padding:5px 0;color:#777777;font-size:12px;">Relay Details:</td><td style="padding:5px 0;color:#222222;font-size:12px;font-family:monospace;">{}</td></tr>'
        '<tr><td style="padding:5px 0;color:#777777;font-size:12px;">Sender Address:</td><td style="padding:5px 0;color:#222222;font-size:12px;font-family:monospace;">{}</td></tr>'
        '<tr><td style="padding:5px 0;color:#777777;font-size:12px;">Recipient Address:</td><td style="padding:5px 0;color:#222222;font-size:12px;font-family:monospace;">{}</td></tr>'
        '<tr><td style="padding:5px 0;color:#777777;font-size:12px;">Dispatched At:</td><td style="padding:5px 0;color:#222222;font-size:12px;font-family:monospace;">{}</td></tr>'
        '</table>'
        '</div>'
        '<div style="text-align:center;margin:24px 0 10px;">'
        '<a href="{}" target="_blank" style="display:inline-block;background:#000000;color:#ffffff;font-size:13px;font-weight:600;padding:12px 26px;border-radius:6px;text-decoration:none;letter-spacing:0.2px;box-shadow:0 2px 8px rgba(0,0,0,0.12);">'
        'Open Admin Dashboard &rarr;'
        '</a>'
        '</div>'
        '</div>'
        '<div style="text-align:center;margin-top:20px;">'
        '<p style="color:#888888;font-size:11px;line-height:1.6;margin:0;">'
        'Automated diagnostic test dispatched by OSHotspot v{} on gateway <strong style="color:#555555;">{}</strong> ({})'
        '</p>'
        '</div>'
        '</div>'
        '</body>'
        '</html>'
    ).format(
        brand_header, _h(hostname), _h(ap_ip), _h(ssid),
        _h(relay_label), _h(relay_detail), _h(from_email),
        _h(to_email), _h(now), admin_url, _h(version),
        _h(hostname), _h(ap_ip)
    )


def _build_plain_body(alerts, sys_info=None):
    """Build an English plain-text email body for a digest of alerts."""
    if sys_info is None:
        sys_info = _get_system_info()

    hostname = sys_info.get("hostname", "oshotspot")
    ap_ip = sys_info.get("ap_ip", "192.168.50.1")
    ssid = sys_info.get("ssid", "OSHotspot")
    admin_url = sys_info.get("admin_url", "http://{}:8073".format(ap_ip))
    version = sys_info.get("version", "5.1")
    now = time.strftime("%Y-%m-%d %H:%M:%S")

    normalized = [_normalize_alert(a) for a in alerts]
    count = len(normalized)

    lines = [
        "======================================================================",
        "OSHotspot Security Alert Digest",
        "Gateway: {} ({}) | SSID: {}".format(hostname, ap_ip, ssid),
        "Timestamp: {} | Incidents: {}".format(now, count),
        "======================================================================",
        "",
    ]

    for idx, a in enumerate(normalized, start=1):
        lines.append("[{}] {} - {}".format(idx, a["level"], a["category"].upper()))
        lines.append("----------------------------------------------------------------------")
        lines.append("Summary:         {}".format(a["message"].split("\n\n", 1)[0]))
        extra = a["extra"]
        if extra.get("client_hostname") or extra.get("hostname"):
            lines.append("Client Hostname: {}".format(extra.get("client_hostname") or extra.get("hostname")))
        if extra.get("known_label") or extra.get("label"):
            lines.append("Device Label:    {}".format(extra.get("known_label") or extra.get("label")))
        if extra.get("client_mac") or extra.get("mac"):
            lines.append("Client MAC:      {}".format(extra.get("client_mac") or extra.get("mac")))
        if extra.get("client_ip") or extra.get("ip"):
            lines.append("Client IP:       {}".format(extra.get("client_ip") or extra.get("ip")))
        if extra.get("attacker_ip"):
            lines.append("Attacker IP:     {}".format(extra.get("attacker_ip")))
        if extra.get("service_name"):
            lines.append("Target Service:  {}".format(extra.get("service_name")))
        if extra.get("user_target"):
            lines.append("Target Account:  {}".format(extra.get("user_target")))
        if extra.get("lockout_duration"):
            lines.append("Lockout Duration:{}".format(extra.get("lockout_duration")))
        if extra.get("domain"):
            lines.append("Target Domain:   {}".format(extra.get("domain")))
        if extra.get("matched_pattern"):
            lines.append("Rule Pattern:    {}".format(extra.get("matched_pattern")))
        if extra.get("query_count"):
            lines.append("Query Count:     {} queries in {}s".format(extra.get("query_count"), extra.get("window", "5")))
        lines.append("Timestamp:       {}".format(a["timestamp"]))
        lines.append("")

    lines.append("----------------------------------------------------------------------")
    lines.append("Admin Dashboard: {}".format(admin_url))
    lines.append("OSHotspot v{} running on gateway {}".format(version, hostname))
    return "\n".join(lines)


def _build_test_plain_body(cfg, sys_info=None):
    """Build an English plain-text diagnostic test email."""
    if sys_info is None:
        sys_info = _get_system_info(cfg)

    hostname = sys_info.get("hostname", "oshotspot")
    ap_ip = sys_info.get("ap_ip", "192.168.50.1")
    ssid = sys_info.get("ssid", "OSHotspot")
    admin_url = sys_info.get("admin_url", "http://{}:8073".format(ap_ip))
    version = sys_info.get("version", "5.1")
    now = time.strftime("%Y-%m-%d %H:%M:%S")

    to = str(cfg.get("ALERT_EMAIL_TO", "")).strip()
    mode = str(cfg.get("ALERT_EMAIL_SMTP_MODE", "msmtp")).strip()

    return (
        "======================================================================\n"
        "OSHotspot Email Diagnostic Test\n"
        "Gateway: {} ({}) | SSID: {}\n"
        "======================================================================\n\n"
        "STATUS: Notification System Operational\n\n"
        "This test email confirms that OSHotspot email alerting is configured\n"
        "correctly and can successfully dispatch alerts to your inbox.\n\n"
        "Diagnostic Details:\n"
        "  - Gateway Hostname: {}\n"
        "  - Gateway IP:       {}\n"
        "  - Hotspot SSID:     {}\n"
        "  - SMTP Relay Mode:  {}\n"
        "  - Recipient:        {}\n"
        "  - Sent At:          {}\n\n"
        "Admin Dashboard: {}\n"
        "OSHotspot v{} running on gateway {}\n"
    ).format(hostname, ap_ip, ssid, hostname, ap_ip, ssid, mode, to, now, admin_url, version, hostname)


# ---------------------------------------------------------------------------
# Send functions
# ---------------------------------------------------------------------------

def _find_sendmail():
    """Locate sendmail or msmtp binary on the system."""
    candidates = [
        "/usr/sbin/sendmail",
        "/usr/bin/sendmail",
        "/usr/lib/sendmail",
    ]
    for path in candidates:
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    try:
        result = subprocess.run(
            ["which", "msmtp"], capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except Exception:
        pass
    return None


def _create_email_message(subject, plain_body, html_body, cfg, sys_info=None):
    """Build EmailMessage container with CID inline image attachment."""
    to = str(cfg.get("ALERT_EMAIL_TO", "")).strip()
    sender = str(cfg.get("ALERT_EMAIL_FROM") or "").strip() \
        or str(cfg.get("ALERT_EMAIL_USERNAME") or "").strip() \
        or "oshotspot@localhost"

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = to

    if sys_info:
        msg["X-OSHotspot-Hostname"] = str(sys_info.get("hostname", "oshotspot"))
        msg["X-OSHotspot-Version"] = str(sys_info.get("version", "5.1"))

    msg.set_content(plain_body)
    msg.add_alternative(html_body, subtype="html")

    # Add inline logo MIME attachment for cid:oshotspot_logo
    if "cid:oshotspot_logo" in html_body:
        path_or_url, mime_type, is_file = _get_logo_file_info(cfg)
        if is_file and path_or_url and os.path.isfile(path_or_url):
            try:
                with open(path_or_url, "rb") as f:
                    img_bytes = f.read()
                sub_type = mime_type.split("/", 1)[-1]
                if sub_type == "svg+xml":
                    sub_type = "svg+xml"
                html_part = msg.get_payload(1)
                if hasattr(html_part, "add_related"):
                    html_part.add_related(
                        img_bytes,
                        maintype="image",
                        subtype=sub_type,
                        cid="<oshotspot_logo>"
                    )
            except Exception:
                pass
    return msg


def _send_via_sendmail(subject, plain_body, html_body, cfg, sys_info=None):
    """Send email via the local sendmail command (msmtp)."""
    sendmail_bin = _find_sendmail()
    if not sendmail_bin:
        return False
    to = str(cfg.get("ALERT_EMAIL_TO", "")).strip()
    if not to:
        return False
    try:
        msg = _create_email_message(subject, plain_body, html_body, cfg, sys_info=sys_info)
        real_path = os.path.realpath(sendmail_bin)
        if "msmtp" in real_path:
            # -t/--read-recipients: msmtp does NOT read To:/Cc:/Bcc headers by default
            cmd = [sendmail_bin, "-C", "/etc/oshotspot/msmtprc", "-a", "oshotspot", "-t"]
        else:
            cmd = [sendmail_bin, "-t", "-oi"]
        proc = subprocess.run(
            cmd,
            input=msg.as_bytes(),
            timeout=30,
            capture_output=True,
        )
        return proc.returncode == 0
    except Exception:
        return False


def _send_via_smtp(subject, plain_body, html_body, cfg, sys_info=None):
    """Send email via direct SMTP connection (Python smtplib)."""
    host = str(cfg.get("ALERT_EMAIL_SMTP_HOST", "")).strip()
    to = str(cfg.get("ALERT_EMAIL_TO", "")).strip()
    if not host or not to:
        return False
    try:
        msg = _create_email_message(subject, plain_body, html_body, cfg, sys_info=sys_info)
        try:
            port = int(str(cfg.get("ALERT_EMAIL_SMTP_PORT", "587")))
        except ValueError:
            port = 587
        with smtplib.SMTP(host, port, timeout=15) as smtp:
            smtp.ehlo()
            if smtp.has_extn("starttls"):
                smtp.starttls()
                smtp.ehlo()
            username = str(cfg.get("ALERT_EMAIL_USERNAME", "")).strip()
            password = str(cfg.get("ALERT_EMAIL_PASSWORD", "")).strip()
            if username:
                smtp.login(username, password)
            smtp.send_message(msg)
        return True
    except Exception:
        return False


def _send_email(cfg, subject, plain_body, html_body, sys_info=None):
    """Dispatch to the correct transport based on SMTP mode."""
    mode = str(cfg.get("ALERT_EMAIL_SMTP_MODE", "msmtp")).strip().lower()
    if mode == "msmtp":
        return _send_via_sendmail(subject, plain_body, html_body, cfg, sys_info=sys_info)
    return _send_via_smtp(subject, plain_body, html_body, cfg, sys_info=sys_info)


# ---------------------------------------------------------------------------
# Digest buffering
# ---------------------------------------------------------------------------

def _flush_digest():
    """Send all buffered alerts as a single digest email."""
    global _alert_buffer, _alert_timer
    with _timer_lock:
        if _alert_timer is not None:
            _alert_timer.cancel()
            _alert_timer = None
        if not _alert_buffer:
            return
        alerts = list(_alert_buffer)
        _alert_buffer.clear()

    count = len(alerts)
    cfg = load_config()
    if not email_enabled(cfg):
        return
    sys_info = _get_system_info(cfg)
    plural = "s" if count != 1 else ""
    subject = "[OSHotspot @ {}] {} Security Alert{} Detected".format(
        sys_info["hostname"], count, plural
    )
    plain_body = _build_plain_body(alerts, sys_info)
    logo_uri = "cid:oshotspot_logo"
    html_body = _build_html_body(alerts, logo_uri, sys_info, cfg=cfg)
    _send_email(cfg, subject, plain_body, html_body, sys_info)


def _schedule_digest():
    """Start or restart the digest timer."""
    global _alert_timer
    with _timer_lock:
        if _alert_timer is not None:
            _alert_timer.cancel()
        _alert_timer = threading.Timer(_DIGEST_TIMEOUT, _flush_digest)
        _alert_timer.daemon = True
        _alert_timer.start()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def alert(message, level="ALERT", extra=None, category=None):
    """Record a clearly flagged alert entry and optionally email it.

    Level is 'ALERT' for anything that needs attention; 'INFO'/'WARN' are
    plain log entries.  Only ALERT-level notifications matching enabled
    categories are emailed. Never raises. Returns True when an email was buffered.

    Alerts are buffered and sent as a digest: up to 10 alerts or 60 seconds,
    whichever comes first, to avoid inbox flooding."""
    cat = category or _detect_category(message, extra)
    log_line(level, message)
    if level != "ALERT":
        return False
    cfg = load_config()
    if not email_enabled(cfg):
        return False
    if not is_category_enabled_for_email(cat, cfg):
        return False

    now_ts = time.strftime("%Y-%m-%d %H:%M:%S")
    item = {
        "level": level,
        "message": message,
        "extra": extra if isinstance(extra, dict) else {},
        "raw_extra": extra,
        "timestamp": now_ts,
        "category": cat,
    }

    with _timer_lock:
        _alert_buffer.append(item)
        buf_len = len(_alert_buffer)

    if buf_len >= _DIGEST_MAX:
        _flush_digest()
    else:
        _schedule_digest()
    return True

