#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

"""Event collector daemon for OSHotspot.

Tails the dedicated dnsmasq log (DNS queries + DHCP actions), parses the
lines, resolves source IPs to client MACs, and stores structured events in
the SQLite database.  It also reconciles the known-device inventory:

  * a DHCPACK or a newly connected client whose MAC is not in the
    inventory is flagged as an unknown device (an event is stored and an
    alert raised), then remembered so it is only flagged once;

  * bursts of DNS queries from one client (flood) are detected and
    reported once per burst window.

In addition to the legacy behaviour above, this version implements:

  * **Noise categorisation** (Step 1) -- each DNS query is classified
    into ``noise`` / ``messaging`` / ``social`` / ``entertainment`` /
    ``browsing`` / ``unknown``.  Noise queries are *not* inserted into
    the events table (the raw dnsmasq log file still has them for full
    audit), the others are.

  * **Session aggregation** (Step 2) -- consecutive DNS queries from
    the same client MAC toward the same domain/category within a
    rolling 5-minute window are merged into a single ``events`` row
    (``request_count`` is incremented, ``last_seen`` is bumped) instead
    of producing one row per query.

  * **Domain policy alerts** (Step 4) -- queries matching
    ``forbidden_domains`` or ``watched_domains`` are inserted as
    individual high-priority events immediately, bypassing the session
    aggregation window, and pushed onto the SSE live stream.

  * **Live bus publishing** (Step 5) -- every new/updated session,
    every alert and every DHCP/unknown-device event is published to
    :mod:`events.live_bus` so the dashboard's SSE endpoint can stream
    them to the browser without polling.

Everything degrades gracefully: if the log file is missing, the database
cannot be created, or any subsystem fails, the collector keeps running and
picks up again on the next tick.  No data is lost when the log rotates
(rename or copytruncate) and duplicate lines are impossible thanks to the
source_hash column.

Run as root (it is launched by scripts/start.sh).  Use --once for a single
pass (also handy for testing) or --daemon to loop forever.
"""

import argparse
import atexit
import hashlib
import os
import subprocess
import sys
import time
from collections import defaultdict

import pygtail

try:
    from events import parser, db, alert, classify, live_bus, notify
except ImportError:
    import parser
    import db
    import alert
    import classify
    import live_bus
    import notify


DEFAULT_LOG_FILE = "/var/log/oshotspot/dnsmasq.log"
DEFAULT_LEASE_FILE = "/run/oshotspot-dnsmasq.leases"
# Persisted in /var/log/oshotspot (survives reboots) so pygtail does not
# restart at offset 0 after a reboot -- the offset file under /run lived
# on tmpfs and was wiped, forcing the whole log to be re-read.
DEFAULT_STATE_FILE = "/var/log/oshotspot/events.state"
DEFAULT_DB_FILE = "/var/log/oshotspot/events.db"
DEFAULT_SCRIPTS_DIR = "/usr/lib/oshotspot/scripts"

LEASE_REFRESH_INTERVAL = 15
SWEEP_INTERVAL = 60
FLOOD_THRESHOLD = 100
FLOOD_WINDOW = 60

# Session-aggregation gap (Step 2).  Two consecutive DNS queries from
# the same client toward the same domain/category are merged into one
# events row if they are within this many seconds of each other.
SESSION_GAP_SECONDS = 300

# Reject any log line whose timestamp is older than the collector's own
# start by more than this many seconds.  After a reboot (or a pygtail
# copytruncate reset to offset 0) the whole dnsmasq log can be re-read;
# everything pre-dating this process is already processed history and must
# stay in the past -- no re-insert, no SSE re-publish, no re-alert.
STALE_GRACE_SECONDS = 10

# Cap on the in-memory set of source hashes seen this runtime.  It only
# guards against intra-session re-reads (dnsmasq replacing the log file
# without truncating), so a soft ceiling is plenty.
SEEN_HASHES_MAX = 200_000


def _now_iso():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _event_epoch(event):
    """Best-effort epoch for an event's timestamp (local time)."""
    try:
        return time.mktime(time.strptime(event["timestamp"], "%Y-%m-%d %H:%M:%S"))
    except (ValueError, TypeError, KeyError):
        return time.time()


