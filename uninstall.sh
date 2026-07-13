#!/usr/bin/env bash
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0
#

# uninstall.sh - Remove OSHotspot from the system.

set -euo pipefail

if [[ -t 1 ]]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    BOLD='\033[1m'
    NC='\033[0m'
else
    RED='' GREEN='' BOLD='' NC=''
fi

log_info() { echo -e "${GREEN}[INFO]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

if [[ "${EUID}" -ne 0 ]]; then
    log_error "This uninstaller must be run as root (use sudo)."
    exit 1
fi

main() {
    echo ""
    echo -e "${BOLD}========================================${NC}"
    echo -e "${BOLD}      OSHotspot - Uninstallation         ${NC}"
    echo -e "${BOLD}========================================${NC}"
    echo ""

    # Stop hotspot if running
    log_info "Stopping hotspot if running..."
    /usr/local/bin/oshotspot stop 2>/dev/null || true

    # Remove CLI
    if [[ -f /usr/local/bin/oshotspot ]]; then
        rm -f /usr/local/bin/oshotspot
        log_info "Removed /usr/local/bin/oshotspot"
    fi

    # Remove scripts
    if [[ -d /usr/lib/oshotspot ]]; then
        rm -rf /usr/lib/oshotspot
        log_info "Removed /usr/lib/oshotspot/"
    fi

    # Remove systemd services
    local removed=0
    for svc in oshotspot.service oshotspot-dnsmasq.service oshotspot-resume.service; do
        if [[ -f "/etc/systemd/system/${svc}" ]]; then
            systemctl stop "${svc}" 2>/dev/null || true
            systemctl disable "${svc}" 2>/dev/null || true
            rm -f "/etc/systemd/system/${svc}"
            log_info "Removed: ${svc}"
            removed=1
        fi
    done
    [[ ${removed} -eq 1 ]] && systemctl daemon-reload

    # Remove persistent sysctl
    if [[ -f /etc/sysctl.d/oshotspot.conf ]]; then
        rm -f /etc/sysctl.d/oshotspot.conf
        log_info "Removed /etc/sysctl.d/oshotspot.conf"
    fi

    # Clean PID files
    rm -f /run/oshotspot-hostapd.pid /run/oshotspot-dnsmasq.pid

    # Optionally remove config and logs
    echo ""
    read -rp "Remove configuration files in /etc/oshotspot/? [y/N] " ans
    if [[ "${ans}" =~ ^[Yy]$ ]]; then
        rm -rf /etc/oshotspot
        log_info "Removed /etc/oshotspot/"
    fi

    read -rp "Remove log files in /var/log/oshotspot/? [y/N] " ans
    if [[ "${ans}" =~ ^[Yy]$ ]]; then
        rm -rf /var/log/oshotspot
        log_info "Removed /var/log/oshotspot/"
    fi

    echo ""
    log_info "========================================"
    log_info "  OSHotspot has been uninstalled."
    log_info "========================================"
    echo ""
}

main "$@"
