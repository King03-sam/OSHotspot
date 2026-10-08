#!/usr/bin/env bash
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0
#

# firewall.sh - NAT and forwarding rules for OSHotspot.
# Supports both iptables and nftables backends.
#
# When DNS_REDIRECT is enabled (default), two extra mechanisms ensure
# all DNS traffic from hotspot clients flows through the local dnsmasq:
#   1. DNS REDIRECT , PREROUTING rules that hijack port 53 (UDP+TCP)
#      from the AP subnet so clients can't bypass dnsmasq with a manual
#      DNS server.
#   2. DoH BLOCK    , FORWARD DROP rules that black-hole traffic from
#      the AP subnet to known DNS-over-HTTPS resolver IPs on port 443
#      (both TCP and UDP/QUIC, modern browsers use HTTP/3), forcing
#      browsers back to standard DNS.

# Known DoH resolver IPs, blocked on port 443 (TCP+UDP) from AP
# clients.  IMPORTANT: this list must only contain addresses that are
# DEDICATED to DNS services.  Broad provider ranges (e.g. Google's
# 142.250.0.0/16 or Cloudflare's CDN ranges like 172.64.0.0/16) also
# host regular web traffic (YouTube, Gmail, millions of websites) and
# blocking them would break legitimate browsing.
DOH_IPS=(
    1.1.1.1 1.0.0.1                       # Cloudflare DNS (dedicated)
    104.16.248.0/24 104.16.249.0/24       # cloudflare-dns.com endpoints
    8.8.8.8 8.8.4.4                       # Google DNS (dedicated)
    9.9.9.9 149.112.112.112               # Quad9
    45.90.28.0/24 45.90.30.0/24           # NextDNS (dedicated anycast)
    94.140.14.0/24 94.140.15.0/24         # AdGuard (dedicated)
    185.228.168.0/24 185.228.169.0/24     # CleanBrowsing
    76.76.19.19                           # Alternate DNS
    194.242.2.2 194.242.2.9               # Mullvad DNS
    208.67.222.222 208.67.220.220         # OpenDNS/Cisco
    146.112.64.0/24 146.112.65.0/24       # Cisco Umbrella (dedicated)
    156.154.70.1 156.154.71.1             # Neustar/UltraDNS
    199.85.126.0/24 199.85.127.0/24       # Norton ConnectSafe/DNS
    8.26.56.10                            # Comodo Secure DNS
    185.121.177.177 169.239.202.202       # OpenNIC
    77.88.8.8 77.88.8.1                   # Yandex DNS
    84.200.69.80 84.200.70.40             # DNSWatch
    74.82.42.42                           # Hurricane Electric DNS
    37.235.1.174 37.235.1.177             # FreeDNS
    109.69.8.51                           # puntCAT
)

# IPv6 equivalents of the well-known DoH resolvers.  A phone that has any
# IPv6 connectivity could otherwise reach these on port 443 (TCP+UDP/QUIC)
# and bypass the IPv4 DoH block above.
DOH_IPS6=(
    2606:4700:4700::1111 2606:4700:4700::1001  # Cloudflare DNS
    2001:4860:4860::8888 2001:4860:4860::8844  # Google DNS
    2620:fe::fe 2620:fe::9                      # Quad9
    2a10:50c0::ad1:ff 2a10:50c0::ad2:ff         # AdGuard (dedicated)
    2a07:a8c0::11 2a07:a8c0::22                 # NextDNS (dedicated anycast)
    2a0d:2a00:1::2 2a0d:2a00:2::2               # CleanBrowsing
)

# VPN protocols to block from AP clients.
VPN_PORTS=(
    "udp/51820"    # WireGuard
    "udp/1194"     # OpenVPN (UDP)
    "tcp/1194"     # OpenVPN (TCP)
    "udp/500"      # IPsec IKE
    "udp/4500"     # IPsec NAT-T
    "udp/1701"     # L2TP
    "udp/5555"     # SoftEther
)

# Well-known application port/IP ranges for category-based blocking.
# Each entry: "category:proto/port_or_range:comment"
# These are only enforced when the admin activates the category via the
# dashboard API (/api/app-block).
APP_BLOCK_RULES=(
    # --- Messaging (pure port-based only; domain/HTTPS blocking
    #     is handled by SNI_BLOCK_RULES below via TLS inspection) ---
    "messaging:tcp/5222:WhatsApp XMPP"
    "messaging:tcp/5223:WhatsApp XMPP SSL"
    "messaging:tcp/5228:Google FCM / WhatsApp fallback"
    "messaging:tcp/5242:Apple Push"
    "messaging:udp/5242:Apple Push"
    # --- Social Media (no pure ports; SNI-only) ---
    # --- Streaming / Entertainment (no pure ports; SNI-only) ---
    # --- File Sharing (no pure ports; SNI-only) ---
    # --- Gaming ---
    "gaming:udp/27015:Steam"
    "gaming:tcp/27015:Steam"
    "gaming:udp/27016:Steam"
    "gaming:tcp/27016:Steam"
)

# SNI strings for deep packet inspection blocking.
# These are used with iptables string matching or nft raw payload
# inspection on TLS Client Hello packets to block by domain even
# when the client has a cached IP or uses an external DNS.
# Format: "category:sni_string:comment"
SNI_BLOCK_RULES=(
    "messaging:whatsapp.com:WhatsApp SNI"
    "messaging:web.whatsapp.com:WhatsApp Web SNI"
    "messaging:telegram.org:Telegram SNI"
    "messaging:discord.com:Discord SNI"
    "messaging:signal.org:Signal SNI"
    "messaging:viber.com:Viber SNI"
    "messaging:snapchat.com:Snapchat SNI"
    "social:facebook.com:Facebook SNI"
    "social:instagram.com:Instagram SNI"
    "social:twitter.com:Twitter SNI"
    "social:x.com:X (Twitter) SNI"
    "social:tiktok.com:TikTok SNI"
    "social:linkedin.com:LinkedIn SNI"
    "social:pinterest.com:Pinterest SNI"
    "social:reddit.com:Reddit SNI"
    "entertainment:youtube.com:YouTube SNI"
    "entertainment:netflix.com:Netflix SNI"
    "entertainment:spotify.com:Spotify SNI"
    "entertainment:twitch.tv:Twitch SNI"
    "entertainment:disneyplus.com:Disney+ SNI"
    "filesharing:dropbox.com:Dropbox SNI"
    "filesharing:drive.google.com:Google Drive SNI"
    "gaming:steampowered.com:Steam SNI"
    "gaming:epicgames.com:Epic Games SNI"
)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=utils.sh
source "${SCRIPT_DIR}/utils.sh"

# Detect firewall backend
detect_firewall() {
    # Prefer nftables when iptables is just an nft backend wrapper
    # (iptables-nft).  The iptables-nft translation layer can mishandle
    # the REDIRECT target in PREROUTING, causing DNS redirect rules to
    # silently fail.  Using native nft commands avoids this.
    if command -v iptables &>/dev/null; then
        local _v
        _v=$(iptables --version 2>/dev/null || true)
        if [[ "${_v}" == *"(nf_tables)"* ]] && command -v nft &>/dev/null; then
            FIREWALL="nft"
        else
            FIREWALL="iptables"
        fi
    elif command -v nft &>/dev/null; then
        FIREWALL="nft"
    else
        log_error "No firewall tool found (iptables or nft required)."
        exit 1
    fi
}

# Set up NAT and forwarding so clients on ap0 can reach the internet.
setup_firewall() {
    require_root
    load_config
    check_commands
    detect_firewall

    log_step "Configuring firewall rules for NAT... (${FIREWALL})"

    if [[ "${FIREWALL}" == "nft" ]]; then
        setup_firewall_nft
    else
        setup_firewall_iptables
    fi

    apply_dns_policy

    log_info "Firewall configured."
}