class Collector:
    def __init__(self, args):
        self.args = args
        self.db_file = args.db
        self.last_event = None
        self.last_leases = {}
        self.last_lease_load = 0.0
        self.last_sweep = 0.0
        self.query_times = defaultdict(list)
        self._notif_cooldown = {}  # key -> timestamp (throttle live bell notifications)
        # Start-of-process watermark: any log line timestamped before this
        # (minus the stale grace) belongs to a previous session and is
        # skipped, so a restart never replays past events.
        self.start_epoch = time.time()
        # Raw source hashes already handled in this runtime.  Guards
        # against intra-session re-reads where pygtail resets to offset 0
        # (copytruncate) while the new log file still carries old lines.
        self._seen_hashes = set()
        self.conn = None
        # Policy cache: avoids re-reading noise_patterns / forbidden /
        # watched tables on every DNS query.  Auto-refreshes every few
        # seconds so dashboard edits show up quickly.
        self.policy = classify.PolicyCache(self.db_file, ttl=5.0)

    def open_db(self):
        """Open (or reopen) the database connection. Closes any existing one first."""
        if self.conn is not None:
            try:
                self.conn.close()
            except Exception:
                pass
            self.conn = None
        try:
            if db.init_if_needed(self.db_file):
                # Seed the noise_patterns / forbidden_domains /
                # watched_domains tables with defaults on a fresh DB.
                classify.init_policy_tables(self.db_file)
                self.conn = db.connect(self.db_file)
                # Make sure the policy cache picks up the freshly-seeded
                # tables on the first query.
                self.policy.invalidate()
                return True
        except Exception:
            self.conn = None
        return False

    def _load_leases(self):
        now = time.time()
        if not self.last_leases or now - self.last_lease_load >= LEASE_REFRESH_INTERVAL:
            self.last_leases = parser.load_leases(self.args.lease_file)
            self.last_lease_load = now
        return self.last_leases

    def reconcile_mac(self, mac, hostname=""):
        """Flag an unknown device once, then remember it forever."""
        mac = parser.normalize_mac(mac)
        if not mac:
            return
        if db.is_known(mac, conn=self.conn):
            return
        if not db.mark_known(mac, "unknown device", _now_iso(), conn=self.conn):
            return
        detail = {
            "client_mac": mac,
            "client_hostname": hostname or "",
            "hostname": hostname or "",
            "known_label": "unknown device",
            "label": "unknown device",
            "event_type": "unknown_device",
        }
        ts = _now_iso()
        if self.conn is not None:
            db.insert_event(self.conn, {
                "timestamp": ts,
                "client_mac": mac,
                "event_type": "unknown_device",
                "detail": detail,
            })
        alert.alert(
            "Unknown device joined the hotspot: {} ({})".format(
                mac, hostname or "no hostname"
            ),
            level="ALERT",
            extra=detail,
            category="unknown_device",
        )
        # Push to the live bus so the dashboard's SSE endpoint can
        # surface it instantly on the Live Activity area.
        live_bus.publish({
            "type": "client_change",
            "subtype": "unknown_device",
            "timestamp": ts,
            "client_mac": mac,
            "hostname": hostname or "",
            "known_label": "unknown device",
        })
        notify.publish(
            "unknown_client",
            "Unknown device joined: {} ({})".format(mac, hostname or "no hostname"),
        )

    def check_flood(self, mac, epoch):
        """Return True once per burst of DNS queries above the threshold."""
        if not mac:
            return False
        times = self.query_times[mac]
        cutoff = epoch - self.args.flood_window
        while times and times[0] < cutoff:
            times.pop(0)
        times.append(epoch)
        if len(times) >= self.args.flood_threshold:
            self.query_times[mac] = []
            return True
        return False

    def _hostname_for_mac(self, mac):
        mac = parser.normalize_mac(mac)
        if not mac:
            return ""
        try:
            with open(self.args.lease_file, "r", errors="replace") as f:
                for line in f:
                    parts = line.split()
                    if len(parts) >= 4 and parts[1].strip().lower() == mac:
                        return "" if parts[3] == "*" else parts[3]
        except OSError:
            pass
        return ""

    def _known_label_for_mac(self, mac):
        mac = parser.normalize_mac(mac)
        if not mac:
            return ""
        try:
            known = db.get_known(mac)
            return (known or {}).get("label", "")
        except Exception:
            return ""

    # ------------------------------------------------------------------
    # New: Step 1 + Step 2 + Step 4 plumbing for DNS queries
    # ------------------------------------------------------------------

    def _publish_dns_event(self, event_dict, session_id=None, is_update=False):
        """Publish a dns_event message to the live bus.

        Called for both new sessions (insert) and updates to existing
        sessions.  The frontend uses ``is_update`` to decide whether to
        prepend a new row or update the matching one in place."""
        try:
            mac = event_dict.get("client_mac", "")
            live_bus.publish({
                "type": "dns_event",
                "id": session_id,
                "is_update": bool(is_update),
                "timestamp": event_dict.get("timestamp", _now_iso()),
                "client_mac": mac,
                "hostname": self._hostname_for_mac(mac),
                "known_label": self._known_label_for_mac(mac),
                "event_type": "dns_query",
                "detail": event_dict.get("detail", {}),
                "category": event_dict.get("category", ""),
                "first_seen": event_dict.get("first_seen", ""),
                "last_seen": event_dict.get("last_seen", ""),
                "request_count": event_dict.get("request_count", 1),
                "priority": event_dict.get("priority", ""),
                "alert_type": event_dict.get("alert_type", ""),
            })
        except Exception:
            pass

    def _publish_alert(self, event_dict, session_id=None):
        """Publish an alert message to the live bus."""
        try:
            mac = event_dict.get("client_mac", "")
            live_bus.publish({
                "type": "alert",
                "id": session_id,
                "timestamp": event_dict.get("timestamp", _now_iso()),
                "client_mac": mac,
                "hostname": self._hostname_for_mac(mac),
                "known_label": self._known_label_for_mac(mac),
                "event_type": event_dict.get("event_type", "dns_query"),
                "alert_type": event_dict.get("alert_type", ""),
                "priority": event_dict.get("priority", "high"),
                "detail": event_dict.get("detail", {}),
                "category": event_dict.get("category", ""),
            })
        except Exception:
            pass

    def _handle_dns_query(self, event):
        """Step 1 + 2 + 4: classify, filter noise, aggregate, alert.

        - Noise queries: dropped (not inserted, not published).  The
          raw dnsmasq log file still contains them.
        - Forbidden/watched matches: inserted as individual high-priority
          events immediately, never batched.  Pushed onto the live bus
          as ``alert`` messages.
        - Everything else: aggregated into a session row (insert or
          update).  Pushed onto the live bus as ``dns_event`` messages.
        """
        domain = classify.normalize_domain(event.get("domain", ""))
        mac = (event.get("client_mac") or "").strip().lower()
        ip = event.get("ip", "")
        ts = event.get("timestamp") or _now_iso()
        qtype = event.get("query_type", "A")

        # Ignore internal system warm-up/health queries originating from localhost
        if ip in ("127.0.0.1", "::1", "localhost"):
            return

        # Pull the current policy lists from the cache.
        noise_patterns = self.policy.patterns("noise_patterns")
        forbidden_patterns = self.policy.patterns("forbidden_domains")
        watched_patterns = self.policy.patterns("watched_domains")

        # Step 4 first: policy alerts bypass everything else.
        policy = classify.check_policy(domain, forbidden_patterns, watched_patterns)
        if policy.get("forbidden") or policy.get("watched"):
            alert_type = "forbidden" if policy["forbidden"] else "watched"
            matched = policy[alert_type]
            detail = {
                "domain": domain,
                "query_type": qtype,
                "ip": ip,
                "matched_pattern": matched,
                "alert_type": alert_type,
            }
            # High-priority events always have a fresh source_hash so
            # they're never deduped against the raw log line.  Use a
            # distinct prefix so they don't collide with the legacy
            # dns_query source_hash either.
            src = "alert:{}:{}:{}:{}".format(alert_type, mac, domain, ts)
            event_dict = {
                "timestamp": ts,
                "first_seen": ts,
                "last_seen": ts,
                "client_mac": mac,
                "event_type": "dns_query",
                "detail": detail,
                "category": "alert",
                "alert_type": alert_type,
                "priority": "high",
                "request_count": 1,
                "source_hash": hashlib.sha1(src.encode("utf-8", "replace")).hexdigest(),
            }
            session_id = None
            if self.conn is not None:
                session_id = db.insert_event(self.conn, event_dict)
            self._publish_alert(event_dict, session_id=session_id)
            hostname = self._hostname_for_mac(mac)
            known_label = self._known_label_for_mac(mac)
            alert_detail = dict(detail)
            alert_detail.update({
                "client_mac": mac or "",
                "client_ip": ip or "",
                "client_hostname": hostname or "",
                "known_label": known_label or "",
                "domain": domain,
                "matched_pattern": matched,
                "rule_type": alert_type.upper(),
            })
            # Trigger the existing optional SMTP alert mechanism.
            alert.alert(
                "{} domain match: {} ({}) for client {}".format(
                    alert_type.upper(), domain, matched,
                    mac or ip or "unknown"),
                level="ALERT",
                extra=alert_detail,
                category=alert_type.lower() + "_domain",
            )
            
            # Format clean client identity string
            client_parts = []
            if known_label and known_label != "unknown device":
                client_parts.append(known_label)
            if hostname:
                client_parts.append(hostname)
            client_parts.append(mac or ip or "unknown")
            client_str = " / ".join(client_parts)
            
            # Throttle persistent bell notifications (1 per 10s per client+domain)
            # to avoid browser memory crash during intense DNS bursts, while keeping
            # live events feed and DB historical recording 100% real-time.
            now_ts = time.time()
            client_id = mac or ip or "unknown"
            notif_key = f"{alert_type}:{client_id}:{domain}"
            last_notif = self._notif_cooldown.get(notif_key, 0)
            if now_ts - last_notif >= 10.0:
                self._notif_cooldown[notif_key] = now_ts
                # Clean up old cooldown entries if dictionary grows large
                if len(self._notif_cooldown) > 1000:
                    self._notif_cooldown = {k: v for k, v in self._notif_cooldown.items() if now_ts - v < 60.0}
                notify.publish(
                    "forbidden_domain" if alert_type == "forbidden" else "watched_domain",
                    "{} domain hit: {} ({}) by {}".format(
                        alert_type.upper(), domain, matched, client_str
                    ),
                    related_event_id=session_id,
                )
            return

        # Step 1: classify.  Noise is dropped here.
        info = classify.classify_domain(domain, noise_patterns)
        category = info["category"]
        if category == "noise":
            # Don't insert, don't publish.  Raw log line is preserved
            # untouched in dnsmasq.log for full audit.
            return

        # Step 2: aggregate into a session.
        existing = None
        if self.conn is not None and mac:
            existing = db.find_open_session(
                self.conn, mac, domain, category,
                gap_seconds=SESSION_GAP_SECONDS,
                now_epoch=_event_epoch(event),
            )
        detail = {
            "domain": domain,
            "query_type": qtype,
            "ip": ip,
            "category": category,
        }
        if existing:
            # Update the in-progress session row.
            new_count = int(existing.get("request_count") or 1) + 1
            if self.conn is not None:
                db.update_session(self.conn, existing["id"], ts, new_count)
            event_dict = {
                "timestamp": ts,
                "client_mac": mac,
                "event_type": "dns_query",
                "detail": detail,
                "category": category,
                "first_seen": existing.get("last_seen") or ts,
                "last_seen": ts,
                "request_count": new_count,
                "priority": "",
                "alert_type": "",
            }
            self._publish_dns_event(event_dict, session_id=existing["id"],
                                    is_update=True)
        else:
            # New session row.  It carries a deterministic source_hash
            # derived from (client, domain, category, aligned window) so a
            # re-read of the same history can never create a duplicate
            # row.  Two sessions for the same client/domain are at least
            # SESSION_GAP_SECONDS apart, which always advances the aligned
            # window, so distinct live sessions never collide.
            epoch = _event_epoch(event)
            window = int(epoch // SESSION_GAP_SECONDS) * SESSION_GAP_SECONDS
            src = "sess:{}:{}:{}:{}".format(mac, domain, category, window)
            session_hash = hashlib.sha1(
                src.encode("utf-8", "replace")
            ).hexdigest()
            event_dict = {
                "timestamp": ts,
                "first_seen": ts,
                "last_seen": ts,
                "client_mac": mac,
                "event_type": "dns_query",
                "detail": detail,
                "category": category,
                "request_count": 1,
                "priority": "",
                "alert_type": "",
                "source_hash": session_hash,
            }
            session_id = None
            if self.conn is not None:
                session_id = db.insert_event(self.conn, event_dict)
                if session_id is None:
                    # Duplicate hash: this history was already aggregated.
                    # Bump the existing row's counters silently so replay
                    # never forks a row nor re-publishes a "new" event.
                    prior = db.find_event_by_hash(self.conn, session_hash)
                    if prior is not None:
                        try:
                            db.update_session(
                                self.conn, prior["id"], ts,
                                int(prior["request_count"]) + 1,
                            )
                        except Exception:
                            pass
                    else:
                        alert.log_line(
                            "WARN", "Event collector: insert_event "
                            "returned None for domain={}".format(domain)
                        )
            if session_id is not None:
                self._publish_dns_event(event_dict, session_id=session_id,
                                        is_update=False)

    def _is_fresh(self, event):
        """True if *event* is new activity, False if it is replay.

        Two checks:
        1. Timestamp older than the collector's start (minus grace) means
           the line is history re-read after a reboot / offset reset --
           it must not trigger any side effect again.
        2. Source hash already handled this runtime (intra-session
           re-read, e.g. dnsmasq replaced the log without truncating).
        """
        epoch = _event_epoch(event)
        if epoch < self.start_epoch - STALE_GRACE_SECONDS:
            return False
        raw_hash = event.get("source_hash")
        if raw_hash:
            if raw_hash in self._seen_hashes:
                return False
            if len(self._seen_hashes) >= SEEN_HASHES_MAX:
                self._seen_hashes = set()
            self._seen_hashes.add(raw_hash)
        return True

    def handle_event(self, event):
        if not self._is_fresh(event):
            return
        event = parser.adjust_year(event, self.last_event)
        self.last_event = event
        event = parser.resolve_mac(event, self._load_leases())

        etype = event.get("event_type")

        # DNS queries take the new Step 1/2/4 path.  They are *not*
        # passed through db.insert_event directly here -- the new path
        # handles insertion + aggregation + alerting + live-bus publish.
        if etype == "dns_query":
            self._handle_dns_query(event)
            # Flood detection still works on the raw stream (it counts
            if self.check_flood(event.get("client_mac", ""), _event_epoch(event)):
                client_mac = event.get("client_mac", "")
                client_ip = event.get("ip", "")
                hostname = self._hostname_for_mac(client_mac)
                known_label = self._known_label_for_mac(client_mac)
                detail = {
                    "count": self.args.flood_threshold,
                    "query_count": self.args.flood_threshold,
                    "threshold": self.args.flood_threshold,
                    "window": self.args.flood_window,
                    "client_mac": client_mac,
                    "client_ip": client_ip,
                    "client_hostname": hostname or "",
                    "known_label": known_label or "",
                    "ip": client_ip,
                }
                if self.conn is not None:
                    # Deterministic hash so re-reading the same history
                    # never creates a duplicate flood row.
                    flood_window_start = int(
                        _event_epoch(event) // self.args.flood_window
                    )
                    flood_src = "flood:{}:{}".format(
                        client_mac, flood_window_start
                    )
                    db.insert_event(self.conn, {
                        "timestamp": event.get("timestamp") or _now_iso(),
                        "client_mac": client_mac,
                        "event_type": "anomaly_dns_flood",
                        "detail": detail,
                        "priority": "high",
                        "alert_type": "flood",
                        "source_hash": hashlib.sha1(
                            flood_src.encode("utf-8", "replace")
                        ).hexdigest(),
                    })
                alert.alert(
                    "DNS query flood from client {} (>{} queries in {}s)".format(
                        client_mac or client_ip or "unknown",
                        self.args.flood_threshold,
                        self.args.flood_window,
                    ),
                    level="ALERT",
                    extra=detail,
                    category="dns_flood",
                )
                live_bus.publish({
                    "type": "alert",
                    "timestamp": event.get("timestamp") or _now_iso(),
                    "client_mac": event.get("client_mac", ""),
                    "hostname": self._hostname_for_mac(event.get("client_mac", "")),
                    "known_label": self._known_label_for_mac(event.get("client_mac", "")),
                    "event_type": "anomaly_dns_flood",
                    "alert_type": "flood",
                    "priority": "high",
                    "detail": detail,
                })
                notify.publish(
                    "flood",
                    "DNS query flood from {} (>{q} queries in {w}s)".format(
                        event.get("client_mac") or event.get("ip", "unknown"),
                        q=self.args.flood_threshold,
                        w=self.args.flood_window,
                    ),
                )
            return

        # All non-DNS events (DHCP actions, unknown_device, anomaly_*,
        # etc.) take the legacy path: insert + (for dhcp_ack) reconcile.
        if self.conn is not None:
            db.insert_event(self.conn, event)

        if etype == "dhcp_ack":
            self.reconcile_mac(event.get("client_mac", ""), event.get("hostname", ""))

    def sweep_connected(self):
        """Reconcile currently connected clients against the inventory."""
        macs = {}
        try:
            out = subprocess.run(
                ["bash", "-c", "source {}; read_connected_clients".format(
                    os.path.join(self.args.scripts_dir, "utils.sh"))],
                capture_output=True,
                text=True,
                timeout=15,
            ).stdout
            for line in out.splitlines():
                parts = line.strip().split("|")
                if len(parts) >= 1:
                    mac = parser.normalize_mac(parts[0])
                    host = parts[2] if len(parts) >= 3 else ""
                    if mac:
                        macs[mac] = host
        except Exception:
            return
        for mac, host in macs.items():
            self.reconcile_mac(mac, host)

    def _make_tail(self):
        """Return a pygtail reader for the dnsmasq log, or None.

        Handles the state-file migration: the old custom reader wrote
        a single "inode offset" line, which pygtail cannot parse.  If
        that (or any other) format error is hit, the stale state file
        is discarded so pygtail starts fresh.  Re-processing already
        seen lines is harmless because the DB deduplicates on
        source_hash."""
        state = self.args.state_file
        try:
            return pygtail.Pygtail(
                self.args.log_file,
                offset_file=state,
                # dnsmasq restarts replace/reopen the log file (new inode)
                # without a logrotate-style rename.  copytruncate=True
                # makes pygtail reset its offset to 0 when it cannot find
                # a rotated copy, so lines from the fresh file are read
                # instead of silently seeking past EOF forever.  Re-reads
                # are harmless: the DB deduplicates on source_hash.
                copytruncate=True,
                save_on_end=True,
            )
        except (ValueError, OSError) as exc:
            alert.log_line("WARN", "Event collector: resetting tail state "
                           "({}), reason: {}".format(state, exc))
            try:
                os.unlink(state)
            except OSError:
                pass
            try:
                return pygtail.Pygtail(
                    self.args.log_file,
                    offset_file=state,
                    copytruncate=True,
                    save_on_end=True,
                )
            except OSError:
                return None

    def run_once(self):
        self._load_leases()
        if self.args.sweep or not self._log_exists():
            self.sweep_connected()
        tail = self._make_tail()
        if tail is None:
            return
        try:
            for line in tail:
                event = parser.parse_line(line)
                if event:
                    # One bad event (e.g. a persistent DB lock after the
                    # retry budget is exhausted) must not abort the whole
                    # tail loop: pygtail only saves its offset at EOF, so
                    # an early abort would re-read the same lines forever.
                    try:
                        self.handle_event(event)
                    except Exception as exc:
                        alert.log_line(
                            "WARN",
                            "Event collector: dropped event "
                            "({})".format(exc),
                        )
        except OSError:
            # Log file missing or temporarily unavailable (e.g. dnsmasq
            # restart).  pygtail's offset file keeps us safe to resume
            # on the next tick with no lines lost or duplicated.
            pass
        if self.args.sweep:
            self.sweep_connected()

    def run(self):
        warned = False
        loop_count = 0
        last_heartbeat = 0.0
        last_sweep_time = 0.0
        known_active_macs = set()

        if not self.open_db():
            alert.log_line("WARN", "Event collector: cannot open database, "
                          "continuing without persistence (will retry)")
            warned = True
        alert.log_line("INFO", "Event collector started")
        try:
            while True:
                now = time.time()
                try:
                    if self.conn is None and not self.open_db():
                        if not warned:
                            alert.log_line("WARN", "Event collector: database "
                                          "still unavailable, persistence disabled")
                            warned = True
                    else:
                        warned = False

                    self.run_once()
                    loop_count += 1

                    # Send periodic heartbeats to live_bus every 5s so SSE stream is never silent
                    if now - last_heartbeat >= 5.0:
                        last_heartbeat = now
                        live_bus.publish({
                            "type": "status_heartbeat",
                            "timestamp": _now_iso(),
                            "tailer_alive": True,
                        })

                    # Track client connects/disconnects every 10s.
                    # NOTE: parser.load_leases() returns {ip: mac}, so the
                    # keys are IPs, not MACs — build a mac -> info map first.
                    # Using leases.get(mac) directly returned a MAC string
                    # (not a dict) and crashed with
                    # "'str' object has no attribute 'get'" on every tick.
                    if now - last_sweep_time >= 10.0:
                        last_sweep_time = now
                        leases = self._load_leases()
                        current = {}
                        for ip, mac in leases.items():
                            if mac:
                                current[mac] = {
                                    "ip": ip,
                                    "hostname": self._hostname_for_mac(mac),
                                }
                        current_macs = set(current.keys())
                        
                        # Disconnected clients
                        for mac in known_active_macs - current_macs:
                            live_bus.publish({
                                "type": "client_change",
                                "subtype": "disconnect",
                                "timestamp": _now_iso(),
                                "client_mac": mac,
                            })

                        # Connected clients
                        for mac in current_macs - known_active_macs:
                            info = current.get(mac, {})
                            live_bus.publish({
                                "type": "client_change",
                                "subtype": "connect",
                                "timestamp": _now_iso(),
                                "client_mac": mac,
                                "hostname": info.get("hostname", ""),
                                "ip": info.get("ip", ""),
                            })

                        known_active_macs = current_macs

                    # Periodic WAL checkpoint to prevent -wal file growth.
                    if self.conn is not None and loop_count % 100 == 0:
                        try:
                            self.conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
                        except Exception:
                            pass
                except Exception as exc:
                    alert.log_line("WARN", "Event collector error: {}".format(exc))
                if self.args.once:
                    break
                time.sleep(self.args.sleep)
        finally:
            if self.conn is not None:
                try:
                    self.conn.close()
                except Exception:
                    pass

    def _log_exists(self):
        return os.path.exists(self.args.log_file)


def build_arg_parser():
    p = argparse.ArgumentParser(
        prog="tailer.py",
        description="OSHotspot event collector (DNS/DHCP logging).",
    )
    p.add_argument("--once", action="store_true",
                   help="process the current log once and exit")
    p.add_argument("--daemon", action="store_true",
                   help="loop forever (default is a single pass)")
    p.add_argument("--log-file", default=DEFAULT_LOG_FILE)
    p.add_argument("--lease-file", default=DEFAULT_LEASE_FILE)
    p.add_argument("--state-file", default=DEFAULT_STATE_FILE)
    p.add_argument("--db", default=db.EVENTS_DB)
    p.add_argument("--scripts-dir", default=DEFAULT_SCRIPTS_DIR)
    p.add_argument("--sleep", type=float, default=0.2)
    p.add_argument("--sweep", action="store_true",
                   help="force a client sweep in --once mode")
    p.add_argument("--flood-threshold", type=int, default=FLOOD_THRESHOLD)
    p.add_argument("--flood-window", type=int, default=FLOOD_WINDOW)
    p.add_argument("--pid-file", default="",
                   help="write PID to this file on start (cleaned up on exit)")
    return p


def main():
    args = build_arg_parser().parse_args()

    # PID file support for the watchdog to monitor.
    if args.pid_file:
        try:
            pid_dir = os.path.dirname(args.pid_file)
            if pid_dir:
                os.makedirs(pid_dir, exist_ok=True)
            with open(args.pid_file, "w") as f:
                f.write(str(os.getpid()))
            def _cleanup_pid():
                try:
                    os.unlink(args.pid_file)
                except Exception:
                    pass
            atexit.register(_cleanup_pid)
        except Exception:
            pass

    collector = Collector(args)
    if args.daemon:
        collector.run()
    else:
        if not collector.open_db():
            alert.log_line("WARN", "Event collector: cannot open database, "
                          "continuing without persistence")
        try:
            collector.run_once()
        finally:
            if collector.conn is not None:
                try:
                    collector.conn.close()
                except Exception:
                    pass


if __name__ == "__main__":
    sys.exit(main())
