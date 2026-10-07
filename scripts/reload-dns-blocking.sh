#!/usr/bin/env bash
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

# reload-dns-blocking.sh - Regenerate the forbidden-domains block config
# from the events SQLite database and restart dnsmasq so the changes
# take effect immediately.
#
# This script is called by the web dashboard whenever an admin adds or
# removes a forbidden domain via the Domain Policy page.  It can also
# be run manually:
#
#   sudo bash /usr/lib/oshotspot/scripts/reload-dns-blocking.sh
#
# What it does:
#   1. Reads all patterns from the forbidden_domains table in events.db.
#   2. Converts each pattern to dnsmasq directives:
#        exact.com       -> address=/exact.com/0.0.0.0
#                           address=/exact.com/::
#        *.example.com   -> address=/example.com/0.0.0.0
#                           address=/example.com/::
#      The address= directives match the domain AND every subdomain,
#      and intercept both query families: A answered with 0.0.0.0,
#      AAAA answered with the unroutable ::.  Both lines are required:
#      on dnsmasq 2.9x an IPv4-only address= still forwards AAAA
#      queries upstream, leaking the real IPv6 of blocked domains.
#      Unlike hosts-file entries, which only match the exact hostname,
#      every subdomain is covered.
#   3. Writes the result to /etc/oshotspot/dnsmasq-blocked.conf, which
#      is included by dnsmasq.conf via conf-file=.
#   4. Writes nftset/ipset directives to /etc/oshotspot/dnsmasq-nftset.conf
#      so dnsmasq can populate a netfilter set with the resolved IPs of
#      forbidden domains.  The firewall then drops FORWARD traffic to
#      those IPs, blocking access even if the client uses an external
#      DNS resolver or has the IP cached.
#   5. Restarts the dedicated dnsmasq instance.  A full restart is
#      required because conf-file/address= directives are only read at
#      startup (SIGHUP re-reads hosts files but not the configuration).
#      DHCP leases are preserved: the lease file is NOT wiped here.
#
# If dnsmasq is not running, the script starts it now so the block list
# is active immediately instead of waiting for the next 'oshotspot start'.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=utils.sh
source "${SCRIPT_DIR}/utils.sh"

require_root

BLOCK_FILE="${OSHOTSPOT_DIR}/dnsmasq-blocked.conf"
NFT_SET_FILE="${OSHOTSPOT_DIR}/dnsmasq-nftset.conf"
DB_FILE="${OSHOTSPOT_LOG_DIR}/events.db"

mkdir -p "${OSHOTSPOT_DIR}"
mkdir -p "${OSHOTSPOT_LOG_DIR}"

# Detect whether the system prefers nftables over legacy iptables.
if command -v iptables &>/dev/null; then
    _ipt_ver=$(iptables --version 2>/dev/null || true)
    if [[ "${_ipt_ver}" == *"(nf_tables)"* ]] && command -v nft &>/dev/null; then
        _NFT_BACKEND=true
    else
        _NFT_BACKEND=false
    fi
elif command -v nft &>/dev/null; then
    _NFT_BACKEND=true
else
    _NFT_BACKEND=false
fi

# ---------------------------------------------------------------------------
# 1. Read forbidden domains from the DB and generate dnsmasq directives
# ---------------------------------------------------------------------------

if [[ ! -f "${DB_FILE}" ]]; then
    log_warn "Events DB not found at ${DB_FILE} -- writing empty block file."
    {
        echo "# Forbidden domains block list (managed by OSHotspot dashboard)"
        echo "# Events DB not found -- no domains loaded."
    } > "${BLOCK_FILE}"
else
    # Generate both files in a single Python invocation to avoid
    # duplicated DB reads and regex validation logic.
    export DB_FILE _NFT_BACKEND BLOCK_FILE NFT_SET_FILE
    python3 - <<'PYEOF'
import sqlite3, re, sys, os

DB_FILE = os.environ['DB_FILE']
NFT_BACKEND = os.environ.get('_NFT_BACKEND', 'false') == 'true'

try:
    conn = sqlite3.connect(DB_FILE)
    rows = conn.execute('SELECT pattern FROM forbidden_domains ORDER BY pattern').fetchall()
    conn.close()
except Exception as e:
    sys.stderr.write('Error reading DB: {}\n'.format(e))
    sys.exit(1)

DOMAIN_RE = re.compile(
    r'^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
)

blocked = [
    '# Forbidden domains block list (managed by OSHotspot dashboard)',
]
nftset = [
    '# Forbidden domains nftset/ipset directives (managed by OSHotspot dashboard)',
]
skipped = 0
seen = set()
for r in rows:
    p = str(r[0]).strip().lower()
    if not p or p.startswith('#'):
        continue
    if p.startswith('*.'):
        p = p[2:]
    p = p.lstrip('.')
    if not DOMAIN_RE.match(p) or p in seen:
        skipped += 1
        continue
    seen.add(p)
    blocked.append('address=/{}/0.0.0.0'.format(p))
    blocked.append('address=/{}/::'.format(p))
    if NFT_BACKEND:
        nftset.append('nftset=/{}/4#ip#oshotspot#blocked_ips'.format(p))
        nftset.append('nftset=/{}/6#ip6#oshotspot#blocked_ips6'.format(p))
    else:
        nftset.append('ipset=/{}/blocked_ips'.format(p))
        nftset.append('ipset=/{}/blocked_ips6'.format(p))

