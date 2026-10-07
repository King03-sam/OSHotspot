#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

"""Server-Sent Events (SSE) endpoint for the OSHotspot dashboard.

Implements the unified ``/api/live-stream`` endpoint described in
Step 5 of the brief.  The endpoint:

1. Validates the auth token (same mechanism as every other /api route).
2. Opens a single long-lived HTTP response with
   ``Content-Type: text/event-stream``.
3. Subscribes to the in-process pub/sub bus in :mod:`events.live_bus`
   so events published by the collector (running in the same Python
   interpreter) are pushed to the browser instantly.
4. Also polls the SQLite-backed ring buffer in :mod:`events.live_bus`
   every ~1 second so events published by a separately-launched
   collector process are also picked up.
5. Sends a heartbeat comment every ~15 seconds so reverse proxies /
   browsers don't kill idle connections.
6. Catches ``BrokenPipeError`` / connection errors and unsubscribes
   cleanly so closing a browser tab doesn't leak threads or file
   descriptors.

The handler is designed to be called from
``BaseHTTPRequestHandler.do_GET`` -- it takes over the response and
blocks the worker thread until the client disconnects.  Because the
server is a ``ThreadingHTTPServer``, each browser tab gets its own
worker thread, so a long-lived SSE connection doesn't block other
clients.

The frontend opens ONE ``EventSource('/api/live-stream')`` connection
per browser tab (regardless of how many dashboard sections are visible)
and dispatches incoming messages by ``type`` to whichever page section
is currently listening.  Pages that don't need real-time updates
(Configuration, Diagnostics, About, Domain Policy list view) don't
subscribe at all.
"""

import json
import os
import threading
import time

from . import settings
from . import auth

# Optional imports -- both the live bus and the event DB are additive
# components.  If either is unavailable the SSE endpoint still works,
# it just won't have anything interesting to stream beyond heartbeats.
try:
    from events import live_bus
except ImportError:
    live_bus = None

try:
    from events import db as events_db
except ImportError:
    events_db = None

try:
    from events import classify
except ImportError:
    classify = None


def _send_sse_headers(handler):
    """Write the HTTP response head for a text/event-stream response."""
    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
    handler.send_header("Cache-Control", "no-cache, no-transform")
    handler.send_header("Connection", "keep-alive")
    # X-Accel-Buffering: no -- disables buffering on nginx when the
    # dashboard is ever reverse-proxied through it.  Harmless on bare
    # http.server.
    handler.send_header("X-Accel-Buffering", "no")
    handler.send_security_headers()
    handler.end_headers()


def _write_event(handler, data, sse_id=None):
    """Write one SSE event to the response stream and flush.

    *data* may be a dict (auto-JSON-encoded) or a string.  *sse_id* must
    be the ring-buffer row id when draining live.db -- never the session
    id embedded in the JSON payload.  Returns True on success, False if
    the client has disconnected (BrokenPipe / ConnectionError)."""
    if isinstance(data, (dict, list)):
        text = json.dumps(data, default=str)
    else:
        text = str(data)
    # Only ring-buffer rows get an SSE id: line so Last-Event-ID stays
    # compatible with live_bus.drain().  Hello / in-process duplicates
    # omit the id line so reconnect cursors are never poisoned by
    # millisecond timestamps or session DB ids.
    id_line = f"id: {sse_id}\n" if sse_id is not None else ""
    payload = "data: " + text.replace("\n", "\ndata: ") + "\n\n"
    try:
        handler.wfile.write(id_line.encode("utf-8"))
        handler.wfile.write(payload.encode("utf-8"))
        handler.wfile.flush()
        return True
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError,
            OSError):
        return False


def _write_heartbeat(handler):
    """Write an SSE comment (``: keepalive\\n\\n``) so the connection
    stays alive without delivering a payload."""
    try:
        handler.wfile.write(b": keepalive\n\n")
        handler.wfile.flush()
        return True
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError,
            OSError):
        return False


def _coerce_message(payload):
    """Best-effort decode of a live-bus payload into a JSON-friendly object."""
    if isinstance(payload, (dict, list)):
        return payload
    if isinstance(payload, bytes):
        try:
            payload = payload.decode("utf-8", "replace")
        except Exception:
            return str(payload)
    if isinstance(payload, str):
        try:
            return json.loads(payload)
        except Exception:
            return payload
    return payload


# Replay this many recent ring-buffer rows on a fresh SSE connection so
# events published just before the tab opened are not missed.
_RING_REPLAY = 50

# Only events published within this many seconds of the connection are
# eligible for the on-connect replay.  The ring buffer is durable across
# restarts, so without this cap a fresh browser tab after a server
# restart would re-emit events from before the restart -- past events
# must stay in the past.
_RING_REPLAY_WINDOW = 60


