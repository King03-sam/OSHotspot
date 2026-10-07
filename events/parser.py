#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

"""Parses the dedicated dnsmasq log into structured events.

Pure-Python, standard library only.  Two kinds of log lines are turned
into events:

  * DNS queries   -- "query[A] example.com from 192.168.50.10"
  * DHCP actions  -- "DHCPACK(ap0) 192.168.50.10 3c:a3:ed:... hostname"

dnsmasq logs to a file (--log-facility) with a syslog-style prefix
without a year, e.g. "Jul 18 09:15:23 dnsmasq[1234]: ...".  The caller
provides a running context so a year rollover across New Year is handled.

The module also ships the lease-file reader used to resolve a query's
source IP back to a client MAC.  Log-file tailing with rotation handling
is delegated to pygtail (see tailer.py).
"""

import hashlib
import re
import time

TS_PREFIX_RE = re.compile(
    r"^(?P<ts>[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+"
    r"(?:dnsmasq(?:-[a-z]+)?\[\d+\]:\s+)?"
    r"(?P<msg>.*)$"
)
QUERY_RE = re.compile(
    r"^query\[(?P<qtype>[A-Z0-9]+)\]\s+"
    r"(?P<domain>\S+)\s+"
    r"from\s+(?P<ip>\d+\.\d+\.\d+\.\d+)$"
)
DHCP_RE = re.compile(
    r"^DHCP(?P<action>DISCOVER|OFFER|REQUEST|ACK|NAK|RELEASE)\((?P<iface>[^)]+)\)\s+"
    r"(?P<ip>\d+\.\d+\.\d+\.\d+|\*)\s+"
    r"(?:(?P<mac>[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}))?"
    r"(?:\s+(?P<hostname>\S+))?$"
)

MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}

IP_RE = re.compile(r"^\d+\.\d+\.\d+\.\d+$")
MAC_RE = re.compile(r"^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$")


def normalize_mac(mac):
    """Lower-case a MAC address and return it, or '' if invalid/empty."""
    if not mac:
        return ""
    mac = mac.strip().lower()
    return mac if MAC_RE.match(mac) else ""


def _parse_timestamp(ts_str):
    """Turn 'Jul 18 09:15:23' into (year, month, day, hh, mm, ss, iso).

    The year is taken from the current clock and fixed up later by
    adjust_year() when a rollover is detected.  Returns None on garbage."""
    m = re.match(
        r"([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})", ts_str
    )
    if not m:
        return None
    month = MONTHS.get(m.group(1).lower())
    if month is None:
        return None
    day, hh, mm, ss = int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5))
    year = time.localtime().tm_year
    iso = "{:04d}-{:02d}-{:02d} {:02d}:{:02d}:{:02d}".format(
        year, month, day, hh, mm, ss
    )
    return (year, month, day, hh, mm, ss, iso)


def adjust_year(event, previous):
    """Fix the timestamp year of *event* given the previously seen event.

    dnsmasq's log lines carry no year.  When the collector runs across a
    New Year boundary the month/day rolls back (Dec 31 -> Jan 1); bump the
    year in that case so events stay chronologically ordered."""
    if not event or not event.get("timestamp") or not previous:
        return event
    prev = previous.get("_ymd")
    if not prev:
        return event
    cur = event.get("_ymd")
    if not cur:
        return event
    prev_year, prev_month, prev_day = prev
    cur_year, cur_month, cur_day = cur
    if (cur_month, cur_day) < (prev_month, prev_day):
        cur_year = prev_year + 1
    event["timestamp"] = "{:04d}-{:02d}-{:02d} {}".format(
        cur_year, cur_month, cur_day, event["timestamp"][11:]
    )
    event["_ymd"] = (cur_year, cur_month, cur_day)
    return event


def parse_line(line):
    """Parse one raw dnsmasq log line into an event dict, or None.

    The returned dict always carries the raw line and a source hash (used
    by the database to deduplicate across restarts/rotation), plus fields
    specific to the event kind."""
    line = line.strip()
    if not line:
        return None

    m = TS_PREFIX_RE.match(line)
    if m:
        ts_str, msg = m.group("ts"), m.group("msg")
        parsed = _parse_timestamp(ts_str)
        if parsed:
            year, month, day, hh, mm, ss, iso = parsed
        else:
            iso, year, month, day = None, None, None, None
    else:
        ts_str, msg, iso = None, line, None
        year = month = day = None

    raw = line
    source_hash = hashlib.sha1(raw.encode("utf-8", "replace")).hexdigest()

    event = {
        "timestamp": iso,
        "client_mac": "",
        "detail": raw,
        "raw": raw,
        "source_hash": source_hash,
    }
    if year is not None:
        event["_ymd"] = (year, month, day)

    q = QUERY_RE.match(msg)
    if q:
        event["event_type"] = "dns_query"
        domain = q.group("domain")
        if domain.endswith("."):
            domain = domain[:-1]
        event["domain"] = domain
        event["query_type"] = q.group("qtype")
        event["ip"] = q.group("ip")
        event["detail"] = {
            "domain": domain,
            "query_type": q.group("qtype"),
            "ip": q.group("ip"),
        }
        return event

    d = DHCP_RE.match(msg)
    if d:
        action = d.group("action").lower()
        event["event_type"] = "dhcp_" + action
        mac = normalize_mac(d.group("mac"))
        ip = d.group("ip")
        hostname = d.group("hostname") or ""
        if hostname == "*":
            hostname = ""
        event["client_mac"] = mac
        event["ip"] = ip
        event["hostname"] = hostname
        event["detail"] = {
            "action": action,
            "iface": d.group("iface"),
            "ip": ip,
            "hostname": hostname,
        }
        return event

    return None


def load_leases(path):
    """Read the dnsmasq lease file and return {ip: mac} in lower case.

    The lease file lines are:  <expiry> <mac> <ip> <hostname> <clientid>"""
    leases = {}
    try:
        with open(path, "r", errors="replace") as f:
            for line in f:
                parts = line.split()
                if len(parts) < 3:
                    continue
                mac, ip = parts[1], parts[2]
                if IP_RE.match(ip) and MAC_RE.match(mac):
                    leases[ip.lower()] = mac.lower()
    except OSError:
        pass
    return leases


def resolve_mac(event, leases):
    """Attach client_mac to *event*: direct MAC when the line carries one,
    otherwise resolved from the source IP via the lease table."""
    mac = event.get("client_mac") or ""
    if not mac and event.get("ip"):
        mac = leases.get(event["ip"].lower(), "")
    event["client_mac"] = normalize_mac(mac)
    return event