setup_firewall_iptables() {
    # Allow local input services on AP_IFACE & network (DNS, DHCP, Captive Portal, Dashboard Admin)
    iptables -I INPUT 1 -p tcp --dport 8073 -j ACCEPT 2>/dev/null || true
    iptables -I INPUT 1 -p tcp --dport 8080 -j ACCEPT 2>/dev/null || true
    iptables -I INPUT 1 -i "${AP_IFACE}" -p tcp --dport 80 -j ACCEPT 2>/dev/null || true
    iptables -I INPUT 1 -i "${AP_IFACE}" -p udp --dport 53 -j ACCEPT 2>/dev/null || true
    iptables -I INPUT 1 -i "${AP_IFACE}" -p tcp --dport 53 -j ACCEPT 2>/dev/null || true
    iptables -I INPUT 1 -i "${AP_IFACE}" -p udp --dport 67:68 -j ACCEPT 2>/dev/null || true

    # Allow Tailscale VPN traffic to dashboard
    if ip link show tailscale0 &>/dev/null; then
        iptables -I INPUT 1 -i tailscale0 -p tcp --dport 8073 -j ACCEPT 2>/dev/null || true
        iptables -I INPUT 1 -i tailscale0 -p tcp --dport 8080 -j ACCEPT 2>/dev/null || true
    fi

    # Redirect port 8080 -> 8073 so http://192.168.50.1:8080 works out-of-the-box
    iptables -t nat -A PREROUTING -p tcp --dport 8080 -j REDIRECT --to-ports 8073 2>/dev/null || true

    # Allow return traffic back to clients
    if ! iptables -C FORWARD -i "${WIFI_IFACE}" -o "${AP_IFACE}" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null; then
        iptables -I FORWARD 1 -i "${WIFI_IFACE}" -o "${AP_IFACE}" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
        log_info "Added FORWARD rule: ${WIFI_IFACE} -> ${AP_IFACE} (established)"
    fi

    # Masquerade outbound traffic
    if ! iptables -t nat -C POSTROUTING -s "${SUBNET}/${AP_CIDR}" -o "${WIFI_IFACE}" -j MASQUERADE 2>/dev/null; then
        iptables -t nat -A POSTROUTING -s "${SUBNET}/${AP_CIDR}" -o "${WIFI_IFACE}" -j MASQUERADE
        log_info "Added NAT MASQUERADE: ${SUBNET}/${AP_CIDR} -> ${WIFI_IFACE}"
    fi

    # If captive portal is NOT active, add default blanket FORWARD accept
    if [[ "${CAPTIVE_PORTAL:-false}" != "true" ]]; then
        if ! iptables -C FORWARD -i "${AP_IFACE}" -o "${WIFI_IFACE}" -j ACCEPT 2>/dev/null; then
            iptables -I FORWARD 2 -i "${AP_IFACE}" -o "${WIFI_IFACE}" -j ACCEPT
            log_info "Added FORWARD rule: ${AP_IFACE} -> ${WIFI_IFACE}"
        fi
    fi
}

setup_firewall_nft() {
    # Create dedicated OSHotspot table and chains
    nft add table ip oshotspot 2>/dev/null || true
    nft add chain ip oshotspot input '{ type filter hook input priority -1; }' 2>/dev/null || true
    nft add chain ip oshotspot forward '{ type filter hook forward priority -1; }' 2>/dev/null || true
    nft add chain ip oshotspot postrouting '{ type nat hook postrouting priority 100; }' 2>/dev/null || true
    nft add chain ip oshotspot prerouting '{ type nat hook prerouting priority -100; }' 2>/dev/null || true

    # Allow input services
    nft add rule ip oshotspot input tcp dport { 8073, 8080 } accept 2>/dev/null || true

    # Allow Tailscale VPN traffic to dashboard
    if ip link show tailscale0 &>/dev/null; then
        nft add rule ip oshotspot input iifname "tailscale0" tcp dport { 8073, 8080 } accept 2>/dev/null || true
    fi

    nft add rule ip oshotspot input iifname "${AP_IFACE}" tcp dport 80 accept 2>/dev/null || true
    nft add rule ip oshotspot input iifname "${AP_IFACE}" udp dport { 53, 67, 68 } accept 2>/dev/null || true
    nft add rule ip oshotspot input iifname "${AP_IFACE}" tcp dport 53 accept 2>/dev/null || true

    # Redirect port 8080 -> 8073
    nft add rule ip oshotspot prerouting tcp dport 8080 redirect to :8073 2>/dev/null || true

    # Allow traffic from ap0 to the internet
    if ! nft list chain ip oshotspot forward 2>/dev/null | grep -q "iifname \"${AP_IFACE}\".*oifname \"${WIFI_IFACE}\""; then
        nft add rule ip oshotspot forward iifname "${AP_IFACE}" oifname "${WIFI_IFACE}" accept
        log_info "Added FORWARD rule: ${AP_IFACE} -> ${WIFI_IFACE}"
    else
        log_info "FORWARD rule ${AP_IFACE} -> ${WIFI_IFACE} already exists."
    fi

    # Allow return traffic back to clients
    if ! nft list chain ip oshotspot forward 2>/dev/null | grep -q "iifname \"${WIFI_IFACE}\".*oifname \"${AP_IFACE}\""; then
        nft add rule ip oshotspot forward iifname "${WIFI_IFACE}" oifname "${AP_IFACE}" ct state established,related accept
        log_info "Added FORWARD rule: ${WIFI_IFACE} -> ${AP_IFACE} (established)"
    else
        log_info "FORWARD rule ${WIFI_IFACE} -> ${AP_IFACE} already exists."
    fi

    # Masquerade outbound traffic
    if ! nft list chain ip oshotspot postrouting 2>/dev/null | grep -q "ip saddr ${SUBNET}/${AP_CIDR}.*oifname \"${WIFI_IFACE}\""; then
        nft add rule ip oshotspot postrouting ip saddr "${SUBNET}/${AP_CIDR}" oifname "${WIFI_IFACE}" masquerade
        log_info "Added NAT MASQUERADE: ${SUBNET}/${AP_CIDR} -> ${WIFI_IFACE}"
    else
        log_info "NAT MASQUERADE rule already exists."
    fi
}

# -------------------------------------------------------------------
# DNS redirect, force all port 53 traffic to local dnsmasq
# -------------------------------------------------------------------

setup_dns_redirect_iptables() {
    if ! iptables -t nat -C PREROUTING -i "${AP_IFACE}" -p udp --dport 53 -j REDIRECT 2>/dev/null; then
        iptables -t nat -A PREROUTING -i "${AP_IFACE}" -p udp --dport 53 -j REDIRECT
        log_info "Added DNS REDIRECT: UDP port 53 -> dnsmasq"
    else
        log_info "DNS REDIRECT (UDP) already exists."
    fi
    if ! iptables -t nat -C PREROUTING -i "${AP_IFACE}" -p tcp --dport 53 -j REDIRECT 2>/dev/null; then
        iptables -t nat -A PREROUTING -i "${AP_IFACE}" -p tcp --dport 53 -j REDIRECT
        log_info "Added DNS REDIRECT: TCP port 53 -> dnsmasq"
    else
        log_info "DNS REDIRECT (TCP) already exists."
    fi
}

setup_dns_redirect_nft() {
    nft add table ip oshotspot 2>/dev/null || true
    nft add chain ip oshotspot prerouting '{ type nat hook prerouting priority -100; }' 2>/dev/null || true

    if ! nft list chain ip oshotspot prerouting 2>/dev/null | grep -q "iifname \"${AP_IFACE}\".*udp dport 53.*redirect"; then
        nft add rule ip oshotspot prerouting iifname "${AP_IFACE}" udp dport 53 redirect
        log_info "Added DNS REDIRECT: UDP port 53 -> dnsmasq"
    else
        log_info "DNS REDIRECT (UDP) already exists."
    fi
    if ! nft list chain ip oshotspot prerouting 2>/dev/null | grep -q "iifname \"${AP_IFACE}\".*tcp dport 53.*redirect"; then
        nft add rule ip oshotspot prerouting iifname "${AP_IFACE}" tcp dport 53 redirect
        log_info "Added DNS REDIRECT: TCP port 53 -> dnsmasq"
    else
        log_info "DNS REDIRECT (TCP) already exists."
    fi
}

# -------------------------------------------------------------------
# DoH block, drop traffic to known DoH resolver IPs on port 443
# -------------------------------------------------------------------

block_doh_iptables() {
    local count=0
    for ip in "${DOH_IPS[@]}"; do
        # TCP 443, classic DoH over HTTP/2.
        if ! iptables -C FORWARD -i "${AP_IFACE}" -d "$ip" -p tcp --dport 443 -j DROP 2>/dev/null; then
            iptables -I FORWARD -i "${AP_IFACE}" -d "$ip" -p tcp --dport 443 -j DROP
            count=$((count + 1))
        fi
        # UDP 443, DoH over HTTP/3 (QUIC), used by modern browsers;
        # without this rule the TCP block is trivially bypassed.
        if ! iptables -C FORWARD -i "${AP_IFACE}" -d "$ip" -p udp --dport 443 -j DROP 2>/dev/null; then
            iptables -I FORWARD -i "${AP_IFACE}" -d "$ip" -p udp --dport 443 -j DROP
            count=$((count + 1))
        fi
    done
    if [[ ${count} -gt 0 ]]; then
        log_info "Blocked DoH resolver IPs: ${count} rules added"
    else
        log_info "DoH block rules already exist."
    fi
    # Kill any existing DoH connections that were established before
    # the DROP rules were applied (e.g. during a stop/start cycle).
    kill_doh_connections
}

