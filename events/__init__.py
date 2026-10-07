#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

"""Event collection subsystem for OSHotspot.

Tails the dedicated dnsmasq log, parses it into structured events
(timestamp, client MAC, queried domain), stores them in a local SQLite
database, tracks known/unknown devices and raises alerts.  Uses the
Python 3 standard library plus two small pip packages -- ``pygtail``
(rotation-safe log tailing) and ``tenacity`` (SQLite retry/backoff).

Modules:
  parser  -- dnsmasq log line parsing + lease lookup + rotation-aware reader
  db      -- SQLite schema, inserts and queries for events/known_devices
  alert   -- flagged log entries plus optional SMTP email
  tailer  -- long-running collector daemon that ties everything together
"""

__all__ = ["parser", "db", "alert", "tailer"]
