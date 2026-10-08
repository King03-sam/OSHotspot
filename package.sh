#!/usr/bin/env bash
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
# Licensed under the Apache License, Version 2.0
#
# package.sh, Build release artifacts (tarball + .deb) for OSHotspot.
# Usage: ./package.sh [VERSION]
#   VERSION defaults to git describe --tags --always (e.g. v4.0-3-gabc1234)
#
# The list of files to include is read from debian/install (single source of
# truth).  Adding a new file to the project only requires updating that one
# file and the .deb control metadata.

set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
    VERSION=$(git describe --tags --always 2>/dev/null || echo "dev")
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="${SCRIPT_DIR}/dist"
TMP_DIR="${DIST_DIR}/tmp-${VERSION}"

log_info()  { echo -e "\033[0;32m[INFO]\033[0m  $*"; }
log_warn() { echo -e "\033[0;33m[WARN]\033[0m  $*" >&2; }
log_error() { echo -e "\033[0;31m[ERROR]\033[0m $*" >&2; }

log_info "Building OSHotspot ${VERSION}..."

if [[ ! -f "${SCRIPT_DIR}/debian/install" ]]; then
    log_error "debian/install not found, cannot determine which files to package"
    exit 1
fi

rm -rf "${TMP_DIR}"
mkdir -p "${TMP_DIR}/oshotspot-${VERSION}"
echo "${VERSION}" > "${TMP_DIR}/oshotspot-${VERSION}/VERSION"

# Parse debian/install to get the list of source files/dirs to copy.
# Format: <source-path>  <destination-path>
# Lines starting with # and blank lines are ignored.
mapfile -t INSTALL_FILES < <(grep -vE '^\s*(#|$)' "${SCRIPT_DIR}/debian/install" | awk '{print $1}')

if [[ ${#INSTALL_FILES[@]} -eq 0 ]]; then
    log_error "No files found in debian/install"
    exit 1
fi

for f in "${INSTALL_FILES[@]}"; do
    mkdir -p "${TMP_DIR}/oshotspot-${VERSION}/$(dirname "$f")"
    if [[ -d "${SCRIPT_DIR}/${f}" ]]; then
        cp -r "${SCRIPT_DIR}/${f}" "${TMP_DIR}/oshotspot-${VERSION}/${f}"
    else
        cp "${SCRIPT_DIR}/${f}" "${TMP_DIR}/oshotspot-${VERSION}/${f}"
    fi
done

# Remove Python cache artefacts
find "${TMP_DIR}/oshotspot-${VERSION}" -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
find "${TMP_DIR}/oshotspot-${VERSION}" -name "*.pyc" -delete 2>/dev/null || true
# Remove C build artefacts
find "${TMP_DIR}/oshotspot-${VERSION}" -name "*.o" -delete 2>/dev/null || true
find "${TMP_DIR}/oshotspot-${VERSION}" -name "*.a" -delete 2>/dev/null || true

# Ensure executables are marked as such
chmod +x "${TMP_DIR}/oshotspot-${VERSION}/install.sh"
chmod +x "${TMP_DIR}/oshotspot-${VERSION}/oshotspot"
chmod +x "${TMP_DIR}/oshotspot-${VERSION}/scripts/"*.sh 2>/dev/null || true

mkdir -p "${DIST_DIR}"

TARBALL="${DIST_DIR}/oshotspot-${VERSION}.tar.gz"
tar czf "${TARBALL}" -C "${TMP_DIR}" "oshotspot-${VERSION}"

log_info "Built: ${TARBALL}"
log_info "Size:  $(du -h "${TARBALL}" | cut -f1)"

# .deb build disabled, only tarball is published

# Cleanup temp dir (after both builds are done)
rm -rf "${TMP_DIR}"