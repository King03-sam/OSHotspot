#!/usr/bin/env bash
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0
#
# scan.sh - WiFi channel occupancy scan for OSHotspot.
#
# Runs `iw dev <iface> scan` on the physical WiFi interface, parses BSS
# entries to extract per-channel network counts and signal strengths,
# and recommends the least congested non-overlapping channel (1/6/11).
#
# If the hotspot is already running, the radio is locked to the AP channel
# and scanning is not possible — the script reports this clearly.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=utils.sh
source "${SCRIPT_DIR}/utils.sh"

SCAN_RESULTS_FILE="/run/oshotspot-scan-results.json"

# Convert frequency (MHz) to 2.4 GHz channel number.
# Returns empty for non-2.4 GHz frequencies.
freq_to_channel_2g() {
    local freq="$1"
    if [[ "${freq}" -ge 2412 && "${freq}" -le 2484 ]]; then
        echo $(( (freq - 2407) / 5 ))
    fi
}

do_scan() {
    require_root
    load_config

    # Determine the WiFi interface to scan on.
    local scan_iface="${WIFI_IFACE:-}"
    if [[ -z "${scan_iface}" ]]; then
        scan_iface=$(detect_wifi_interface 2>/dev/null || true)
    fi
    if [[ -z "${scan_iface}" ]]; then
        log_error "No WiFi interface found for scanning."
        exit 1
    fi

    local is_active_ap=false
    local scan_output=""
    local bss_count=0

    if is_running "${OSHOTSPOT_PID_HOSTAPD}"; then
        is_active_ap=true
        log_info "Hotspot is ACTIVE on ${AP_IFACE}. Using cached WiFi scan dump on ${scan_iface}..."
        scan_output=$(iw dev "${scan_iface}" scan dump 2>&1) || true
        bss_count=$(echo "${scan_output}" | grep -c '^BSS ' || true)
    else
        echo ""
        log_step "Scanning WiFi channels on ${scan_iface}..."
        echo ""
        scan_output=$(iw dev "${scan_iface}" scan 2>&1) || {
            ip link set "${scan_iface}" up 2>/dev/null || true
            sleep 1
            scan_output=$(iw dev "${scan_iface}" scan 2>&1) || true
        }
        bss_count=$(echo "${scan_output}" | grep -c '^BSS ' || true)
    fi

    if [[ "${bss_count}" -eq 0 ]]; then
        log_warn "Fresh scan returned no results (NetworkManager may hold the interface)."
        log_info "Trying cached scan results..."
        local cached_output=""
        cached_output=$(iw dev "${scan_iface}" scan dump 2>&1) || true
        local cached_bss=0
        cached_bss=$(echo "${cached_output}" | grep -c '^BSS ' || true)
        if [[ "${cached_bss}" -gt 0 ]]; then
            scan_output="${cached_output}"
            bss_count="${cached_bss}"
            log_info "Found ${bss_count} cached network(s)."
        else
            log_error "No scan results available (tried fresh scan and cache)."
            log_error "Ensure the WiFi adapter is working and not blocked:"
            log_info "  rfkill list wifi"
            log_info "  sudo rfkill unblock wifi"
            echo ""
        fi
    fi

    # Parse the scan output into per-channel aggregates.
    # We track: channel -> count of networks, channel -> strongest signal (dBm).
    declare -A ch_count
    declare -A ch_max_signal
    local DEFAULT_SIGNAL=-100
    local current_freq=""
    local current_ssid=""
    local current_signal=""

    while IFS= read -r line; do
        # New BSS block starts with "BSS "
        if [[ "${line}" =~ ^BSS\ [0-9a-fA-F:]+ ]]; then
            # Process previous BSS if it was 2.4 GHz
            if [[ -n "${current_freq}" ]]; then
                local ch
                ch=$(freq_to_channel_2g "${current_freq}")
                if [[ -n "${ch}" && "${ch}" -ge 1 && "${ch}" -le 13 ]]; then
                    ch_count[${ch}]=$(( ${ch_count[${ch}]:-0} + 1 ))
                    local prev_max="${ch_max_signal[${ch}]:-${DEFAULT_SIGNAL}}"
                    if [[ "${current_signal}" -gt "${prev_max}" ]]; then
                        ch_max_signal[${ch}]="${current_signal}"
                    fi
                fi
            fi
            current_freq=""
            current_ssid=""
            current_signal=""
        fi

        # Extract frequency (iw scan: "frequency: 2437 MHz", scan dump: "freq: 2437.0")
        if [[ "${line}" =~ frequency:\ ([0-9]+)\ MHz ]]; then
            current_freq="${BASH_REMATCH[1]}"
        elif [[ "${line}" =~ freq:\ ([0-9]+) ]]; then
            current_freq="${BASH_REMATCH[1]}"
        fi

        # Extract signal strength (dBm)
        if [[ "${line}" =~ signal:\ (-?[0-9]+)\.[0-9]+\ dBm ]]; then
            current_signal="${BASH_REMATCH[1]}"
        fi

        # Extract SSID (may be empty for hidden networks)
        if [[ "${line}" =~ ^[[:space:]]+SSID:\ (.+) ]]; then
            current_ssid="${BASH_REMATCH[1]}"
        fi
    done <<< "${scan_output}"

    # Process the last BSS block
    if [[ -n "${current_freq}" ]]; then
        local ch
        ch=$(freq_to_channel_2g "${current_freq}")
        if [[ -n "${ch}" && "${ch}" -ge 1 && "${ch}" -le 13 ]]; then
            ch_count[${ch}]=$(( ${ch_count[${ch}]:-0} + 1 ))
            local prev_max="${ch_max_signal[${ch}]:-${DEFAULT_SIGNAL}}"
            if [[ "${current_signal}" -gt "${prev_max}" ]]; then
                ch_max_signal[${ch}]="${current_signal}"
            fi
        fi
    fi

    # Count total networks detected.
    local total_networks=0
    for ch in $(seq 1 13); do
        total_networks=$((total_networks + ${ch_count[${ch}]:-0}))
    done

    # Find the best channel.
    # Priority: empty non-overlapping (1/6/11) > strongest signal among 1/6/11.
    local best_ch=6
    local best_signal=${DEFAULT_SIGNAL}

    # 1) Check for empty channels among 1, 6, 11.
    for ch in 1 6 11; do
        local cnt="${ch_count[${ch}]:-0}"
        if [[ "${cnt}" -eq 0 ]]; then
            best_ch="${ch}"
            best_signal=0
            break
        fi
    done

    # 2) If no empty non-overlapping channel, pick the one with the strongest signal among 1, 6, 11.
    if [[ "${best_signal}" -eq "${DEFAULT_SIGNAL}" ]]; then
        for ch in 1 6 11; do
            local sig="${ch_max_signal[${ch}]:-${DEFAULT_SIGNAL}}"
            if [[ "${sig}" -gt "${best_signal}" ]]; then
                best_signal="${sig}"
                best_ch="${ch}"
            fi
        done
    fi

    # Print human-readable results.
    echo -e "${BOLD}Channel Scan Results${NC}"
    echo -e "${BOLD}====================${NC}"
    echo ""
    printf "  ${BOLD}%-10s %-12s %-20s${NC}\n" "Channel" "Networks" "Strongest Signal"
    printf "  %-10s %-12s %-20s\n" "-------" "--------" "----------------"

    for ch in $(seq 1 13); do
        local cnt="${ch_count[${ch}]:-0}"
        local sig="${ch_max_signal[${ch}]:-}"
        local marker=""

        if [[ "${ch}" -eq "${best_ch}" ]]; then
            marker=" ${GREEN}← recommended${NC}"
        elif [[ "${ch}" -eq 1 || "${ch}" -eq 6 || "${ch}" -eq 11 ]]; then
            marker=""
        fi

        if [[ -n "${sig}" ]]; then
            printf "  %-10s %-12s %-20s" "${ch}" "${cnt}" "${sig} dBm"
        else
            printf "  %-10s %-12s %-20s" "${ch}" "${cnt}" "—"
        fi
        echo -e "${marker}"
    done

    echo ""
    if [[ "${total_networks}" -eq 0 ]]; then
        log_info "No networks detected. All channels are clear."
    else
        log_info "Detected ${total_networks} network(s). Recommended channel: ${best_ch}"
    fi
    echo ""

    # Write JSON results for the API and doctor integration.
    local json_channels="["
    local first=true
    for ch in $(seq 1 13); do
        local cnt="${ch_count[${ch}]:-0}"
        local sig="${ch_max_signal[${ch}]:-${DEFAULT_SIGNAL}}"
        if [[ "${first}" == "true" ]]; then
            first=false
        else
            json_channels+=","
        fi
        json_channels+="{\"channel\":${ch},\"count\":${cnt},\"signal\":${sig}}"
    done
    json_channels+="]"

    cat > "${SCAN_RESULTS_FILE}" <<EOFSCAN
{
  "ok": true,
  "hotspot_active": ${is_active_ap},
  "scan_iface": "${scan_iface}",
  "configured_channel": ${CHANNEL:-6},
  "total_networks": ${total_networks},
  "channels": ${json_channels},
  "recommendation": ${best_ch},
  "timestamp": $(date +%s)
}
EOFSCAN

    chmod 644 "${SCAN_RESULTS_FILE}" 2>/dev/null || true
}

do_scan "$@"
