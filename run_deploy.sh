#!/usr/bin/env bash
#
# run_deploy.sh — Wrapper that sources .env then runs deploy.sh.
# Usage: ./run_deploy.sh [VERSION]
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source .env if present
if [[ -f "${SCRIPT_DIR}/.env" ]]; then
  set -a
  source "${SCRIPT_DIR}/.env"
  set +a
fi

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo -e "\033[0;31m[ERROR]\033[0m GITHUB_TOKEN not set"
  echo ""
  echo "Option 1: export GITHUB_TOKEN='ghp_...'"
  echo "Option 2: copy .env.example to .env and add your token:"
  echo "          cp .env.example .env"
  echo "          # then edit .env with your token"
  exit 1
fi

exec "${SCRIPT_DIR}/deploy.sh" "$@"
