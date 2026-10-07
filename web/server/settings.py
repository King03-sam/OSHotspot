#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

"""Global constants shared across the dashboard server modules."""

import os

PORT = 8073
DEFAULT_HOST = "0.0.0.0"

def get_bind_host():
    """Determine the host to bind to, based on config.conf or environment."""
    # Environment variable takes priority
    env = os.environ.get("OSHOTSPOT_HOST")
    if env:
        return env

    # Read from config.conf
    try:
        if os.path.isfile(CONFIG_FILE):
            import re as _re
            with open(CONFIG_FILE) as _f:
                for _line in _f:
                    _line = _line.strip()
                    if not _line or _line.startswith("#"):
                        continue
                    _m = _re.match(r'^DASHBOARD_BIND_ADDRESS\s*=\s*"?([^"]*)"?$', _line)
                    if _m:
                        return _m.group(1)
    except Exception:
        pass

    return DEFAULT_HOST

HOST = get_bind_host()
INACTIVITY_TIMEOUT = int(os.environ.get("OSHOTSPOT_INACTIVITY_TIMEOUT", "0"))
if not INACTIVITY_TIMEOUT:
    try:
        import re as _re
        _cfg = {}
        if os.path.isfile(CONFIG_FILE):
            with open(CONFIG_FILE) as _f:
                for _line in _f:
                    _line = _line.strip()
                    if not _line or _line.startswith("#"):
                        continue
                    _m = _re.match(r'^([A-Z_]+)\s*=\s*"?([^"]*)"?$', _line)
                    if _m:
                        _cfg[_m.group(1)] = _m.group(2)
        INACTIVITY_TIMEOUT = int(_cfg.get("INACTIVITY_TIMEOUT", "7200"))
    except Exception:
        INACTIVITY_TIMEOUT = 7200


def reload_inactivity_timeout():
    """Re-read INACTIVITY_TIMEOUT from env / config.conf at runtime."""
    global INACTIVITY_TIMEOUT
    INACTIVITY_TIMEOUT = int(os.environ.get("OSHOTSPOT_INACTIVITY_TIMEOUT", "0"))
    if not INACTIVITY_TIMEOUT:
        try:
            from .config_store import parse_config
            _cfg = parse_config()
            INACTIVITY_TIMEOUT = int(_cfg.get("INACTIVITY_TIMEOUT", "7200"))
        except Exception:
            INACTIVITY_TIMEOUT = 7200


SESSION_EXPIRY = 7200      # 2 hours, matches INACTIVITY_TIMEOUT
LOCKOUT_TIERS = [
    (5,  60),    # 5 failures   -> 1 minute
    (10, 600),   # 10 failures  -> 10 minutes
    (15, 1800),  # 15 failures  -> 30 minutes
    (20, 3600),  # 20+ failures -> 60 minutes
]
PASSWORD_MIN_LENGTH = 8    # minimum password length

# Per-IP brute-force protection on the dashboard login. The lockout is tracked
# in-memory and NEVER disclosed to the client: a blocked IP receives the exact
# same generic "invalid credentials" response as any other failure.
LOGIN_FAIL_DELAY = 1.0               # seconds to sleep after each failed login
IP_LOCKOUT_TIERS = [
    (5,  60),    # 5 failures   -> 1 minute
    (10, 300),   # 10 failures  -> 5 minutes
    (20, 900),   # 20 failures  -> 15 minutes
    (30, 3600),  # 30+ failures -> 60 minutes
]
IP_ATTEMPT_TTL = 3600.0      # drop idle per-IP tracking after 1 hour
IP_LOCKOUT_EXEMPT = ("127.0.0.1", "::1", "localhost")

# Scripts: use the project's own scripts/ when running from source,
# fall back to the installed location otherwise.  Same philosophy as
# STATIC_DIR below: resolve relative to this package so the dashboard
# always drives the scripts it was shipped with.
_REPO_SCRIPTS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "scripts",
)
SCRIPTS_DIR = (
    _REPO_SCRIPTS
    if os.path.isfile(os.path.join(_REPO_SCRIPTS, "firewall.sh"))
    else "/usr/lib/oshotspot/scripts"
)
CONFIG_FILE = "/etc/oshotspot/config.conf"
LOG_DIR = "/var/log/oshotspot"
LOG_FILES = {
    "hostapd": "/var/log/oshotspot/hostapd.log",
    "dnsmasq": "/var/log/oshotspot/dnsmasq.log",
    "web": "/var/log/oshotspot/web.log",
    "events": "/var/log/oshotspot/events.log",
}
PROC_NET_DEV = "/proc/net/dev"

HOSTAPD_PID = "/run/oshotspot-hostapd.pid"

# SQLite storage for the event collector (DNS/DHCP/device activity).
EVENTS_DB = "/var/log/oshotspot/events.db"

# SQLite storage for auth, sessions, and notifications.
AUTH_DB = "/var/log/oshotspot/auth.db"

# Persistent image directories that survive software updates
PERSISTENT_IMAGE_DIR = "/var/lib/oshotspot/images"
ETC_IMAGE_DIR = "/etc/oshotspot/images"

# Captive portal temporary codes and active sessions
CAPTIVE_CODES_FILE = "/var/lib/oshotspot/captive_codes.json"
CAPTIVE_SESSIONS_FILE = "/var/lib/oshotspot/captive_sessions.json"

# static/ lives one directory up from server/, next to this package
STATIC_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static"
)

VALID_CHANNELS = list(range(1, 14))
VALID_HW_MODES = ("g", "a")

# Full ISO 3166-1 alpha-2 country list, used to validate the regulatory
# domain the user picks in the config form.
ISO_COUNTRIES = {
    "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AN", "AO", "AQ", "AR", "AS", "AT", "AU", "AW",
    "AX", "AZ", "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BM", "BN", "BO", "BR",
    "BS", "BT", "BW", "BY", "BZ", "CA", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN",
    "CO", "CR", "CU", "CV", "CY", "CZ", "DE", "DJ", "DK", "DM", "DO", "DZ", "EC", "EE", "EG",
    "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR", "GA", "GB", "GD", "GE", "GF", "GG",
    "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GT", "GU", "GW", "GY", "HK", "HN", "HR",
    "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT", "JE", "JM", "JO",
    "JP", "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW", "KY", "KZ", "LA", "LB", "LC",
    "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME", "MG", "MK", "ML",
    "MM", "MN", "MO", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA", "NC", "NE",
    "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NZ", "OM", "PA", "PE", "PF", "PG", "PH", "PK",
    "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RU", "RW", "SA",
    "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SK", "SL", "SM", "SN", "SO", "SR", "SS", "ST",
    "SV", "SY", "SZ", "TC", "TD", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO", "TR", "TT",
    "TV", "TW", "TZ", "UA", "UG", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VN", "VU", "WF",
    "WS", "YE", "YT", "ZA", "ZM", "ZW",
}
