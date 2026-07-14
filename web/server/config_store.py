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
    Returns (validated_dict, errors_list) — validated_dict uses the
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

    return validated, errors
