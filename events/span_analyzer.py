#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

"""SPAN Port Switch Traffic & Log Analyzer.

Captures mirrored network packets from a switch SPAN port on a specified interface,
parses DNS and HTTP request headers, and publishes events to live_bus and the event database.
"""

import argparse
import hashlib
import json
import logging
import os
import socket
import struct
import sys
import threading
import time

try:
    from events import db, classify, live_bus
except ImportError:
    import db
    import classify
    import live_bus

_log = logging.getLogger(__name__)
_running = False
_thread = None

# ─── DHCP lease hostname resolution ───
_LEASE_PATH = "/run/oshotspot-dnsmasq.leases"
_hostname_cache = {}
_lease_mtime = 0.0


def _load_hostname_cache():
    global _hostname_cache, _lease_mtime
    try:
        st = os.stat(_LEASE_PATH)
        if st.st_mtime == _lease_mtime:
            return
        _lease_mtime = st.st_mtime
        cache = {}
        with open(_LEASE_PATH, "r", errors="replace") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 4:
                    mac = parts[1].strip().lower()
                    hostname = "" if parts[3] == "*" else parts[3]
                    cache[mac] = hostname
        _hostname_cache = cache
    except Exception:
        pass


def resolve_hostname(mac):
    if not mac:
        return ""
    _load_hostname_cache()
    return _hostname_cache.get(mac.lower(), "")

def parse_dns_packet(data):
    """Minimal stdlib DNS packet parser."""
    try:
        if len(data) < 12:
            return None
        flags = struct.unpack("!H", data[2:4])[0]
        qr = (flags >> 15) & 0x1
        qdcount = struct.unpack("!H", data[4:6])[0]
        if qdcount < 1:
            return None

        # Parse QNAME
        idx = 12
        labels = []
        while idx < len(data):
            length = data[idx]
            if length == 0:
                idx += 1
                break
            if length >= 192:  # Compression offset
                idx += 2
                break
            idx += 1
            if idx + length > len(data):
                return None
            labels.append(data[idx:idx+length].decode("utf-8", "replace"))
            idx += length

        domain = ".".join(labels)
        if len(data) >= idx + 2:
            qtype_num = struct.unpack("!H", data[idx:idx+2])[0]
            qtype_map = {1: "A", 28: "AAAA", 5: "CNAME", 15: "MX", 16: "TXT", 65: "HTTPS"}
            qtype = qtype_map.get(qtype_num, str(qtype_num))
        else:
            qtype = "A"

        return {"domain": domain, "query_type": qtype, "is_response": bool(qr)}
    except Exception:
        return None

def parse_http_host(payload):
    """Extract Host header from HTTP GET/POST payload."""
    try:
        text = payload.decode("utf-8", errors="ignore")
        if text.startswith(("GET ", "POST ", "HEAD ", "PUT ", "DELETE ")):
            for line in text.split("\r\n"):
                if line.lower().startswith("host:"):
                    return line.split(":", 1)[1].strip()
    except Exception:
        pass
    return None

def parse_tls_sni(payload):
    """Extract Server Name Indication (SNI) from TLS ClientHello packet."""
    try:
        # TLS Record Header: ContentType=22 (Handshake), Version, Length
        if len(payload) < 43 or payload[0] != 0x16:
            return None
        # Handshake Type=1 (ClientHello)
        if payload[5] != 0x01:
            return None

        idx = 43  # Skip Session ID length & Session ID
        if idx >= len(payload): return None
        session_id_len = payload[38]
        idx = 39 + session_id_len
        if idx + 2 > len(payload): return None
        cipher_len = struct.unpack("!H", payload[idx:idx+2])[0]
        idx += 2 + cipher_len
        if idx + 1 > len(payload): return None
        comp_len = payload[idx]
        idx += 1 + comp_len
        if idx + 2 > len(payload): return None
        ext_len = struct.unpack("!H", payload[idx:idx+2])[0]
        idx += 2
        end_ext = idx + ext_len

        while idx + 4 <= end_ext and idx + 4 <= len(payload):
            ext_type = struct.unpack("!H", payload[idx:idx+2])[0]
            ext_data_len = struct.unpack("!H", payload[idx+2:idx+4])[0]
            idx += 4
            if ext_type == 0:  # server_name extension
                if idx + 5 <= len(payload):
                    list_len = struct.unpack("!H", payload[idx:idx+2])[0]
                    name_type = payload[idx+2]
                    if name_type == 0:  # host_name
                        name_len = struct.unpack("!H", payload[idx+3:idx+5])[0]
                        if idx + 5 + name_len <= len(payload):
                            return payload[idx+5:idx+5+name_len].decode("utf-8", errors="ignore")
            idx += ext_data_len
    except Exception:
        pass
    return None

