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
    log_step "Downloading OSHotspot from GitHub Releases..."

    if ! command -v curl &>/dev/null && ! command -v wget &>/dev/null; then
        log_error "Neither curl nor wget is installed."
        log_error "Install curl first: sudo apt install curl"
        exit 1
    fi

    TEMP_DIR="$(mktemp -d)"
    local archive="${TEMP_DIR}/oshotspot.tar.gz"

    # GitHub release assets are fetched over HTTPS.
    # Override version with OSHOTSPOT_VERSION env var if needed.
    local version="${OSHOTSPOT_VERSION:-}"
    if [[ -z "${version}" ]]; then
        version=$(curl -fsSL "https://api.github.com/repos/King03-sam/OSHotspot/releases/latest" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"v\([^"]*\)".*/\1/')
    fi
    # Accept "5.1" or "v5.1": release assets exist in both forms across versions.
    version="${version#v}"
    local candidates=(
        "${REPO_URL}/releases/latest/download/oshotspot-v${version}.tar.gz"
        "${REPO_URL}/releases/latest/download/oshotspot-${version}.tar.gz"
    )

    local downloaded=""
    for release_url in "${candidates[@]}"; do
        if command -v curl &>/dev/null; then
            if curl -fsSL "${release_url}" -o "${archive}"; then downloaded="${release_url}"; break; fi
        else
            if wget -q "${release_url}" -O "${archive}"; then downloaded="${release_url}"; break; fi
        fi
    done
    if [[ -z "${downloaded}" ]]; then
        log_error "Failed to download OSHotspot release ${version} (tried ${candidates[*]})."
        exit 1
    fi

    tar -xzf "${archive}" -C "${TEMP_DIR}"
    # package.sh names the top dir oshotspot-${VERSION} (with or without leading v
    # depending on how it was invoked), accept either layout.
    if [[ -d "${TEMP_DIR}/oshotspot-v${version}" ]]; then
        SRC="${TEMP_DIR}/oshotspot-v${version}"
    elif [[ -d "${TEMP_DIR}/oshotspot-${version}" ]]; then
        SRC="${TEMP_DIR}/oshotspot-${version}"
    else
        SRC=$(find "${TEMP_DIR}" -maxdepth 1 -type d -name 'oshotspot-*' | head -n 1)
    fi
    if [[ -z "${SRC}" || ! -d "${SRC}" ]]; then
        log_error "Extracted archive has no oshotspot-* directory."
        exit 1
    fi
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
            apt-get install -y hostapd dnsmasq iptables iw iproute2 qrencode gcc make libnl-genl-3-dev msmtp python3 python3-pip
            ;;
        dnf)
            dnf install -y hostapd dnsmasq iptables iw iproute qrencode gcc make libnl3-devel msmtp python3 python3-pip
            ;;
        pacman)
            pacman -S --noconfirm hostapd dnsmasq iptables iw iproute2 qrencode gcc make libnl msmtp python python-pip
            ;;
        zypper)
            zypper install -y hostapd dnsmasq iptables iw iproute2 qrencode gcc make libnl-genl-3-devel msmtp python3 python3-pip
            ;;
        *)
            log_warn "Unknown package manager. Install manually: hostapd dnsmasq iptables iw iproute2 qrencode gcc make libnl-genl-3-dev msmtp python3 python3-pip"
            log_warn "Press Enter to continue or Ctrl+C to abort."
            read -r
            ;;
    esac

    log_info "Dependencies installed."
}

install_tailscale() {
    log_step "Installing Tailscale (VPN for remote access)..."

    if command -v tailscale &>/dev/null; then
        log_info "Tailscale already installed."
        return
    fi

    if ! command -v curl &>/dev/null; then
        log_warn "curl not found. Install curl first, then run: curl -fsSL https://tailscale.com/install.sh | sh"
        return
    fi

    log_info "Installing Tailscale via official script..."
    curl -fsSL https://tailscale.com/install.sh | sh
    log_info "Tailscale installed."
}

