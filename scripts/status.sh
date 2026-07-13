#!/usr/bin/env bash
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0
#

# status.sh - Show the current state of the hotspot and its components.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=utils.sh
source "${SCRIPT_DIR}/utils.sh"

status_line() {
    printf "  %-20s ${3}%-20s${NC}\n" "$1" "$2"
}

get_client_count() {
    local count=0
    if command -v hostapd_cli &>/dev/null && is_running "${OSHOTSPOT_PID_HOSTAPD}"; then
        count=$(hostapd_cli -i "${AP_IFACE}" all_sta 2>/dev/null \
            | grep -c "^" 2>/dev/null || echo "0")
    fi
    echo "${count}"
}

show_connected_clients() {
    if ! is_running "${OSHOTSPOT_PID_HOSTAPD}"; then
        return
    fi

    if ! command -v hostapd_cli &>/dev/null; then
        echo "  (install hostapd-utils for client details)"
        return
    fi

    local clients
    clients=$(hostapd_cli -i "${AP_IFACE}" all_sta 2>/dev/null \
        | grep -E "^([0-9a-fA-F]{2}:){5}" || true)

    if [[ -z "${clients}" ]]; then
        echo "  (none)"
        return
    fi

    while IFS= read -r mac; do
        local hostname="unknown"
        if [[ -f /var/lib/misc/dnsmasq.leases ]]; then
            hostname=$(awk -v mac="${mac}" '$4 == mac {print $3}' \
                /var/lib/misc/dnsmasq.leases 2>/dev/null || echo "unknown")
        fi
        printf "  %-20s %s\n" "${mac}" "${hostname}"
    done <<< "${clients}"
}

show_status() {
    require_root

    echo ""
    echo -e "${BOLD}========================================${NC}"
    echo -e "${BOLD}         OSHotspot - Status              ${NC}"
    echo -e "${BOLD}========================================${NC}"
    echo ""

    if [[ -f "${OSHOTSPOT_CONFIG}" ]]; then
        load_config
    else
        log_warn "Configuration not found at ${OSHOTSPOT_CONFIG}."
        AP_IFACE="ap0"
        WIFI_IFACE=""
        SSID="(not configured)"
    fi

    # WiFi interface
    if [[ -n "${WIFI_IFACE:-}" ]] && iface_exists "${WIFI_IFACE}"; then
        status_line "WiFi Interface:" "${WIFI_IFACE}" "${GREEN}"
    else
        status_line "WiFi Interface:" "NOT FOUND" "${RED}"
    fi

    # AP interface
    if iface_exists "${AP_IFACE}" && iface_is_up "${AP_IFACE}"; then
        local ap_ip
        ap_ip=$(ip -4 addr show "${AP_IFACE}" 2>/dev/null \
            | grep -oP 'inet \K[0-9.]+' || echo "none")
        status_line "AP Interface (${AP_IFACE}):" "UP (${ap_ip})" "${GREEN}"
    elif iface_exists "${AP_IFACE}"; then
        status_line "AP Interface (${AP_IFACE}):" "DOWN" "${YELLOW}"
    else
        status_line "AP Interface (${AP_IFACE}):" "NOT CREATED" "${RED}"
    fi

    status_line "SSID:" "${SSID:-N/A}" "${NC}"

    # hostapd
    if is_running "${OSHOTSPOT_PID_HOSTAPD}"; then
        status_line "hostapd:" "RUNNING (PID $(cat "${OSHOTSPOT_PID_HOSTAPD}"))" "${GREEN}"
    else
        status_line "hostapd:" "STOPPED" "${RED}"
    fi

    # dnsmasq
    if is_running "${OSHOTSPOT_PID_DNSMASQ}"; then
        status_line "dnsmasq (dedicated):" "RUNNING (PID $(cat "${OSHOTSPOT_PID_DNSMASQ}"))" "${GREEN}"
    else
        status_line "dnsmasq (dedicated):" "STOPPED" "${RED}"
    fi

    # IP forwarding
    local fwd
    fwd=$(sysctl -n net.ipv4.ip_forward 2>/dev/null || echo "0")
    if [[ "${fwd}" == "1" ]]; then
        status_line "IP Forwarding:" "ENABLED" "${GREEN}"
    else
        status_line "IP Forwarding:" "DISABLED" "${RED}"
    fi

    # NAT
    if iptables -t nat -C POSTROUTING -s "${SUBNET:-192.168.50.0}/${AP_CIDR:-24}" \
        -o "${WIFI_IFACE:-wlp2s0}" -j MASQUERADE 2>/dev/null; then
        status_line "NAT (MASQUERADE):" "ACTIVE" "${GREEN}"
    else
        status_line "NAT (MASQUERADE):" "NOT CONFIGURED" "${YELLOW}"
    fi

    # Clients
    local count
    count=$(get_client_count)
    echo ""
    echo -e "${BOLD}  Connected Clients: ${count}${NC}"
    if [[ "${count}" -gt 0 ]]; then
        echo -e "  ${BOLD}MAC Address          Hostname${NC}"
        show_connected_clients
    fi

    echo ""
}

show_status
