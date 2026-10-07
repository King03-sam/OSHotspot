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
# Dedicated DHCP lease file for the hotspot's dnsmasq instance. Kept in
# /run (tmpfs) so it is cleared on reboot, and wiped on start so stale
# MAC/IP/hostname mappings can never be attributed to new clients.
readonly OSHOTSPOT_DNSMASQ_LEASES="/run/oshotspot-dnsmasq.leases"
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

    # Sanitize: CHANNEL=0 (from a previous ACS attempt, manual edit, or
    # restored backup) is incompatible with self-managed WiFi drivers.
    # Rewrite it to a safe fixed channel unconditionally so hostapd never
    # receives channel=0.
    if [[ "${CHANNEL:-}" == "0" ]]; then
        log_warn "CHANNEL=0 is not supported (incompatible with this driver)."
        log_warn "Automatically correcting to channel 1."
        CHANNEL="1"
        sed -i 's/^CHANNEL=0$/CHANNEL="1"/' "${OSHOTSPOT_CONFIG}" 2>/dev/null || true
    fi

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
    DNS_REDIRECT="${DNS_REDIRECT:-true}"

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
        # Fallback: extract phy from iw dev output
        local phy
        phy=$(iw dev 2>/dev/null | awk -v iface="${iface}" '
            /^[[:space:]]*phy/ { gsub(/[^a-z0-9]/, "", $1); current_phy = $1 }
            /^[[:space:]]*Interface/ && $2 == iface { print current_phy; exit }
        ' | head -1)
        if [[ -n "${phy}" ]]; then
            echo "${phy}"
        else
            log_error "Cannot determine physical device for ${iface}."
            exit 1
        fi
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

    # Fast check: does iw list report AP mode?
    if iw phy "${phy}" info 2>/dev/null | grep -q "AP"; then
        log_info "AP mode supported on ${iface} (${phy})."
        return 0
    fi

    # Fallback: if grep fails (transient state after hostapd Ctrl+C),
    # test by creating and removing ap0 directly.
    iw dev ap0 del 2>/dev/null || true
    if iw phy "${phy}" interface add ap0 type __ap 2>/dev/null; then
        iw dev ap0 del 2>/dev/null || true
        log_info "AP mode supported on ${iface} (${phy})."
        return 0
    fi

    log_error "Your WiFi adapter (${iface}, ${phy}) does not support Access Point mode."
    log_error "Run 'sudo hostapd -dd /etc/oshotspot/hostapd.conf' for details."
    exit 1
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

    # Keep the AP link IPv4-only: disable IPv6 autoconfiguration on the
    # interface so it can never acquire a (semi)global IPv6 address or
    # accept RA that an IPv6-capable phone could use to bypass the
    # IPv4-only DNS redirect / blocking rules.
    sysctl -w "net.ipv6.conf.${iface}.accept_ra=0"    >/dev/null 2>&1 || true
    sysctl -w "net.ipv6.conf.${iface}.autoconf=0"     >/dev/null 2>&1 || true
    sysctl -w "net.ipv6.conf.${iface}.accept_dad=0"   >/dev/null 2>&1 || true

    # Check if the IP is already assigned
    if ip -4 addr show dev "${iface}" 2>/dev/null | grep -q "inet ${ip}/${cidr}"; then
        log_info "IP ${ip}/${cidr} already assigned to ${iface}."
    else
        ip addr flush dev "${iface}" 2>/dev/null || true
        ip addr add "${ip}/${cidr}" dev "${iface}" 2>/dev/null || true
    fi

    # Try to bring it up, but don't fail — hostapd will do it
    if ! ip link set "${iface}" up 2>/dev/null; then
        log_warn "Failed to bring ${iface} up (hostapd may still succeed)."
    fi
    sleep 1

    log_info "Interface ${iface} configured with IP ${ip}/${cidr}."
}

