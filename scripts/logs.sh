#!/usr/bin/env bash
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0
#

# logs.sh - View and follow OSHotspot logs.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=utils.sh
source "${SCRIPT_DIR}/utils.sh"

HOSTAPD_LOG="/var/log/oshotspot/hostapd.log"
DNSMASQ_LOG="/var/log/oshotspot/dnsmasq.log"

show_logs() {
    local component="${1:-all}"
    local follow=false
    local lines=50

    for arg in "$@"; do
        case "${arg}" in
            --follow|-f) follow=true ;;
            --lines=*) lines="${arg#*=}" ;;
        esac
    done

    local log_files=()
    case "${component}" in
        hostapd)
            log_files=("${HOSTAPD_LOG}")
            ;;
        dnsmasq)
            log_files=("${DNSMASQ_LOG}")
            ;;
        all)
            log_files=("${HOSTAPD_LOG}" "${DNSMASQ_LOG}")
            ;;
        *)
            log_error "Unknown component: ${component}"
            echo "Usage: oshotspot logs [hostapd|dnsmasq|all] [--follow] [--lines=N]"
            exit 1
            ;;
    esac

    # Check if log files exist
    local found=false
    for lf in "${log_files[@]}"; do
        if [[ -f "${lf}" ]]; then
            found=true
            break
        fi
    done

    if ! ${found}; then
        log_warn "No log files found in /var/log/oshotspot/"
        log_info "Logs will appear after starting the hotspot."
        exit 0
    fi

    if ${follow}; then
        echo -e "${BOLD}Following logs (Ctrl+C to quit)...${NC}"
        echo ""
        tail -f -n "${lines}" "${log_files[@]}" 2>/dev/null
    else
        for lf in "${log_files[@]}"; do
            if [[ -f "${lf}" ]]; then
                echo -e "${BOLD}--- $(basename "${lf}") (last ${lines} lines) ---${NC}"
                tail -n "${lines}" "${lf}"
                echo ""
            fi
        done
    fi
}

main() {
    local component="all"
    local follow=false
    local lines=50

    for arg in "$@"; do
        case "${arg}" in
            hostapd|dnsmasq|all) component="${arg}" ;;
            --follow|-f) follow=true ;;
            --lines=*) lines="${arg#*=}" ;;
            -h|--help)
                echo ""
                echo "Usage: oshotspot logs [component] [options]"
                echo ""
                echo "Components:"
                echo "  hostapd    Show hostapd log only"
                echo "  dnsmasq    Show dnsmasq log only"
                echo "  all        Show both logs (default)"
                echo ""
                echo "Options:"
                echo "  --follow   Follow log output in real-time"
                echo "  --lines=N  Number of lines to show (default: 50)"
                echo ""
                exit 0
                ;;
        esac
    done

    show_logs "${component}" ${follow:+--follow} "--lines=${lines}"
}

main "$@"
