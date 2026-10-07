#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
# Licensed under the Apache License, Version 2.0

"""Holds the session token and last-activity timestamp shared between
the request handler and the inactivity watchdog.  Also provides helpers
for the cookie-based session system used by the login flow."""

import http.cookies
import os
import time

last_activity = time.time()
ACTIVITY_FILE = "/tmp/oshotspot_activity"

SESSION_COOKIE_NAME = "oshotspot_session"


def touch_activity():
    """Mark the dashboard as active.  Called on every incoming request
    so the inactivity watchdog doesn't shut the server down mid-use."""
    global last_activity
    last_activity = time.time()
    try:
        os.utime(ACTIVITY_FILE, None)
    except Exception:
        pass


def seconds_since_activity():
    return time.time() - last_activity


# ---------------------------------------------------------------------------
# Session cookie helpers
# ---------------------------------------------------------------------------

def set_session_cookie(handler, session_token):
    """Set an HttpOnly session cookie on the response."""
    cookie = http.cookies.SimpleCookie()
    cookie[SESSION_COOKIE_NAME] = session_token
    cookie[SESSION_COOKIE_NAME]["path"] = "/"
    cookie[SESSION_COOKIE_NAME]["httponly"] = True
    cookie[SESSION_COOKIE_NAME]["samesite"] = "Strict"
    handler.send_header("Set-Cookie", cookie[SESSION_COOKIE_NAME].OutputString())


def get_session_from_cookie(handler):
    """Read the session token from the request cookie.  Returns the
    token string or None."""
    cookie_header = handler.headers.get("Cookie", "")
    if not cookie_header:
        return None
    for part in cookie_header.split(";"):
        part = part.strip()
        if part.startswith(SESSION_COOKIE_NAME + "="):
            return part[len(SESSION_COOKIE_NAME) + 1:]
    return None


def clear_session_cookie(handler):
    """Clear the session cookie on the response (for logout)."""
    cookie = http.cookies.SimpleCookie()
    cookie[SESSION_COOKIE_NAME] = ""
    cookie[SESSION_COOKIE_NAME]["path"] = "/"
    cookie[SESSION_COOKIE_NAME]["httponly"] = True
    cookie[SESSION_COOKIE_NAME]["samesite"] = "Strict"
    cookie[SESSION_COOKIE_NAME]["max-age"] = 0
    cookie[SESSION_COOKIE_NAME]["expires"] = "Thu, 01 Jan 1970 00:00:00 GMT"
    handler.send_header("Set-Cookie", cookie[SESSION_COOKIE_NAME].OutputString())
