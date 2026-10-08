#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

"""Reads, writes and validates /etc/oshotspot/config.conf, a simple
shell-style KEY="value" file that's also sourced directly by the bash
scripts, so we have to keep its format intact when we rewrite it."""

import os
import re

from . import settings


def parse_config():
    """Load config.conf into a plain dict. Returns {} if the file
    doesn't exist yet (fresh install)."""
    config = {}
    if not os.path.isfile(settings.CONFIG_FILE):
        return config
    with open(settings.CONFIG_FILE) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            m = re.match(r'^([A-Z_]+)\s*=\s*"?([^"]*)"?$', line)
            if m:
                config[m.group(1)] = m.group(2)
    return config


def escape_config_value(val):
    """Escape backslashes and double quotes so the value stays safe
    inside a shell-style KEY="value" assignment."""
    val = val.replace("\\", "\\\\")
    val = val.replace('"', '\\"')
    return val


def write_config(updates):
    """Merge `updates` into config.conf, preserving existing keys and
    comments. Keys not already present are appended at the end."""
    lines = []
    seen_keys = set()
    if os.path.isfile(settings.CONFIG_FILE):
        with open(settings.CONFIG_FILE) as f:
            for line in f:
                stripped = line.strip()
                m = re.match(r'^([A-Z_]+)\s*=', stripped)
                if m and m.group(1) in updates:
                    key = m.group(1)
                    val = updates[key]
                    if val is None:
                        lines.append(f'{key}=""\n')
                    else:
                        lines.append(f'{key}="{escape_config_value(val)}"\n')
                    seen_keys.add(key)
                else:
                    lines.append(line)
    for key, val in updates.items():
        if key not in seen_keys:
            if val is None:
                lines.append(f'{key}=""\n')
            else:
                lines.append(f'{key}="{escape_config_value(val)}"\n')
    with open(settings.CONFIG_FILE, "w") as f:
        f.writelines(lines)


