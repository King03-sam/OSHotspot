#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

"""Wrappers for invoking the shell scripts that actually drive the hotspot,
plus a small helper to append entries to the web action log."""

import os
import subprocess
import time

from . import settings


def log_action(action):
    """Append a timestamped line to web.log. Failures here are non-fatal:
    we don't want a logging hiccup to break the dashboard."""
    try:
        os.makedirs(settings.LOG_DIR, exist_ok=True)
        log_path = os.path.join(settings.LOG_DIR, "web.log")
        with open(log_path, "a") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {action}\n")
    except Exception:
        pass


def run_script(script_name, timeout=30):
    """Run one of the bash scripts under SCRIPTS_DIR and return
    (returncode, stdout, stderr). Guards against a missing script and
    against a script that hangs past `timeout` seconds."""
    script = os.path.join(settings.SCRIPTS_DIR, script_name)
    if not os.path.isfile(script):
        return 1, "", "Script not found"
    try:
        result = subprocess.run(
            ["bash", script],
            capture_output=True, text=True, timeout=timeout
        )
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return 1, "", "Script timed out"
