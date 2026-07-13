#!/usr/bin/env bash
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0
#

# qr.sh - Display a QR code to connect to the hotspot.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=utils.sh
source "${SCRIPT_DIR}/utils.sh"

if ! command -v qrencode &>/dev/null; then
    echo -e "${RED}qrencode is not installed.${NC}"
    echo ""
    echo "Install it with:"
    echo "  sudo apt install qrencode      # Debian/Ubuntu"
    echo "  sudo dnf install qrencode      # Fedora"
    echo "  sudo pacman -S qrencode        # Arch"
    echo ""
    exit 1
fi

load_config

if [[ -z "${SSID:-}" || -z "${PASSWORD:-}" ]]; then
    echo -e "${RED}SSID or PASSWORD not configured.${NC}"
    echo "Edit: sudo nano /etc/oshotspot/config.conf"
    exit 1
fi

WIFI_STRING="WIFI:T:WPA;S:${SSID};P:${PASSWORD};;"

echo ""
echo -e "${BOLD}WiFi QR Code for: ${GREEN}${SSID}${NC}"
echo ""
qrencode -t UTF8 "${WIFI_STRING}"
echo ""
echo -e "Scan this QR code with your phone's camera to connect."
echo ""
