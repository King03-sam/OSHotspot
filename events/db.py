#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

"""SQLite storage for OSHotspot events and the known-device inventory.

A plain file-backed database (no server) stored in the project's log
directory convention, /var/log/oshotspot/events.db.  The schema is created
on first use, every function degrades to a safe no-op on failure, and the
tailer + web dashboard can both use this module.

The extra `source_hash` column (UNIQUE) makes replay safe: the same log
line never produces two rows, no matter how many times the collector
restarts or a rotated log is re-read.
"""

import json
import logging
import os
import sqlite3
import time

from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

_log = logging.getLogger(__name__)

EVENTS_DB = os.environ.get("OSHOTSPOT_EVENTS_DB", "/var/log/oshotspot/events.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT NOT NULL,
    client_mac  TEXT NOT NULL DEFAULT '',
    event_type  TEXT NOT NULL,
    detail      TEXT NOT NULL DEFAULT '',
    source_hash TEXT UNIQUE,
    category    TEXT NOT NULL DEFAULT '',
    first_seen  TEXT NOT NULL DEFAULT '',
    last_seen   TEXT NOT NULL DEFAULT '',
    request_count INTEGER NOT NULL DEFAULT 1,
    alert_type  TEXT NOT NULL DEFAULT '',
    priority    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_client_mac ON events(client_mac);
CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_priority ON events(priority);
CREATE INDEX IF NOT EXISTS idx_events_alert_type ON events(alert_type);
CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);

CREATE TABLE IF NOT EXISTS known_devices (
    mac        TEXT PRIMARY KEY,
    label      TEXT NOT NULL DEFAULT 'unknown device',
    first_seen TEXT NOT NULL
);

