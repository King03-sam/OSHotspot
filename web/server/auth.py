#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

"""Holds the session token and last-activity timestamp shared between
the request handler and the inactivity watchdog. Kept as a tiny module
of its own instead of function-local globals so both sides can import
it without circular references."""

import time

TOKEN = None
last_activity = time.time()


def touch_activity():
    """Mark the dashboard as active. Called on every incoming request
    so the inactivity watchdog doesn't shut the server down mid-use."""
    global last_activity
    last_activity = time.time()


def seconds_since_activity():
    return time.time() - last_activity
