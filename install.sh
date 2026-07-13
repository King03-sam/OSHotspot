#!/usr/bin/env bash
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0
#

# install.sh - Install OSHotspot and its dependencies.

set -euo pipefail

if [[ -t 1 ]]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[0;33m'
    BLUE='\033[0;34m'
    BOLD='\033[1m'
    NC='\033[0m'
else
    RED='' GREEN='' YELLOW='' BLUE='' BOLD='' NC=''
fi

log_info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
log_step()  { echo -e "${BLUE}[STEP]${NC} ${BOLD}$*${NC}"; }

if [[ "${EUID}" -ne 0 ]]; then
    log_error "This installer must be run as root (use sudo)."
    exit 1
fi

INSTALL_DIR="/usr/local/bin"
CONFIG_DIR="/etc/oshotspot"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="/var/log/oshotspot"

detect_pkg_manager() {
    if command -v apt-get &>/dev/null; then echo "apt"
    elif command -v dnf &>/dev/null; then echo "dnf"
    elif command -v pacman &>/dev/null; then echo "pacman"
    elif command -v zypper &>/dev/null; then echo "zypper"
    else echo "unknown"
    fi
}

install_dependencies() {
    log_step "Installing required packages..."

    case "$(detect_pkg_manager)" in
        apt)
            apt-get update -qq
            apt-get install -y hostapd dnsmasq iptables iw iproute2 qrencode
            ;;
        dnf)
            dnf install -y hostapd dnsmasq iptables iw iproute qrencode
            ;;
        pacman)
            pacman -S --noconfirm hostapd dnsmasq iptables iw iproute2 qrencode
            ;;
        zypper)
            zypper install -y hostapd dnsmasq iptables iw iproute2 qrencode
            ;;
        *)
            log_warn "Unknown package manager. Install manually: hostapd dnsmasq iptables iw iproute2 qrencode"
            log_warn "Press Enter to continue or Ctrl+C to abort."
            read -r
            ;;
    esac

    log_info "Dependencies installed."
}

setup_config() {
    log_step "Setting up configuration..."

    mkdir -p "${CONFIG_DIR}" "${LOG_DIR}"

    if [[ ! -f "${CONFIG_DIR}/config.conf" ]]; then
        cp "${SRC}/config.conf.example" "${CONFIG_DIR}/config.conf"
        chmod 600 "${CONFIG_DIR}/config.conf"
        log_info "Created: ${CONFIG_DIR}/config.conf"
        log_warn "Edit it to set your SSID and password!"
    else
        log_info "Config already exists at ${CONFIG_DIR}/config.conf"
    fi
}

install_files() {
    log_step "Installing OSHotspot files..."

    install -m 755 "${SRC}/oshotspot" "${INSTALL_DIR}/oshotspot"
    log_info "CLI installed: ${INSTALL_DIR}/oshotspot"

    local scripts_dir="/usr/lib/oshotspot/scripts"
    mkdir -p "${scripts_dir}"
    for script in "${SRC}/scripts/"*.sh; do
        install -m 755 "${script}" "${scripts_dir}/"
    done
    log_info "Scripts installed to ${scripts_dir}/"

    local configs_dir="/usr/lib/oshotspot/configs"
    mkdir -p "${configs_dir}"
    cp "${SRC}/configs/"*.conf.template "${configs_dir}/"
    log_info "Templates installed to ${configs_dir}/"

    # Bash completion
    local completion_dir="/etc/bash_completion.d"
    mkdir -p "${completion_dir}"
    cp "${SRC}/completions/oshotspot" "${completion_dir}/oshotspot"
    log_info "Bash completion installed to ${completion_dir}/oshotspot"
}

update_script_paths() {
    log_step "Updating installed script paths..."

    local scripts_dir="/usr/lib/oshotspot/scripts"

    sed -i "s|readonly OSHOTSPOT_DIR=.*|readonly OSHOTSPOT_DIR=\"${CONFIG_DIR}\"|" \
        "${scripts_dir}/utils.sh"
    sed -i "s|PROJECT_DIR=.*|PROJECT_DIR=\"/usr/lib/oshotspot\"|" \
        "${scripts_dir}/utils.sh"

    log_info "Paths updated."
}