-- Editable domain policy tables (populated/queried by events.classify).
-- Created here so they exist on a fresh DB even if classify.init_policy_tables
-- is never called explicitly; both code paths are idempotent.
CREATE TABLE IF NOT EXISTS noise_patterns (
    pattern     TEXT PRIMARY KEY,
    label       TEXT NOT NULL DEFAULT '',
    added_date  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS forbidden_domains (
    pattern     TEXT PRIMARY KEY,
    label       TEXT NOT NULL DEFAULT '',
    added_date  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS watched_domains (
    pattern     TEXT PRIMARY KEY,
    label       TEXT NOT NULL DEFAULT '',
    added_date  TEXT NOT NULL
);
"""

# Columns added to the events table in a later revision.  Each is added
# with ALTER TABLE if missing, so an existing database is upgraded in
# place without losing data.  ALTER TABLE ADD COLUMN cannot be run
# inside CREATE TABLE IF NOT EXISTS, so this is done separately in
# init_db() below.
_EVENT_COLUMNS = {
    "category":       "TEXT NOT NULL DEFAULT ''",
    "first_seen":     "TEXT NOT NULL DEFAULT ''",
    "last_seen":      "TEXT NOT NULL DEFAULT ''",
    "request_count":  "INTEGER NOT NULL DEFAULT 1",
    "alert_type":     "TEXT NOT NULL DEFAULT ''",
    "priority":       "TEXT NOT NULL DEFAULT ''",
}

# Columns added to the known_devices table for the Device Inventory
# feature (Step 1).  Same ALTER TABLE pattern as _EVENT_COLUMNS.
_KNOWN_COLUMNS = {
    "device_type": "TEXT NOT NULL DEFAULT ''",
    "notes":       "TEXT NOT NULL DEFAULT ''",
    "added_by":    "TEXT NOT NULL DEFAULT ''",
    "added_at":    "TEXT NOT NULL DEFAULT ''",
}


def db_path():
    """Absolute path of the events database (overridable for testing)."""
    return EVENTS_DB


def connect(path=None):
    """Open a connection with dict-like row access. Caller must close it.

    WAL mode is enabled so the tailer (writer) and the web dashboard
    (reader) can operate concurrently without "database is locked" errors.
    busy_timeout gives SQLite 5 seconds to wait for a lock before failing.
    """
    conn = sqlite3.connect(path or EVENTS_DB, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA synchronous=NORMAL")
    except Exception:
        pass
    return conn


def db_reachable(path=None):
    """True if the events DB can actually be opened and queried.

    Distinguishes "there are simply no events yet" from "the DB cannot be
    read right now" (permissions, corruption, locked/unavailable directory)
    so the dashboard can surface a real problem instead of silently showing
    an empty Events page.
    """
    try:
        conn = connect(path)
        try:
            conn.execute("SELECT 1").fetchone()
        finally:
            conn.close()
        return True
    except Exception:
        return False


def _existing_columns(conn, table):
    """Return the set of column names on *table*."""
    try:
        rows = conn.execute("PRAGMA table_info(%s)" % table).fetchall()
        return {r[1] for r in rows}
    except Exception:
        return set()


def init_db(conn):
    """Create the schema on an existing connection.

    Also adds columns introduced after the initial release to existing
    tables via ALTER TABLE ADD COLUMN so historical data is preserved.
    Idempotent: every step is IF NOT EXISTS-style."""
    conn.executescript(SCHEMA)
    existing = _existing_columns(conn, "events")
    for col, decl in _EVENT_COLUMNS.items():
        if col not in existing:
            try:
                conn.execute("ALTER TABLE events ADD COLUMN %s %s" % (col, decl))
            except Exception:
                pass
    existing_known = _existing_columns(conn, "known_devices")
    for col, decl in _KNOWN_COLUMNS.items():
        if col not in existing_known:
            try:
                conn.execute("ALTER TABLE known_devices ADD COLUMN %s %s" % (col, decl))
            except Exception:
                pass
    conn.commit()


def init_if_needed(path=None):
    """Ensure the database file and its schema exist. Returns True on
    success, False on any failure (so callers can degrade gracefully)."""
    try:
        db_file = path or EVENTS_DB
        parent = os.path.dirname(db_file)
        if parent:
            os.makedirs(parent, exist_ok=True)
        conn = connect(db_file)
        try:
            init_db(conn)
        finally:
            conn.close()
        return True
    except Exception:
        return False


def _now_iso():
    return time.strftime("%Y-%m-%d %H:%M:%S")


@retry(
    retry=retry_if_exception_type(sqlite3.OperationalError),
    stop=stop_after_attempt(4),
    wait=wait_exponential(multiplier=0.05, min=0.05, max=1.0),
    reraise=True,
)
def insert_event(conn, event):
    """Insert one event dict, serialising the detail payload to JSON.
    Duplicate log lines (same source_hash) are silently ignored.
    Returns the new row id, or None if the row was skipped or failed.

    The event dict may carry extra optional fields introduced for the
    session-aggregation / alert features:
      ``category``      -- noise / messaging / social / entertainment / browsing / unknown
      ``first_seen``    -- ISO timestamp (session start)
      ``last_seen``     -- ISO timestamp (last activity in the session)
      ``request_count`` -- int (number of DNS queries in the session)
      ``alert_type``    -- 'forbidden' / 'watched' / '' for normal events
      ``priority``      -- 'high' / 'normal' / ''
    Missing fields default to safe values so callers can keep using the
    old event shape (just timestamp / client_mac / event_type / detail /
    source_hash) without changes."""
    detail = event.get("detail")
    if isinstance(detail, (dict, list)):
        detail = json.dumps(detail)
    else:
        detail = str(detail or "")
    try:
        cur = conn.execute(
            "INSERT OR IGNORE INTO events "
            "(timestamp, client_mac, event_type, detail, source_hash, "
            " category, first_seen, last_seen, request_count, "
            " alert_type, priority) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                event.get("timestamp") or _now_iso(),
                (event.get("client_mac") or "").strip().lower(),
                event.get("event_type") or "unknown",
                detail,
                event.get("source_hash") or None,
                event.get("category") or "",
                event.get("first_seen") or "",
                event.get("last_seen") or "",
                int(event.get("request_count") or 1),
                event.get("alert_type") or "",
                event.get("priority") or "",
            ),
        )
        conn.commit()
        if cur.rowcount == 0:
            return None
        return cur.lastrowid
    except sqlite3.OperationalError:
        raise
    except Exception:
        return None


@retry(
    retry=retry_if_exception_type(sqlite3.OperationalError),
    stop=stop_after_attempt(4),
    wait=wait_exponential(multiplier=0.05, min=0.05, max=1.0),
    reraise=True,
)
def update_session(conn, row_id, last_seen, request_count):
    """Bump last_seen + request_count on an existing session row.

    Used by the Step 2 aggregation path: a matching DNS query within the
    5-minute window doesn't create a new row, it just updates the
    in-progress session.  Returns True on success."""
    try:
        conn.execute(
            "UPDATE events SET last_seen = ?, request_count = ? "
            "WHERE id = ?",
            (last_seen, int(request_count), int(row_id)),
        )
        conn.commit()
        return True
    except sqlite3.OperationalError:
        raise
    except Exception:
        return False


def find_event_by_hash(conn, source_hash):
    """Return the id + request_count of the event row with *source_hash*,
    or None.  Used when an aggregated session insert is ignored as a
    duplicate so the replay bumps the existing row instead of forking a
    new one."""
    if not source_hash:
        return None
    try:
        row = conn.execute(
            "SELECT id, last_seen, request_count FROM events "
            "WHERE source_hash = ?",
            (source_hash,),
        ).fetchone()
        if not row:
            return None
        return {"id": row["id"], "last_seen": row["last_seen"],
                "request_count": row["request_count"] or 1}
    except Exception:
        return None


def find_open_session(conn, client_mac, domain, category, gap_seconds=300,
                      now_epoch=None):
    """Return the id + last_seen + request_count of the most recent
    session-style event row matching (client_mac, domain, category)
    whose last_seen is within *gap_seconds* of *now_epoch*, or None.

    Used by the Step 2 aggregation path.  ``domain`` and ``category``
    are matched against the JSON ``detail`` field because the events
    table doesn't have a dedicated domain column (the detail payload is
    the source of truth).

    *now_epoch* defaults to ``time.time()`` (i.e. wall-clock now).  The
    caller should pass the new event's epoch when feeding historical
    log lines so the gap is measured between the two log entries, not
    between a log entry and the wall clock."""
    if now_epoch is None:
        now_epoch = time.time()
    try:
        # Look at the latest 200 dns_query rows for this MAC to keep the
        # scan cheap; sessions rarely live more than a few minutes.
        rows = conn.execute(
            "SELECT id, last_seen, request_count, detail, timestamp, category "
            "FROM events WHERE event_type = 'dns_query' "
            "  AND client_mac = ? "
            "  AND priority = '' "
            "ORDER BY id DESC LIMIT 200",
            (client_mac.strip().lower(),),
        ).fetchall()
        for r in rows:
            try:
                d = json.loads(r["detail"]) if r["detail"] else {}
            except (ValueError, TypeError):
                d = {}
            if d.get("domain") != domain:
                continue
            # The category is stored on the row; if it's empty (legacy
            # row written before the category column existed), fall back
            # to "unknown" so it still matches a new "unknown" event.
            row_cat = r["category"] if "category" in r.keys() else ""
            if not row_cat:
                row_cat = "unknown"
            if row_cat != category:
                continue
            # Check the gap.
            ts_str = r["last_seen"] or r["timestamp"]
            try:
                ts_epoch = time.mktime(time.strptime(ts_str, "%Y-%m-%d %H:%M:%S"))
            except (ValueError, TypeError):
                continue
            if now_epoch - ts_epoch > gap_seconds:
                continue
            if now_epoch - ts_epoch < 0:
                # Clock skew or out-of-order log line -- still treat as
                # the same session so we don't fork endless rows.
                pass
            return {"id": r["id"], "last_seen": r["last_seen"],
                    "request_count": r["request_count"] or 1}
        return None
    except Exception:
        return None


def query_events(event_type=None, mac=None, from_ts=None, to_ts=None, limit=200):
    """Return recent events as a list of dicts, newest first.

    `mac` is a substring match on the client MAC; `event_type` is exact;
    `from_ts`/`to_ts` are ISO-8601 date/datetime strings.  `limit` is
    clamped to [1, 1000]."""
    try:
        limit = max(1, min(int(limit), 1000))
    except (ValueError, TypeError):
        limit = 200
    try:
        sql = ["SELECT id, timestamp, client_mac, event_type, detail, "
               "       category, first_seen, last_seen, request_count, "
               "       alert_type, priority "
               "FROM events WHERE 1=1"]
        params = []
        if event_type:
            sql.append("AND event_type = ?")
            params.append(event_type)
        if mac:
            sql.append("AND client_mac LIKE ?")
            params.append("%" + mac.strip().lower() + "%")
        if from_ts:
            sql.append("AND COALESCE(NULLIF(last_seen, ''), timestamp) >= ?")
            params.append(from_ts)
        if to_ts:
            sql.append("AND COALESCE(NULLIF(last_seen, ''), timestamp) <= ?")
            params.append(to_ts)
        sql.append("ORDER BY COALESCE(NULLIF(last_seen, ''), timestamp) DESC, id DESC LIMIT ?")
        params.append(limit)
        conn = connect()
        try:
            rows = conn.execute(" ".join(sql), params).fetchall()
        finally:
            conn.close()
        events = []
        for r in rows:
            entry = {
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
                entry["detail"] = json.loads(r["detail"]) if r["detail"] else {}
            except (ValueError, TypeError):
                entry["detail"] = {"raw": r["detail"]}
            events.append(entry)
        return events
    except Exception:
        return []


def count_events(event_type=None, mac=None):
    """Return the number of matching events, or 0 on any failure."""
    try:
        sql = ["SELECT COUNT(*) AS n FROM events WHERE 1=1"]
        params = []
        if event_type:
            sql.append("AND event_type = ?")
            params.append(event_type)
        if mac:
            sql.append("AND client_mac LIKE ?")
            params.append("%" + mac.strip().lower() + "%")
        conn = connect()
        try:
            row = conn.execute(" ".join(sql), params).fetchone()
        finally:
            conn.close()
        return int(row["n"]) if row else 0
    except Exception:
        return 0


def delete_oldest_events(count):
    """Delete the N oldest events by id.  Returns (deleted_count, max_id_deleted)."""
    try:
        conn = connect()
        try:
            rows = conn.execute(
                "SELECT id FROM events ORDER BY id ASC LIMIT ?", (count,)
            ).fetchall()
            ids = [r[0] for r in rows]
            if not ids:
                return 0, 0
            placeholders = ",".join("?" for _ in ids)
            conn.execute(f"DELETE FROM events WHERE id IN ({placeholders})", ids)
            conn.commit()
            return len(ids), max(ids)
        finally:
            conn.close()
    except Exception:
        return 0, 0


def list_event_types():
    """Distinct event types seen so far (for the dashboard filter)."""
    try:
        conn = connect()
        try:
            rows = conn.execute(
                "SELECT DISTINCT event_type FROM events ORDER BY event_type"
            ).fetchall()
        finally:
            conn.close()
        return [r["event_type"] for r in rows]
    except Exception:
        return []


def is_known(mac, conn=None):
    """True if the MAC is already in the known-devices inventory.

    If *conn* is provided it is used directly (caller manages the
    lifecycle); otherwise a short-lived connection is opened/closed."""
    mac = (mac or "").strip().lower()
    if not mac:
        return False
    own_conn = conn is None
    try:
        if own_conn:
            conn = connect()
        try:
            row = conn.execute(
                "SELECT 1 FROM known_devices WHERE mac = ?", (mac,)
            ).fetchone()
        finally:
            if own_conn:
                conn.close()
        return row is not None
    except Exception:
        return False


def get_known(mac):
    """Return the known_devices row for a MAC, or None."""
    mac = (mac or "").strip().lower()
    if not mac:
        return None
    try:
        conn = connect()
        try:
            row = conn.execute(
                "SELECT mac, label, first_seen, device_type, notes, "
                "added_by, added_at FROM known_devices WHERE mac = ?",
                (mac,),
            ).fetchone()
        finally:
            conn.close()
        return dict(row) if row else None
    except Exception:
        return None


@retry(
    retry=retry_if_exception_type(sqlite3.OperationalError),
    stop=stop_after_attempt(4),
    wait=wait_exponential(multiplier=0.05, min=0.05, max=1.0),
    reraise=True,
)
def mark_known(mac, label="known device", first_seen=None, conn=None):
    """Add a device to the known inventory. Returns True if newly added,
    False if it already existed or the operation failed.

    If *conn* is provided it is used directly."""
    mac = (mac or "").strip().lower()
    if not mac:
        return False
    own_conn = conn is None
    try:
        if own_conn:
            conn = connect()
        try:
            cur = conn.execute(
                "INSERT OR IGNORE INTO known_devices (mac, label, first_seen) "
                "VALUES (?, ?, ?)",
                (mac, label, first_seen or _now_iso()),
            )
            conn.commit()
            added = cur.rowcount > 0
        finally:
            if own_conn:
                conn.close()
        return added
    except sqlite3.OperationalError:
        raise
    except Exception:
        return False


@retry(
    retry=retry_if_exception_type(sqlite3.OperationalError),
    stop=stop_after_attempt(4),
    wait=wait_exponential(multiplier=0.05, min=0.05, max=1.0),
    reraise=True,
)
def set_known_label(mac, label, device_type="", notes="", added_by=""):
    """Upsert a known-device row with label and optional metadata.

    Used by the "Mark as known" feature on the Clients page and the
    bulk-import endpoint.  The row is created if it doesn't already
    exist so the function is idempotent.

    Returns True on success, False on failure."""
    mac = (mac or "").strip().lower()
    if not mac:
        return False
    label = str(label or "").strip()
    if not label:
        label = "known device"
    device_type = str(device_type or "").strip()
    notes = str(notes or "").strip()
    added_by = str(added_by or "").strip()
    now = _now_iso()
    try:
        conn = connect()
        try:
            conn.execute(
                "INSERT OR IGNORE INTO known_devices "
                "(mac, label, first_seen, device_type, notes, added_by, added_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (mac, label, now, device_type, notes, added_by, now),
            )
            conn.execute(
                "UPDATE known_devices SET label = ?, device_type = ?, "
                "notes = ?, added_by = ? WHERE mac = ?",
                (label, device_type, notes, added_by, mac),
            )
            conn.commit()
        finally:
            conn.close()
        return True
    except sqlite3.OperationalError as exc:
        _log.warning("set_known_label busy for %s: %s", mac, exc)
        return False
    except Exception as exc:
        _log.warning("set_known_label failed for %s: %s", mac, exc)
        return False


def list_known_devices():
    """All devices in the inventory, oldest first, as list of dicts."""
    try:
        conn = connect()
        try:
            rows = conn.execute(
                "SELECT mac, label, first_seen, device_type, notes, "
                "added_by, added_at FROM known_devices "
                "ORDER BY first_seen, mac"
            ).fetchall()
        finally:
            conn.close()
        return [dict(r) for r in rows]
    except Exception:
        return []


@retry(
    retry=retry_if_exception_type(sqlite3.OperationalError),
    stop=stop_after_attempt(4),
    wait=wait_exponential(multiplier=0.05, min=0.05, max=1.0),
    reraise=True,
)
def remove_known(mac):
    """Remove a device from the known inventory.  Returns True on
    success, False on failure.  The device will be re-classified as
    unknown on its next connection."""
    mac = (mac or "").strip().lower()
    if not mac:
        return False
    try:
        conn = connect()
        try:
            conn.execute("DELETE FROM known_devices WHERE mac = ?", (mac,))
            conn.commit()
        finally:
            conn.close()
        return True
    except sqlite3.OperationalError:
        raise
    except Exception:
        return False
