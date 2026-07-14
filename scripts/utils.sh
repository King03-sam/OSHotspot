#!/usr/bin/env bash
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0
#

# utils.sh - Shared functions used by all OSHotspot scripts.

set -euo pipefail

# Paths
readonly OSHOTSPOT_DIR="/etc/oshotspot"
readonly OSHOTSPOT_CONFIG="${OSHOTSPOT_DIR}/config.conf"
readonly OSHOTSPOT_HOSTAPD_CONF="${OSHOTSPOT_DIR}/hostapd.conf"
readonly OSHOTSPOT_DNSMASQ_CONF="${OSHOTSPOT_DIR}/dnsmasq.conf"
readonly OSHOTSPOT_SYSCTL="/etc/sysctl.d/oshotspot.conf"
readonly OSHOTSPOT_PID_HOSTAPD="/run/oshotspot-hostapd.pid"
readonly OSHOTSPOT_PID_DNSMASQ="/run/oshotspot-dnsmasq.pid"
readonly OSHOTSPOT_LOG_DIR="/var/log/oshotspot"
readonly OSHOTSPOT_HOSTAPD_LOG="${OSHOTSPOT_LOG_DIR}/hostapd.log"
readonly OSHOTSPOT_DNSMASQ_LOG="${OSHOTSPOT_LOG_DIR}/dnsmasq.log"

# Where we live on disk
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Colors (disabled if not a terminal)
if [[ -t 1 ]]; then
    readonly RED='\033[0;31m'
    readonly GREEN='\033[0;32m'
    readonly YELLOW='\033[0;33m'
    readonly BLUE='\033[0;34m'
    readonly BOLD='\033[1m'
    readonly NC='\033[0m'
else
    readonly RED='' GREEN='' YELLOW='' BLUE='' BOLD='' NC=''
fi

log_info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
log_step()  { echo -e "${BLUE}[STEP]${NC} ${BOLD}$*${NC}"; }

require_root() {
    if [[ "${EUID}" -ne 0 ]]; then
        log_error "This command must be run as root (use sudo)."
        exit 1
    fi
}

# Load /etc/oshotspot/config.conf and apply defaults.
load_config() {
    if [[ ! -f "${OSHOTSPOT_CONFIG}" ]]; then
        log_error "Configuration not found: ${OSHOTSPOT_CONFIG}"
        log_error "Run 'sudo ./install.sh' first."
        exit 1
    fi

    # shellcheck source=/dev/null
    source "${OSHOTSPOT_CONFIG}"

    AP_IFACE="${AP_IFACE:-ap0}"
    CHANNEL="${CHANNEL:-6}"
    HW_MODE="${HW_MODE:-g}"
    COUNTRY_CODE="${COUNTRY_CODE:-FR}"
    HOSTNAME="${HOSTNAME:-oshotspot}"
    SUBNET="${SUBNET:-192.168.50.0}"
    AP_IP="${AP_IP:-192.168.50.1}"
    AP_CIDR="${AP_CIDR:-24}"
    DHCP_RANGE_START="${DHCP_RANGE_START:-192.168.50.10}"
    DHCP_RANGE_END="${DHCP_RANGE_END:-192.168.50.100}"
    DHCP_LEASE="${DHCP_LEASE:-12h}"
    DNS_PRIMARY="${DNS_PRIMARY:-8.8.8.8}"
    DNS_SECONDARY="${DNS_SECONDARY:-1.1.1.1}"

    if [[ -z "${WIFI_IFACE:-}" ]]; then
        WIFI_IFACE=$(detect_wifi_interface)
    fi

    if [[ -z "${SSID:-}" ]]; then
        log_error "SSID is not set in ${OSHOTSPOT_CONFIG}."
        exit 1
    fi

    if [[ -z "${PASSWORD:-}" ]]; then
        log_error "PASSWORD is not set in ${OSHOTSPOT_CONFIG}."
        exit 1
    fi

    if [[ "${#PASSWORD}" -lt 8 ]]; then
        log_error "PASSWORD must be at least 8 characters for WPA2."
        exit 1
    fi
}