setup_systemd() {
    log_step "Setting up systemd services..."

    local services_dir="/etc/systemd/system"
    local templates_dir="${SRC}/systemd"

    if [[ -d "${templates_dir}" ]] && command -v systemctl &>/dev/null; then
        for f in "${templates_dir}"/*.service; do
            [[ -f "${f}" ]] || continue
            cp "${f}" "${services_dir}/"
            log_info "Installed: $(basename "${f}")"
        done
        systemctl daemon-reload
    else
        log_info "Skipping systemd (systemctl not available)."
    fi
}

check_dnsmasq_conflicts() {
    log_step "Checking for dnsmasq conflicts..."

    if systemctl is-active --quiet dnsmasq 2>/dev/null; then
        log_warn "System dnsmasq is running. This is fine — OSHotspot uses its own dedicated instance."
    fi
}

setup_networkmanager() {
    log_step "Configuring NetworkManager to ignore ap0..."

    local nm_dir="/etc/NetworkManager/conf.d"
    local nm_conf="${nm_dir}/oshotspot.conf"

    if [[ -d "${nm_dir}" ]]; then
        mkdir -p "${nm_dir}"
        cat > "${nm_conf}" <<'NMCONF'
[keyfile]
unmanaged-devices=interface-name:ap0
NMCONF
        log_info "NetworkManager will ignore ap0 (${nm_conf})."

        # Reload NM so it picks up the change
        if systemctl is-active --quiet NetworkManager 2>/dev/null; then
            systemctl reload NetworkManager 2>/dev/null || true
            log_info "NetworkManager reloaded."
        fi
    else
        log_info "NetworkManager not found, skipping."
    fi
}

setup_suspend_hook() {
    log_step "Setting up suspend/resume auto-repair..."

    local services_dir="/etc/systemd/system"

    cat > "${services_dir}/oshotspot-resume.service" <<'UNIT'
[Unit]
Description=OSHotspot Repair After Resume
After=suspend.target hibernate.target hybrid-sleep.target
After=NetworkManager-wait-online.service

[Service]
Type=oneshot
ExecStart=/usr/bin/systemctl restart oshotspot.service
User=root

[Install]
WantedBy=suspend.target hibernate.target hybrid-sleep.target
UNIT

    systemctl daemon-reload
    systemctl enable oshotspot-resume.service 2>/dev/null || true
    log_info "Auto-repair on resume enabled."
}

main() {
    echo ""
    echo -e "${BOLD}========================================${NC}"
    echo -e "${BOLD}      OSHotspot - Installation           ${NC}"
    echo -e "${BOLD}========================================${NC}"
    echo ""

    install_dependencies
    echo ""
    setup_config
    echo ""
    install_files
    echo ""
    update_script_paths
    echo ""
    check_dnsmasq_conflicts
    echo ""
    setup_networkmanager
    echo ""
    setup_systemd
    echo ""
    setup_suspend_hook
    echo ""

    echo -e "${BOLD}========================================${NC}"
    echo -e "${GREEN}Installation complete!${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Edit configuration:"
    echo -e "     ${BOLD}sudo nano /etc/oshotspot/config.conf${NC}"
    echo ""
    echo "  2. Start the hotspot:"
    echo -e "     ${BOLD}sudo oshotspot start${NC}"
    echo ""
    echo "  3. Check status:"
    echo -e "     ${BOLD}sudo oshotspot status${NC}"
    echo ""
    echo "  4. Stop the hotspot:"
    echo -e "     ${BOLD}sudo oshotspot stop${NC}"
    echo ""
    echo "  5. Repair after suspend:"
    echo -e "     ${BOLD}sudo oshotspot repair${NC}"
    echo ""
    echo -e "${BOLD}========================================${NC}"
    echo ""
}

main "$@"
