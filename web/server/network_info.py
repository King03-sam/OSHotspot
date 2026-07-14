#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

"""Reads network-level data straight from /proc, and generates the WiFi
QR code image for the "scan to connect" page."""

import os
import subprocess

from . import settings
from .config_store import parse_config


def read_log_tail(component, lines=200):
    """Return the last N lines of a component's log file as a list of
    strings, or [] if the file is missing."""
    path = settings.LOG_FILES.get(component)
    if not path or not os.path.isfile(path):
        return []
    try:
        with open(path, "r", errors="replace") as f:
            data = f.readlines()
        return [l.rstrip("\n") for l in data[-lines:]]
    except Exception:
        return []


def read_traffic_stats(iface="ap0"):
    """Return current RX/TX byte counters for an interface, read
    directly from /proc/net/dev."""
    if not iface or not os.path.isfile(settings.PROC_NET_DEV):
        return {"rx_bytes": 0, "tx_bytes": 0, "iface": iface or ""}
    try:
        with open(settings.PROC_NET_DEV, "r") as f:
            for line in f:
                parts = line.strip().split(":")
                if len(parts) != 2:
                    continue
                name = parts[0].strip()
                if name == iface:
                    fields = parts[1].split()
                    return {
                        "iface": iface,
                        "rx_bytes": int(fields[0]) if fields else 0,
                        "tx_bytes": int(fields[8]) if len(fields) > 8 else 0,
                    }
    except Exception:
        pass
    return {"rx_bytes": 0, "tx_bytes": 0, "iface": iface or ""}


def list_wifi_interfaces():
    """Return the WiFi interfaces available on this machine, combining
    /proc/net/wireless (active radios) with a /sys/class/net scan so
    interfaces that exist but aren't currently up still show up."""
    ifaces = []
    try:
        with open("/proc/net/wireless", "r") as f:
            for line in f.readlines()[2:]:
                name = line.split(":")[0].strip()
                if name:
                    ifaces.append({"name": name, "state": "up"})
    except FileNotFoundError:
        pass
    try:
        if os.path.isdir("/sys/class/net"):
            for name in os.listdir("/sys/class/net"):
                if name.startswith("wl") and not any(i["name"] == name for i in ifaces):
                    ifaces.append({"name": name, "state": "present"})
    except Exception:
        pass
    return ifaces


def generate_qr_png():
    """Build a WiFi-connect QR code (PNG bytes) from the current SSID
    and password using qrencode. Returns None if either is unset or
    qrencode isn't installed."""
    config = parse_config()
    ssid = config.get("SSID", "")
    password = config.get("PASSWORD", "")
    if not ssid or not password:
        return None
    wifi_string = f"WIFI:T:WPA;S:{ssid};P:{password};;"
    try:
        result = subprocess.run(
            ["qrencode", "-o", "-", "--type", "PNG", "--size", "8", wifi_string],
            capture_output=True, timeout=10
        )
        if result.returncode == 0 and result.stdout:
            return result.stdout
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return None
