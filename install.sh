#!/usr/bin/env bash
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0
#

# install.sh - Install OSHotspot and its dependencies.
# Works in two modes:
# 1. Local: sudo ./install.sh (from cloned repo)
# 2. Remote: curl -fsSL URL | sudo bash (one-liner install)

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

log_info() { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
log_step() { echo -e "${BLUE}[STEP]${NC} ${BOLD}$*${NC}"; }

if [[ "${EUID}" -ne 0 ]]; then
    log_error "This installer must be run as root (use sudo)."
    exit 1
fi

INSTALL_DIR="/usr/local/bin"
CONFIG_DIR="/etc/oshotspot"
LOG_DIR="/var/log/oshotspot"
REPO_URL="https://github.com/King03-sam/OSHotspot"
TEMP_DIR=""

cleanup() {
    if [[ -n "${TEMP_DIR}" && -d "${TEMP_DIR}" ]]; then
        rm -rf "${TEMP_DIR}"
    fi
}

trap cleanup EXIT

download_source() {
    log_step "Downloading OSHotspot from GitHub..."

    if ! command -v curl &>/dev/null && ! command -v wget &>/dev/null; then
        log_error "Neither curl nor wget is installed."
        log_error "Install curl first: sudo apt install curl"
        exit 1
    fi

    TEMP_DIR="$(mktemp -d)"
    local archive="${TEMP_DIR}/oshotspot.tar.gz"

    if command -v curl &>/dev/null; then
        curl -fsSL "${REPO_URL}/archive/refs/heads/main.tar.gz" -o "${archive}"
    else
        wget -q "${REPO_URL}/archive/refs/heads/main.tar.gz" -O "${archive}"
    fi

    tar -xzf "${archive}" -C "${TEMP_DIR}"
    SRC="${TEMP_DIR}/OSHotspot-main"
    log_info "Downloaded and extracted to ${SRC}"
}

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
            apt-get update -qq || log_warn "Some repositories failed to update. Continuing..."
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
    if [[ -f "${SRC}/uninstall.sh" ]]; then
        install -m 755 "${SRC}/uninstall.sh" "${scripts_dir}/uninstall.sh"
    fi
    log_info "Scripts installed to ${scripts_dir}/"

    local configs_dir="/usr/lib/oshotspot/configs"
    mkdir -p "${configs_dir}"
    if [[ -d "${SRC}/configs" ]]; then
        cp "${SRC}/configs/"* "${configs_dir}/" 2>/dev/null || true
    fi
    log_info "Configs installed to ${configs_dir}/"

    # Bash completion
    local completion_dir="/etc/bash_completion.d"
    mkdir -p "${completion_dir}"
    if [[ -f "${SRC}/completions/oshotspot" ]]; then
        cp "${SRC}/completions/oshotspot" "${completion_dir}/oshotspot"
        log_info "Bash completion installed to ${completion_dir}/oshotspot"
    fi

    # Zsh completion
    local zsh_dir="/usr/share/zsh/site-functions"
    if [[ -d "${zsh_dir}" && -f "${SRC}/completions/oshotspot.zsh" ]]; then
        cp "${SRC}/completions/oshotspot.zsh" "${zsh_dir}/_oshotspot"
        log_info "Zsh completion installed to ${zsh_dir}/_oshotspot"
    fi

    # Fish completion
    local fish_dir="/usr/share/fish/vendor_completions.d"
    if [[ -d "${fish_dir}" && -f "${SRC}/completions/oshotspot.fish" ]]; then
        cp "${SRC}/completions/oshotspot.fish" "${fish_dir}/oshotspot.fish"
        log_info "Fish completion installed to ${fish_dir}/oshotspot.fish"
    fi

    # Web dashboard
    local web_dir="/usr/lib/oshotspot/web"
    rm -rf "${web_dir}" 2>/dev/null || true
    mkdir -p "${web_dir}/static/js"
    if [[ -f "${SRC}/web/serve.py" ]]; then
        cp "${SRC}/web/serve.py" "${web_dir}/serve.py"
        cp -r "${SRC}/web/server/." "${web_dir}/server/"
        cp -r "${SRC}/web/static/." "${web_dir}/static/"
        log_info "Web dashboard installed to ${web_dir}/"
    fi
}

