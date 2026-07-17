#!/usr/bin/env bash
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0
#

# start.sh - Bring up the WiFi hotspot (AP interface, hostapd, dnsmasq, NAT).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=utils.sh
source "${SCRIPT_DIR}/utils.sh"

start_hostapd() {
    log_step "Starting hostapd..."

    if is_running "${OSHOTSPOT_PID_HOSTAPD}"; then
        local old_pid
        old_pid=$(cat "${OSHOTSPOT_PID_HOSTAPD}")
        log_warn "Stopping existing hostapd (PID ${old_pid})..."
        kill "${old_pid}" 2>/dev/null || true
        sleep 1
        remove_pid "${OSHOTSPOT_PID_HOSTAPD}"
    fi

    # Force kill any stale hostapd process that might hold the interface
    pkill -9 -f hostapd 2>/dev/null || true
    sleep 3

    ensure_log_dir

    local rc=0
    timeout 15 hostapd -B "${OSHOTSPOT_HOSTAPD_CONF}" \
        -P "${OSHOTSPOT_PID_HOSTAPD}" \
        >> "${OSHOTSPOT_HOSTAPD_LOG}" 2>&1 || rc=$?

    sleep 2
    if is_running "${OSHOTSPOT_PID_HOSTAPD}"; then
        log_info "hostapd started (PID $(cat "${OSHOTSPOT_PID_HOSTAPD}"))."
    else
        log_error "hostapd failed to start (exit code: ${rc})."
        if [[ -f "${OSHOTSPOT_HOSTAPD_LOG}" ]]; then
            log_error "Last lines from ${OSHOTSPOT_HOSTAPD_LOG}:"
            tail -10 "${OSHOTSPOT_HOSTAPD_LOG}" | while IFS= read -r line; do
                log_error "  ${line}"
            done
        fi
        exit 1
    fi
}

start_dnsmasq() {
    log_step "Starting dedicated dnsmasq instance..."

    if is_running "${OSHOTSPOT_PID_DNSMASQ}"; then
        local old_pid
        old_pid=$(cat "${OSHOTSPOT_PID_DNSMASQ}")
        log_warn "Stopping existing dnsmasq (PID ${old_pid})..."
        kill "${old_pid}" 2>/dev/null || true
        sleep 1
        remove_pid "${OSHOTSPOT_PID_DNSMASQ}"
    fi

    ensure_log_dir

    if ! command -v dnsmasq &>/dev/null; then
        log_error "dnsmasq is not installed."
        exit 1
    fi

    # Kill system dnsmasq if it occupies port 53
    if pgrep -x dnsmasq >/dev/null 2>&1; then
        log_warn "System dnsmasq detected, stopping it..."
        systemctl stop dnsmasq 2>/dev/null || true
        pkill -x dnsmasq 2>/dev/null || true
        sleep 1
    fi

    # Let dnsmasq daemonize itself so it writes the PID file properly
    dnsmasq \
        --conf-file="${OSHOTSPOT_DNSMASQ_CONF}" \
        --pid-file="${OSHOTSPOT_PID_DNSMASQ}" \
        --log-facility="${OSHOTSPOT_DNSMASQ_LOG}"

    local retries=0
    while ! is_running "${OSHOTSPOT_PID_DNSMASQ}" && [[ ${retries} -lt 10 ]]; do
        sleep 0.5
        retries=$((retries + 1))
    done

    if is_running "${OSHOTSPOT_PID_DNSMASQ}"; then
        log_info "Dedicated dnsmasq started (PID $(cat "${OSHOTSPOT_PID_DNSMASQ}"))."
    else
        log_error "dnsmasq failed to start."
        if [[ -f "${OSHOTSPOT_DNSMASQ_LOG}" ]]; then
            log_error "Last lines from dnsmasq log:"
            tail -10 "${OSHOTSPOT_DNSMASQ_LOG}" | while IFS= read -r line; do
                log_error "  ${line}"
            done
        fi
        exit 1
    fi
}

start_hotspot() {
    require_root
    load_config
    check_commands

    echo ""
    echo -e "${BOLD}========================================${NC}"
    echo -e "${BOLD}       OSHotspot - Starting Hotspot      ${NC}"
    echo -e "${BOLD}========================================${NC}"
    echo ""

    check_ap_support "${WIFI_IFACE}"

    # Auto-scan WiFi capabilities (C tool, optional)
    local caps_json=""
    if command -v oshotspot-scan &>/dev/null; then
        log_step "Scanning WiFi capabilities..."
        local phy
        phy=$(iw phy | head -1 | awk '{print $2}' | sed 's/:$//')
        if [[ -z "${phy}" ]]; then
            phy="phy0"
        fi
        caps_json=$(timeout 5 oshotspot-scan --phy="${phy}" 2>/dev/null) || true
        if [[ -n "${caps_json}" ]] && echo "${caps_json}" | grep -q '"supports_ap": true' && echo "${caps_json}" | grep -q '"channels_2g": \['; then
            echo "${caps_json}" > /tmp/oshotspot_caps.json
            log_info "WiFi capabilities detected."
        else
            log_info "C scan skipped (no valid data), using bash fallback."
            caps_json=""
        fi
    fi

    # Tell NetworkManager to ignore ap0 so it doesn't interfere with hostapd
    local nm_conf="/etc/NetworkManager/conf.d/oshotspot.conf"
    if [[ -d /etc/NetworkManager/conf.d ]] && [[ ! -f "${nm_conf}" ]]; then
        mkdir -p /etc/NetworkManager/conf.d
        echo -e "[keyfile]\nunmanaged-devices=interface-name:ap0" > "${nm_conf}"
        systemctl reload NetworkManager 2>/dev/null || true
        log_info "NetworkManager configured to ignore ${AP_IFACE}."
    fi

    create_ap_interface "${AP_IFACE}"
    sleep 3
    configure_ap_ip "${AP_IFACE}" "${AP_IP}" "${AP_CIDR}"

    # Generate hostapd config (adaptive C tool or fallback to bash)
    if command -v oshotspot-gen &>/dev/null && [[ -f /tmp/oshotspot_caps.json ]]; then
        log_step "Generating adaptive hostapd config..."
        timeout 5 oshotspot-gen --caps=/tmp/oshotspot_caps.json \
                      --config="${OSHOTSPOT_DIR}/config.conf" \
                      --output="${OSHOTSPOT_HOSTAPD_CONF}"
        log_info "Adaptive hostapd config generated."
    else
        generate_hostapd_conf
    fi

    generate_dnsmasq_conf
    enable_ip_forward
    "${SCRIPT_DIR}/firewall.sh" setup
    sleep 2
    start_hostapd
    start_dnsmasq

    # Start watchdog (C tool, optional)
    if command -v oshotspot-watchdog &>/dev/null; then
        oshotspot-watchdog monitor --interval=10 &
        log_info "Watchdog started."
    fi

    echo ""
    log_info "========================================"
    log_info "  Hotspot is running!"
    log_info "  SSID:      ${SSID}"
    log_info "  Interface: ${AP_IFACE}"
    log_info "  IP:        ${AP_IP}"
    log_info "  Channel:   ${CHANNEL}"
    log_info "========================================"
    echo ""
}

start_hotspot