install_pip_dependencies() {
    log_step "Installing Python dependencies (pygtail, tenacity, fpdf2)..."

    if ! command -v python3 &>/dev/null; then
        log_warn "python3 not found. Python dependencies not installed."
        log_warn "Install python3 first: sudo apt install python3"
        return
    fi

    local req="${SRC}/requirements.txt"

    local pip_cmd=""
    if command -v pip3 &>/dev/null; then
        pip_cmd="pip3"
    elif python3 -m pip --version &>/dev/null; then
        pip_cmd="python3 -m pip"
    else
        log_warn "pip not available. Install it: sudo apt install python3-pip"
        if [[ -f "${req}" ]]; then
            log_warn "Then run: pip3 install -r ${req}"
        else
            log_warn "Then run: pip3 install \"pygtail>=0.4.0\" \"tenacity>=8.0.0\" \"fpdf2>=2.0\""
        fi
        return
    fi

    # Fallback inline list so tarballs published without requirements.txt
    # (e.g. 5.1) still install dependencies instead of skipping silently.
    if [[ ! -f "${req}" ]]; then
        log_warn "requirements.txt not found in ${SRC}. Using built-in dependency list."
        if ! ${pip_cmd} install "pygtail>=0.4.0" "tenacity>=8.0.0" "fpdf2>=2.0" &>/dev/null; then
            log_warn "Standard pip install failed, retrying with --break-system-packages"
            ${pip_cmd} install --break-system-packages "pygtail>=0.4.0" "tenacity>=8.0.0" "fpdf2>=2.0" || true
        fi
        log_info "Python dependencies installed."
        return
    fi

    # PEP 668 (Debian/Ubuntu 23.04+) blocks system pip; fall back to
    # --break-system-packages so the install still works on those images.
    if ! ${pip_cmd} install -r "${req}" &>/dev/null; then
        log_warn "Standard pip install failed, retrying with --break-system-packages"
        ${pip_cmd} install --break-system-packages -r "${req}" || true
    fi

    # Ensure fpdf2 is available for PDF code export feature
    if ! ${pip_cmd} show fpdf2 &>/dev/null; then
        log_info "Installing fpdf2 for PDF code export..."
        ${pip_cmd} install --break-system-packages "fpdf2>=2.0" || true
    fi

    log_info "Python dependencies installed."
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
        # Migrate the stock portal message to the new default. Custom
        # messages are never touched, only the exact legacy default.
        local legacy_msg='CAPTIVE_MESSAGE="Welcome to OSHotspot! Please accept terms or enter access code to connect."'
        if grep -qxF "${legacy_msg}" "${CONFIG_DIR}/config.conf"; then
            sed -i 's|^CAPTIVE_MESSAGE=.*|CAPTIVE_MESSAGE="Enter access code to connect."|' "${CONFIG_DIR}/config.conf"
            log_info "Updated stock portal message to the new default."
        fi
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
    else
        log_warn "uninstall.sh not found in ${SRC}; 'oshotspot uninstall' will be unavailable."
    fi
    log_info "Scripts installed to ${scripts_dir}/"

    local configs_dir="/usr/lib/oshotspot/configs"
    mkdir -p "${configs_dir}"
    if [[ -d "${SRC}/configs" ]]; then
        cp "${SRC}/configs/"* "${configs_dir}/" 2>/dev/null || true
    fi
    log_info "Configs installed to ${configs_dir}/"

    # Install example config for 'config reset'
    if [[ -f "${SRC}/config.conf.example" ]]; then
        install -m 644 "${SRC}/config.conf.example" "/usr/lib/oshotspot/config.conf.example"
    fi

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

    # Install version marker
    if [[ -f "${SRC}/VERSION" ]]; then
        install -m 644 "${SRC}/VERSION" "/usr/lib/oshotspot/VERSION"
        log_info "Version file installed"
    fi

    # Web dashboard
    local web_dir="/usr/lib/oshotspot/web"
    # Backup existing uploaded logos if present before updating web directory
    local backup_dir="$(mktemp -d)"
    if [[ -d "${web_dir}/static/images" ]]; then
        cp -r "${web_dir}/static/images/." "${backup_dir}/" 2>/dev/null || true
    fi

    rm -rf "${web_dir}" 2>/dev/null || true
    mkdir -p "${web_dir}/static/js" "${web_dir}/static/images" /var/lib/oshotspot/images /etc/oshotspot/images /var/lib/oshotspot

    # Captive codes are now stored in /var/lib/oshotspot/ instead of /etc/oshotspot/
    # so the web server (running as non-root) can write them.
    if [[ ! -f "/var/lib/oshotspot/captive_codes.json" ]]; then
        echo '{"codes":[]}' > /var/lib/oshotspot/captive_codes.json
        chmod 644 /var/lib/oshotspot/captive_codes.json
    fi
    if [[ -f "/etc/oshotspot/captive_codes.conf" ]] && [[ ! -s "/var/lib/oshotspot/captive_codes.json" ]]; then
        cp /etc/oshotspot/captive_codes.conf /var/lib/oshotspot/captive_codes.json
        chmod 644 /var/lib/oshotspot/captive_codes.json
    fi

    if [[ -f "${SRC}/web/serve.py" ]]; then
        cp "${SRC}/web/serve.py" "${web_dir}/serve.py"
        cp -r "${SRC}/web/server/." "${web_dir}/server/"
        cp -r "${SRC}/web/static/." "${web_dir}/static/"

        # Restore persistent logo images to web static dir so they are never lost on update
        cp -n "${backup_dir}/"* "${web_dir}/static/images/" 2>/dev/null || true
        cp -n /var/lib/oshotspot/images/* "${web_dir}/static/images/" 2>/dev/null || true
        cp -n /etc/oshotspot/images/* "${web_dir}/static/images/" 2>/dev/null || true

        # Sync existing images to persistent locations
        cp -n "${web_dir}/static/images/"* /var/lib/oshotspot/images/ 2>/dev/null || true
        cp -n "${web_dir}/static/images/"* /etc/oshotspot/images/ 2>/dev/null || true
        rm -rf "${backup_dir}" 2>/dev/null || true
        log_info "Web dashboard installed to ${web_dir}/"
    fi

    # Event collector (Python; requires pygtail + tenacity, see requirements.txt)
    local events_dir="/usr/lib/oshotspot/events"
    local tailer_was_running=false
    if pgrep -f "events[.]tailer|events/tailer.py" &>/dev/null; then
        tailer_was_running=true
        pkill -f "events[.]tailer|events/tailer.py" 2>/dev/null || true
        rm -f /run/oshotspot-tailer.pid
    fi

    rm -rf "${events_dir}" 2>/dev/null || true
    if [[ -d "${SRC}/events" ]]; then
        mkdir -p "${events_dir}"
        cp -r "${SRC}/events/." "${events_dir}/"
        log_info "Event collector installed to ${events_dir}/"
    fi

    if [[ "${tailer_was_running}" == "true" && -f "${events_dir}/tailer.py" ]]; then
        # NOTE: do NOT pass --log-file here, the default
        # (/var/log/oshotspot/dnsmasq.log) is the dnsmasq query log to parse.
        # Passing events.log (the alert log) would make the collector tail
        # its own output and no Events would ever reach the dashboard.
        PYTHONPATH="/usr/lib/oshotspot" python3 -m events.tailer --daemon \
            --pid-file /run/oshotspot-tailer.pid &>/dev/null &
        log_info "Restarted active event collector daemon."
    fi
}

compile_c_tools() {
    log_step "Compiling C tools (for enhanced auto-detection)..."

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
    local installed=0

    # Compile each tool independently, partial success is acceptable
    local libnl_cflags libnl_libs
    libnl_cflags=$(pkg-config --cflags libnl-genl-3.0 2>/dev/null || echo "-I/usr/include/libnl3")
    libnl_libs=$(pkg-config --libs libnl-genl-3.0 2>/dev/null || echo "-lnl-genl-3 -lnl-3")

    if gcc -std=gnu99 -O2 -Wall -Iinclude -o oshotspot-scan src/oshotspot-scan.c \
            ${libnl_cflags} ${libnl_libs} -lpthread 2>/dev/null; then
        install -m 755 oshotspot-scan /usr/local/bin/
        installed=$((installed + 1))
    else
        log_warn "oshotspot-scan compilation failed (needs libnl-genl-3-dev)"
    fi

    if gcc -std=gnu99 -O2 -Wall -Iinclude -o oshotspot-gen src/oshotspot-gen.c 2>/dev/null; then
        install -m 755 oshotspot-gen /usr/local/bin/
        installed=$((installed + 1))
    else
        log_warn "oshotspot-gen compilation failed"
    fi

    if gcc -std=gnu99 -O2 -Wall -Iinclude -o oshotspot-watchdog src/oshotspot-watchdog.c 2>/dev/null; then
        install -m 755 oshotspot-watchdog /usr/local/bin/
        installed=$((installed + 1))
    else
        log_warn "oshotspot-watchdog compilation failed"
    fi

    if [[ ${installed} -gt 0 ]]; then
        log_info "C tools compiled and installed (${installed}/3)"
    else
        log_warn "No C tools could be compiled. Using bash fallback."
    fi

    # Cleanup build artifacts
    rm -f oshotspot-scan oshotspot-gen oshotspot-watchdog
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
        log_warn "System dnsmasq is running. This is fine, OSHotspot uses its own dedicated instance."
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

    if [[ "${1:-}" == "--check" ]]; then
        echo -e "${BLUE}Checking OSHotspot installation...${NC}"
        echo ""

        local issues=0

        if [[ -f "/usr/local/bin/oshotspot-scan" ]]; then
            echo -e "${GREEN}[OK]${NC} oshotspot-scan installed"
        else
            echo -e "${RED}[MISSING]${NC} oshotspot-scan not installed"
            issues=$((issues + 1))
        fi

        if [[ -f "/usr/local/bin/oshotspot-gen" ]]; then
            echo -e "${GREEN}[OK]${NC} oshotspot-gen installed"
        else
            echo -e "${RED}[MISSING]${NC} oshotspot-gen not installed"
            issues=$((issues + 1))
        fi

        if [[ -d "/usr/lib/oshotspot/scripts" ]]; then
            echo -e "${GREEN}[OK]${NC} Scripts directory exists"
        else
            echo -e "${RED}[MISSING]${NC} Scripts directory missing"
            issues=$((issues + 1))
        fi

        if [[ -f "/etc/oshotspot/config.conf" ]]; then
            echo -e "${GREEN}[OK]${NC} Configuration exists"
        else
            echo -e "${RED}[MISSING]${NC} Configuration missing"
            issues=$((issues + 1))
        fi

        if command -v hostapd &>/dev/null; then
            echo -e "${GREEN}[OK]${NC} hostapd installed"
        else
            echo -e "${RED}[MISSING]${NC} hostapd not installed"
            issues=$((issues + 1))
        fi

        if command -v dnsmasq &>/dev/null; then
            echo -e "${GREEN}[OK]${NC} dnsmasq installed"
        else
            echo -e "${RED}[MISSING]${NC} dnsmasq not installed"
            issues=$((issues + 1))
        fi

        if python3 -c "import pygtail, tenacity" &>/dev/null; then
            echo -e "${GREEN}[OK]${NC} Python dependencies (pygtail, tenacity) available"
        else
            echo -e "${RED}[MISSING]${NC} Python dependencies missing (pygtail, tenacity)"
            issues=$((issues + 1))
        fi

        if [[ -f "/var/lib/oshotspot/captive_codes.json" ]]; then
            echo -e "${GREEN}[OK]${NC} Captive codes file at /var/lib/oshotspot/captive_codes.json"
        else
            echo -e "${YELLOW}[WARN]${NC} Captive codes file missing at /var/lib/oshotspot/captive_codes.json"
        fi

        if python3 -c "import fpdf" &>/dev/null; then
            echo -e "${GREEN}[OK]${NC} fpdf2 available (PDF code export)"
        else
            echo -e "${YELLOW}[WARN]${NC} fpdf2 missing (PDF export unavailable), run: pip3 install fpdf2"
        fi

        if command -v msmtp &>/dev/null; then
            echo -e "${GREEN}[OK]${NC} msmtp (mail transfer agent) available"
        else
            echo -e "${YELLOW}[WARN]${NC} msmtp not installed (optional: needed for email alerts)"
        fi

        if command -v tailscale &>/dev/null; then
            echo -e "${GREEN}[OK]${NC} tailscale (VPN) available"
        else
            echo -e "${YELLOW}[WARN]${NC} tailscale not installed (optional: needed for remote VPN access)"
        fi

        echo ""
        if [[ ${issues} -eq 0 ]]; then
            echo -e "${GREEN}All checks passed!${NC}"
        else
            echo -e "${YELLOW}${issues} issue(s) found. Run 'sudo ./install.sh' to fix.${NC}"
        fi
        echo ""
        exit 0
    fi

    if [[ -f "${script_dir}/oshotspot" && -d "${script_dir}/scripts" ]]; then
        SRC="${script_dir}"
        log_info "Using local source files from ${SRC}"
    else
        download_source
    fi

    install_dependencies
    echo ""
    install_tailscale
    echo ""
    install_pip_dependencies
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