block_doh_nft() {
    nft add table ip oshotspot 2>/dev/null || true
    nft add chain ip oshotspot forward '{ type filter hook forward priority -1; }' 2>/dev/null || true

    local count=0
    for ip in "${DOH_IPS[@]}"; do
        if ! nft list chain ip oshotspot forward 2>/dev/null | grep -q "iifname \"${AP_IFACE}\".*${ip}.*tcp dport 443.*drop"; then
            nft add rule ip oshotspot forward iifname "${AP_IFACE}" ip daddr "$ip" tcp dport 443 drop
            count=$((count + 1))
        fi
        if ! nft list chain ip oshotspot forward 2>/dev/null | grep -q "iifname \"${AP_IFACE}\".*${ip}.*udp dport 443.*drop"; then
            nft add rule ip oshotspot forward iifname "${AP_IFACE}" ip daddr "$ip" udp dport 443 drop
            count=$((count + 1))
        fi
    done
    if [[ ${count} -gt 0 ]]; then
        log_info "Blocked DoH resolver IPs: ${count} rules added"
    else
        log_info "DoH block rules already exist."
    fi
    # Kill any existing DoH connections that were established before
    # the DROP rules were applied (e.g. during a stop/start cycle).
    kill_doh_connections
}

# -------------------------------------------------------------------
# Kill existing DoH/DoT connections (called after DROP rules are applied)
# -------------------------------------------------------------------

kill_doh_connections() {
    if ! command -v conntrack &>/dev/null; then
        return
    fi
    local killed=0
    for ip in "${DOH_IPS[@]}"; do
        if conntrack -D -p tcp --dport 443 -d "$ip" 2>/dev/null; then
            killed=$((killed + 1))
        fi
        if conntrack -D -p udp --dport 443 -d "$ip" 2>/dev/null; then
            killed=$((killed + 1))
        fi
    done
    # Also kill any DoT connections
    if conntrack -D -p tcp --dport 853 2>/dev/null; then
        killed=$((killed + 1))
    fi
    if conntrack -D -p udp --dport 853 2>/dev/null; then
        killed=$((killed + 1))
    fi
    if [[ ${killed} -gt 0 ]]; then
        log_info "Killed ${killed} existing DoH/DoT connection(s)"
    fi
}

# -------------------------------------------------------------------
# DoT block, drop DNS-over-TLS traffic on port 853
# -------------------------------------------------------------------

block_dot_iptables() {
    if ! iptables -C FORWARD -i "${AP_IFACE}" -p tcp --dport 853 -j DROP 2>/dev/null; then
        iptables -I FORWARD -i "${AP_IFACE}" -p tcp --dport 853 -j DROP
        log_info "Blocked DoT (TCP port 853)"
    else
        log_info "DoT block (TCP) already exists."
    fi
    if ! iptables -C FORWARD -i "${AP_IFACE}" -p udp --dport 853 -j DROP 2>/dev/null; then
        iptables -I FORWARD -i "${AP_IFACE}" -p udp --dport 853 -j DROP
        log_info "Blocked DoT (UDP port 853)"
    else
        log_info "DoT block (UDP) already exists."
    fi
}

block_dot_nft() {
    nft add table ip oshotspot 2>/dev/null || true
    nft add chain ip oshotspot forward '{ type filter hook forward priority -1; }' 2>/dev/null || true

    if ! nft list chain ip oshotspot forward 2>/dev/null | grep -q "iifname \"${AP_IFACE}\".*tcp dport 853.*drop"; then
        nft add rule ip oshotspot forward iifname "${AP_IFACE}" tcp dport 853 drop
        log_info "Blocked DoT (TCP port 853)"
    else
        log_info "DoT block (TCP) already exists."
    fi
    if ! nft list chain ip oshotspot forward 2>/dev/null | grep -q "iifname \"${AP_IFACE}\".*udp dport 853.*drop"; then
        nft add rule ip oshotspot forward iifname "${AP_IFACE}" udp dport 853 drop
        log_info "Blocked DoT (UDP port 853)"
    else
        log_info "DoT block (UDP) already exists."
    fi
}

# -------------------------------------------------------------------
# VPN protocol block, drop common VPN traffic from AP clients
# -------------------------------------------------------------------

block_vpn_iptables() {
    local count=0
    for entry in "${VPN_PORTS[@]}"; do
        local proto="${entry%%/*}"
        local port="${entry##*/}"
        if ! iptables -C FORWARD -i "${AP_IFACE}" -p "${proto}" --dport "${port}" -j DROP 2>/dev/null; then
            iptables -I FORWARD -i "${AP_IFACE}" -p "${proto}" --dport "${port}" -j DROP
            count=$((count + 1))
        fi
    done
    # Block IPsec ESP (IP protocol 50)
    if ! iptables -C FORWARD -i "${AP_IFACE}" -p esp -j DROP 2>/dev/null; then
        iptables -I FORWARD -i "${AP_IFACE}" -p esp -j DROP
        count=$((count + 1))
    fi
    if [[ ${count} -gt 0 ]]; then
        log_info "Blocked VPN protocols: ${count} rules added"
    else
        log_info "VPN block rules already exist."
    fi
}

block_vpn_nft() {
    nft add table ip oshotspot 2>/dev/null || true
    nft add chain ip oshotspot forward '{ type filter hook forward priority -1; }' 2>/dev/null || true

    local count=0
    for entry in "${VPN_PORTS[@]}"; do
        local proto="${entry%%/*}"
        local port="${entry##*/}"
        if ! nft list chain ip oshotspot forward 2>/dev/null | grep -q "iifname \"${AP_IFACE}\".*${proto} dport ${port}.*drop"; then
            nft add rule ip oshotspot forward iifname "${AP_IFACE}" "${proto}" dport "${port}" drop
            count=$((count + 1))
        fi
    done
    # Block IPsec ESP
    if ! nft list chain ip oshotspot forward 2>/dev/null | grep -q "iifname \"${AP_IFACE}\".*ip protocol esp.*drop"; then
        nft add rule ip oshotspot forward iifname "${AP_IFACE}" ip protocol esp drop
        count=$((count + 1))
    fi
    if [[ ${count} -gt 0 ]]; then
        log_info "Blocked VPN protocols: ${count} rules added"
    else
        log_info "VPN block rules already exist."
    fi
}

# -------------------------------------------------------------------
# IPv6 DNS/DoH/DoT/VPN block, close IPv6-side bypasses
# -------------------------------------------------------------------
# All the DNS policy above is IPv4-only.  If an AP client somehow has
# IPv6 connectivity (link-local leaks, an upstream router passing RA,
# or a dual-stack route), it could use IPv6 port 53 to bypass the local
# dnsmasq redirect, or IPv6 DoH/DoT/VPN to dodge the IP/port blocks.
#
# There is no IPv6 address on the AP interface and no IPv6 redirect
# target, so we can't redirect IPv6 DNS to dnsmasq.  Instead we DROP it
# so IPv6-capable clients are forced to use IPv4 DNS, which the
# redirect/block rules fully control.

block_ipv6_policy_nft() {
    if ! command -v nft &>/dev/null; then
        return 0
    fi

    nft add table ip6 oshotspot 2>/dev/null || true
    nft add chain ip6 oshotspot forward '{ type filter hook forward priority -1; }' 2>/dev/null || true

    # 1. Drop IPv6 DNS (53) and DoT (853) so clients can't bypass the
    #    IPv4 redirect with a manual IPv6 resolver or Android Private DNS.
    for spec in "udp 53" "tcp 53" "udp 853" "tcp 853"; do
        local proto="${spec%% *}"
        local port="${spec##* }"
        if ! nft list chain ip6 oshotspot forward 2>/dev/null | grep -q "iifname \"${AP_IFACE}\".*${proto} dport ${port}.*drop"; then
            nft add rule ip6 oshotspot forward iifname "${AP_IFACE}" "${proto}" dport "${port}" drop 2>/dev/null || true
        fi
    done

    # 2. Drop IPv6 DoH resolver addresses on 443 (TCP + UDP/QUIC).
    local count=0
    for ip in "${DOH_IPS6[@]}"; do
        if ! nft list chain ip6 oshotspot forward 2>/dev/null | grep -q "iifname \"${AP_IFACE}\".*${ip}.*tcp dport 443.*drop"; then
            nft add rule ip6 oshotspot forward iifname "${AP_IFACE}" ip6 daddr "${ip}" tcp dport 443 drop 2>/dev/null || true
            count=$((count + 1))
        fi
        if ! nft list chain ip6 oshotspot forward 2>/dev/null | grep -q "iifname \"${AP_IFACE}\".*${ip}.*udp dport 443.*drop"; then
            nft add rule ip6 oshotspot forward iifname "${AP_IFACE}" ip6 daddr "${ip}" udp dport 443 drop 2>/dev/null || true
            count=$((count + 1))
        fi
    done

    # 3. Drop IPv6 VPN protocols (mirror of IPv4 VPN_PORTS + ESP).
    for entry in "${VPN_PORTS[@]}"; do
        local proto="${entry%%/*}"
        local port="${entry##*/}"
        if ! nft list chain ip6 oshotspot forward 2>/dev/null | grep -q "iifname \"${AP_IFACE}\".*${proto} dport ${port}.*drop"; then
            nft add rule ip6 oshotspot forward iifname "${AP_IFACE}" "${proto}" dport "${port}" drop 2>/dev/null || true
        fi
    done
    if ! nft list chain ip6 oshotspot forward 2>/dev/null | grep -q "iifname \"${AP_IFACE}\".*l4proto esp.*drop"; then
        nft add rule ip6 oshotspot forward iifname "${AP_IFACE}" meta l4proto esp drop 2>/dev/null || true
    fi

    if [[ ${count} -gt 0 ]]; then
        log_info "IPv6 DNS/DoH/DoT/VPN blocking applied (nft)."
    fi
}

