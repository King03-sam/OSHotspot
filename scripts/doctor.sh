#!/usr/bin/env bash
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0
#

# doctor.sh - Diagnostic tool for OSHotspot.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=utils.sh
source "${SCRIPT_DIR}/utils.sh"

VERSION="1.0"
PASS=0
WARN=0
FAIL=0

check_ok()   { echo -e "  ${GREEN}[OK]${NC}    $*"; PASS=$((PASS + 1)); }
check_warn() { echo -e "  ${YELLOW}[WARN]${NC}  $*"; WARN=$((WARN + 1)); }
check_fail() { echo -e "  ${RED}[FAIL]${NC}  $*"; FAIL=$((FAIL + 1)); }

check_wifi_adapter() {
    local ifaces=()
    for dev in /sys/class/net/*/wireless; do
        if [[ -d "${dev}" ]]; then
            local name
            name="$(basename "$(dirname "${dev}")")"
            if [[ "${name}" != "ap0" ]]; then
                ifaces+=("${name}")
            fi
        fi
    done

    if [[ ${#ifaces[@]} -eq 0 ]]; then
        check_fail "No WiFi adapter detected"
        return
    fi

    if [[ ${#ifaces[@]} -eq 1 ]]; then
        check_ok "WiFi adapter detected (${ifaces[0]})"
    else
        check_ok "WiFi adapters detected: ${ifaces[*]}"
    fi

    # Check AP mode support on first interface
    local phy
    phy=$(get_phy_device "${ifaces[0]}" 2>/dev/null || true)
    if [[ -n "${phy}" ]]; then
        if iw phy "${phy}" info 2>/dev/null | grep -q "AP"; then
            check_ok "AP mode supported (${phy})"
        else
            check_fail "AP mode NOT supported on ${phy}"
        fi
    else
        check_warn "Cannot determine physical device for ${ifaces[0]}"
    fi
}

check_package() {
    local pkg="$1"
    local name="${2:-$1}"
    if command -v "${pkg}" &>/dev/null; then
        check_ok "${name} installed"
    else
        check_fail "${name} NOT installed"
    fi
}

check_ip_forward() {
    local val
    val=$(sysctl -n net.ipv4.ip_forward 2>/dev/null || echo "0")
    if [[ "${val}" == "1" ]]; then
        check_ok "IP forwarding enabled"
    else
        check_warn "IP forwarding disabled (hotspot will enable it on start)"
    fi
}

check_nat() {
    if command -v iptables &>/dev/null && iptables -t nat -L -n 2>/dev/null | grep -q "MASQUERADE"; then
        check_ok "NAT/MASQUERADE configured (iptables)"
    elif command -v nft &>/dev/null && nft list ruleset 2>/dev/null | grep -q "masquerade"; then
        check_ok "NAT/MASQUERADE configured (nftables)"
    else
        check_warn "NAT not configured (hotspot will set it up on start)"
    fi
}

check_config() {
    if [[ -f /etc/oshotspot/config.conf ]]; then
        check_ok "Configuration file exists"
    else
        check_fail "Configuration not found (/etc/oshotspot/config.conf)"
    fi
}

check_networkmanager() {
    if [[ -d /etc/NetworkManager/conf.d ]]; then
        if [[ -f /etc/NetworkManager/conf.d/oshotspot.conf ]]; then
            check_ok "NetworkManager configured to ignore ap0"
        else
            check_warn "NetworkManager may interfere with ap0 (run: sudo oshotspot start to fix)"
        fi
    else
        check_ok "NetworkManager not present (no conflict)"
    fi
}

check_systemd() {
    if command -v systemctl &>/dev/null; then
        if systemctl is-enabled --quiet oshotspot.service 2>/dev/null; then
            check_ok "Systemd service installed"
        else
            check_warn "Systemd service not installed (run: sudo oshotspot start)"
        fi
    else
        check_ok "Systemd not available (skipped)"
    fi
}

check_hotspot_running() {
    local pid_file="/run/oshotspot-hostapd.pid"
    if [[ -f "${pid_file}" ]] && kill -0 "$(cat "${pid_file}")" 2>/dev/null; then
        check_ok "Hotspot is currently RUNNING"
    else
        check_warn "Hotspot is not running"
    fi
}

main() {
    echo ""
    echo -e "${BOLD}OSHotspot Diagnostic v${VERSION}${NC}"
    echo ""

    check_wifi_adapter
    echo ""
    check_package hostapd "hostapd"
    check_package dnsmasq "dnsmasq"
    check_package qrencode "qrencode"
    echo ""
    check_ip_forward
    check_nat
    echo ""
    check_config
    check_networkmanager
    check_systemd
    echo ""
    check_hotspot_running

    echo ""
    echo -e "${BOLD}----------------------------------------${NC}"
    echo -e "  ${GREEN}Passed: ${PASS}${NC}  ${YELLOW}Warnings: ${WARN}${NC}  ${RED}Failed: ${FAIL}${NC}"
    echo ""

    if [[ ${FAIL} -eq 0 ]]; then
        echo -e "  ${GREEN}System is ready.${NC}"
        if [[ ${WARN} -gt 0 ]]; then
            echo -e "  ${YELLOW}Warnings will be resolved on first start.${NC}"
        fi
    else
        echo -e "  ${RED}Issues found. Fix the failures above before starting.${NC}"
    fi
    echo ""
}

main "$@"