if skipped:
    note = '# NOTE: {} invalid/duplicate pattern(s) ignored'.format(skipped)
    blocked.append(note)
    nftset.append(note)

block_file   = os.environ.get('BLOCK_FILE',   '/etc/oshotspot/dnsmasq-blocked.conf')
nftset_file  = os.environ.get('NFT_SET_FILE', '/etc/oshotspot/dnsmasq-nftset.conf')

with open(block_file, 'w') as fh:
    fh.write('\n'.join(blocked) + '\n')

with open(nftset_file, 'w') as fh:
    fh.write('\n'.join(nftset) + '\n')
PYEOF

    chmod 644 "${BLOCK_FILE}"
    chmod 644 "${NFT_SET_FILE}"
    # One domain = one "0.0.0.0" line (the "::" companion is not counted).
    log_info "Block file written to ${BLOCK_FILE} ($(grep -c '0\.0\.0\.0$' "${BLOCK_FILE}" 2>/dev/null || echo 0) domains)"
    log_info "Nftset/ipset file written to ${NFT_SET_FILE} ($(grep -c 'nftset=\|ipset=' "${NFT_SET_FILE}" 2>/dev/null || echo 0) entries)"
fi

# Validate the generated config before touching the running process.
# Use the full dnsmasq.conf so unsupported directives like filter-rr=SVCB
# are caught early instead of killing the running instance.
if command -v dnsmasq &>/dev/null; then
    if ! dnsmasq --test --conf-file="${OSHOTSPOT_DNSMASQ_CONF}" >/dev/null 2>&1; then
        log_error "dnsmasq configuration failed syntax check -- aborting reload."
        exit 1
    fi
fi

# ---------------------------------------------------------------------------
# 2. Restart the dedicated dnsmasq so it picks up the new block list
# ---------------------------------------------------------------------------

# If dnsmasq is not running, start it now so the block list is active
# immediately instead of waiting for the next 'oshotspot start'.
if ! is_running "${OSHOTSPOT_PID_DNSMASQ}"; then
    ensure_log_dir

    if ! command -v dnsmasq &>/dev/null; then
        log_error "dnsmasq is not installed."
        exit 1
    fi

    if pgrep -x dnsmasq >/dev/null 2>&1; then
        log_warn "System dnsmasq detected, stopping it..."
        systemctl stop dnsmasq 2>/dev/null || true
        pkill -x dnsmasq 2>/dev/null || true
        sleep 1
    fi

    stdbuf -oL -eL dnsmasq \
        --conf-file="${OSHOTSPOT_DNSMASQ_CONF}" \
        --pid-file="${OSHOTSPOT_PID_DNSMASQ}" \
        --log-facility="${OSHOTSPOT_DNSMASQ_LOG}" \
        --log-async=0

    retries=0
    while ! is_running "${OSHOTSPOT_PID_DNSMASQ}" && [[ ${retries} -lt 10 ]]; do
        sleep 0.5
        retries=$((retries + 1))
    done

    if is_running "${OSHOTSPOT_PID_DNSMASQ}"; then
        date +%s > /run/oshotspot-dnsmasq-started
        log_info "dnsmasq started (PID $(cat "${OSHOTSPOT_PID_DNSMASQ}")) -- domain blocking active."
    else
        log_error "dnsmasq failed to start! Last log lines:"
        if [[ -f "${OSHOTSPOT_DNSMASQ_LOG}" ]]; then
            tail -10 "${OSHOTSPOT_DNSMASQ_LOG}" | while IFS= read -r line; do
                log_error "  ${line}"
            done
        fi
        exit 1
    fi
else
    old_pid=$(cat "${OSHOTSPOT_PID_DNSMASQ}")

    log_step "Restarting dnsmasq to apply domain policy (PID ${old_pid})..."

    kill "${old_pid}" 2>/dev/null || true

    waited=0
    while kill -0 "${old_pid}" 2>/dev/null && (( waited < 10 )); do
        sleep 0.5
        waited=$((waited + 1))
    done
    if kill -0 "${old_pid}" 2>/dev/null; then
        log_warn "dnsmasq did not exit gracefully, sending SIGKILL..."
        kill -KILL "${old_pid}" 2>/dev/null || true
        sleep 0.5
    fi
    remove_pid "${OSHOTSPOT_PID_DNSMASQ}"

    ensure_log_dir

    stdbuf -oL -eL dnsmasq \
        --conf-file="${OSHOTSPOT_DNSMASQ_CONF}" \
        --pid-file="${OSHOTSPOT_PID_DNSMASQ}" \
        --log-facility="${OSHOTSPOT_DNSMASQ_LOG}" \
        --log-async=0

    retries=0
    while ! is_running "${OSHOTSPOT_PID_DNSMASQ}" && [[ ${retries} -lt 10 ]]; do
        sleep 0.5
        retries=$((retries + 1))
    done

    if is_running "${OSHOTSPOT_PID_DNSMASQ}"; then
        date +%s > /run/oshotspot-dnsmasq-started
        log_info "dnsmasq restarted (PID $(cat "${OSHOTSPOT_PID_DNSMASQ}")) -- domain blocking updated."
    else
        log_error "dnsmasq failed to restart! Last log lines:"
        if [[ -f "${OSHOTSPOT_DNSMASQ_LOG}" ]]; then
            tail -10 "${OSHOTSPOT_DNSMASQ_LOG}" | while IFS= read -r line; do
                log_error "  ${line}"
            done
        fi
        exit 1
    fi