block_ipv6_policy_iptables() {
    if ! command -v ip6tables &>/dev/null; then
        return 0
    fi

    # 1. Drop IPv6 DNS (53) and DoT (853).
    for spec in "udp 53" "tcp 53" "udp 853" "tcp 853"; do
        local proto="${spec%% *}"
        local port="${spec##* }"
        if ! ip6tables -C FORWARD -i "${AP_IFACE}" -p "${proto}" --dport "${port}" -j DROP 2>/dev/null; then
            ip6tables -I FORWARD -i "${AP_IFACE}" -p "${proto}" --dport "${port}" -j DROP 2>/dev/null || true
        fi
    done

    # 2. Drop IPv6 DoH resolver addresses on 443 (TCP + UDP/QUIC).
    local count=0
    for ip in "${DOH_IPS6[@]}"; do
        if ! ip6tables -C FORWARD -i "${AP_IFACE}" -d "${ip}" -p tcp --dport 443 -j DROP 2>/dev/null; then
            ip6tables -I FORWARD -i "${AP_IFACE}" -d "${ip}" -p tcp --dport 443 -j DROP 2>/dev/null || true
            count=$((count + 1))
        fi
        if ! ip6tables -C FORWARD -i "${AP_IFACE}" -d "${ip}" -p udp --dport 443 -j DROP 2>/dev/null; then
            ip6tables -I FORWARD -i "${AP_IFACE}" -d "${ip}" -p udp --dport 443 -j DROP 2>/dev/null || true
            count=$((count + 1))
        fi
    done

    # 3. Drop IPv6 VPN protocols (mirror of IPv4 VPN_PORTS + ESP).
    for entry in "${VPN_PORTS[@]}"; do
        local proto="${entry%%/*}"
        local port="${entry##*/}"
        if ! ip6tables -C FORWARD -i "${AP_IFACE}" -p "${proto}" --dport "${port}" -j DROP 2>/dev/null; then
            ip6tables -I FORWARD -i "${AP_IFACE}" -p "${proto}" --dport "${port}" -j DROP 2>/dev/null || true
        fi
    done
    if ! ip6tables -C FORWARD -i "${AP_IFACE}" -p esp -j DROP 2>/dev/null; then
        ip6tables -I FORWARD -i "${AP_IFACE}" -p esp -j DROP 2>/dev/null || true
    fi

    if [[ ${count} -gt 0 ]]; then
        log_info "IPv6 DNS/DoH/DoT/VPN blocking applied (ip6tables)."
    fi
}

cleanup_ipv6_policy_nft() {
    if ! command -v nft &>/dev/null; then
        return 0
    fi
    local rules
    rules=$(nft -a list chain ip6 oshotspot forward 2>/dev/null || true)
    if [[ -z "${rules}" ]]; then
        return 0
    fi
    local handle
    while IFS= read -r line; do
        handle=$(echo "$line" | grep -oP '# handle \K\d+' || true)
        if [[ -n "${handle}" ]]; then
            nft delete rule ip6 oshotspot forward handle "${handle}" 2>/dev/null || true
        fi
    done < <(echo "$rules" | grep "iifname.*${AP_IFACE}.*\(dport 53\|dport 853\|dport 443\|dport 51820\|dport 1194\|dport 500\|dport 4500\|dport 1701\|dport 5555\|l4proto esp\).*drop" | tac)
    log_info "Removed IPv6 DNS/DoH/DoT/VPN block rules (nft)."
}

cleanup_ipv6_policy_iptables() {
    if ! command -v ip6tables &>/dev/null; then
        return 0
    fi
    for spec in "udp 53" "tcp 53" "udp 853" "tcp 853"; do
        local proto="${spec%% *}"
        local port="${spec##* }"
        while ip6tables -D FORWARD -i "${AP_IFACE}" -p "${proto}" --dport "${port}" -j DROP 2>/dev/null; do
            :
        done
    done
    for ip in "${DOH_IPS6[@]}"; do
        while ip6tables -D FORWARD -i "${AP_IFACE}" -d "${ip}" -p tcp --dport 443 -j DROP 2>/dev/null; do
            :
        done
        while ip6tables -D FORWARD -i "${AP_IFACE}" -d "${ip}" -p udp --dport 443 -j DROP 2>/dev/null; do
            :
        done
    done
    for entry in "${VPN_PORTS[@]}"; do
        local proto="${entry%%/*}"
        local port="${entry##*/}"
        while ip6tables -D FORWARD -i "${AP_IFACE}" -p "${proto}" --dport "${port}" -j DROP 2>/dev/null; do
            :
        done
    done
    while ip6tables -D FORWARD -i "${AP_IFACE}" -p esp -j DROP 2>/dev/null; do
        :
    done
    log_info "Removed IPv6 DNS/DoH/DoT/VPN block rules (ip6tables)."
}

# -------------------------------------------------------------------
# Cleanup helpers for DNS redirect and DoH block
# -------------------------------------------------------------------

cleanup_dns_redirect_iptables() {
    while iptables -t nat -D PREROUTING -i "${AP_IFACE}" -p udp --dport 53 -j REDIRECT 2>/dev/null; do
        log_info "Removed DNS REDIRECT: UDP port 53"
    done
    while iptables -t nat -D PREROUTING -i "${AP_IFACE}" -p tcp --dport 53 -j REDIRECT 2>/dev/null; do
        log_info "Removed DNS REDIRECT: TCP port 53"
    done
}

cleanup_dns_redirect_nft() {
    local rules
    rules=$(nft -a list chain ip oshotspot prerouting 2>/dev/null || true)
    if [[ -z "${rules}" ]]; then
        return
    fi
    local handle
    while IFS= read -r line; do
        handle=$(echo "$line" | grep -oP '# handle \K\d+' || true)
        if [[ -n "${handle}" ]]; then
            nft delete rule ip oshotspot prerouting handle "${handle}" 2>/dev/null || true
        fi
    done < <(echo "$rules" | grep "iifname.*${AP_IFACE}.*dport 53.*redirect" | tac)
}

cleanup_doh_block_iptables() {
    for ip in "${DOH_IPS[@]}"; do
        while iptables -D FORWARD -i "${AP_IFACE}" -d "$ip" -p tcp --dport 443 -j DROP 2>/dev/null; do
            :
        done
        while iptables -D FORWARD -i "${AP_IFACE}" -d "$ip" -p udp --dport 443 -j DROP 2>/dev/null; do
            :
        done
    done
    log_info "Removed DoH block rules."
}

cleanup_doh_block_nft() {
    local rules
    rules=$(nft -a list chain ip oshotspot forward 2>/dev/null || true)
    if [[ -z "${rules}" ]]; then
        return
    fi
    local handle
    while IFS= read -r line; do
        handle=$(echo "$line" | grep -oP '# handle \K\d+' || true)
        if [[ -n "${handle}" ]]; then
            nft delete rule ip oshotspot forward handle "${handle}" 2>/dev/null || true
        fi
    done < <(echo "$rules" | grep -E "iifname.*${AP_IFACE}.*(tcp|udp) dport 443.*drop" | tac)
}

cleanup_dot_iptables() {
    while iptables -D FORWARD -i "${AP_IFACE}" -p tcp --dport 853 -j DROP 2>/dev/null; do
        :
    done
    while iptables -D FORWARD -i "${AP_IFACE}" -p udp --dport 853 -j DROP 2>/dev/null; do
        :
    done
    log_info "Removed DoT block rules."
}