# Find the first wireless interface on the system (skip ap0 and similar).
detect_wifi_interface() {
    local iface=""

    for dev in /sys/class/net/*/wireless; do
        if [[ -d "${dev}" ]]; then
            local name
            name="$(basename "$(dirname "${dev}")")"
            # Skip our AP interface
            if [[ "${name}" == "${AP_IFACE:-ap0}" ]]; then
                continue
            fi
            iface="${name}"
            break
        fi
    done

    if [[ -z "${iface}" ]] && command -v iw &>/dev/null; then
        iface=$(iw dev 2>/dev/null \
            | awk '/Interface/{print $2}' \
            | grep -v "^${AP_IFACE:-ap0}$" \
            | head -1)
    fi

    if [[ -z "${iface}" ]]; then
        log_error "No WiFi interface found."
        exit 1
    fi

    echo "${iface}"
}

# List all wireless interfaces with details (skip ap0).
# Output: iface_name:state:mac
list_wifi_interfaces() {
    local results=()

    for dev in /sys/class/net/*/wireless; do
        if [[ -d "${dev}" ]]; then
            local name state mac
            name="$(basename "$(dirname "${dev}")")"
            if [[ "${name}" == "ap0" ]]; then
                continue
            fi
            state="$(cat "/sys/class/net/${name}/operstate" 2>/dev/null || echo "unknown")"
            mac="$(cat "/sys/class/net/${name}/address" 2>/dev/null || echo "xx:xx:xx:xx:xx:xx")"
            results+=("${name}:${state}:${mac}")
        fi
    done

    if [[ ${#results[@]} -eq 0 ]] && command -v iw &>/dev/null; then
        while IFS= read -r line; do
            local name state mac
            name="${line}"
            state="$(cat "/sys/class/net/${name}/operstate" 2>/dev/null || echo "unknown")"
            mac="$(cat "/sys/class/net/${name}/address" 2>/dev/null || echo "xx:xx:xx:xx:xx:xx")"
            results+=("${name}:${state}:${mac}")
        done < <(iw dev 2>/dev/null | awk '/Interface/{print $2}' | grep -v "^ap0$")
    fi

    for r in "${results[@]}"; do
        echo "${r}"
    done
}

# Given a wireless interface, return its phy device (e.g. phy0).
get_phy_device() {
    local iface="$1"
    local phy_path
    phy_path=$(readlink -f "/sys/class/net/${iface}/phy80211" 2>/dev/null || true)

    if [[ -n "${phy_path}" ]]; then
        basename "${phy_path}"
    else
        log_error "Cannot determine physical device for ${iface}."
        exit 1
    fi
}

# Abort if the adapter doesn't support AP mode.
check_ap_support() {
    local iface="$1"
    local phy

    if ! command -v iw &>/dev/null; then
        log_error "'iw' is not installed. Cannot verify AP mode support."
        exit 1
    fi

    phy=$(get_phy_device "${iface}")

    if ! iw phy "${phy}" info 2>/dev/null | grep -q "AP"; then
        log_error "Your WiFi adapter (${iface}, ${phy}) does not support Access Point mode."
        exit 1
    fi

    log_info "AP mode supported on ${iface} (${phy})."
}

iface_exists() { ip link show "$1" &>/dev/null; }

iface_is_up() {
    [[ "$(cat "/sys/class/net/$1/operstate" 2>/dev/null)" == "up" ]]
}

# Create the virtual AP interface (e.g. ap0).
create_ap_interface() {
    local iface="$1"
    local phy
    phy=$(get_phy_device "${WIFI_IFACE}")

    # Kill any orphan hostapd/dnsmasq that might hold the interface
    pkill -f "hostapd.*oshotspot" 2>/dev/null || true
    pkill -f "dnsmasq.*oshotspot" 2>/dev/null || true
    sleep 1

    if iface_exists "${iface}"; then
        log_warn "Interface ${iface} already exists, removing it first..."
        ip link set "${iface}" down 2>/dev/null || true
        sleep 1
        iw dev "${iface}" del 2>/dev/null || true
        sleep 1
    fi

    log_step "Creating AP interface ${iface} on ${phy}..."
    if ! iw phy "${phy}" interface add "${iface}" type __ap 2>&1; then
        log_error "Failed to create AP interface ${iface}."
        exit 1
    fi

    sleep 1

    if ! iface_exists "${iface}"; then
        log_error "AP interface ${iface} was not created."
        exit 1
    fi

    log_info "AP interface ${iface} created."
}

remove_ap_interface() {
    local iface="$1"

    if iface_exists "${iface}"; then
        log_step "Removing AP interface ${iface}..."
        ip link set "${iface}" down 2>/dev/null || true
        iw dev "${iface}" del 2>/dev/null || true
        log_info "Interface ${iface} removed."
    else
        log_info "Interface ${iface} does not exist, nothing to remove."
    fi
}

# Assign an IP address to the AP interface.
# Note: hostapd brings the interface UP when it starts — don't require it here.
configure_ap_ip() {
    local iface="$1" ip="$2" cidr="$3"

    # Check if the IP is already assigned
    if ip -4 addr show dev "${iface}" 2>/dev/null | grep -q "inet ${ip}/${cidr}"; then
        log_info "IP ${ip}/${cidr} already assigned to ${iface}."
    else
        ip addr flush dev "${iface}" 2>/dev/null || true
        ip addr add "${ip}/${cidr}" dev "${iface}" 2>/dev/null || true
    fi

    # Try to bring it up, but don't fail — hostapd will do it
    ip link set "${iface}" up 2>/dev/null || true
    sleep 1

    log_info "Interface ${iface} configured with IP ${ip}/${cidr}."
}

enable_ip_forward() {
    log_step "Enabling IP forwarding..."
    sysctl -w net.ipv4.ip_forward=1 >/dev/null

    mkdir -p "$(dirname "${OSHOTSPOT_SYSCTL}")"
    echo "net.ipv4.ip_forward=1" > "${OSHOTSPOT_SYSCTL}"
    log_info "IP forwarding enabled."
}

disable_ip_forward() {
    if [[ -f "${OSHOTSPOT_SYSCTL}" ]]; then
        rm -f "${OSHOTSPOT_SYSCTL}"
        log_info "Removed persistent IP forwarding config."
    fi
}

# Generate /etc/oshotspot/hostapd.conf from the template.
generate_hostapd_conf() {
    log_step "Generating hostapd configuration..."

    local template="${PROJECT_DIR}/configs/hostapd.conf.template"
    if [[ ! -f "${template}" ]]; then
        log_error "hostapd template not found: ${template}"
        exit 1
    fi

    mkdir -p "${OSHOTSPOT_DIR}"

    sed -e "s|__AP_IFACE__|${AP_IFACE}|g" \
        -e "s|__SSID__|${SSID}|g" \
        -e "s|__HW_MODE__|${HW_MODE}|g" \
        -e "s|__CHANNEL__|${CHANNEL}|g" \
        -e "s|__COUNTRY_CODE__|${COUNTRY_CODE}|g" \
        -e "s|__PASSWORD__|${PASSWORD}|g" \
        "${template}" > "${OSHOTSPOT_HOSTAPD_CONF}"

    chmod 600 "${OSHOTSPOT_HOSTAPD_CONF}"
    log_info "hostapd config written to ${OSHOTSPOT_HOSTAPD_CONF}."

    touch "${OSHOTSPOT_DIR}/deny_maclist.conf"
}

# Generate /etc/oshotspot/dnsmasq.conf from the template.
generate_dnsmasq_conf() {
    log_step "Generating dnsmasq configuration..."

    local template="${PROJECT_DIR}/configs/dnsmasq.conf.template"
    if [[ ! -f "${template}" ]]; then
        log_error "dnsmasq template not found: ${template}"
        exit 1
    fi

    mkdir -p "${OSHOTSPOT_DIR}"

    sed -e "s|__AP_IFACE__|${AP_IFACE}|g" \
        -e "s|__DHCP_RANGE_START__|${DHCP_RANGE_START}|g" \
        -e "s|__DHCP_RANGE_END__|${DHCP_RANGE_END}|g" \
        -e "s|__DHCP_LEASE__|${DHCP_LEASE}|g" \
        -e "s|__AP_IP__|${AP_IP}|g" \
        -e "s|__DNS_PRIMARY__|${DNS_PRIMARY}|g" \
        -e "s|__DNS_SECONDARY__|${DNS_SECONDARY}|g" \
        "${template}" > "${OSHOTSPOT_DNSMASQ_CONF}"

    chmod 644 "${OSHOTSPOT_DNSMASQ_CONF}"
    log_info "dnsmasq config written to ${OSHOTSPOT_DNSMASQ_CONF}."
}

# Simple PID-file helpers.
is_running() {
    local pid_file="$1"
    if [[ -f "${pid_file}" ]]; then
        local pid
        pid=$(cat "${pid_file}")
        if kill -0 "${pid}" 2>/dev/null; then
            return 0
        fi
        rm -f "${pid_file}"
    fi
    return 1
}

write_pid()  { echo "$2" > "$1"; }
remove_pid() { rm -f "$1"; }

# Make sure every required tool is installed.
check_commands() {
    local missing=()
    for cmd in ip iw sysctl; do
        if ! command -v "${cmd}" &>/dev/null; then
            missing+=("${cmd}")
        fi
    done

    # Check for firewall tool: iptables or nft
    if command -v iptables &>/dev/null; then
        FIREWALL_CMD="iptables"
    elif command -v nft &>/dev/null; then
        FIREWALL_CMD="nft"
    else
        missing+=("iptables|nft")
    fi

    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Missing required commands: ${missing[*]}"
        exit 1
    fi
}

# Firewall wrapper: run iptables or nft depending on what's available.
fw() {
    if [[ "${FIREWALL_CMD:-iptables}" == "nft" ]]; then
        nft "$@"
    else
        iptables "$@"
    fi
}

ensure_log_dir() { mkdir -p "${OSHOTSPOT_LOG_DIR}"; }
