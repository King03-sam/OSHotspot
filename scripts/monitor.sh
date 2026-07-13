#!/usr/bin/env bash
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0
#

# monitor.sh - Real-time monitoring of the hotspot.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=utils.sh
source "${SCRIPT_DIR}/utils.sh"

# Read DHCP leases
read_dhcp_leases() {
    local lease_file="/var/lib/misc/dnsmasq.leases"
    [[ -f "${lease_file}" ]] || return

    while IFS=' ' read -r expiry mac ip hostname client_id _rest; do
        [[ -z "${mac}" ]] && continue
        echo "${mac}|${ip}|${hostname}"
    done < "${lease_file}"
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

# Get interface stats from /proc/net/dev
get_iface_stats() {
    local iface="$1"
    if [[ -f /proc/net/dev ]]; then
        awk -v iface="${iface}:" '$0 ~ iface {print $2, $10}' /proc/net/dev
    fi
}

show_monitor() {
    require_root
    load_config

    # Check if hotspot is running
    if ! is_running "${OSHOTSPOT_PID_HOSTAPD}"; then
        log_error "Hotspot is not running. Start it with: sudo oshotspot start"
        exit 1
    fi

    # Track previous stats for delta calculation
    local prev_ap_rx=0
    local prev_ap_tx=0
    local prev_time=0

    # Get initial stats
    read -r prev_ap_rx prev_ap_tx <<< "$(get_iface_stats "${AP_IFACE}")"
    prev_time=$(date +%s)

    # Trap Ctrl+C to exit cleanly
    trap 'echo -e "\n${GREEN}Monitor stopped.${NC}"; exit 0' INT TERM

    while true; do
        clear

        local now
        now=$(date +%s)
        local elapsed=$((now - prev_time))
        [[ ${elapsed} -eq 0 ]] && elapsed=1

        # Current stats
        local ap_rx ap_tx
        read -r ap_rx ap_tx <<< "$(get_iface_stats "${AP_IFACE}")"

        # Calculate delta (speed)
        local rx_delta=$((ap_rx - prev_ap_rx))
        local tx_delta=$((ap_tx - prev_ap_tx))
        local rx_speed=$((rx_delta / elapsed))
        local tx_speed=$((tx_delta / elapsed))

        # Client count
        local client_count=0
        local clients=()
        while IFS='|' read -r mac ip hostname; do
            [[ -z "${mac}" ]] && continue
            clients+=("${mac}|${ip}|${hostname}")
            client_count=$((client_count + 1))
        done < <(read_dhcp_leases)

        # hostapd status
        local hostapd_status="STOPPED"
        if is_running "${OSHOTSPOT_PID_HOSTAPD}"; then
            hostapd_status="RUNNING"
        fi

        local dnsmasq_status="STOPPED"
        if is_running "${OSHOTSPOT_PID_DNSMASQ}"; then
            dnsmasq_status="RUNNING"
        fi

        # Display
        echo -e "${BOLD}========================================${NC}"
        echo -e "${BOLD}    OSHotspot Monitor - $(date '+%H:%M:%S')${NC}"
        echo -e "${BOLD}========================================${NC}"
        echo ""
        echo -e "  SSID:      ${BOLD}${SSID}${NC}"
        echo -e "  Interface: ${AP_IFACE} | Channel: ${CHANNEL}"
        echo -e "  hostapd:   ${hostapd_status} | dnsmasq: ${dnsmasq_status}"
        echo -e "  Clients:   ${BOLD}${client_count}${NC}"
        echo ""

        if [[ ${client_count} -gt 0 ]]; then
            echo -e "${BOLD}  MAC Address          IP Address       Hostname${NC}"
            echo "  ------------------------------------------------"

            for client in "${clients[@]}"; do
                IFS='|' read -r mac ip hostname <<< "${client}"
                [[ -z "${hostname}" || "${hostname}" == "*" ]] && hostname="-"
                printf "  %-20s %-16s %s\n" "${mac}" "${ip}" "${hostname}"
            done
        else
            echo "  No clients connected."
        fi

        echo ""
        echo -e "${BOLD}  Traffic:${NC}"
        echo "  AP (${AP_IFACE}):"
        echo "    Total  RX: $(format_bytes "${ap_rx}") | TX: $(format_bytes "${ap_tx}")"
        echo "    Speed  RX: $(format_bytes "${rx_speed}")/s | TX: $(format_bytes "${tx_speed}")/s"
        echo ""

        # Save for next iteration
        prev_ap_rx=${ap_rx}
        prev_ap_tx=${ap_tx}
        prev_time=${now}

        echo -e "  ${YELLOW}Refreshing every 3s... Press Ctrl+C to quit${NC}"
        echo ""

        sleep 3
    done
}

show_monitor