cleanup_dot_nft() {
    local rules
    rules=$(nft -a list chain ip oshotspot forward 2>/dev/null || true)
    if [[ -z "${rules}" ]]; then
        return
    fi
    local handle
    while IFS= read -r line; do
        handle=$(echo "$line" | grep -oP '# handle \K\d+' || true)
        if [[ -n "${handle}" ]]; then
            nft delete rule ip oshotspot forward handle "${handle}" 2>/dev/null || true
        fi
    done < <(echo "$rules" | grep "iifname.*${AP_IFACE}.*dport 853.*drop" | tac)
}

# -------------------------------------------------------------------
# VPN cleanup
# -------------------------------------------------------------------

cleanup_vpn_iptables() {
    for entry in "${VPN_PORTS[@]}"; do
        local proto="${entry%%/*}"
        local port="${entry##*/}"
        while iptables -D FORWARD -i "${AP_IFACE}" -p "${proto}" --dport "${port}" -j DROP 2>/dev/null; do
            :
        done
    done
    while iptables -D FORWARD -i "${AP_IFACE}" -p esp -j DROP 2>/dev/null; do
        :
    done
    log_info "Removed VPN block rules."
}

cleanup_vpn_nft() {
    local rules
    rules=$(nft -a list chain ip oshotspot forward 2>/dev/null || true)
    if [[ -z "${rules}" ]]; then
        return
    fi
    local handle
    while IFS= read -r line; do
        handle=$(echo "$line" | grep -oP '# handle \K\d+' || true)
        if [[ -n "${handle}" ]]; then
            nft delete rule ip oshotspot forward handle "${handle}" 2>/dev/null || true
        fi
    done < <(echo "$rules" | grep "iifname.*${AP_IFACE}.*\(dport 51820\|dport 1194\|dport 500\|dport 4500\|dport 1701\|dport 5555\|protocol esp\).*drop" | tac)
}

# -------------------------------------------------------------------
# Apply DNS redirect + DoH block (called from setup functions)
# -------------------------------------------------------------------

apply_dns_policy() {
    if [[ "${DNS_REDIRECT}" != "true" ]]; then
        log_info "DNS_REDIRECT is disabled, skipping DNS policy rules."
        return
    fi

    log_step "Applying DNS traffic policy (redirect + DoH block + DoT block + VPN block + blocked IP sets)..."
    log_step "  + IPv6 DNS/DoH/DoT/VPN block (closes IPv6 bypasses)..."

    if [[ "${FIREWALL}" == "nft" ]]; then
        setup_dns_redirect_nft
        block_doh_nft
        block_dot_nft
        block_vpn_nft
        block_ipv6_policy_nft
        setup_blocked_ip_sets_nft
    else
        setup_dns_redirect_iptables
        block_doh_iptables
        block_dot_iptables
        block_vpn_iptables
        block_ipv6_policy_iptables
        setup_blocked_ip_sets_iptables
    fi
}

remove_dns_policy() {
    if [[ "${FIREWALL}" == "nft" ]]; then
        cleanup_dns_redirect_nft
        cleanup_doh_block_nft
        cleanup_dot_nft
        cleanup_vpn_nft
        cleanup_ipv6_policy_nft
        cleanup_blocked_ip_sets_nft
    else
        cleanup_dns_redirect_iptables
        cleanup_doh_block_iptables
        cleanup_dot_iptables
        cleanup_vpn_iptables
        cleanup_ipv6_policy_iptables
        cleanup_blocked_ip_sets_iptables
    fi
}

# -------------------------------------------------------------------
# Blocked IP sets: drop FORWARD traffic to IPs resolved for forbidden
# domains.  Works even if the client uses an external DNS resolver.
# -------------------------------------------------------------------

setup_blocked_ip_sets_nft() {
    if ! nft list table ip oshotspot 2>/dev/null | grep -q 'table ip oshotspot'; then
        nft add table ip oshotspot 2>/dev/null || true
    fi

    if ! nft list set ip oshotspot blocked_ips 2>/dev/null | grep -q 'type ipv4_addr'; then
        nft add set ip oshotspot blocked_ips '{ type ipv4_addr; timeout 1h; }' 2>/dev/null || true
    fi

    if ! nft list chain ip oshotspot forward 2>/dev/null | grep -q '@blocked_ips '; then
        nft add rule ip oshotspot forward iifname "${AP_IFACE}" ip daddr @blocked_ips drop 2>/dev/null || true
    fi

    if ! nft list table ip6 oshotspot 2>/dev/null | grep -q 'table ip6 oshotspot'; then
        nft add table ip6 oshotspot 2>/dev/null || true
        nft add chain ip6 oshotspot forward '{ type filter hook forward priority -1; }' 2>/dev/null || true
    fi

    if ! nft list set ip6 oshotspot blocked_ips6 2>/dev/null | grep -q 'type ipv6_addr'; then
        nft add set ip6 oshotspot blocked_ips6 '{ type ipv6_addr; timeout 1h; }' 2>/dev/null || true
    fi

    if ! nft list chain ip6 oshotspot forward 2>/dev/null | grep -q '@blocked_ips6 '; then
        nft add rule ip6 oshotspot forward iifname "${AP_IFACE}" ip6 daddr @blocked_ips6 drop 2>/dev/null || true
    fi
}

cleanup_blocked_ip_sets_nft() {
    if nft list chain ip oshotspot forward 2>/dev/null | grep -q '@blocked_ips '; then
        nft flush set ip oshotspot blocked_ips 2>/dev/null || true
    fi
    nft delete set ip oshotspot blocked_ips 2>/dev/null || true
    nft delete rule ip oshotspot forward handle $(nft -a list chain ip oshotspot forward 2>/dev/null | grep '@blocked_ips ' | grep -oP 'handle \K\d+' | head -1) 2>/dev/null || true

    if nft list chain ip6 oshotspot forward 2>/dev/null | grep -q '@blocked_ips6 '; then
        nft flush set ip6 oshotspot blocked_ips6 2>/dev/null || true
    fi
    nft delete set ip6 oshotspot blocked_ips6 2>/dev/null || true
    nft delete rule ip6 oshotspot forward handle $(nft -a list chain ip6 oshotspot forward 2>/dev/null | grep '@blocked_ips6 ' | grep -oP 'handle \K\d+' | head -1) 2>/dev/null || true
}

setup_blocked_ip_sets_iptables() {
    if ! command -v ipset &>/dev/null; then
        return
    fi

    ipset create blocked_ips hash:ip timeout 3600 2>/dev/null || true
    ipset create blocked_ips6 hash:ip timeout 3600 2>/dev/null || true

    if ! iptables -C FORWARD -i "${AP_IFACE}" -m set --match-set blocked_ips dst -j DROP 2>/dev/null; then
        iptables -I FORWARD 1 -i "${AP_IFACE}" -m set --match-set blocked_ips dst -j DROP 2>/dev/null || true
    fi
    if ! iptables -C FORWARD -i "${AP_IFACE}" -m set --match-set blocked_ips6 dst -j DROP 2>/dev/null; then
        iptables -I FORWARD 1 -i "${AP_IFACE}" -m set --match-set blocked_ips6 dst -j DROP 2>/dev/null || true
    fi
}

cleanup_blocked_ip_sets_iptables() {
    if ! command -v ipset &>/dev/null; then
        return
    fi

    iptables -D FORWARD -i "${AP_IFACE}" -m set --match-set blocked_ips dst -j DROP 2>/dev/null || true
    iptables -D FORWARD -i "${AP_IFACE}" -m set --match-set blocked_ips6 dst -j DROP 2>/dev/null || true
    ipset destroy blocked_ips 2>/dev/null || true
    ipset destroy blocked_ips6 2>/dev/null || true
}

# Remove only the rules we added (leaves everything else untouched).
cleanup_firewall() {
    require_root
    load_config
    detect_firewall

    log_step "Cleaning up OSHotspot firewall rules... (${FIREWALL})"

    if [[ "${FIREWALL}" == "nft" ]]; then
        cleanup_firewall_nft
    else
        cleanup_firewall_iptables
    fi

    remove_dns_policy

    log_info "Firewall cleanup complete."
}

# Kill existing DoH/DoT connections without removing firewall rules.
# Called before a stop/start cycle to ensure established DoH connections
# don't survive the brief window when rules are removed.
cleanup_doh_connections() {
    load_config
    kill_doh_connections
}

cleanup_firewall_iptables() {
    while iptables -D FORWARD -i "${AP_IFACE}" -o "${WIFI_IFACE}" -j ACCEPT 2>/dev/null; do
        log_info "Removed FORWARD rule: ${AP_IFACE} -> ${WIFI_IFACE}"
    done

    while iptables -D FORWARD -i "${WIFI_IFACE}" -o "${AP_IFACE}" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null; do
        log_info "Removed FORWARD rule: ${WIFI_IFACE} -> ${AP_IFACE} (established)"
    done

    while iptables -t nat -D POSTROUTING -s "${SUBNET}/${AP_CIDR}" -o "${WIFI_IFACE}" -j MASQUERADE 2>/dev/null; do
        log_info "Removed NAT MASQUERADE: ${SUBNET}/${AP_CIDR} -> ${WIFI_IFACE}"
    done
}

