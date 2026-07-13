#!/usr/bin/env bash
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0
#

# firewall.sh - NAT and forwarding rules for OSHotspot.
# Supports both iptables and nftables backends.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=utils.sh
source "${SCRIPT_DIR}/utils.sh"

# Detect firewall backend
detect_firewall() {
    if command -v iptables &>/dev/null; then
        FIREWALL="iptables"
    elif command -v nft &>/dev/null; then
        FIREWALL="nft"
    else
        log_error "No firewall tool found (iptables or nft required)."
        exit 1
    fi
}

# Check if a firewall rule already exists
fw_rule_exists() {
    if [[ "${FIREWALL}" == "nft" ]]; then
        nft list ruleset 2>/dev/null | grep -q "$1"
    else
        iptables "$@" 2>/dev/null
    fi
}

# Set up NAT and forwarding so clients on ap0 can reach the internet.
setup_firewall() {
    require_root
    load_config
    check_commands
    detect_firewall

    log_step "Configuring firewall rules for NAT... (${FIREWALL})"

    if [[ "${FIREWALL}" == "nft" ]]; then
        setup_firewall_nft
    else
        setup_firewall_iptables
    fi

    log_info "Firewall configured."
}

setup_firewall_iptables() {
    # Allow traffic from ap0 to the internet
    if ! iptables -C FORWARD -i "${AP_IFACE}" -o "${WIFI_IFACE}" -j ACCEPT 2>/dev/null; then
        iptables -I FORWARD 1 -i "${AP_IFACE}" -o "${WIFI_IFACE}" -j ACCEPT
        log_info "Added FORWARD rule: ${AP_IFACE} -> ${WIFI_IFACE}"
    else
        log_info "FORWARD rule ${AP_IFACE} -> ${WIFI_IFACE} already exists."
    fi

    # Allow return traffic back to clients
    if ! iptables -C FORWARD -i "${WIFI_IFACE}" -o "${AP_IFACE}" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null; then
        iptables -I FORWARD 2 -i "${WIFI_IFACE}" -o "${AP_IFACE}" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
        log_info "Added FORWARD rule: ${WIFI_IFACE} -> ${AP_IFACE} (established)"
    else
        log_info "FORWARD rule ${WIFI_IFACE} -> ${AP_IFACE} already exists."
    fi

    # Masquerade outbound traffic
    if ! iptables -t nat -C POSTROUTING -s "${SUBNET}/${AP_CIDR}" -o "${WIFI_IFACE}" -j MASQUERADE 2>/dev/null; then
        iptables -t nat -A POSTROUTING -s "${SUBNET}/${AP_CIDR}" -o "${WIFI_IFACE}" -j MASQUERADE
        log_info "Added NAT MASQUERADE: ${SUBNET}/${AP_CIDR} -> ${WIFI_IFACE}"
    else
        log_info "NAT MASQUERADE rule already exists."
    fi
}