enable_ip_forward() {
    log_step "Enabling IP forwarding..."
    sysctl -w net.ipv4.ip_forward=1 >/dev/null

    # IPv4-only hotspot: do NOT forward IPv6, otherwise any IPv6 route
    # present upstream could let clients reach the internet over IPv6,
    # bypassing every IPv4 DNS/DoH/site/app filter this project enforces.
    sysctl -w net.ipv6.conf.all.forwarding=0 >/dev/null 2>&1 || true
    sysctl -w net.ipv6.conf.default.forwarding=0 >/dev/null 2>&1 || true

    mkdir -p "$(dirname "${OSHOTSPOT_SYSCTL}")"
    cat > "${OSHOTSPOT_SYSCTL}" <<EOF
net.ipv4.ip_forward=1
net.ipv6.conf.all.forwarding=0
net.ipv6.conf.default.forwarding=0
EOF
    log_info "IP forwarding enabled (IPv4=1, IPv6=0)."
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

    local open_wifi="${WIFI_OPEN:-false}"

    if [[ "${open_wifi}" == "true" ]] || [[ -z "${PASSWORD:-}" ]]; then
        log_info "Configuring OPEN WiFi network (no password)..."
        sed -e "s|__AP_IFACE__|${AP_IFACE}|g" \
            -e "s|__SSID__|${SSID}|g" \
            -e "s|__HW_MODE__|${HW_MODE}|g" \
            -e "s|__CHANNEL__|${CHANNEL}|g" \
            -e "s|__COUNTRY_CODE__|${COUNTRY_CODE}|g" \
            -e "/^auth_algs=/d" \
            -e "/^wpa=/d" \
            -e "/^wpa_passphrase=/d" \
            -e "/^wpa_key_mgmt=/d" \
            -e "/^rsn_pairwise=/d" \
            "${template}" > "${OSHOTSPOT_HOSTAPD_CONF}"
        echo "auth_algs=1" >> "${OSHOTSPOT_HOSTAPD_CONF}"
    else
        sed -e "s|__AP_IFACE__|${AP_IFACE}|g" \
            -e "s|__SSID__|${SSID}|g" \
            -e "s|__HW_MODE__|${HW_MODE}|g" \
            -e "s|__CHANNEL__|${CHANNEL}|g" \
            -e "s|__COUNTRY_CODE__|${COUNTRY_CODE}|g" \
            -e "s|__PASSWORD__|${PASSWORD}|g" \
            "${template}" > "${OSHOTSPOT_HOSTAPD_CONF}"
    fi

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

    # dhcp-lease-max = size of the address pool, so the lease table can't
    # grow past what the network can actually hold.
    local range_start_last="${DHCP_RANGE_START##*.}"
    local range_end_last="${DHCP_RANGE_END##*.}"
    local lease_max=100
    if [[ "${range_start_last}" =~ ^[0-9]+$ ]] && [[ "${range_end_last}" =~ ^[0-9]+$ ]]; then
        lease_max=$(( 10#${range_end_last} - 10#${range_start_last} + 1 ))
        [[ ${lease_max} -lt 1 ]] && lease_max=1
    fi

    sed -e "s|__AP_IFACE__|${AP_IFACE}|g" \
        -e "s|__DHCP_RANGE_START__|${DHCP_RANGE_START}|g" \
        -e "s|__DHCP_RANGE_END__|${DHCP_RANGE_END}|g" \
        -e "s|__DHCP_LEASE__|${DHCP_LEASE}|g" \
        -e "s|__DHCP_LEASE_MAX__|${lease_max}|g" \
        -e "s|__AP_IP__|${AP_IP}|g" \
        -e "s|__DNS_PRIMARY__|${DNS_PRIMARY}|g" \
        -e "s|__DNS_SECONDARY__|${DNS_SECONDARY}|g" \
        -e "s|__LOG_FACILITY__|${OSHOTSPOT_DNSMASQ_LOG}|g" \
        "${template}" > "${OSHOTSPOT_DNSMASQ_CONF}"

    chmod 644 "${OSHOTSPOT_DNSMASQ_CONF}"
    log_info "dnsmasq config written to ${OSHOTSPOT_DNSMASQ_CONF}."

    # Create an empty forbidden-domains block file if it doesn't exist,
    # so dnsmasq's conf-file= directive doesn't cause a startup error.
    # The web dashboard regenerates this file via scripts/
    # reload-dns-blocking.sh when the admin manages forbidden domains;
    # it contains a pair of "address=/domain/<ip>" directives per
    # domain (0.0.0.0 for A, :: for AAAA) covering the domain and
    # every subdomain.
    local blocked_file="${OSHOTSPOT_DIR}/dnsmasq-blocked.conf"
    if [[ ! -f "${blocked_file}" ]]; then
        echo "# Forbidden domains block list (managed by OSHotspot dashboard)" > "${blocked_file}"
        echo "# Per domain: address=/domain/0.0.0.0 + address=/domain/:: (all subdomains)" >> "${blocked_file}"
    fi
    chmod 644 "${blocked_file}"

    # Create an empty nftset/ipset directives file if it doesn't exist,
    # so dnsmasq's conf-file= directive doesn't cause a startup error.
    local nftset_file="${OSHOTSPOT_DIR}/dnsmasq-nftset.conf"
    if [[ ! -f "${nftset_file}" ]]; then
        echo "# Forbidden domains nftset/ipset directives (managed by OSHotspot dashboard)" > "${nftset_file}"
        echo "# Per domain: nftset=/domain/4#inet#oshotspot#blocked_ips + 6#..." >> "${nftset_file}"
    fi
    chmod 644 "${nftset_file}"

    # Generate the custom captive portal domain resolution file.
    # When CAPTIVE_DOMAIN is set in config.conf, this injects an
    # address= directive so hotspot clients resolve the domain to AP_IP
    # without needing an external DNS server or manual /etc/hosts entry.
    local domain_file="${OSHOTSPOT_DIR}/dnsmasq-captive-domain.conf"
    local raw_domain="${CAPTIVE_DOMAIN:-}"
    local clean_domain=""
    if [[ -n "${raw_domain}" ]]; then
        clean_domain=$(echo "${raw_domain}" | sed -e 's#^https\?://##' -e 's#/.*##' -e 's#:.*##' | tr '[:upper:]' '[:lower:]' | xargs)
    fi

    if [[ -n "${clean_domain}" ]]; then
        printf "# Custom captive portal domain (auto-generated by OSHotspot)\n" > "${domain_file}"
        printf "# Resolves %s to the AP so portal opens on any HTTP request\n" "${clean_domain}" >> "${domain_file}"
        # Authoritative local zone: AAAA is not forwarded upstream (avoids
        # IPv6 bypass). Do NOT use address=/domain/:: — Happy Eyeballs would
        # prefer :: and break access even when the A record is correct.
        printf "local=/%s/\n" "${clean_domain}" >> "${domain_file}"
        printf "address=/%s/%s\n" "${clean_domain}" "${AP_IP}" >> "${domain_file}"
        if [[ "${clean_domain}" == www.* ]] && [[ ${#clean_domain} -gt 4 ]]; then
            local root_dom="${clean_domain#www.}"
            printf "local=/%s/\n" "${root_dom}" >> "${domain_file}"
            printf "address=/%s/%s\n" "${root_dom}" "${AP_IP}" >> "${domain_file}"
        fi
        log_info "Custom captive domain DNS: ${clean_domain} -> ${AP_IP}"
    else
        printf "# No custom captive portal domain configured\n" > "${domain_file}"
    fi
    chmod 644 "${domain_file}"
}

# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# Client detection
#
# The authoritative list of "who is connected right now" comes from hostapd
# (the L2 association table). The DHCP lease file only ever enriches a MAC
# with its IP and hostname — it must never decide who shows up, otherwise a
# stale lease (a device that left but whose lease has not expired, or whose
# IP was reassigned to a new client) keeps being displayed with the old
# device's MAC and name.
# ---------------------------------------------------------------------------

# Return the MAC addresses currently associated to the AP interface.
get_associated_macs() {
    local iface="${1:-ap0}"
    local macs=() mac=""

    # Source 1: hostapd station list (authoritative, L2).
    if command -v hostapd_cli &>/dev/null; then
        while IFS= read -r mac; do
            mac=$(echo "${mac}" | tr '[:upper:]' '[:lower:]')
            if echo "${mac}" | grep -qE '^([0-9a-f]{2}:){5}[0-9a-f]{2}$'; then
                macs+=("${mac}")
            fi
        done < <(hostapd_cli -i "${iface}" all_sta 2>/dev/null)
    fi

    # Source 2 (fallback): kernel neighbour table on the AP interface.
    if [[ ${#macs[@]} -eq 0 ]]; then
        local _ip _dev _iface lladdr state
        while IFS=' ' read -r _ip _dev _iface lladdr mac state; do
            if [[ "${lladdr}" == "lladdr" ]] \
                && echo "${mac}" | grep -qE '^([0-9a-f]{2}:){5}[0-9a-f]{2}$'; then
                mac=$(echo "${mac}" | tr '[:upper:]' '[:lower:]')
                case "${state}" in
                    REACHABLE|STALE|DELAY|PROBE|PERMANENT)
                        macs+=("${mac}")
                        ;;
                esac
            fi
        done < <(ip neigh show dev "${iface}" 2>/dev/null)
    fi

    for mac in "${macs[@]}"; do
        echo "${mac}"
    done
}

# Output currently connected clients as "mac|ip|hostname", one per line.
# The list is driven by get_associated_macs(); the lease file only adds
# the IP and hostname for each MAC.
read_connected_clients() {
    local iface="${AP_IFACE:-ap0}"
    local lease_file="${OSHOTSPOT_DNSMASQ_LEASES}"
    local -A ip_of=() hostname_of=()

    # Index the DHCP lease file by MAC.
    if [[ -f "${lease_file}" ]]; then
        local expiry mac ip hostname client_id _rest
        while IFS=' ' read -r expiry mac ip hostname client_id _rest; do
            [[ -z "${mac}" ]] && continue
            mac=$(echo "${mac}" | tr '[:upper:]' '[:lower:]')
            ip_of["${mac}"]="${ip}"
            hostname_of["${mac}"]="${hostname}"
        done < "${lease_file}"
    fi

    local mac
    while IFS= read -r mac; do
        [[ -z "${mac}" ]] && continue
        local ip="${ip_of[${mac}]:-}"
        local hostname="${hostname_of[${mac}]:-}"
        echo "${mac}|${ip}|${hostname}"
    done < <(get_associated_macs "${iface}")
}