cleanup_firewall_nft() {
    # Flush and delete only OSHotspot dedicated chains (never touches system chains)
    nft flush chain ip oshotspot forward 2>/dev/null || true
    nft flush chain ip oshotspot postrouting 2>/dev/null || true
    nft flush chain ip oshotspot prerouting 2>/dev/null || true
    nft delete chain ip oshotspot forward 2>/dev/null || true
    nft delete chain ip oshotspot postrouting 2>/dev/null || true
    nft delete chain ip oshotspot prerouting 2>/dev/null || true
    nft delete table ip oshotspot 2>/dev/null || true
    log_info "Cleaned up OSHotspot firewall chains (nft mode)."
}

# Re-pin DNS policy DROP rules above captive MAC FORWARD ACCEPT.
# Without this, Private DNS / DoH bypasses local dnsmasq after auth and
# CAPTIVE_DOMAIN (wifi.portal etc.) stops resolving to the AP.
ensure_dns_policy_on_top() {
    if [[ "${DNS_REDIRECT}" != "true" ]]; then
        return 0
    fi

    if [[ "${FIREWALL}" == "iptables" ]]; then
        cleanup_doh_block_iptables
        cleanup_dot_iptables
        cleanup_vpn_iptables
        if command -v ipset &>/dev/null; then
            while iptables -D FORWARD -i "${AP_IFACE}" -m set --match-set blocked_ips dst -j DROP 2>/dev/null; do :; done
            while iptables -D FORWARD -i "${AP_IFACE}" -m set --match-set blocked_ips6 dst -j DROP 2>/dev/null; do :; done
        fi
        block_doh_iptables
        block_dot_iptables
        block_vpn_iptables
        setup_blocked_ip_sets_iptables
    else
        # nft: DoH/DoT live in `forward` (priority -1); captive_forward is
        # priority 0 so DNS drops already evaluate before MAC accept.
        block_doh_nft
        block_dot_nft
        block_vpn_nft
        setup_blocked_ip_sets_nft
    fi
}

# Captive portal firewall handlers
captive_whitelist_mac() {
    local mac="${1:-}"
    [[ -z "${mac}" ]] && return 0
    require_root
    load_config
    detect_firewall
    mac=$(echo "${mac}" | tr '[:upper:]' '[:lower:]')
    if [[ "${FIREWALL}" == "iptables" ]]; then
        iptables -t nat -I PREROUTING 1 -i "${AP_IFACE}" -m mac --mac-source "${mac}" -p tcp --dport 80 -j ACCEPT 2>/dev/null || true
        # Insert MAC accept, then re-pin DNS policy above it so DoH/DoT
        # still win for authenticated clients.
        iptables -I FORWARD 1 -i "${AP_IFACE}" -o "${WIFI_IFACE}" -m mac --mac-source "${mac}" -j ACCEPT 2>/dev/null || true
        ensure_dns_policy_on_top
    else
        nft insert rule ip oshotspot captive_prerouting iifname "${AP_IFACE}" ether saddr "${mac}" tcp dport 80 accept 2>/dev/null || true
        nft insert rule ip oshotspot captive_forward iifname "${AP_IFACE}" ether saddr "${mac}" oifname "${WIFI_IFACE}" accept 2>/dev/null || true
        ensure_dns_policy_on_top
    fi
    log_info "Captive Portal: Whitelisted MAC ${mac}"
}

captive_revoke_mac() {
    local mac="${1:-}"
    [[ -z "${mac}" ]] && return 0
    require_root
    load_config
    detect_firewall
    mac=$(echo "${mac}" | tr '[:upper:]' '[:lower:]')
    # Re-setup captive rules cleanly
    captive_setup_firewall
    # Flush existing connections for revoked client so redirection triggers instantly
    if command -v conntrack &>/dev/null; then
        conntrack -D --mac-source "${mac}" 2>/dev/null || true
    fi
}

captive_setup_firewall() {
    require_root
    load_config
    detect_firewall
    local auth_file="/run/oshotspot-captive-authenticated.list"

    log_step "Setting up Captive Portal firewall rules (${FIREWALL})..."

    if [[ "${FIREWALL}" == "iptables" ]]; then
        # 1. Clean existing blanket accept and captive rules
        while iptables -D FORWARD -i "${AP_IFACE}" -o "${WIFI_IFACE}" -j ACCEPT 2>/dev/null; do :; done
        while iptables -D FORWARD -i "${AP_IFACE}" -o "${WIFI_IFACE}" -j DROP 2>/dev/null; do :; done
        while iptables -t nat -D PREROUTING -i "${AP_IFACE}" -p tcp --dport 80 -j DNAT --to-destination "${AP_IP}:80" 2>/dev/null; do :; done
        # Remove legacy HTTPS→HTTP redirect (caused ERR_SSL_PROTOCOL_ERROR:
        # browsers expect TLS on 443, captive server is HTTP-only).
        while iptables -t nat -D PREROUTING -i "${AP_IFACE}" -p tcp --dport 443 -d "${AP_IP}" -j REDIRECT --to-ports 80 2>/dev/null; do :; done

        # 2. Bypass captive portal for Dashboard Admin ports 8073 & 8080
        iptables -t nat -I PREROUTING 1 -p tcp --dport 8073 -j ACCEPT 2>/dev/null || true
        iptables -t nat -I PREROUTING 1 -p tcp --dport 8080 -j ACCEPT 2>/dev/null || true
        iptables -I INPUT 1 -p tcp --dport 8073 -j ACCEPT 2>/dev/null || true
        iptables -I INPUT 1 -p tcp --dport 8080 -j ACCEPT 2>/dev/null || true

        # 3. Redirect unauthenticated HTTP port 80 to local portal server
        iptables -t nat -A PREROUTING -i "${AP_IFACE}" -p tcp --dport 80 -j DNAT --to-destination "${AP_IP}:80" 2>/dev/null || true
        # NOTE: do NOT redirect 443→80. The captive server has no TLS; that
        # redirect produces ERR_SSL_PROTOCOL_ERROR. Portal is HTTP-only.

        # 4. Whitelist authenticated MAC addresses
        if [[ -f "${auth_file}" ]]; then
            while IFS= read -r mac; do
                mac=$(echo "${mac}" | tr '[:upper:]' '[:lower:]' | xargs)
                if [[ -n "${mac}" ]]; then
                    iptables -t nat -I PREROUTING 1 -i "${AP_IFACE}" -m mac --mac-source "${mac}" -p tcp --dport 80 -j ACCEPT 2>/dev/null || true
                    iptables -I FORWARD 1 -i "${AP_IFACE}" -o "${WIFI_IFACE}" -m mac --mac-source "${mac}" -j ACCEPT 2>/dev/null || true
                fi
            done < "${auth_file}"
        fi

        # 5. Drop all unauthenticated forwarding to the internet & drop all IPv6 forwarded leaks
        iptables -A FORWARD -i "${AP_IFACE}" -o "${WIFI_IFACE}" -j DROP 2>/dev/null || true
        ip6tables -I FORWARD 1 -i "${AP_IFACE}" -j DROP 2>/dev/null || true

        # 6. Re-pin DoH/DoT/blocked DROP above MAC ACCEPT (custom domain + DNS policy)
        ensure_dns_policy_on_top
    else
        # nftables mode
        nft flush chain ip oshotspot captive_prerouting 2>/dev/null || true
        nft flush chain ip oshotspot captive_forward 2>/dev/null || true
        nft delete chain ip oshotspot captive_prerouting 2>/dev/null || true
        nft delete chain ip oshotspot captive_forward 2>/dev/null || true

        nft add chain ip oshotspot captive_prerouting '{ type nat hook prerouting priority dstnat; policy accept; }' 2>/dev/null || true
        # priority 0 runs AFTER DoH/DoT chain (priority -1), so authenticated
        # MAC accept cannot bypass Private-DNS blocking.
        nft add chain ip oshotspot captive_forward '{ type filter hook forward priority 0; policy accept; }' 2>/dev/null || true

        # Block all IPv6 forwarded traffic from AP_IFACE to prevent IPv6 domain bypass
        nft add table ip6 oshotspot 2>/dev/null || true
        nft flush chain ip6 oshotspot captive_forward_v6 2>/dev/null || true
        nft delete chain ip6 oshotspot captive_forward_v6 2>/dev/null || true
        nft add chain ip6 oshotspot captive_forward_v6 '{ type filter hook forward priority 0; policy accept; }' 2>/dev/null || true
        nft add rule ip6 oshotspot captive_forward_v6 iifname "${AP_IFACE}" drop 2>/dev/null || true

        # Allow dashboard admin ports 8073 & 8080
        nft add rule ip oshotspot captive_prerouting tcp dport { 8073, 8080 } accept 2>/dev/null || true

        if [[ -f "${auth_file}" ]]; then
            while IFS= read -r mac; do
                mac=$(echo "${mac}" | tr '[:upper:]' '[:lower:]' | xargs)
                if [[ -n "${mac}" ]]; then
                    nft add rule ip oshotspot captive_prerouting iifname "${AP_IFACE}" ether saddr "${mac}" tcp dport 80 accept 2>/dev/null || true
                    nft add rule ip oshotspot captive_forward iifname "${AP_IFACE}" ether saddr "${mac}" oifname "${WIFI_IFACE}" accept 2>/dev/null || true
                fi
            done < "${auth_file}"
        fi

        nft add rule ip oshotspot captive_prerouting iifname "${AP_IFACE}" tcp dport 80 dnat to "${AP_IP}:80" 2>/dev/null || true
        # No 443→80 redirect: captive server is HTTP-only (TLS handshake would fail).
        nft add rule ip oshotspot captive_forward iifname "${AP_IFACE}" oifname "${WIFI_IFACE}" drop 2>/dev/null || true

        ensure_dns_policy_on_top
    fi

    log_info "Captive Portal firewall configured: Unauthenticated clients redirected to portal."
}

