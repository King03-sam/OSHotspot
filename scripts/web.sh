#!/usr/bin/env bash
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0
#

# web.sh - Launch the OSHotspot web dashboard.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="/usr/lib/oshotspot/web"

if [[ ! -f "${WEB_DIR}/serve.py" ]]; then
    echo "[ERROR] Web dashboard not found at ${WEB_DIR}/serve.py" >&2
    echo "Install OSHotspot with the latest version to get the web dashboard." >&2
    exit 1
fi

exec python3 "${WEB_DIR}/serve.py"
