#!/usr/bin/env bash
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0
#

# repair.sh - Restart the hotspot after suspend/resume or driver issues.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=utils.sh
source "${SCRIPT_DIR}/utils.sh"

# Wait up to $2 seconds for the WiFi interface to show up again.
wait_for_wifi() {
    local max_wait="${1:-30}"
    local waited=0

    log_step "Waiting for WiFi interface ${WIFI_IFACE}..."

    while ! iface_exists "${WIFI_IFACE}" && [[ ${waited} -lt ${max_wait} ]]; do
        sleep 1
        waited=$((waited + 1))
    done

    if ! iface_exists "${WIFI_IFACE}"; then
        log_error "WiFi interface ${WIFI_IFACE} did not appear within ${max_wait}s."
        return 1
    fi

    log_info "WiFi interface ${WIFI_IFACE} is available."
    return 0
}

repair_hotspot() {
    require_root
    load_config

    echo ""
    echo -e "${BOLD}========================================${NC}"
    echo -e "${BOLD}       OSHotspot - Repairing Hotspot     ${NC}"
    echo -e "${BOLD}========================================${NC}"
    echo ""

    log_step "[1/6] Stopping existing components..."
    "${SCRIPT_DIR}/stop.sh" 2>/dev/null || true

    log_step "[2/6] Waiting for WiFi interface..."
    if ! wait_for_wifi 30; then
        log_error "Cannot repair: WiFi interface not available."
        exit 1
    fi

    log_step "[3/6] Letting the driver settle..."
    sleep 3

    log_step "[4/6] Verifying AP mode support..."
    check_ap_support "${WIFI_IFACE}"

    log_step "[5/6] Restarting hotspot..."
    "${SCRIPT_DIR}/start.sh"

    log_step "[6/6] Verifying everything is running..."
    local ok=true

    if is_running "${OSHOTSPOT_PID_HOSTAPD}"; then
        log_info "  hostapd: running"
    else
        log_error "  hostapd: NOT running"
        ok=false
    fi

    if is_running "${OSHOTSPOT_PID_DNSMASQ}"; then
        log_info "  dnsmasq: running"
    else
        log_error "  dnsmasq: NOT running"
        ok=false
    fi

    if iface_exists "${AP_IFACE}" && iface_is_up "${AP_IFACE}"; then
        log_info "  AP interface ${AP_IFACE}: up"
    else
        log_error "  AP interface ${AP_IFACE}: down"
        ok=false
    fi

    echo ""
    if ${ok}; then
        log_info "========================================"
        log_info "  Repair complete! Hotspot is running."
        log_info "  SSID: ${SSID}"
        log_info "========================================"
    else
        log_warn "========================================"
        log_warn "  Repair partially completed."
        log_warn "  Check: sudo oshotspot status"
        log_warn "========================================"
    fi
    echo ""
}

repair_hotspot