captive_teardown_firewall() {
    require_root
    load_config
    detect_firewall
    local auth_file="/run/oshotspot-captive-authenticated.list"
    log_step "Tearing down Captive Portal firewall rules (${FIREWALL})..."

    # Remove temporary authenticated list file so stale rules aren't reloaded
    rm -f "${auth_file}" 2>/dev/null || true

    if [[ "${FIREWALL}" == "iptables" ]]; then
        while iptables -t nat -D PREROUTING -i "${AP_IFACE}" -p tcp --dport 80 -j DNAT --to-destination "${AP_IP}:80" 2>/dev/null; do :; done
        while iptables -t nat -D PREROUTING -i "${AP_IFACE}" -p tcp --dport 80 -j ACCEPT 2>/dev/null; do :; done
        while iptables -t nat -D PREROUTING -i "${AP_IFACE}" -p tcp --dport 443 -d "${AP_IP}" -j REDIRECT --to-ports 80 2>/dev/null; do :; done
        while iptables -D FORWARD -i "${AP_IFACE}" -o "${WIFI_IFACE}" -j DROP 2>/dev/null; do :; done
        # Ensure blanket forwarding accept is present
        if ! iptables -C FORWARD -i "${AP_IFACE}" -o "${WIFI_IFACE}" -j ACCEPT 2>/dev/null; then
            iptables -I FORWARD 1 -i "${AP_IFACE}" -o "${WIFI_IFACE}" -j ACCEPT 2>/dev/null || true
        fi
    else
        nft flush chain ip oshotspot captive_prerouting 2>/dev/null || true
        nft flush chain ip oshotspot captive_forward 2>/dev/null || true
        nft delete chain ip oshotspot captive_prerouting 2>/dev/null || true
        nft delete chain ip oshotspot captive_forward 2>/dev/null || true
        # Ensure blanket forwarding rule exists in main forward chain
        if ! nft list chain ip oshotspot forward 2>/dev/null | grep -q "iifname \"${AP_IFACE}\".*oifname \"${WIFI_IFACE}\""; then
            nft add rule ip oshotspot forward iifname "${AP_IFACE}" oifname "${WIFI_IFACE}" accept 2>/dev/null || true
        fi
    fi
    log_info "Captive Portal firewall torn down."
}

# -------------------------------------------------------------------
# SNI-based blocking -- inspect TLS Client Hello for domain names
# -------------------------------------------------------------------
# This catches clients that bypass DNS (cached IPs, external DNS, hosts
# file) by inspecting the SNI field in TLS Client Hello packets.
# Works at the PREROUTING stage on the first packet of each connection.

# Read the set of active app-block categories from the state file.
# Returns space-separated list of active categories (e.g. "messaging social").
_get_active_categories() {
    local state_file="/run/oshotspot-app-block.conf"
    if [[ ! -f "${state_file}" ]]; then
        echo ""
        return
    fi
    # Source the file to get APP_BLOCK_CATEGORIES variable
    source "${state_file}" 2>/dev/null || true
    echo "${APP_BLOCK_CATEGORIES:-}"
}

block_sni_iptables() {
    local categories
    categories="$(_get_active_categories)"
    [[ -z "${categories}" ]] && return 0

    # Create a dedicated chain for SNI inspection
    if ! iptables -t mangle -L OSH_SNI_BLOCK 2>/dev/null; then
        iptables -t mangle -N OSH_SNI_BLOCK 2>/dev/null || true
        iptables -t mangle -I PREROUTING 1 -i "${AP_IFACE}" -p tcp --dport 443 -j OSH_SNI_BLOCK 2>/dev/null || true
    fi

    local count=0
    for entry in "${SNI_BLOCK_RULES[@]}"; do
        local category="${entry%%:*}"
        local rest="${entry#*:}"
        local sni_string="${rest%%:*}"
        # Only add if this category is active
        local active=false
        for cat in ${categories}; do
            if [[ "${cat}" == "${category}" ]]; then
                active=true
                break
            fi
        done
        [[ "${active}" != "true" ]] && continue

        # Check if rule already exists
        if ! iptables -t mangle -C OSH_SNI_BLOCK -p tcp --dport 443 -m string --string "${sni_string}" --algo bm -j DROP 2>/dev/null; then
            iptables -t mangle -A OSH_SNI_BLOCK -p tcp --dport 443 -m string --string "${sni_string}" --algo bm --from 0 --to 600 -j DROP 2>/dev/null
            count=$((count + 1))
        fi
    done

    if [[ ${count} -gt 0 ]]; then
        log_info "SNI blocking: ${count} rules added (categories: ${categories})"
    fi
}

block_sni_nft() {
    local categories
    categories="$(_get_active_categories)"
    [[ -z "${categories}" ]] && return 0

    nft add table ip oshotspot 2>/dev/null || true
    if ! nft list chain ip oshotspot sni_block 2>/dev/null | grep -q 'sni_block'; then
        nft add chain ip oshotspot sni_block 2>/dev/null || true
    fi

    local count=0
    for entry in "${SNI_BLOCK_RULES[@]}"; do
        local category="${entry%%:*}"
        local rest="${entry#*:}"
        local sni_string="${rest%%:*}"
        local active=false
        for cat in ${categories}; do
            if [[ "${cat}" == "${category}" ]]; then
                active=true
                break
            fi
        done
        [[ "${active}" != "true" ]] && continue

        # SNI blocking via nftables is disabled on this system
        # (nftables v1.1.6 does not support string-match payload expressions).
        # Port-based blocking in APP_BLOCK_RULES is used instead.
        :
    done

    # Hook the chain if not already hooked
    if ! nft list chain ip oshotspot prerouting 2>/dev/null | grep -q 'jump sni_block' 2>/dev/null; then
        nft insert rule ip oshotspot prerouting iifname "${AP_IFACE}" tcp dport 443 jump sni_block 2>/dev/null || true
    fi

    if [[ ${count} -gt 0 ]]; then
        log_info "SNI blocking: ${count} rules added (nft, categories: ${categories})"
    fi
}

block_sni() {
    require_root
    load_config
    detect_firewall
    log_step "Applying SNI-based blocking... (${FIREWALL})"
    if [[ "${FIREWALL}" == "nft" ]]; then
        block_sni_nft
    else
        block_sni_iptables
    fi
}

cleanup_sni_iptables() {
    # Remove jump rule first
    while iptables -t mangle -D PREROUTING -i "${AP_IFACE}" -p tcp --dport 443 -j OSH_SNI_BLOCK 2>/dev/null; do :; done
    # Flush and delete chain
    iptables -t mangle -F OSH_SNI_BLOCK 2>/dev/null || true
    iptables -t mangle -X OSH_SNI_BLOCK 2>/dev/null || true
    log_info "SNI blocking rules removed (iptables)."
}

cleanup_sni_nft() {
    # Remove jump rule from prerouting
    local rules
    rules=$(nft -a list chain ip oshotspot prerouting 2>/dev/null || true)
    if [[ -n "${rules}" ]]; then
        local handle
        while IFS= read -r line; do
            handle=$(echo "${line}" | grep -oP 'handle \K\d+' || true)
            if [[ -n "${handle}" ]]; then
                nft delete rule ip oshotspot prerouting handle "${handle}" 2>/dev/null || true
            fi
        done < <(echo "${rules}" | grep 'jump sni_block' | tac)
    fi
    nft flush chain ip oshotspot sni_block 2>/dev/null || true
    nft delete chain ip oshotspot sni_block 2>/dev/null || true
    log_info "SNI blocking rules removed (nft)."
}