fi

echo ""
echo "Block list summary:"
echo "  File:       ${BLOCK_FILE}"
echo "  Entries:    $(grep -c '0\.0\.0\.0$' "${BLOCK_FILE}" 2>/dev/null || echo 0)"
echo "  dnsmasq:    $([[ -f "${OSHOTSPOT_PID_DNSMASQ}" ]] && echo 'running' || echo 'not running')"
echo "  Reload via: full restart (conf-file/address= need startup reload)"

# ---------------------------------------------------------------------------
# 3. Kill existing connections to newly blocked IPs
# ---------------------------------------------------------------------------
# After dnsmasq restarts with the new block list, the nftset/ipset entries
# will be populated when clients query. But clients with cached IPs or
# existing connections can continue until their TCP sessions expire.
# Force-kill all connections to the blocked IP set to close this window.

if command -v conntrack &>/dev/null; then
    killed=0

    # Kill connections to IPs in nft set (nft backend)
    if nft list set ip oshotspot blocked_ips 2>/dev/null | grep -q 'type ipv4_addr'; then
        while IFS= read -r ip; do
            ip=$(echo "${ip}" | xargs)
            [[ -z "${ip}" ]] && continue
            conntrack -D -d "${ip}" 2>/dev/null && killed=$((killed + 1)) || true
        done < <(nft list set ip oshotspot blocked_ips 2>/dev/null | grep -oE '\b[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b')
    fi

    # Kill connections to IPs in ipset (iptables backend)
    if command -v ipset &>/dev/null && ipset list blocked_ips 2>/dev/null | grep -q 'Type: hash:ip'; then
        while IFS= read -r ip; do
            ip=$(echo "${ip}" | xargs)
            [[ -z "${ip}" ]] && continue
            conntrack -D -d "${ip}" 2>/dev/null && killed=$((killed + 1)) || true
        done < <(ipset list blocked_ips 2>/dev/null | grep -oE '\b[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b')
    fi

    # Also kill any lingering DoH/DoT connections
    for doh_ip in 1.1.1.1 1.0.0.1 8.8.8.8 8.8.4.4 9.9.9.9 149.112.112.112; do
        conntrack -D -d "${doh_ip}" -p tcp --dport 443 2>/dev/null && killed=$((killed + 1)) || true
        conntrack -D -d "${doh_ip}" -p udp --dport 443 2>/dev/null && killed=$((killed + 1)) || true
    done
    conntrack -D -p tcp --dport 853 2>/dev/null && killed=$((killed + 1)) || true

    if [[ ${killed} -gt 0 ]]; then
        log_info "Killed ${killed} existing connection(s) to blocked targets"
    fi
fi

# ---------------------------------------------------------------------------
# 4. Set up periodic re-resolution of blocked domains (cron-like via systemd timer or background)
# ---------------------------------------------------------------------------
# Write a systemd timer that periodically re-resolves blocked domains to
# keep the nftset/ipset entries fresh even when no client queries them.
# This prevents the timeout expiry from creating a window where a blocked
# domain's IP falls out of the set.

TIMER_UNIT="/etc/systemd/system/oshotspot-block-resolve.timer"
SERVICE_UNIT="/etc/systemd/system/oshotspot-block-resolve.service"

if [[ -d /etc/systemd/system ]]; then
    cat > "${SERVICE_UNIT}" << 'UNIT_EOF'
[Unit]
Description=OSHotspot periodic blocked domain re-resolution
After=network.target

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'sleep 3 && for d in $(grep "^address=/" /etc/oshotspot/dnsmasq-blocked.conf | sed "s|address=/||;s|/0\.0\.0\.0||;s|/::||" | sort -u); do nslookup "$d" 127.0.0.1 >/dev/null 2>&1; done'
TimeoutStartSec=30

[Install]
WantedBy=multi-user.target
UNIT_EOF

    cat > "${TIMER_UNIT}" << 'TIMER_EOF'
[Unit]
Description=OSHotspot periodic blocked domain re-resolution timer

[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
AccuracySec=1min

[Install]
WantedBy=timers.target
TIMER_EOF

    systemctl daemon-reload 2>/dev/null || true
    systemctl enable oshotspot-block-resolve.timer 2>/dev/null || true
    systemctl start oshotspot-block-resolve.timer 2>/dev/null || true
    log_info "Periodic domain re-resolution timer installed (every 10min)"
fi