#!/usr/bin/env bash
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0
#

# firewall.sh - iptables NAT and forwarding rules for OSHotspot.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=utils.sh
source "${SCRIPT_DIR}/utils.sh"

# Returns 0 if the given iptables rule already exists.
iptables_rule_exists() {
    local chain="$1"
    shift
    iptables -C "${chain}" "$@" 2>/dev/null
}

# Set up NAT and forwarding so clients on ap0 can reach the internet.
setup_firewall() {
    require_root
    load_config
    check_commands

    log_step "Configuring firewall rules for NAT..."

    # Allow traffic from ap0 to the internet
    if ! iptables_rule_exists FORWARD -i "${AP_IFACE}" -o "${WIFI_IFACE}" -j ACCEPT; then
        iptables -I FORWARD 1 -i "${AP_IFACE}" -o "${WIFI_IFACE}" -j ACCEPT
        log_info "Added FORWARD rule: ${AP_IFACE} -> ${WIFI_IFACE}"
    else
        log_info "FORWARD rule ${AP_IFACE} -> ${WIFI_IFACE} already exists."
    fi

    # Allow return traffic back to clients
    if ! iptables_rule_exists FORWARD -i "${WIFI_IFACE}" -o "${AP_IFACE}" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT; then
        iptables -I FORWARD 2 -i "${WIFI_IFACE}" -o "${AP_IFACE}" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
        log_info "Added FORWARD rule: ${WIFI_IFACE} -> ${AP_IFACE} (established)"
    else
        log_info "FORWARD rule ${WIFI_IFACE} -> ${AP_IFACE} already exists."
    fi

    # Masquerade outbound traffic so clients share the host's internet IP
    if ! iptables -t nat -C POSTROUTING -s "${SUBNET}/${AP_CIDR}" -o "${WIFI_IFACE}" -j MASQUERADE 2>/dev/null; then
        iptables -t nat -A POSTROUTING -s "${SUBNET}/${AP_CIDR}" -o "${WIFI_IFACE}" -j MASQUERADE
        log_info "Added NAT MASQUERADE: ${SUBNET}/${AP_CIDR} -> ${WIFI_IFACE}"
    else
        log_info "NAT MASQUERADE rule already exists."
    fi

    log_info "Firewall configured."
}

# Remove only the rules we added (leaves everything else untouched).
cleanup_firewall() {
    require_root
    load_config

    log_step "Cleaning up OSHotspot firewall rules..."

    while iptables -D FORWARD -i "${AP_IFACE}" -o "${WIFI_IFACE}" -j ACCEPT 2>/dev/null; do
        log_info "Removed FORWARD rule: ${AP_IFACE} -> ${WIFI_IFACE}"
    done

    while iptables -D FORWARD -i "${WIFI_IFACE}" -o "${AP_IFACE}" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null; do
        log_info "Removed FORWARD rule: ${WIFI_IFACE} -> ${AP_IFACE} (established)"
    done

    while iptables -t nat -D POSTROUTING -s "${SUBNET}/${AP_CIDR}" -o "${WIFI_IFACE}" -j MASQUERADE 2>/dev/null; do
        log_info "Removed NAT MASQUERADE: ${SUBNET}/${AP_CIDR} -> ${WIFI_IFACE}"
    done

    log_info "Firewall cleanup complete."
}

allow_ap_forwarding() {
    require_root
    load_config

    if ! iptables_rule_exists FORWARD -s "${SUBNET}/${AP_CIDR}" -j ACCEPT; then
        iptables -I FORWARD 1 -s "${SUBNET}/${AP_CIDR}" -j ACCEPT
    fi

    if ! iptables_rule_exists FORWARD -d "${SUBNET}/${AP_CIDR}" -j ACCEPT; then
        iptables -I FORWARD 2 -d "${SUBNET}/${AP_CIDR}" -j ACCEPT
    fi
}

case "${1:-setup}" in
    setup)   setup_firewall ;;
    cleanup) cleanup_firewall ;;
    allow)   allow_ap_forwarding ;;
    *)       echo "Usage: $0 {setup|cleanup|allow}"; exit 1 ;;
esac