# -------------------------------------------------------------------
# Application port-based blocking
# -------------------------------------------------------------------
# Blocks known ports used by messaging/social/streaming apps.
# Combined with SNI blocking, this provides defense-in-depth.

block_app_ports_iptables() {
    local categories
    categories="$(_get_active_categories)"
    [[ -z "${categories}" ]] && return 0

    if ! iptables -L OSH_APP_BLOCK 2>/dev/null; then
        iptables -N OSH_APP_BLOCK 2>/dev/null || true
        iptables -I FORWARD 1 -i "${AP_IFACE}" -j OSH_APP_BLOCK 2>/dev/null || true
    fi

    local count=0
    for entry in "${APP_BLOCK_RULES[@]}"; do
        local category="${entry%%:*}"
        local rest="${entry#*:}"
        local proto_port="${rest%%:*}"
        local proto="${proto_port%%/*}"
        local port="${proto_port#*/}"

        local active=false
        for cat in ${categories}; do
            if [[ "${cat}" == "${category}" ]]; then
                active=true
                break
            fi
        done
        [[ "${active}" != "true" ]] && continue

        if ! iptables -C OSH_APP_BLOCK -i "${AP_IFACE}" -p "${proto}" --dport "${port}" -j DROP 2>/dev/null; then
            iptables -A OSH_APP_BLOCK -i "${AP_IFACE}" -p "${proto}" --dport "${port}" -j DROP 2>/dev/null
            count=$((count + 1))
        fi
    done

    if [[ ${count} -gt 0 ]]; then
        log_info "App port blocking: ${count} rules added (categories: ${categories})"
    fi
}

block_app_ports_nft() {
    local categories
    categories="$(_get_active_categories)"
    [[ -z "${categories}" ]] && return 0

    nft add table ip oshotspot 2>/dev/null || true
    if ! nft list chain ip oshotspot app_block 2>/dev/null | grep -q 'app_block'; then
        nft add chain ip oshotspot app_block 2>/dev/null || true
    fi

    local count=0
    for entry in "${APP_BLOCK_RULES[@]}"; do
        local category="${entry%%:*}"
        local rest="${entry#*:}"
        local proto_port="${rest%%:*}"
        local proto="${proto_port%%/*}"
        local port="${proto_port#*/}"

        local active=false
        for cat in ${categories}; do
            if [[ "${cat}" == "${category}" ]]; then
                active=true
                break
            fi
        done
        [[ "${active}" != "true" ]] && continue

        if ! nft list chain ip oshotspot app_block 2>/dev/null | grep -q "${proto} dport ${port}.*drop"; then
            nft add rule ip oshotspot app_block iifname "${AP_IFACE}" "${proto}" dport "${port}" drop 2>/dev/null
            count=$((count + 1))
        fi
    done

    # Hook into forward chain if not already
    if ! nft list chain ip oshotspot forward 2>/dev/null | grep -q 'jump app_block' 2>/dev/null; then
        nft insert rule ip oshotspot forward iifname "${AP_IFACE}" jump app_block 2>/dev/null || true
    fi

    if [[ ${count} -gt 0 ]]; then
        log_info "App port blocking: ${count} rules added (nft, categories: ${categories})"
    fi
}

cleanup_app_block_iptables() {
    while iptables -D FORWARD -i "${AP_IFACE}" -j OSH_APP_BLOCK 2>/dev/null; do :; done
    iptables -F OSH_APP_BLOCK 2>/dev/null || true
    iptables -X OSH_APP_BLOCK 2>/dev/null || true
    log_info "App block rules removed (iptables)."
}

cleanup_app_block_nft() {
    local rules
    rules=$(nft -a list chain ip oshotspot forward 2>/dev/null || true)
    if [[ -n "${rules}" ]]; then
        local handle
        while IFS= read -r line; do
            handle=$(echo "${line}" | grep -oP 'handle \K\d+' || true)
            if [[ -n "${handle}" ]]; then
                nft delete rule ip oshotspot forward handle "${handle}" 2>/dev/null || true
            fi
        done < <(echo "${rules}" | grep 'jump app_block' | tac)
    fi
    nft flush chain ip oshotspot app_block 2>/dev/null || true
    nft delete chain ip oshotspot app_block 2>/dev/null || true
    log_info "App block rules removed (nft)."
}

# -------------------------------------------------------------------
# Combined app-block apply / cleanup (called from API)
# -------------------------------------------------------------------

apply_app_block() {
    require_root
    load_config
    detect_firewall
    log_step "Applying application blocking rules... (${FIREWALL})"

    if [[ "${FIREWALL}" == "nft" ]]; then
        # Clean existing SNI + app block rules first, then reapply
        cleanup_sni_nft
        cleanup_app_block_nft
        block_sni_nft
        block_app_ports_nft
    else
        cleanup_sni_iptables
        cleanup_app_block_iptables
        block_sni_iptables
        block_app_ports_iptables
    fi

    # Also kill any existing connections to blocked services
    kill_blocked_connections

    log_info "Application blocking applied."
}

cleanup_app_block() {
    require_root
    load_config
    detect_firewall
    log_step "Cleaning up application blocking rules... (${FIREWALL})"

    if [[ "${FIREWALL}" == "nft" ]]; then
        cleanup_sni_nft
        cleanup_app_block_nft
    else
        cleanup_sni_iptables
        cleanup_app_block_iptables
    fi

    # Remove state file
    rm -f /run/oshotspot-app-block.conf 2>/dev/null || true

    log_info "Application blocking cleaned up."
}

# -------------------------------------------------------------------
# Kill established connections to blocked domain IPs and app ports
# -------------------------------------------------------------------

kill_blocked_connections() {
    if ! command -v conntrack &>/dev/null; then
        return
    fi
    local killed=0
    local categories
    categories="$(_get_active_categories)"

    # 1. Kill connections to IPs in the blocked_ips set
    if command -v nft &>/dev/null && nft list set ip oshotspot blocked_ips 2>/dev/null | grep -q 'type ipv4_addr'; then
        while IFS= read -r ip; do
            ip=$(echo "${ip}" | xargs)
            [[ -z "${ip}" ]] && continue
            if conntrack -D -d "${ip}" 2>/dev/null; then
                killed=$((killed + 1))
            fi
        done < <(nft list set ip oshotspot blocked_ips 2>/dev/null | grep -oE '\b[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b')
    elif command -v ipset &>/dev/null && ipset list blocked_ips 2>/dev/null | grep -q 'Type: hash:ip'; then
        while IFS= read -r ip; do
            ip=$(echo "${ip}" | xargs)
            [[ -z "${ip}" ]] && continue
            if conntrack -D -d "${ip}" 2>/dev/null; then
                killed=$((killed + 1))
            fi
        done < <(ipset list blocked_ips 2>/dev/null | grep -oE '\b[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b')
    fi

    # 2. Kill connections on well-known app ports for active categories
    if [[ -n "${categories}" ]]; then
        for entry in "${APP_BLOCK_RULES[@]}"; do
            local category="${entry%%:*}"
            local rest="${entry#*:}"
            local proto_port="${rest%%:*}"
            local proto="${proto_port%%/*}"
            local port="${proto_port#*/}"
            local active=false
            for cat in ${categories}; do
                if [[ "${cat}" == "${category}" ]]; then
                    active=true
                    break
                fi
            done
            [[ "${active}" != "true" ]] && continue
            conntrack -D -p "${proto}" --dport "${port}" 2>/dev/null && killed=$((killed + 1)) || true
        done
    fi

    if [[ ${killed} -gt 0 ]]; then
        log_info "Killed ${killed} existing connection(s) to blocked targets"
    fi
}

case "${1:-setup}" in
    setup)                  setup_firewall ;;
    cleanup)                cleanup_firewall ;;
    cleanup-doh-connections) cleanup_doh_connections ;;
    captive_setup)          captive_setup_firewall ;;
    captive_teardown)       captive_teardown_firewall ;;
    captive_whitelist)      captive_whitelist_mac "${2:-}" ;;
    captive_revoke)         captive_revoke_mac "${2:-}" ;;
    app_block_apply)        apply_app_block ;;
    app_block_cleanup)      cleanup_app_block ;;
    kill_blocked)           kill_blocked_connections ;;
    *)                      echo "Usage: $0 {setup|cleanup|cleanup-doh-connections|captive_setup|captive_teardown|captive_whitelist|captive_revoke|app_block_apply|app_block_cleanup|kill_blocked}" >&2; exit 1 ;;
esac
