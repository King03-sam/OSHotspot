#!/usr/bin/env bash
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
# Licensed under the Apache License, Version 2.0
#
# deploy.sh — Build and publish a GitHub release from local machine.
# Usage: GITHUB_TOKEN="ghp_..." ./deploy.sh [VERSION]
#   VERSION defaults to git describe --tags --always (e.g. v5.0)
#

set -euo pipefail

REPO="King03-sam/OSHotspot"
API_URL="https://api.github.com/repos/${REPO}/releases"

die() { echo -e "\033[0;31m[ERROR]\033[0m $*" >&2; exit 1; }
info() { echo -e "\033[0;32m[INFO]\033[0m  $*"; }

# ── Preflight checks ──────────────────────────────────────────────
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  die "GITHUB_TOKEN environment variable is not set. Export it first:\n  export GITHUB_TOKEN=\"ghp_...\""
fi

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  VERSION=$(git describe --tags --always 2>/dev/null || echo "dev")
fi

if [[ "$VERSION" == "dev" ]]; then
  die "No version provided and no git tag found. Usage: ./deploy.sh v5.0"
fi

TAG="v${VERSION#v}"
ASSET="dist/oshotspot-${VERSION}.tar.gz"

# ── Step 1: Build ─────────────────────────────────────────────────
info "Building OSHotspot ${VERSION}..."
./package.sh "${VERSION}"

if [[ ! -f "${ASSET}" ]]; then
  die "Asset not found after build: ${ASSET}"
fi
info "Asset ready: ${ASSET} ($(du -h "${ASSET}" | cut -f1))"

# ── Step 2: Prepare release body ─────────────────────────────────
BODY=$(cat << EOF
OSHotspot ${TAG}: WiFi Hotspot & Network Security Manager for Linux

## What's new in 5.1
- Captive Portal: Fixed custom domain resolution breaking post-authentication
- DNS & Connectivity: Fixed dnsmasq upstream forwarder configuration so internet browsing works seamlessly post-auth
- Captive Portal: Added IP fallback mechanism on portal status polling
- Security: logout now persists across server restarts; token-based auth restricted to localhost
- Security: per-IP silent brute-force lockout on admin login (progressive tiers, never disclosed) + 1s server delay per failed attempt
- Security: POST /api/known-devices now requires an admin session (was open to all)
- Security: failed login audit logs now show the correct user role instead of hardcoded 'admin'
- UX: VPN Start button stays clickable during startup; hint message added when startup is slow
- UX: email alert digests reformatted with 3-column HTML layout
- Bug fix: mark-known device DB contention no longer crashes the request
- Docs: App Block, Dynamic Blocked IP Sets, hot-config toggles, and VPN remote access fully documented

## Installation
\`\`\`bash
curl -fsSL https://github.com/${REPO}/releases/latest/download/oshotspot-${VERSION}.tar.gz | sudo tar xz -C /tmp
sudo /tmp/oshotspot-${VERSION}/install.sh
\`\`\`
EOF
)

PAYLOAD=$(printf '%s' "$BODY" | python3 -c "
import json, sys
body = sys.stdin.read()
print(json.dumps({
    'tag_name': '${TAG}',
    'name': '${TAG}',
    'body': body,
    'draft': False,
    'prerelease': False
}))
")

# ── Step 3: Create or update release ─────────────────────────────
info "Checking if release ${TAG} exists..."
EXISTING=$(curl -s --connect-timeout 10 --max-time 30 \
  -H "Authorization: token ${GITHUB_TOKEN}" \
  "${API_URL}/tags/${TAG}" | grep '"id"' | head -1 | sed 's/.*"id": \([0-9]*\).*/\1/' || true)

if [[ -n "$EXISTING" ]]; then
  info "Release exists (id=${EXISTING}), updating..."
  RESPONSE=$(curl -s --connect-timeout 10 --max-time 30 -X PATCH \
    -H "Authorization: token ${GITHUB_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    "${API_URL}/${EXISTING}")
  RELEASE_URL=$(echo "$RESPONSE" | grep '"html_url"' | head -1 | sed 's/.*"html_url": *"\([^"]*\)".*/\1/')
  info "Release updated: ${RELEASE_URL}"
else
  info "Creating new release ${TAG}..."
  RESPONSE=$(curl -s --connect-timeout 10 --max-time 30 -X POST \
    -H "Authorization: token ${GITHUB_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    "${API_URL}")
  RELEASE_URL=$(echo "$RESPONSE" | grep '"html_url"' | head -1 | sed 's/.*"html_url": *"\([^"]*\)".*/\1/')
  if [[ -z "$RELEASE_URL" ]]; then
    echo "GitHub API response:"
    echo "$RESPONSE"
    die "Failed to create release. Check token scopes (needs 'repo')."
  fi
  info "Release created: ${RELEASE_URL}"
fi

# ── Step 4: Upload asset ──────────────────────────────────────────
UPLOAD_URL_BASE=$(curl -s --connect-timeout 10 --max-time 30 \
  -H "Authorization: token ${GITHUB_TOKEN}" \
  "${API_URL}/tags/${TAG}" | grep '"upload_url"' | head -1 | sed 's/.*"upload_url": *"\([^"]*\)".*/\1/' || true)
UPLOAD_URL_BASE="${UPLOAD_URL_BASE%\{*}"

if [[ -z "$UPLOAD_URL_BASE" ]]; then
  die "Failed to get upload_url for release ${TAG}"
fi

BASENAME=$(basename "${ASSET}")

# Delete existing asset with the same name if present
EXISTING_ASSET_ID=$(curl -s -H "Authorization: token ${GITHUB_TOKEN}" "${API_URL}/tags/${TAG}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for a in data.get('assets', []):
    if a['name'] == '${BASENAME}':
        print(a['id'])
        break
" || true)

if [[ -n "$EXISTING_ASSET_ID" ]]; then
  info "Deleting existing asset ${BASENAME} (id=${EXISTING_ASSET_ID})..."
  curl -s -X DELETE -H "Authorization: token ${GITHUB_TOKEN}" "https://api.github.com/repos/${REPO}/releases/assets/${EXISTING_ASSET_ID}"
fi

info "Uploading ${BASENAME}..."
curl -s --connect-timeout 10 --max-time 30 -X POST \
  -H "Authorization: token ${GITHUB_TOKEN}" \
  -H "Content-Type: application/gzip" \
  --data-binary @"${ASSET}" \
  "${UPLOAD_URL_BASE}?name=${BASENAME}" > /dev/null
info "Uploaded: ${BASENAME}"

echo ""
info "========================================"
info "Release ${TAG} published successfully!"
info "URL: ${RELEASE_URL}"
info "Asset: https://github.com/${REPO}/releases/latest/download/${BASENAME}"
info "========================================"