def validate_config_update(data):
    """Validate a config PATCH payload coming from the dashboard form.
    Returns (validated_dict, errors_list), validated_dict uses the
    upper-case keys expected by config.conf."""
    errors = []
    validated = {}

    if "ssid" in data:
        ssid = data["ssid"]
        if not isinstance(ssid, str) or len(ssid) < 1 or len(ssid) > 32:
            errors.append("SSID must be 1-32 characters.")
        elif any(ord(c) < 32 for c in ssid):
            errors.append("SSID contains invalid control characters.")
        else:
            validated["SSID"] = ssid

    if "password" in data:
        pw = data["password"]
        if not isinstance(pw, str) or len(pw) < 8:
            errors.append("Password must be at least 8 characters.")
        else:
            validated["PASSWORD"] = pw

    if "channel" in data:
        try:
            ch = int(data["channel"])
            if ch not in settings.VALID_CHANNELS:
                errors.append(
                    f"Channel must be one of: "
                    f"{', '.join(str(c) for c in settings.VALID_CHANNELS)}."
                )
            else:
                validated["CHANNEL"] = str(ch)
        except (ValueError, TypeError):
            errors.append("Channel must be an integer.")

    if "hw_mode" in data:
        mode = data["hw_mode"]
        if mode not in settings.VALID_HW_MODES:
            errors.append(
                f"Hardware mode must be one of: {', '.join(settings.VALID_HW_MODES)}."
            )
        else:
            validated["HW_MODE"] = mode

    if "country_code" in data:
        cc = data["country_code"].upper()
        if not re.match(r'^[A-Z]{2}$', cc):
            errors.append("Country code must be exactly 2 uppercase letters.")
        elif cc not in settings.ISO_COUNTRIES:
            errors.append(f"'{cc}' is not a valid ISO 3166-1 alpha-2 country code.")
        else:
            validated["COUNTRY_CODE"] = cc

    if "dashboard_remote_access" in data:
        validated["DASHBOARD_REMOTE_ACCESS"] = "true" if str(data["dashboard_remote_access"]).lower() in ("true", "1", "yes") else "false"

    if "dashboard_bind_address" in data:
        addr = str(data["dashboard_bind_address"]).strip()
        validated["DASHBOARD_BIND_ADDRESS"] = addr if addr else "0.0.0.0"

    if "wifi_open" in data:
        validated["WIFI_OPEN"] = "true" if str(data["wifi_open"]).lower() in ("true", "1", "yes") else "false"

    if "captive_portal" in data:
        validated["CAPTIVE_PORTAL"] = "true" if str(data["captive_portal"]).lower() in ("true", "1", "yes") else "false"

    if "captive_code" in data:
        validated["CAPTIVE_CODE"] = str(data["captive_code"]).strip()

    if "captive_message" in data:
        validated["CAPTIVE_MESSAGE"] = str(data["captive_message"]).strip()

    if "captive_bg_color" in data:
        bg = str(data["captive_bg_color"]).strip()
        if bg and not bg.startswith("#"):
            bg = "#" + bg
        validated["CAPTIVE_BG_COLOR"] = bg if bg else "#050505"

    if "captive_domain" in data:
        raw_dom = str(data["captive_domain"]).strip().lower()
        # Strip protocols (http://, https://), paths, ports, and trailing slashes
        dom = re.sub(r'^(https?://)+', '', raw_dom)
        dom = dom.split('/')[0].split(':')[0].strip()
        if dom and not re.match(r'^[a-z0-9]([a-z0-9\-\.]*[a-z0-9])?$', dom):
            errors.append("Custom domain is invalid. Use letters, numbers, hyphens, and dots (e.g. wifi.portal).")
        else:
            validated["CAPTIVE_DOMAIN"] = dom

    if "captive_logo_url" in data:
        validated["CAPTIVE_LOGO_URL"] = str(data["captive_logo_url"]).strip()

    if "admin_login_bg_color" in data:
        bg = str(data["admin_login_bg_color"]).strip()
        if bg and not bg.startswith("#"):
            bg = "#" + bg
        validated["ADMIN_LOGIN_BG_COLOR"] = bg

    if "admin_logo_url" in data:
        validated["ADMIN_LOGO_URL"] = str(data["admin_logo_url"]).strip()

    if "span_enabled" in data:
        validated["SPAN_ENABLED"] = "true" if str(data["span_enabled"]).lower() in ("true", "1", "yes") else "false"

    if "span_interface" in data:
        validated["SPAN_INTERFACE"] = str(data["span_interface"]).strip()

    if "inactivity_timeout" in data:
        _valid = {"0", "7200", "18000", "36000"}
        val = str(data["inactivity_timeout"]).strip()
        if val not in _valid:
            errors.append("Inactivity timeout must be 2h, 5h, 10h, or Never.")
        else:
            validated["INACTIVITY_TIMEOUT"] = val

    # --- Email alerts ---
    if "alert_email_enabled" in data:
        validated["ALERT_EMAIL_ENABLED"] = "true" if str(data["alert_email_enabled"]).lower() in ("true", "1", "yes") else "false"

    if "alert_email_smtp_mode" in data:
        mode = str(data["alert_email_smtp_mode"]).strip().lower()
        if mode not in ("msmtp", "direct"):
            errors.append("SMTP mode must be 'msmtp' or 'direct'.")
        else:
            validated["ALERT_EMAIL_SMTP_MODE"] = mode

    if "alert_email_to" in data:
        to = str(data["alert_email_to"]).strip()
        if to and "@" not in to:
            errors.append("Alert email recipient must be a valid email address.")
        else:
            validated["ALERT_EMAIL_TO"] = to

    if "alert_email_from" in data:
        validated["ALERT_EMAIL_FROM"] = str(data["alert_email_from"]).strip()

    if "alert_email_smtp_host" in data:
        validated["ALERT_EMAIL_SMTP_HOST"] = str(data["alert_email_smtp_host"]).strip()

    if "alert_email_smtp_port" in data:
        try:
            port = int(data["alert_email_smtp_port"])
            if port < 1 or port > 65535:
                errors.append("SMTP port must be 1-65535.")
            else:
                validated["ALERT_EMAIL_SMTP_PORT"] = str(port)
        except (ValueError, TypeError):
            errors.append("SMTP port must be a number.")

    if "alert_email_username" in data:
        validated["ALERT_EMAIL_USERNAME"] = str(data["alert_email_username"]).strip()

    if "alert_email_password" in data:
        validated["ALERT_EMAIL_PASSWORD"] = str(data["alert_email_password"])

    if "alert_email_template" in data:
        validated["ALERT_EMAIL_TEMPLATE"] = str(data["alert_email_template"]).strip()

    if "alert_email_categories" in data:
        validated["ALERT_EMAIL_CATEGORIES"] = str(data["alert_email_categories"]).strip()

    # Cross-field check: must run AFTER alert_email_to is processed above,
    # otherwise validated["ALERT_EMAIL_TO"] is still empty and enabling
    # alerts would always fail even with a valid recipient.
    if validated.get("ALERT_EMAIL_ENABLED") == "true":
        to = str(validated.get("ALERT_EMAIL_TO", "")).strip()
        if not to or "@" not in to:
            errors.append("ALERT_EMAIL_TO must be set to a valid email when email alerts are enabled.")

    return validated, errors
