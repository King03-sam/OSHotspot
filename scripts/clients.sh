#!/usr/bin/env bash
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0
#

# clients.sh - Show connected clients on the hotspot.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=utils.sh
source "${SCRIPT_DIR}/utils.sh"

# Read DHCP leases from dnsmasq
read_dhcp_leases() {
    local lease_file="/var/lib/misc/dnsmasq.leases"
    if [[ ! -f "${lease_file}" ]]; then
        return
    fi

    while IFS=' ' read -r expiry mac ip hostname client_id _rest; do
        # Skip empty lines
        [[ -z "${mac}" ]] && continue
        echo "${mac}|${ip}|${hostname}"
    done < "${lease_file}"
}

# Get traffic stats for an IP from /proc/net/dev via arp + conntrack
get_client_traffic() {
    local ip="$1"
    local rx_bytes=0
    local tx_bytes=0

    # Try conntrack for per-IP stats
    if command -v conntrack &>/dev/null; then
        local stats
        stats=$(conntrack -L -f ipv4 2>/dev/null | grep -c "src=${ip}" || true)
        # conntrack doesn't give byte counts easily, fall back to interface stats
    fi

    # Read from /proc/net/nf_conntrack if available
    if [[ -f /proc/net/nf_conntrack ]]; then
        local conn_count
        conn_count=$(grep -c "src=${ip}" /proc/net/nf_conntrack 2>/dev/null || echo "0")
        echo "${conn_count} conns"
        return
    fi

    echo "-"
}

# Get interface traffic stats
get_iface_traffic() {
    local iface="$1"
    if [[ -f /proc/net/dev ]]; then
        local stats
        stats=$(grep "${iface}:" /proc/net/dev 2>/dev/null | awk '{print $2, $10}')
        local rx=$(echo "${stats}" | awk '{print $1}')
        local tx=$(echo "${stats}" | awk '{print $2}')
        echo "${rx}|${tx}"
    fi
}

# Format bytes to human readable
format_bytes() {
    local bytes="${1:-0}"
    if [[ "${bytes}" -ge 1073741824 ]]; then
        echo "$(echo "scale=1; ${bytes}/1073741824" | bc 2>/dev/null || echo "${bytes}") GB"
    elif [[ "${bytes}" -ge 1048576 ]]; then
        echo "$(echo "scale=1; ${bytes}/1048576" | bc 2>/dev/null || echo "${bytes}") MB"
    elif [[ "${bytes}" -ge 1024 ]]; then
        echo "$(echo "scale=1; ${bytes}/1024" | bc 2>/dev/null || echo "${bytes}") KB"
    else
        echo "${bytes} B"
    fi
}

show_clients() {
    require_root
    load_config

    echo ""
    echo -e "${BOLD}========================================${NC}"
    echo -e "${BOLD}       OSHotspot - Connected Clients     ${NC}"
    echo -e "${BOLD}========================================${NC}"
    echo ""

    # Check if hotspot is running
    if ! is_running "${OSHOTSPOT_PID_HOSTAPD}"; then
        log_warn "Hotspot is not running. Start it with: sudo oshotspot start"
        echo ""
        return
    fi

    # Read DHCP leases
    local clients=()
    while IFS='|' read -r mac ip hostname; do
        [[ -z "${mac}" ]] && continue
        clients+=("${mac}|${ip}|${hostname}")
    done < <(read_dhcp_leases)

    if [[ ${#clients[@]} -eq 0 ]]; then
        log_info "No clients connected."
        echo ""
        return
    fi

    # Print header
    printf "${BOLD}%-20s %-18s %-16s %s${NC}\n" "MAC Address" "IP Address" "Hostname" "Status"
    echo "--------------------------------------------------------------------------------"

    # Print each client
    for client in "${clients[@]}"; do
        IFS='|' read -r mac ip hostname <<< "${client}"

        # Check if client is reachable via ARP
        local status="connected"
        if ip neigh show "${ip}" 2>/dev/null | grep -q "REACHABLE\|STALE\|DELAY"; then
            status="active"
        elif ip neigh show "${ip}" 2>/dev/null | grep -q "FAILED\|INCOMPLETE"; then
            status="inactive"
        fi

        # Format hostname
        if [[ -z "${hostname}" || "${hostname}" == "*" ]]; then
            hostname="-"
        fi

        printf "%-20s %-18s %-16s ${GREEN}%s${NC}\n" "${mac}" "${ip}" "${hostname}" "${status}"
    done

    echo ""

    # Show AP traffic stats
    local ap_traffic
    ap_traffic=$(get_iface_traffic "${AP_IFACE}")
    local ap_rx=$(echo "${ap_traffic}" | cut -d'|' -f1)
    local ap_tx=$(echo "${ap_traffic}" | cut -d'|' -f2)

    echo -e "${BOLD}AP Interface (${AP_IFACE}) Traffic:${NC}"
    echo "  RX: $(format_bytes "${ap_rx}") | TX: $(format_bytes "${ap_tx}")"
    echo ""
    echo -e "  Total clients: ${BOLD}${#clients[@]}${NC}"
    echo ""
}

show_clients