def analyze_span_packets(iface):
    """Raw socket capture & aggressive anomaly detection on SPAN interface."""
    global _running
    try:
        sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.ntohs(0x0003))
        sock.bind((iface, 0))
        sock.settimeout(1.0)
    except Exception as e:
        _log.error("Failed to bind raw socket on SPAN interface %s: %s", iface, e)
        return

    _log.info("SPAN analyzer active on interface %s", iface)

    # Anomaly tracking windows
    port_scan_tracker = {}     # {src_ip: {port: last_seen_ts}}
    syn_flood_tracker = {}     # {src_ip: [syn_count, sec_ts]}
    traffic_rate_tracker = {}  # {src_ip: [count, sec_ts]}
    icmp_flood_tracker = {}    # {src_ip: [count, sec_ts]}
    arp_ip_mac_table = {}      # {ip: mac}
    last_anomaly_alert = {}    # {(src_ip, anomaly_type): alert_ts}

    while _running:
        try:
            raw_data, addr = sock.recvfrom(65535)
            if len(raw_data) < 14:
                continue

            src_mac = ":".join(f"{b:02x}" for b in raw_data[6:12])
            dst_mac = ":".join(f"{b:02x}" for b in raw_data[0:6])
            eth_proto = struct.unpack("!H", raw_data[12:14])[0]

            now = time.time()
            ts_str = time.strftime("%Y-%m-%d %H:%M:%S")

            # --- ARP ANOMALY DETECTION (Protocol 0x0806) ---
            if eth_proto == 0x0806 and len(raw_data) >= 42:
                arp_hdr = raw_data[14:42]
                hw_type, proto_type, hw_len, proto_len, opcode = struct.unpack("!HHBBH", arp_hdr[:8])
                if opcode == 2:  # ARP Reply
                    arp_src_mac = ":".join(f"{b:02x}" for b in arp_hdr[8:14])
                    arp_src_ip = socket.inet_ntoa(arp_hdr[14:18])
                    existing_mac = arp_ip_mac_table.get(arp_src_ip)
                    if existing_mac and existing_mac != arp_src_mac:
                        last_alert = last_anomaly_alert.get((arp_src_ip, "arp_spoof"), 0)
                        if now - last_alert > 10:
                            last_anomaly_alert[(arp_src_ip, "arp_spoof")] = now
                            live_bus.publish({
                                "type": "span_event",
                                "timestamp": ts_str,
                                "client_mac": arp_src_mac,
                                "hostname": resolve_hostname(arp_src_mac),
                                "ip": arp_src_ip,
                                "event_type": "anomaly",
                                "anomaly": "ARP SPOOF",
                                "detail": f"MAC address mismatch for IP {arp_src_ip}: {arp_src_mac} vs {existing_mac}",
                                "iface": iface,
                            })
                    else:
                        arp_ip_mac_table[arp_src_ip] = arp_src_mac

            if eth_proto != 0x0800 or len(raw_data) < 34:  # IPv4
                continue

            ip_header = raw_data[14:34]
            iph = struct.unpack("!BBHHHBBH4s4s", ip_header)
            protocol = iph[6]
            src_ip = socket.inet_ntoa(iph[8])
            dst_ip = socket.inet_ntoa(iph[9])

            ip_hdr_len = (iph[0] & 0x0F) * 4
            transport_offset = 14 + ip_hdr_len

            # --- ANOMALY DETECTION 1: Aggressive Traffic Burst / Flood ---
            sec_ts = int(now)
            rate_info = traffic_rate_tracker.get(src_ip, [0, sec_ts])
            if rate_info[1] == sec_ts:
                rate_info[0] += 1
            else:
                rate_info = [1, sec_ts]
            traffic_rate_tracker[src_ip] = rate_info

            if rate_info[0] > 80:  # > 80 pkts/s threshold
                last_alert = last_anomaly_alert.get((src_ip, "traffic_burst"), 0)
                if now - last_alert > 10:  # 10s cooldown
                    last_anomaly_alert[(src_ip, "traffic_burst")] = now
                    live_bus.publish({
                        "type": "span_event",
                        "timestamp": ts_str,
                        "client_mac": src_mac,
                        "hostname": resolve_hostname(src_mac),
                        "ip": src_ip,
                        "event_type": "anomaly",
                        "anomaly": "TRAFFIC BURST",
                        "detail": f"High packet volume: {rate_info[0]} pkts/sec toward {dst_ip}",
                        "iface": iface,
                    })

            # --- ANOMALY DETECTION 2: ICMP Ping Flood (Protocol 1) ---
            if protocol == 1 and len(raw_data) >= transport_offset + 2:
                icmp_hdr = raw_data[transport_offset:transport_offset+2]
                icmp_type = icmp_hdr[0]
                if icmp_type == 8:  # Echo Request
                    icmp_info = icmp_flood_tracker.get(src_ip, [0, sec_ts])
                    if icmp_info[1] == sec_ts:
                        icmp_info[0] += 1
                    else:
                        icmp_info = [1, sec_ts]
                    icmp_flood_tracker[src_ip] = icmp_info

                    if icmp_info[0] > 25:  # > 25 ICMP pings/s
                        last_alert = last_anomaly_alert.get((src_ip, "icmp_flood"), 0)
                        if now - last_alert > 10:
                            last_anomaly_alert[(src_ip, "icmp_flood")] = now
                            live_bus.publish({
                                "type": "span_event",
                                "timestamp": ts_str,
                                "client_mac": src_mac,
                                "hostname": resolve_hostname(src_mac),
                                "ip": src_ip,
                                "event_type": "anomaly",
                                "anomaly": "ICMP FLOOD",
                                "detail": f"Ping flood detected: {icmp_info[0]} ICMP requests/sec toward {dst_ip}",
                                "iface": iface,
                            })

            # --- UDP Protocol Handling (DNS) ---
            elif protocol == 17 and len(raw_data) >= transport_offset + 8:
                udp_hdr = raw_data[transport_offset:transport_offset+8]
                src_port, dst_port, length, checksum = struct.unpack("!HHHH", udp_hdr)

                # Port scan check for UDP
                ports_dict = port_scan_tracker.get(src_ip, {})
                ports_dict[dst_port] = now
                ports_dict = {p: t for p, t in ports_dict.items() if now - t <= 8.0}
                port_scan_tracker[src_ip] = ports_dict

                if len(ports_dict) >= 6:  # > 6 distinct ports in 8s
                    last_alert = last_anomaly_alert.get((src_ip, "port_scan"), 0)
                    if now - last_alert > 10:
                        last_anomaly_alert[(src_ip, "port_scan")] = now
                        live_bus.publish({
                            "type": "span_event",
                            "timestamp": ts_str,
                            "client_mac": src_mac,
                            "hostname": resolve_hostname(src_mac),
                            "ip": src_ip,
                            "event_type": "anomaly",
                            "anomaly": "PORT SCAN",
                            "detail": f"Aggressive port scan detected: {len(ports_dict)} distinct ports targeted",
                            "iface": iface,
                        })

                if dst_port == 53 or src_port == 53:
                    dns_payload = raw_data[transport_offset+8:]
                    dns_info = parse_dns_packet(dns_payload)
                    if dns_info and dns_info["domain"]:
                        live_bus.publish({
                            "type": "span_event",
                            "timestamp": ts_str,
                            "client_mac": src_mac,
                            "hostname": resolve_hostname(src_mac),
                            "ip": src_ip,
                            "event_type": "dns_query",
                            "detail": dns_info["domain"],
                            "query_type": dns_info["query_type"],
                            "iface": iface,
                        })

            # --- TCP Protocol Handling (HTTP/HTTPS & Port Scan & SYN Flood) ---
            elif protocol == 6 and len(raw_data) >= transport_offset + 20:
                tcp_hdr = raw_data[transport_offset:transport_offset+20]
                src_port, dst_port, seq, ack, offset_reserved_flags = struct.unpack("!HHIIH", tcp_hdr)
                tcp_hdr_len = ((offset_reserved_flags >> 12) & 0x0F) * 4
                tcp_payload_offset = transport_offset + tcp_hdr_len

                # Check TCP Flags (SYN = 0x02, ACK = 0x10)
                flags = offset_reserved_flags & 0x01FF
                if (flags & 0x02) and not (flags & 0x10):  # SYN-only packet
                    syn_info = syn_flood_tracker.get(src_ip, [0, sec_ts])
                    if syn_info[1] == sec_ts:
                        syn_info[0] += 1
                    else:
                        syn_info = [1, sec_ts]
                    syn_flood_tracker[src_ip] = syn_info

                    if syn_info[0] > 20:  # > 20 SYN/s
                        last_alert = last_anomaly_alert.get((src_ip, "syn_flood"), 0)
                        if now - last_alert > 10:
                            last_anomaly_alert[(src_ip, "syn_flood")] = now
                            live_bus.publish({
                                "type": "span_event",
                                "timestamp": ts_str,
                                "client_mac": src_mac,
                                "hostname": resolve_hostname(src_mac),
                                "ip": src_ip,
                                "event_type": "anomaly",
                                "anomaly": "SYN FLOOD",
                                "detail": f"SYN Flood detected: {syn_info[0]} SYN requests/sec toward {dst_ip}:{dst_port}",
                                "iface": iface,
                            })

                # --- ANOMALY DETECTION 3: Aggressive Port Scanning ---
                ports_dict = port_scan_tracker.get(src_ip, {})
                ports_dict[dst_port] = now
                ports_dict = {p: t for p, t in ports_dict.items() if now - t <= 8.0}
                port_scan_tracker[src_ip] = ports_dict

                if len(ports_dict) >= 6:  # > 6 distinct ports in 8s
                    last_alert = last_anomaly_alert.get((src_ip, "port_scan"), 0)
                    if now - last_alert > 10:
                        last_anomaly_alert[(src_ip, "port_scan")] = now
                        live_bus.publish({
                            "type": "span_event",
                            "timestamp": ts_str,
                            "client_mac": src_mac,
                            "hostname": resolve_hostname(src_mac),
                            "ip": src_ip,
                            "event_type": "anomaly",
                            "anomaly": "PORT SCAN",
                            "detail": f"Aggressive port scan detected: {len(ports_dict)} distinct ports targeted in 8s",
                            "iface": iface,
                        })

                if len(raw_data) > tcp_payload_offset:
                    payload = raw_data[tcp_payload_offset:]

                    # Check HTTP Host header (port 80 or 8080)
                    if dst_port in (80, 8080):
                        http_host = parse_http_host(payload)
                        if http_host:
                            live_bus.publish({
                                "type": "span_event",
                                "timestamp": ts_str,
                                "client_mac": src_mac,
                                "hostname": resolve_hostname(src_mac),
                                "ip": src_ip,
                                "event_type": "http_request",
                                "detail": http_host,
                                "iface": iface,
                            })

                    # Check TLS SNI Hostname (port 443)
                    elif dst_port == 443:
                        tls_sni = parse_tls_sni(payload)
                        if tls_sni:
                            live_bus.publish({
                                "type": "span_event",
                                "timestamp": ts_str,
                                "client_mac": src_mac,
                                "hostname": resolve_hostname(src_mac),
                                "ip": src_ip,
                                "event_type": "tls_connect",
                                "detail": tls_sni,
                                "iface": iface,
                            })

        except socket.timeout:
            continue
        except Exception:
            continue

    sock.close()

def start_span_analyzer(iface):
    global _running, _thread
    if _running:
        return True
    if not iface:
        return False
    _running = True
    _thread = threading.Thread(target=analyze_span_packets, args=(iface,))
    _thread.daemon = True
    _thread.start()
    return True

def stop_span_analyzer():
    global _running, _thread
    _running = False
    if _thread is not None:
        _thread.join(timeout=2.0)
        _thread = None