def _resolve_ring_cursor(handler):
    """Return the ring-buffer drain cursor for this SSE connection.

    Validates Last-Event-ID against the ring buffer.  Old server versions
    sent session DB ids or millisecond timestamps as SSE ids, which made
    reconnect cursors jump past the end of live_stream_events and silence
    the feed permanently.

    The on-connect replay baseline is clamped both by count
    (``_RING_REPLAY``) and by recency (``_RING_REPLAY_WINDOW``), so a
    freshly-opened tab only catches up on events from the last minute."""
    if live_bus is None:
        return 0
    try:
        latest = live_bus.latest_id()
    except Exception:
        return 0
    replay_start = max(0, latest - _RING_REPLAY)
    try:
        recent_from = live_bus.min_id_newer_than(time.time() - _RING_REPLAY_WINDOW)
        if recent_from:
            # recent_from is the first eligible id; to read it we start
            # at recent_from - 1.
            replay_start = max(replay_start, recent_from - 1)
    except Exception:
        pass
    header_id = handler.headers.get("Last-Event-ID")
    if not header_id or not header_id.isdigit():
        return replay_start
    hid = int(header_id)
    # Poisoned cursors from old bugs: ms timestamps or ids far beyond ring.
    if hid > 10**12 or hid > latest + 1000:
        return replay_start
    # Clamp the resume cursor to the recent window as well: a cursor from
    # before a server restart must not dump that history onto the screen.
    # Clients that are merely reconnecting mid-feed have a cursor inside
    # the window and are unaffected.
    return max(replay_start, hid - 1)


def stream(handler):
    """Main SSE loop.  Blocks the calling worker thread until the
    client disconnects (or the server shuts down).

    The handler must have already passed the auth token check before
    calling this function."""
    _send_sse_headers(handler)

    # Send an initial hello event so the browser knows the connection
    # is alive and what protocol version we speak.
    hello = {"type": "hello", "ts": int(time.time()),
             "version": 1}
    if not _write_event(handler, hello):
        return

    # Subscribe to the in-process bus (instant delivery when the
    # collector runs in the same interpreter).
    sub = None
    if live_bus is not None:
        sub = live_bus.subscribe()

    # Catch-up cursor for the cross-process ring buffer.
    last_ring_id = _resolve_ring_cursor(handler)

    last_heartbeat = time.time()
    last_ring_poll = time.time()
    heartbeat_every = 15.0      # seconds -- full SSE comment heartbeat
    disconnect_ping_every = 1.0 # seconds -- tiny write to detect dead clients
    last_ping = time.time()
    ring_poll_every = 0.2       # seconds -- smooth, sub-second live streaming

    try:
        while True:
            now = time.time()

            # 1) Drain in-process subscriber (blocks up to ~1 s).
            had_items = False
            if sub is not None:
                items = sub.wait_for(timeout=1.0)
                had_items = bool(items)
                for _text in items:
                    try:
                        # In-process delivery has no ring row id; omit SSE
                        # id so Last-Event-ID tracks ring buffer only.
                        if not _write_event(handler, _coerce_message(_text)):
                            return
                    except Exception:
                        return

            # 2) Poll the cross-process ring buffer.
            if live_bus is not None and now - last_ring_poll >= ring_poll_every:
                last_ring_poll = now
                try:
                    rows = live_bus.drain(last_ring_id, limit=200)
                    for row_id, msg in rows:
                        if row_id > last_ring_id:
                            last_ring_id = row_id
                        if not _write_event(handler, _coerce_message(msg),
                                            sse_id=row_id):
                            return
                except Exception:
                    pass

            # 3) Heartbeat.  We send a tiny keepalive comment every
            #    ``disconnect_ping_every`` seconds (default 1s) so we
            #    detect a broken connection within ~1 second of the
            #    client closing the tab.  Without this, the loop would
            #    spin in sub.wait_for() forever (when no events are
            #    arriving) and never notice the socket is gone, which
            #    would leak the subscriber + the worker thread.
            if now - last_ping >= disconnect_ping_every:
                last_ping = now
                if not _write_heartbeat(handler):
                    return

            # 4) A fuller "ready" heartbeat every 15 seconds -- helps
            #    reverse proxies that have their own idle timeout.
            if now - last_heartbeat >= heartbeat_every:
                last_heartbeat = now
                # Just reuse the same keepalive comment.
                if not _write_heartbeat(handler):
                    return
    finally:
        # Always clean up the subscriber so we don't leak memory when
        # the browser tab closes.
        if sub is not None and live_bus is not None:
            try:
                live_bus.unsubscribe(sub)
            except Exception:
                pass
