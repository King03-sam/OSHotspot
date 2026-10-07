#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

"""Notification publisher for the event collector.

Stores anomaly notifications in the auth database (for the bell badge
and dropdown) and publishes a ``notification`` message onto the live
bus so the SSE endpoint can push it instantly to every open dashboard
tab.

The auth DB path is the same one used by the web server module.  If the
DB cannot be opened (e.g. first boot before ``sudo oshotspot web`` has
created it), the failure is silent -- the SSE toast still fires because
``live_bus.publish`` is independent of the auth DB."""

import os
import sqlite3
import time

from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

try:
    from events import live_bus
except ImportError:
    import live_bus

_AUTH_DB_PATH = os.environ.get(
    "OSHOTSPOT_AUTH_DB",
    "/var/log/oshotspot/auth.db",
)

_SEVERITY_MAP = {
    "forbidden_domain":  "high",
    "watched_domain":    "warn",
    "unknown_client":    "warn",
    "flood":             "high",
    "lockout":           "high",
    "critical_service":  "high",
}


def _open_auth_db():
    """Return a connection to the auth DB, or None on failure.

    The `notifications` table is created here (idempotent) so the
    collector can persist notifications even if the web server has not
    initialised the auth DB yet (e.g. first boot)."""
    try:
        conn = sqlite3.connect(_AUTH_DB_PATH, timeout=5)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=3000")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS notifications ("
            "  id               INTEGER PRIMARY KEY AUTOINCREMENT,"
            "  type             TEXT NOT NULL,"
            "  message          TEXT NOT NULL,"
            "  severity         TEXT NOT NULL DEFAULT 'info',"
            "  created_at       TEXT NOT NULL,"
            "  read             INTEGER NOT NULL DEFAULT 0,"
            "  related_event_id INTEGER"
            ")"
        )
        conn.commit()
        return conn
    except Exception:
        return None


@retry(
    retry=retry_if_exception_type(sqlite3.OperationalError),
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=0.05, min=0.05, max=0.5),
    reraise=True,
)
def _persist_notification(ntype, message, severity, related_event_id):
    """Insert one notification row, returning its id.  Retries on
    transient SQLite errors (locked DB)."""
    conn = _open_auth_db()
    if conn is None:
        return None
    try:
        cur = conn.execute(
            "INSERT INTO notifications (type, message, severity, "
            "related_event_id, read, created_at) "
            "VALUES (?, ?, ?, ?, 0, ?)",
            (ntype, message, severity, related_event_id,
             time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())),
        )
        conn.commit()
        return cur.lastrowid
    except sqlite3.OperationalError:
        raise
    except Exception:
        return None
    finally:
        conn.close()


def publish(ntype, message, severity=None, related_event_id=None):
    """Store a notification in auth.db and push it to the live bus.

    Parameters
    ----------
    ntype : str
        One of ``forbidden_domain``, ``watched_domain``,
        ``unknown_client``, ``flood``, ``lockout``, ``critical_service``.
    message : str
        Human-readable notification text.
    severity : str or None
        ``high``, ``warn`` or ``info``.  If *None*, inferred from *ntype*.
    related_event_id : int or None
        Optional events table row id for cross-referencing.
    """
    if severity is None:
        severity = _SEVERITY_MAP.get(ntype, "info")

    # 1) Persist in the auth DB.  Best-effort: a failure here must not
    #    crash the collector -- the SSE toast still fires via live_bus.
    notification_id = None
    try:
        notification_id = _persist_notification(
            ntype, message, severity, related_event_id)
    except Exception:
        notification_id = None

    # 2) Publish to the live bus for real-time SSE delivery.
    live_bus.publish({
        "type": "notification",
        "id": notification_id,
        "ntype": ntype,
        "message": message,
        "severity": severity,
        "related_event_id": related_event_id,
        "read": False,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()),
    })

    return notification_id