setup_firewall_nft() {
    # Create tables if they don't exist
    nft add table ip filter 2>/dev/null || true
    nft add table ip nat 2>/dev/null || true
    nft add chain ip filter forward '{ type filter hook forward priority 0; }' 2>/dev/null || true
    nft add chain ip nat postrouting '{ type nat hook postrouting priority 100; }' 2>/dev/null || true

    # Allow traffic from ap0 to the internet
    if ! nft list chain ip filter forward 2>/dev/null | grep -q "iifname \"${AP_IFACE}\".*oifname \"${WIFI_IFACE}\""; then
        nft add rule ip filter forward iifname "${AP_IFACE}" oifname "${WIFI_IFACE}" accept
        log_info "Added FORWARD rule: ${AP_IFACE} -> ${WIFI_IFACE}"
    else
        log_info "FORWARD rule ${AP_IFACE} -> ${WIFI_IFACE} already exists."
    fi

    # Allow return traffic back to clients
    if ! nft list chain ip filter forward 2>/dev/null | grep -q "iifname \"${WIFI_IFACE}\".*oifname \"${AP_IFACE}\""; then
        nft add rule ip filter forward iifname "${WIFI_IFACE}" oifname "${AP_IFACE}" ct state established,related accept
        log_info "Added FORWARD rule: ${WIFI_IFACE} -> ${AP_IFACE} (established)"
    else
        log_info "FORWARD rule ${WIFI_IFACE} -> ${AP_IFACE} already exists."
    fi

    # Masquerade outbound traffic
    if ! nft list chain ip nat postrouting 2>/dev/null | grep -q "ip saddr ${SUBNET}/${AP_CIDR}.*oifname \"${WIFI_IFACE}\""; then
        nft add rule ip nat postrouting ip saddr "${SUBNET}/${AP_CIDR}" oifname "${WIFI_IFACE}" masquerade
        log_info "Added NAT MASQUERADE: ${SUBNET}/${AP_CIDR} -> ${WIFI_IFACE}"
    else
        log_info "NAT MASQUERADE rule already exists."
    fi
}

# Remove only the rules we added (leaves everything else untouched).
cleanup_firewall() {
    require_root
    load_config
    detect_firewall

    log_step "Cleaning up OSHotspot firewall rules... (${FIREWALL})"

    if [[ "${FIREWALL}" == "nft" ]]; then
        cleanup_firewall_nft
    else
        cleanup_firewall_iptables
    fi

    log_info "Firewall cleanup complete."
}

cleanup_firewall_iptables() {
    while iptables -D FORWARD -i "${AP_IFACE}" -o "${WIFI_IFACE}" -j ACCEPT 2>/dev/null; do
        log_info "Removed FORWARD rule: ${AP_IFACE} -> ${WIFI_IFACE}"
    done

    while iptables -D FORWARD -i "${WIFI_IFACE}" -o "${AP_IFACE}" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null; do
        log_info "Removed FORWARD rule: ${WIFI_IFACE} -> ${AP_IFACE} (established)"
    done

    while iptables -t nat -D POSTROUTING -s "${SUBNET}/${AP_CIDR}" -o "${WIFI_IFACE}" -j MASQUERADE 2>/dev/null; do
        log_info "Removed NAT MASQUERADE: ${SUBNET}/${AP_CIDR} -> ${WIFI_IFACE}"
    done
}

cleanup_firewall_nft() {
    # Flush and remove OSHotspot chains (nft doesn't have easy per-rule deletion)
    nft flush chain ip filter forward 2>/dev/null || true
    nft flush chain ip nat postrouting 2>/dev/null || true
    log_info "Flushed firewall rules (nft mode)."
}

allow_ap_forwarding() {
    require_root
    load_config
    detect_firewall

    if [[ "${FIREWALL}" == "nft" ]]; then
        nft add rule ip filter forward ip saddr "${SUBNET}/${AP_CIDR}" accept 2>/dev/null || true
        nft add rule ip filter forward ip daddr "${SUBNET}/${AP_CIDR}" accept 2>/dev/null || true
    else
        if ! iptables -C FORWARD -s "${SUBNET}/${AP_CIDR}" -j ACCEPT 2>/dev/null; then
            iptables -I FORWARD 1 -s "${SUBNET}/${AP_CIDR}" -j ACCEPT
        fi

        if ! iptables -C FORWARD -d "${SUBNET}/${AP_CIDR}" -j ACCEPT 2>/dev/null; then
            iptables -I FORWARD 2 -d "${SUBNET}/${AP_CIDR}" -j ACCEPT
        fi
    fi
}

case "${1:-setup}" in
    setup)   setup_firewall ;;
    cleanup) cleanup_firewall ;;
    allow)   allow_ap_forwarding ;;
    *)       echo "Usage: $0 {setup|cleanup|allow}"; exit 1 ;;
esac
