#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

"""In-process pub/sub bus for live dashboard events.

The event collector (:mod:`events.tailer`) is the only writer; the
unified SSE endpoint (:mod:`web.server.live_stream`) is the only
reader(s).  Both live in the same Python interpreter when the dashboard
is launched by ``oshotspot web`` -- but the collector is normally a
separate process started by ``scripts/start.sh``.

To bridge the two without adding a new IPC channel or DB polling load,
this module:

1. Provides an in-memory bus that the SSE endpoint subscribes to.  When
   the collector runs *in the same process* (e.g. when the dashboard
   launches the collector in a thread, or for testing), events are
   delivered instantly.

2. Also writes every published event to a small SQLite-backed ring
   buffer table (``live_stream_events``) so a separately-launched
   collector process can leave a "tail" for the SSE endpoint to drain
   via short polling.  This keeps the implementation simple (no named
   pipes, no UNIX sockets, no extra dependencies) while still being
   near-real-time (sub-second).

The bus is intentionally tiny and dependency-free.  It degrades to a
no-op if SQLite is unavailable.
"""

import json
import logging
import os
import sqlite3
import threading
import time

from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

_log = logging.getLogger(__name__)

_BUS_PATH = os.environ.get(
    "OSHOTSPOT_LIVE_DB",
    "/var/log/oshotspot/live.db",
)

# In-memory subscribers.  Each subscriber is a thread-safe queue-like
# object with a ``put(item)`` method (we use a simple list + Condition
# here to avoid pulling in ``queue``).
_subscribers = []
_sub_lock = threading.Lock()


class _Subscriber:
    """A single SSE subscriber's buffer.

    The SSE handler thread creates one of these, registers it, then
    loops calling :py:meth:`wait_for` which blocks until a new event
    arrives or *timeout* seconds elapse.  When the browser tab closes,
    the handler thread calls :py:meth:`close` to deregister itself and
    free its slot."""

    def __init__(self):
        self._items = []
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._closed = False

    def put(self, item):
        with self._cond:
            if self._closed:
                return
            # Cap the per-subscriber backlog so a slow client can't
            # consume unbounded memory.
            if len(self._items) < 500:
                self._items.append(item)
            self._cond.notify_all()

    def wait_for(self, timeout=15.0):
        """Block until at least one event is available, then return all
        queued items as a list.  Returns an empty list on timeout."""
        with self._cond:
            if not self._items and not self._closed:
                self._cond.wait(timeout=timeout)
            if self._closed:
                return []
            items = self._items
            self._items = []
            return items

    def close(self):
        with self._cond:
            self._closed = True
            self._items = []
            self._cond.notify_all()


def subscribe():
    """Register a new SSE subscriber.  Returns the subscriber object.

    The caller MUST call ``.close()`` when done (e.g. in a ``finally``
    block) so the slot is freed and the server doesn't leak threads /
    memory when browser tabs close."""
    sub = _Subscriber()
    with _sub_lock:
        _subscribers.append(sub)
    return sub


def unsubscribe(sub):
    """Deregister a subscriber.  Safe to call multiple times."""
    if sub is None:
        return
    sub.close()
    with _sub_lock:
        try:
            _subscribers.remove(sub)
        except ValueError:
            pass


def _deliver_local(item):
    """Push *item* to every in-process subscriber.  Best effort."""
    with _sub_lock:
        subs = list(_subscribers)
    for sub in subs:
        try:
            sub.put(item)
        except Exception:
            # A misbehaving subscriber shouldn't break the others.
            pass


# ---------------------------------------------------------------------------
# SQLite-backed ring buffer -- so a separately-launched collector process
# can publish events that an SSE endpoint in another process will drain.
# ---------------------------------------------------------------------------

# Persistent connection used by publish() to avoid open/close per event.
# Only used by the writer process (tailer).  drain() and latest_id()
# keep their own short-lived connections (called from the web server).
_ring_conn = None
_ring_lock = threading.Lock()

# Counter to batch the ring-buffer trim operation.  Running the DELETE
# subquery on every INSERT is O(n); we only run it every _TRIM_EVERY
# inserts to keep write throughput high under heavy event rates.
_insert_count = 0
_TRIM_EVERY = 100


def _fix_db_permissions():
    """Ensure SQLite live.db and WAL files have world-writable 0666 permissions
    so both root (tailer) and non-root (web server) processes can read/write."""
    try:
        for ext in ["", "-wal", "-shm", "-journal"]:
            p = _BUS_PATH + ext
            if os.path.isfile(p):
                try:
                    os.chmod(p, 0o666)
                except Exception:
                    pass
    except Exception:
        pass


