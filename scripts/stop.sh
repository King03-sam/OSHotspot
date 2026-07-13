#!/usr/bin/env bash
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0
#

# stop.sh - Tear down the WiFi hotspot cleanly.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=utils.sh
source "${SCRIPT_DIR}/utils.sh"

stop_hostapd() {
    log_step "Stopping hostapd..."

    if is_running "${OSHOTSPOT_PID_HOSTAPD}"; then
        local pid
        pid=$(cat "${OSHOTSPOT_PID_HOSTAPD}")
        kill "${pid}" 2>/dev/null || true

        local retries=0
        while kill -0 "${pid}" 2>/dev/null && [[ ${retries} -lt 10 ]]; do
            sleep 0.5
            retries=$((retries + 1))
        done

        if kill -0 "${pid}" 2>/dev/null; then
            log_warn "Force killing hostapd (PID ${pid})..."
            kill -9 "${pid}" 2>/dev/null || true
        fi

        remove_pid "${OSHOTSPOT_PID_HOSTAPD}"
        log_info "hostapd stopped."
    else
        log_info "hostapd is not running."
    fi

    pkill -f "hostapd.*${OSHOTSPOT_HOSTAPD_CONF}" 2>/dev/null || true
}

stop_dnsmasq() {
    log_step "Stopping dedicated dnsmasq instance..."

    if is_running "${OSHOTSPOT_PID_DNSMASQ}"; then
        local pid
        pid=$(cat "${OSHOTSPOT_PID_DNSMASQ}")
        kill "${pid}" 2>/dev/null || true

        local retries=0
        while kill -0 "${pid}" 2>/dev/null && [[ ${retries} -lt 10 ]]; do
            sleep 0.5
            retries=$((retries + 1))
        done

        if kill -0 "${pid}" 2>/dev/null; then
            log_warn "Force killing dnsmasq (PID ${pid})..."
            kill -9 "${pid}" 2>/dev/null || true
        fi

        remove_pid "${OSHOTSPOT_PID_DNSMASQ}"
        log_info "Dedicated dnsmasq stopped."
    else
        log_info "Dedicated dnsmasq is not running."
    fi

    pkill -f "dnsmasq.*${OSHOTSPOT_DNSMASQ_CONF}" 2>/dev/null || true
}

stop_hotspot() {
    require_root
    load_config

    echo ""
    echo -e "${BOLD}========================================${NC}"
    echo -e "${BOLD}       OSHotspot - Stopping Hotspot      ${NC}"
    echo -e "${BOLD}========================================${NC}"
    echo ""

    stop_hostapd
    stop_dnsmasq
    "${SCRIPT_DIR}/firewall.sh" cleanup
    remove_ap_interface "${AP_IFACE}"

    echo ""
    log_info "========================================"
    log_info "  Hotspot has been stopped."
    log_info "========================================"
    echo ""
}

stop_hotspot
