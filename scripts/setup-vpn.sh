#!/usr/bin/env bash
#
# OSHotspot, Tailscale VPN Setup
# Installs and configures Tailscale for remote dashboard access.
#

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

CONFIG_DIR="/etc/oshotspot"
CONFIG_FILE="${CONFIG_DIR}/config.conf"

if [[ "${EUID}" -ne 0 ]]; then
    echo -e "${RED}This command must be run as root (use sudo).${NC}"
    exit 1
fi

echo ""
echo "========================================="
echo "  OSHotspot, Tailscale VPN Setup"
echo "========================================="
echo ""

# --- Step 1: Check / Install Tailscale ---
echo -e "${YELLOW}[1/5]${NC} Checking Tailscale installation..."

if command -v tailscale &>/dev/null; then
    echo -e "${GREEN}[OK]${NC} Tailscale is already installed ($(tailscale version 2>/dev/null | head -1))"
else
    echo "Tailscale not found. Installing..."
    curl -fsSL https://tailscale.com/install.sh | sh
    echo -e "${GREEN}[OK]${NC} Tailscale installed."
fi

# --- Step 2: Bring up Tailscale ---
echo ""
echo -e "${YELLOW}[2/5]${NC} Starting Tailscale..."

if tailscale status --json 2>/dev/null | grep -q '"BackendState":"Running"'; then
    echo -e "${GREEN}[OK]${NC} Tailscale is already running."
else
    echo "Launching Tailscale. A browser window will open for authentication."
    echo "If no browser opens, copy the URL printed below into your browser."
    echo ""
    tailscale up
    echo ""
    echo -e "${GREEN}[OK]${NC} Tailscale connected."
fi

# --- Step 3: Get Tailscale IP ---
echo ""
echo -e "${YELLOW}[3/5]${NC} Retrieving Tailscale IP..."

TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || echo "")
if [[ -z "${TAILSCALE_IP}" ]]; then
    echo -e "${RED}[ERROR]${NC} Could not retrieve Tailscale IP. Is Tailscale connected?"
    exit 1
fi

echo -e "${GREEN}[OK]${NC} Tailscale IP: ${TAILSCALE_IP}"

# --- Step 4: Detect dashboard port ---
echo ""
echo -e "${YELLOW}[4/5]${NC} Detecting dashboard port..."

DASHBOARD_PORT="8073"
# Try to find the actual port from the running process
if command -v ss &>/dev/null; then
    DETECTED_PORT=$(ss -tlnp 2>/dev/null | grep -oP ':\K[0-9]+' | sort -un | while read -r p; do
        if [[ "$p" -ge 8073 && "$p" -le 8173 ]]; then
            echo "$p"
            break
        fi
    done)
    if [[ -n "${DETECTED_PORT}" ]]; then
        DASHBOARD_PORT="${DETECTED_PORT}"
    fi
fi

echo -e "${GREEN}[OK]${NC} Dashboard port: ${DASHBOARD_PORT}"

# --- Step 5: Update config.conf ---
echo ""
echo -e "${YELLOW}[5/5]${NC} Updating ${CONFIG_FILE}..."

if [[ -f "${CONFIG_FILE}" ]]; then
    grep -v '^VPN_' "${CONFIG_FILE}" > "${CONFIG_FILE}.tmp" || true
    cat >> "${CONFIG_FILE}.tmp" <<CONF

# VPN (Tailscale)
VPN_ENABLED="true"
VPN_URL="http://${TAILSCALE_IP}:${DASHBOARD_PORT}"
CONF
    mv "${CONFIG_FILE}.tmp" "${CONFIG_FILE}"
    chmod 600 "${CONFIG_FILE}"
    echo -e "${GREEN}[OK]${NC} Updated ${CONFIG_FILE}"
else
    echo -e "${YELLOW}[WARN]${NC} ${CONFIG_FILE} not found. VPN settings not saved."
fi

# --- Done ---
echo ""
echo "========================================="
echo "  VPN setup complete!"
echo "========================================="
echo ""
echo "  Tailscale IP:  ${TAILSCALE_IP}"
echo "  Dashboard URL: http://${TAILSCALE_IP}:${DASHBOARD_PORT}"
echo ""
echo "  To access from another device:"
echo "  1. Install Tailscale on the device:"
echo "     - Windows/macOS: https://tailscale.com/download"
echo "     - iOS/Android: App Store / Play Store"
echo "  2. Login with the same Tailscale account"
echo "  3. Open: http://${TAILSCALE_IP}:${DASHBOARD_PORT}"
echo ""
echo "  Make sure the dashboard is running:"
echo "    sudo oshotspot web"
echo ""
echo "  Manage from dashboard: VPN page"
echo "  Or CLI: sudo tailscale status"
echo ""