def _open_ring():
    """Open the ring-buffer DB, creating the table if needed.  Returns
    a connection or None on failure."""
    try:
        parent = os.path.dirname(_BUS_PATH)
        if parent:
            os.makedirs(parent, exist_ok=True)
            try:
                os.chmod(parent, 0o777)
            except Exception:
                pass
        conn = sqlite3.connect(_BUS_PATH, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS live_stream_events ("
            "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "  ts REAL NOT NULL,"
            "  msg TEXT NOT NULL"
            ")"
        )
        conn.commit()
        _fix_db_permissions()
        return conn
    except Exception:
        _fix_db_permissions()
        return None


def _get_ring_conn():
    """Return the persistent ring-buffer connection, reconnecting if needed."""
    global _ring_conn
    with _ring_lock:
        if _ring_conn is not None:
            try:
                _ring_conn.execute("SELECT 1")
                return _ring_conn
            except Exception:
                try:
                    _ring_conn.close()
                except Exception:
                    pass
                _ring_conn = None
        conn = _open_ring()
        if conn is not None:
            _ring_conn = conn
        return _ring_conn


def reset_ring_conn():
    """Close the persistent ring-buffer connection.  For cleanup."""
    global _ring_conn
    with _ring_lock:
        if _ring_conn is not None:
            try:
                _ring_conn.close()
            except Exception:
                pass
            _ring_conn = None


def _ring_insert(text):
    """Insert one event into the ring buffer.  Retries on transient SQLite errors."""
    global _insert_count
    conn = _get_ring_conn()
    if conn is None:
        return True
    try:
        conn.execute(
            "INSERT INTO live_stream_events (ts, msg) VALUES (?, ?)",
            (time.time(), text),
        )
        _insert_count += 1
        if _insert_count % _TRIM_EVERY == 0:
            conn.execute(
                "DELETE FROM live_stream_events WHERE id NOT IN "
                "(SELECT id FROM live_stream_events ORDER BY id DESC LIMIT 1000)"
            )
        conn.commit()
        _fix_db_permissions()
        return True
    except Exception:
        with _ring_lock:
            if _ring_conn is not None:
                try:
                    _ring_conn.close()
                except Exception:
                    pass
                _ring_conn = None
        raise


@retry(
    retry=retry_if_exception_type(sqlite3.OperationalError),
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=0.05, min=0.05, max=0.5),
    reraise=True,
)
def _ring_insert_with_retry(text):
    """Insert with retry on 'database is locked' errors."""
    return _ring_insert(text)


def publish(message):
    """Publish one message dict to every subscriber and to the ring.

    *message* must be JSON-serialisable.  Returns True if at least one
    delivery channel succeeded (in-memory or on-disk)."""
    try:
        text = json.dumps(message, default=str)
    except Exception:
        try:
            text = json.dumps({"type": "error",
                               "error": "unserialisable message"})
        except Exception:
            return False

    _deliver_local(text)

    try:
        _ring_insert_with_retry(text)
    except Exception:
        pass
    return True


def drain(since_id=0, limit=200):
    """Return a list of (id, msg) tuples whose id > *since_id*, oldest
    first, capped at *limit*.  Used by the SSE endpoint to catch up on
    events published by a separate collector process between polls."""
    conn = _open_ring()
    if conn is None:
        return []
    try:
        rows = conn.execute(
            "SELECT id, msg FROM live_stream_events "
            "WHERE id > ? ORDER BY id ASC LIMIT ?",
            (int(since_id), int(limit)),
        ).fetchall()
        return [(r["id"], r["msg"]) for r in rows]
    except Exception:
        return []
    finally:
        conn.close()


def query_span_anomalies(limit=100):
    """Return the last *limit* SPAN anomaly events from the ring buffer."""
    conn = _open_ring()
    if conn is None:
        return []
    try:
        rows = conn.execute(
            "SELECT msg FROM live_stream_events "
            "WHERE json_extract(msg, '$.type') = 'span_event' "
            "AND json_extract(msg, '$.event_type') = 'anomaly' "
            "ORDER BY id DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
        return [json.loads(r["msg"]) for r in rows]
    except Exception:
        return []
    finally:
        conn.close()


def latest_id():
    """Return the highest id in the ring buffer, or 0 if empty/missing."""
    conn = _open_ring()
    if conn is None:
        return 0
    try:
        row = conn.execute(
            "SELECT MAX(id) AS m FROM live_stream_events"
        ).fetchone()
        return int(row["m"]) if row and row["m"] else 0
    except Exception:
        return 0
    finally:
        conn.close()


def min_id_newer_than(cutoff_ts):
    """Return the smallest ring-buffer id whose ``ts`` is >= *cutoff_ts*,
    or 0 if there is no such row.

    Used by the SSE endpoint to cap the on-connect replay to *recent*
    events only (the ring buffer is durable across restarts, so without
    this cap a fresh connection would re-emit events from before a
    server restart)."""
    if not cutoff_ts:
        return 0
    conn = _open_ring()
    if conn is None:
        return 0
    try:
        row = conn.execute(
            "SELECT id FROM live_stream_events "
            "WHERE ts >= ? ORDER BY id ASC LIMIT 1",
            (float(cutoff_ts),),
        ).fetchone()
        return int(row["id"]) if row else 0
    except Exception:
        return 0
    finally:
        conn.close()