compile_c_tools() {
    log_step "Compiling C tools (optional, for enhanced auto-detection)..."

    if ! command -v gcc &>/dev/null; then
        log_warn "gcc not found. C tools not compiled."
        log_warn "To install: sudo apt install gcc libnl-genl-3-dev"
        return
    fi

    if [[ ! -f "${SRC}/Makefile" ]]; then
        log_warn "Makefile not found. C tools not compiled."
        return
    fi

    cd "${SRC}"

    # Try to compile (may fail if libnl not installed)
    if make all 2>/dev/null; then
        # Install to /usr/local/bin
        install -m 755 oshotspot-scan /usr/local/bin/ 2>/dev/null || true
        install -m 755 oshotspot-gen /usr/local/bin/ 2>/dev/null || true
        install -m 755 oshotspot-watchdog /usr/local/bin/ 2>/dev/null || true
        log_info "C tools installed: oshotspot-scan, oshotspot-gen, oshotspot-watchdog"
    else
        log_warn "C tools compilation failed. Using bash fallback."
        log_warn "To install dependencies: sudo apt install gcc libnl-genl-3-dev"
    fi

    # Cleanup build artifacts
    make clean 2>/dev/null || true
}

update_script_paths() {
    log_step "Updating installed script paths..."

    local scripts_dir="/usr/lib/oshotspot/scripts"

    if [[ -f "${scripts_dir}/utils.sh" ]]; then
        sed -i "s|readonly OSHOTSPOT_DIR=.*|readonly OSHOTSPOT_DIR=\"${CONFIG_DIR}\"|" \
            "${scripts_dir}/utils.sh"
        sed -i "s|PROJECT_DIR=.*|PROJECT_DIR=\"/usr/lib/oshotspot\"|" \
            "${scripts_dir}/utils.sh"
        log_info "Paths updated."
    fi
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

    if ! command -v systemctl &>/dev/null; then
        log_info "Skipping suspend hook (systemctl not available)."
        return
    fi

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
    echo -e "${BOLD} OSHotspot - Installation ${NC}"
    echo -e "${BOLD}========================================${NC}"
    echo ""

    # Detect source: local directory or download from GitHub
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

    if [[ -f "${script_dir}/oshotspot" && -d "${script_dir}/scripts" ]]; then
        SRC="${script_dir}"
        log_info "Using local source files from ${SRC}"
    else
        download_source
    fi

    install_dependencies
    echo ""
    setup_config
    echo ""
    install_files
    echo ""
    compile_c_tools
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
    echo " 1. Edit configuration:"
    echo -e "     ${BOLD}sudo nano /etc/oshotspot/config.conf${NC}"
    echo ""
    echo " 2. Launch the web dashboard:"
    echo -e "     ${BOLD}sudo oshotspot web${NC}"
    echo ""
    echo " 3. Start the hotspot:"
    echo -e "     ${BOLD}sudo oshotspot start${NC}"
    echo ""
    echo " 4. Check status:"
    echo -e "     ${BOLD}sudo oshotspot status${NC}"
    echo ""
    echo " 5. Show QR code:"
    echo -e "     ${BOLD}sudo oshotspot qr${NC}"
    echo ""
    echo " 6. Stop the hotspot:"
    echo -e "     ${BOLD}sudo oshotspot stop${NC}"
    echo ""
    echo " 7. Repair after suspend:"
    echo -e "     ${BOLD}sudo oshotspot repair${NC}"
    echo ""
    echo -e "${BOLD}========================================${NC}"
    echo ""
}

main "$@"
