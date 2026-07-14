#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

"""Turns the plain-text output of status.sh, clients.sh and doctor.sh into
structured data the dashboard can serialize to JSON."""

import re


def parse_status(output):
    """Extract the hotspot's current state from status.sh output."""
    status = {
        "wifi_iface": None,
        "wifi_state": "unknown",
        "ap_iface": "ap0",
        "ap_state": "unknown",
        "ap_ip": None,
        "ssid": None,
        "hostapd": False,
        "hostapd_pid": None,
        "dnsmasq": False,
        "dnsmasq_pid": None,
        "ip_forward": False,
        "nat": False,
        "clients": 0,
    }
    for line in output.splitlines():
        line = line.strip()
        if "WiFi Interface:" in line:
            if "NOT FOUND" in line:
                status["wifi_state"] = "missing"
            else:
                parts = line.split()
                for p in parts:
                    if p and not p.endswith(":") and "Interface" not in p:
                        status["wifi_iface"] = p.rstrip(":")
                        status["wifi_state"] = "ok"
                        break
        elif "AP Interface" in line:
            if "NOT CREATED" in line:
                status["ap_state"] = "missing"
            elif "DOWN" in line:
                status["ap_state"] = "down"
            else:
                status["ap_state"] = "up"
                # AP line looks like "AP Interface (ap0): UP (192.168.50.1)"
                m = re.search(r'\((\d+\.\d+\.\d+\.\d+)\)', line)
                if m:
                    ip_val = m.group(1)
                    if re.match(r'\d+\.\d+\.\d+\.\d+', ip_val):
                        status["ap_ip"] = ip_val
        elif "SSID:" in line:
            parts = line.split(":", 1)
            if len(parts) == 2:
                status["ssid"] = parts[1].strip()
        elif "hostapd:" in line.lower() and "RUNNING" in line:
            status["hostapd"] = True
            m = re.search(r'PID\s+(\d+)', line)
            if m:
                status["hostapd_pid"] = int(m.group(1))
        elif "dnsmasq" in line.lower() and "RUNNING" in line:
            status["dnsmasq"] = True
            m = re.search(r'PID\s+(\d+)', line)
            if m:
                status["dnsmasq_pid"] = int(m.group(1))
        elif "IP Forwarding:" in line:
            status["ip_forward"] = "ENABLED" in line
        elif "NAT" in line or "MASQUERADE" in line:
            status["nat"] = "ACTIVE" in line
        elif "Connected Clients:" in line:
            m = re.search(r'(\d+)', line)
            if m:
                status["clients"] = int(m.group(1))
    return status


def parse_clients(output):
    """Parse the DHCP lease table printed by clients.sh into a list of
    {mac, ip, hostname, status} dicts."""
    clients = []
    for line in output.splitlines():
        line = line.strip()
        m = re.match(
            r'([0-9a-fA-F:]{17})\s+'
            r'(\d+\.\d+\.\d+\.\d+)\s+'
            r'(\S+|-|\*)\s+'
            r'(\S+)',
            line
        )
        if m:
            hostname = m.group(3)
            if hostname in ("*", "-"):
                hostname = ""
            clients.append({
                "mac": m.group(1),
                "ip": m.group(2),
                "hostname": hostname,
                "status": m.group(4),
            })
    return clients


def parse_doctor(output):
    """Parse the [OK]/[WARN]/[FAIL] lines produced by doctor.sh."""
    checks = []
    for line in output.splitlines():
        line = line.strip()
        m = re.match(r'\[(OK|WARN|FAIL)\]\s+(.*)', line)
        if m:
            checks.append({"status": m.group(1).lower(), "message": m.group(2)})
    return checks
