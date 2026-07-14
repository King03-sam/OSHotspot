#!/usr/bin/env bash
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0
#

# firewall.sh - NAT and forwarding rules for OSHotspot.
# Supports both iptables and nftables backends.
#
# When DNS_REDIRECT is enabled (default), two extra mechanisms ensure
# all DNS traffic from hotspot clients flows through the local dnsmasq:
#   1. DNS REDIRECT  — PREROUTING rules that hijack port 53 (UDP+TCP)
#      from the AP subnet so clients can't bypass dnsmasq with a manual
#      DNS server.
#   2. DoH BLOCK     — FORWARD DROP rules that black-hole traffic from
#      the AP subnet to known DNS-over-HTTPS resolver IPs on port 443,
#      forcing browsers back to standard DNS.

# Known DoH resolver IPs — blocked on port 443 from AP clients.
DOH_IPS=(
    1.1.1.1 1.0.0.1                       # Cloudflare
    8.8.8.8 8.8.4.4                       # Google
    9.9.9.9 149.112.112.112               # Quad9
    45.90.28.0/24 45.90.30.0/24           # NextDNS
    94.140.14.14 94.140.15.15             # AdGuard
    194.242.2.2 194.242.2.9               # Mullvad
    104.197.240.0/24                      # LibreDNS
)

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

    apply_dns_policy

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

# -------------------------------------------------------------------
# DNS redirect — force all port 53 traffic to local dnsmasq
# -------------------------------------------------------------------

setup_dns_redirect_iptables() {
    if ! iptables -t nat -C PREROUTING -i "${AP_IFACE}" -p udp --dport 53 -j REDIRECT 2>/dev/null; then
        iptables -t nat -A PREROUTING -i "${AP_IFACE}" -p udp --dport 53 -j REDIRECT
        log_info "Added DNS REDIRECT: UDP port 53 -> dnsmasq"
    else
        log_info "DNS REDIRECT (UDP) already exists."
    fi
    if ! iptables -t nat -C PREROUTING -i "${AP_IFACE}" -p tcp --dport 53 -j REDIRECT 2>/dev/null; then
        iptables -t nat -A PREROUTING -i "${AP_IFACE}" -p tcp --dport 53 -j REDIRECT
        log_info "Added DNS REDIRECT: TCP port 53 -> dnsmasq"
    else
        log_info "DNS REDIRECT (TCP) already exists."
    fi
}

setup_dns_redirect_nft() {
    nft add table ip nat 2>/dev/null || true
    nft add chain ip nat prerouting '{ type nat hook prerouting priority -100; }' 2>/dev/null || true

    if ! nft list chain ip nat prerouting 2>/dev/null | grep -q "iifname \"${AP_IFACE}\".*udp dport 53.*redirect"; then
        nft add rule ip nat prerouting iifname "${AP_IFACE}" udp dport 53 redirect
        log_info "Added DNS REDIRECT: UDP port 53 -> dnsmasq"
    else
        log_info "DNS REDIRECT (UDP) already exists."
    fi
    if ! nft list chain ip nat prerouting 2>/dev/null | grep -q "iifname \"${AP_IFACE}\".*tcp dport 53.*redirect"; then
        nft add rule ip nat prerouting iifname "${AP_IFACE}" tcp dport 53 redirect
        log_info "Added DNS REDIRECT: TCP port 53 -> dnsmasq"
    else
        log_info "DNS REDIRECT (TCP) already exists."
    fi
}

# -------------------------------------------------------------------
# DoH block — drop traffic to known DoH resolver IPs on port 443
# -------------------------------------------------------------------

block_doh_iptables() {
    local count=0
    for ip in "${DOH_IPS[@]}"; do
        if ! iptables -C FORWARD -i "${AP_IFACE}" -d "$ip" -p tcp --dport 443 -j DROP 2>/dev/null; then
            iptables -I FORWARD -i "${AP_IFACE}" -d "$ip" -p tcp --dport 443 -j DROP
            count=$((count + 1))
        fi
    done
    if [[ ${count} -gt 0 ]]; then
        log_info "Blocked DoH resolver IPs: ${count} rules added"
    else
        log_info "DoH block rules already exist."
    fi
}

