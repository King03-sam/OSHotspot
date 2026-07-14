#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

"""Background traffic monitor: tails dnsmasq DNS logs and polls
/proc/net/nf_conntrack to build a lightweight SQLite database of
queries and outbound connections from hotspot clients.

The monitor is a daemon thread started by the web server.  It only
collects data while the hotspot is running (checks the hostapd PID
file).  The database auto-rotates, keeping only the last 24 hours.
"""

import os
import re
import sqlite3
import threading
import time

from . import settings

# Regex for dnsmasq query lines:
#   Jul 14 03:12:29 dnsmasq[1234]: query[A] google.com from 192.168.50.10
_DNS_RE = re.compile(
    r'query\[(A|AAAA|CNAME|PTR|MX|TXT|SRV|SOA|ANY)\]\s+'
    r'(\S+)\s+from\s+(\S+)'
)

# Regex for a single conntrack entry (one direction):
#   src=192.168.50.10 dst=142.250.74.46 sport=49832 dport=443
_CONN_RE = re.compile(
    r'src=(\S+)\s+dst=(\S+)\s+sport=(\d+)\s+dport=(\d+)'
)


def _is_hotspot_running():
    return os.path.isfile(settings.HOSTAPD_PID)


def _ensure_db(db_path):
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS dns_queries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            client_ip TEXT NOT NULL,
            domain TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS connections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            client_ip TEXT NOT NULL,
            dest_ip TEXT NOT NULL,
            dest_port INTEGER,
            proto TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_dns_ts ON dns_queries(ts);
        CREATE INDEX IF NOT EXISTS idx_dns_client ON dns_queries(client_ip);
        CREATE INDEX IF NOT EXISTS idx_conn_ts ON connections(ts);
        CREATE INDEX IF NOT EXISTS idx_conn_client ON connections(client_ip);
    """)
    conn.commit()
    return conn


class TrafficMonitor:
    def __init__(self):
        self._thread = None
        self._stop = threading.Event()
        self._db = None
        self._dns_pos = 0
        self._seen_conns = set()
        self._seen_conns_ts = 0

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._dns_pos = 0
        self._seen_conns = set()
        self._seen_conns_ts = 0
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    # ------------------------------------------------------------------
    # Database query helpers (called from handler.py)
    # ------------------------------------------------------------------

    def get_dns_queries(self, client_ip=None, domain=None, limit=200):
        if not self._db:
            return []
        try:
            sql = "SELECT ts, client_ip, domain FROM dns_queries WHERE 1=1"
            params = []
            if client_ip:
                sql += " AND client_ip = ?"
                params.append(client_ip)
            if domain:
                sql += " AND domain LIKE ?"
                params.append(f"%{domain}%")
            sql += " ORDER BY id DESC LIMIT ?"
            params.append(limit)
            rows = self._db.execute(sql, params).fetchall()
            return [{"ts": r[0], "client_ip": r[1], "domain": r[2]} for r in rows]
        except Exception:
            return []

    def get_connections(self, client_ip=None, limit=200):
        if not self._db:
            return []
        try:
            sql = ("SELECT ts, client_ip, dest_ip, dest_port, proto "
                   "FROM connections WHERE 1=1")
            params = []
            if client_ip:
                sql += " AND client_ip = ?"
                params.append(client_ip)
            sql += " ORDER BY id DESC LIMIT ?"
            params.append(limit)
            rows = self._db.execute(sql, params).fetchall()
            return [
                {"ts": r[0], "client_ip": r[1], "dest_ip": r[2],
                 "dest_port": r[3], "proto": r[4]}
                for r in rows
            ]
        except Exception:
            return []

    def get_summary(self, limit=50):
        if not self._db:
            return {"top_domains": [], "active_clients": [],
                    "total_queries": 0, "total_connections": 0,
                    "tracking_since": 0}
        try:
            top_domains = self._db.execute(
                "SELECT domain, COUNT(*) as cnt FROM dns_queries "
                "GROUP BY domain ORDER BY cnt DESC LIMIT ?", (limit,)
            ).fetchall()

            active_clients = self._db.execute(
                "SELECT client_ip, "
                "  (SELECT COUNT(*) FROM dns_queries d WHERE d.client_ip = c.client_ip) as dns_cnt, "
                "  (SELECT COUNT(*) FROM connections n WHERE n.client_ip = c.client_ip) as conn_cnt, "
                "  MIN(first_seen) as first_seen, MAX(last_seen) as last_seen "
                "FROM ("
                "  SELECT client_ip, MIN(ts) as first_seen, MAX(ts) as last_seen "
                "  FROM dns_queries "
                "  UNION "
                "  SELECT client_ip, MIN(ts) as first_seen, MAX(ts) as last_seen "
                "  FROM connections"
                ") c "
                "GROUP BY client_ip "
                "ORDER BY dns_cnt + conn_cnt DESC LIMIT ?", (limit,)
            ).fetchall()

            total_q = self._db.execute(
                "SELECT COUNT(*) FROM dns_queries"
            ).fetchone()[0]
            total_c = self._db.execute(
                "SELECT COUNT(*) FROM connections"
            ).fetchone()[0]
            first = self._db.execute(
                "SELECT MIN(ts) FROM ("
                "  SELECT MIN(ts) as ts FROM dns_queries "
                "  UNION ALL "
                "  SELECT MIN(ts) as ts FROM connections"
                ")"
            ).fetchone()[0]

            return {
                "top_domains": [
                    {"domain": r[0], "count": r[1]} for r in top_domains
                ],
                "active_clients": [
                    {"client_ip": r[0], "dns_queries": r[1],
                     "connections": r[2], "first_seen": r[3],
                     "last_seen": r[4]}
                    for r in active_clients
                ],
                "total_queries": total_q,
                "total_connections": total_c,
                "tracking_since": first or 0,
            }
        except Exception:
            return {"top_domains": [], "active_clients": [],
                    "total_queries": 0, "total_connections": 0,
                    "tracking_since": 0}

    def clear_data(self):
        if not self._db:
            return
        try:
            self._db.execute("DELETE FROM dns_queries")
            self._db.execute("DELETE FROM connections")
            self._db.commit()
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Background loop
    # ------------------------------------------------------------------

    def _run(self):
        self._db = _ensure_db(settings.TRAFFIC_DB)
        cycle = 0
        while not self._stop.is_set():
            if not _is_hotspot_running():
                self._stop.wait(10)
                continue
            try:
                self._tail_dns_log()
                self._poll_conntrack()
            except Exception:
                pass
            cycle += 1
            if cycle % 120 == 0:
                self._cleanup()
            self._stop.wait(5)

    def _tail_dns_log(self):
        """Read new lines from the dnsmasq log using binary seek for
        reliable file-position tracking across Python text-mode opens."""
        path = settings.DNS_LOG_FILE
        if not os.path.isfile(path):
            return
        try:
            size = os.path.getsize(path)
            if size < self._dns_pos:
                self._dns_pos = 0
            if size == self._dns_pos:
                return

            with open(path, "rb") as f:
                f.seek(self._dns_pos)
                raw = f.read()
                self._dns_pos = f.tell()

            if not raw:
                return

            now = int(time.time())
            batch = []
            for line in raw.decode("utf-8", errors="replace").splitlines():
                m = _DNS_RE.search(line)
                if m:
                    domain = m.group(2).rstrip(".")
                    client_ip = m.group(3)
                    batch.append((now, client_ip, domain))

            if batch:
                self._db.executemany(
                    "INSERT INTO dns_queries (ts, client_ip, domain) VALUES (?, ?, ?)",
                    batch
                )
                self._db.commit()
        except Exception:
            pass

    def _poll_conntrack(self):
        """Read /proc/net/nf_conntrack and insert only NEW connections
        not already seen in the current dedup window (60s)."""
        path = settings.PROC_NET_CONNTRACK
        if not os.path.isfile(path):
            return
        try:
            now = int(time.time())

            # Reset dedup set every 60 seconds so long-lived connections
            # eventually re-appear (useful for session tracking).
            if now - self._seen_conns_ts > 60:
                self._seen_conns = set()
                self._seen_conns_ts = now

            subnet = self._get_ap_subnet()
            batch = []
            with open(path, "r", errors="replace") as f:
                for line in f:
                    m = _CONN_RE.search(line)
                    if not m:
                        continue
                    src_ip = m.group(1)
                    dst_ip = m.group(2)
                    dst_port = int(m.group(3))
                    if subnet and not src_ip.startswith(subnet):
                        continue
                    if src_ip == dst_ip:
                        continue
                    proto = "tcp" if "tcp" in line[:20] else "udp"
                    key = (src_ip, dst_ip, dst_port, proto)
                    if key in self._seen_conns:
                        continue
                    self._seen_conns.add(key)
                    batch.append((now, src_ip, dst_ip, dst_port, proto))

            if batch:
                self._db.executemany(
                    "INSERT INTO connections (ts, client_ip, dest_ip, dest_port, proto) "
                    "VALUES (?, ?, ?, ?, ?)",
                    batch
                )
                self._db.commit()
        except Exception:
            pass

    def _get_ap_subnet(self):
        try:
            config = {}
            if os.path.isfile(settings.CONFIG_FILE):
                with open(settings.CONFIG_FILE, "r") as f:
                    for line in f:
                        line = line.strip()
                        if "=" in line and not line.startswith("#"):
                            k, v = line.split("=", 1)
                            config[k.strip()] = v.strip()
            ap_ip = config.get("AP_IP", "192.168.50.1")
            parts = ap_ip.rsplit(".", 1)
            return parts[0] + "." if len(parts) == 2 else None
        except Exception:
            return "192.168.50."

    def _cleanup(self):
        cutoff = int(time.time()) - (settings.TRAFFIC_RETENTION_HOURS * 3600)
        try:
            self._db.execute("DELETE FROM dns_queries WHERE ts < ?", (cutoff,))
            self._db.execute("DELETE FROM connections WHERE ts < ?", (cutoff,))
            self._db.commit()
        except Exception:
            pass


# Singleton — imported by main.py and handler.py
monitor = TrafficMonitor()