block_doh_nft() {
    nft add table ip filter 2>/dev/null || true
    nft add chain ip filter forward '{ type filter hook forward priority 0; }' 2>/dev/null || true

    local count=0
    for ip in "${DOH_IPS[@]}"; do
        if ! nft list chain ip filter forward 2>/dev/null | grep -q "iifname \"${AP_IFACE}\".*${ip}.*tcp dport 443.*drop"; then
            nft add rule ip filter forward iifname "${AP_IFACE}" ip daddr "$ip" tcp dport 443 drop
            count=$((count + 1))
        fi
    done
    if [[ ${count} -gt 0 ]]; then
        log_info "Blocked DoH resolver IPs: ${count} rules added"
    else
        log_info "DoH block rules already exist."
    fi
}

# -------------------------------------------------------------------
# Cleanup helpers for DNS redirect and DoH block
# -------------------------------------------------------------------

cleanup_dns_redirect_iptables() {
    while iptables -t nat -D PREROUTING -i "${AP_IFACE}" -p udp --dport 53 -j REDIRECT 2>/dev/null; do
        log_info "Removed DNS REDIRECT: UDP port 53"
    done
    while iptables -t nat -D PREROUTING -i "${AP_IFACE}" -p tcp --dport 53 -j REDIRECT 2>/dev/null; do
        log_info "Removed DNS REDIRECT: TCP port 53"
    done
}

cleanup_dns_redirect_nft() {
    local rules
    rules=$(nft -a list chain ip nat prerouting 2>/dev/null || true)
    if [[ -z "${rules}" ]]; then
        return
    fi
    # Remove rules in reverse order (handle line number shifts)
    local handle
    while IFS= read -r line; do
        handle=$(echo "$line" | grep -oP '# handle \K\d+' || true)
        if [[ -n "${handle}" ]]; then
            nft delete rule ip nat prerouting handle "${handle}" 2>/dev/null || true
        fi
    done < <(echo "$rules" | grep "iifname.*${AP_IFACE}.*dport 53.*redirect" | tac)
}

cleanup_doh_block_iptables() {
    for ip in "${DOH_IPS[@]}"; do
        while iptables -D FORWARD -i "${AP_IFACE}" -d "$ip" -p tcp --dport 443 -j DROP 2>/dev/null; do
            :
        done
    done
    log_info "Removed DoH block rules."
}

cleanup_doh_block_nft() {
    local rules
    rules=$(nft -a list chain ip filter forward 2>/dev/null || true)
    if [[ -z "${rules}" ]]; then
        return
    fi
    local handle
    while IFS= read -r line; do
        handle=$(echo "$line" | grep -oP '# handle \K\d+' || true)
        if [[ -n "${handle}" ]]; then
            nft delete rule ip filter forward handle "${handle}" 2>/dev/null || true
        fi
    done < <(echo "$rules" | grep "iifname.*${AP_IFACE}.*tcp dport 443.*drop" | tac)
}

# -------------------------------------------------------------------
# Apply DNS redirect + DoH block (called from setup functions)
# -------------------------------------------------------------------

apply_dns_policy() {
    if [[ "${DNS_REDIRECT}" != "true" ]]; then
        log_info "DNS_REDIRECT is disabled, skipping DNS policy rules."
        return
    fi

    log_step "Applying DNS traffic policy (redirect + DoH block)..."

    if [[ "${FIREWALL}" == "nft" ]]; then
        setup_dns_redirect_nft
        block_doh_nft
    else
        setup_dns_redirect_iptables
        block_doh_iptables
    fi
}

remove_dns_policy() {
    if [[ "${FIREWALL}" == "nft" ]]; then
        cleanup_dns_redirect_nft
        cleanup_doh_block_nft
    else
        cleanup_dns_redirect_iptables
        cleanup_doh_block_iptables
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

    remove_dns_policy

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
