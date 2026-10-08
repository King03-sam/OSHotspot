# OSHotspot, Complete Technical & Functional Specification

**Version 5.1**

**OSHotspot** is an enterprise-grade, sovereign Linux software suite providing automated WiFi Access Point (Hotspot) management, customizable Captive Portal capabilities, and a standalone SPAN Port Network Traffic & Intrusion Detection System (IDS).

---

## Table of Contents

1. [Architectural Overview & Core Design](#1-architectural-overview--core-design)
2. [WiFi Access Point Core (Hotspot Engine)](#2-wifi-access-point-core-hotspot-engine)
3. [Captive Portal System](#3-captive-portal-system)
4. [SPAN Port Traffic Analysis & Anomaly Detection (IDS)](#4-span-port-traffic-analysis--anomaly-detection-ids)
5. [Dashboard Security & Authentication Architecture](#5-dashboard-security--authentication-architecture)
6. [Persistent Branding & Image Architecture](#6-persistent-branding--image-architecture)
7. [User Management & Role-Based Access Control (RBAC)](#7-user-management--role-based-access-control-rbac)
8. [Domain Policy & Content Filtering](#8-domain-policy--content-filtering)
9. [DNS Traffic Policy & Network Security](#9-dns-traffic-policy--network-security)
10. [SMTP Email Alerting](#10-smtp-email-alerting)
11. [Device Inventory & Unknown Device Detection](#11-device-inventory--unknown-device-detection)
12. [Live Bandwidth Monitor](#12-live-bandwidth-monitor)
13. [Channel Scanner & 5 GHz Support](#13-channel-scanner--5-ghz-support)
14. [Captive Portal Rate Limiting](#14-captive-portal-rate-limiting)
15. [Event Pipeline & Data Architecture](#15-event-pipeline--data-architecture)
16. [System Diagnostics, Logs & Telemetry](#16-system-diagnostics-logs--telemetry)
17. [Command-Line Interface (CLI) Reference](#17-command-line-interface-cli-reference)
18. [Remote Access via Tailscale VPN](#18-remote-access-via-tailscale-vpn)
19. [Audit Trail & Compliance](#19-audit-trail--compliance)
20. [Release Packaging & Distribution](#20-release-packaging--distribution)

---

## 1. Architectural Overview & Core Design

OSHotspot is built to operate natively on standard Linux distributions without requiring external framework dependencies (standard Python 3 library and native Linux utilities).

### Component Stack:
- **Web & API Server (`web/server/main.py` & `handler.py`)**: Multithreaded Python HTTP server serving REST API endpoints, real-time Server-Sent Events (SSE) streams, and static web assets.
- **Access Point & DHCP Engine (`hostapd` & `dnsmasq`)**: Native `hostapd` for 802.11a/b/g/n/ac WiFi broadcast and dedicated `dnsmasq` for DHCP IP allocation and local DNS resolution.
- **Firewall & Packet Routing (`scripts/firewall.sh`)**: Dual-backend support for `iptables` and `nftables` handling NAT masquerading, client isolation, captive portal traffic redirection, and remote administrative port management.
- **SPAN Network Analyzer (`events/span_analyzer.py`)**: Raw socket packet parser and real-time security anomaly detector.

---

## 2. WiFi Access Point Core (Hotspot Engine)

- **Dual-Interface Routing**: Simultaneously handles the upstream Internet interface (e.g., `wlan0`, `eth0`) and broadcasts a virtual Access Point interface (`ap0`).
- **Wireless Configuration**:
  - Configurable SSID (1–32 chars), WPA2/WPA3 PSK credentials, country code (ISO 3166-1), and hidden SSID broadcast options.
  - Automatic channel optimization and frequency scanning via `iw`.
  - 802.11n / 802.11ac hardware mode selection with automatic short-GI fallback handling.
- **DHCP Subnet Management**: Customizable IP subnet range (`192.168.50.0/24`), gateway IP (`192.168.50.1`), lease duration, and upstream primary/secondary DNS servers.
- **Client Tracking & Device Fingerprinting**: Real-time connected device table tracking MAC addresses, assigned IPs, hostnames, signal strength (dBm), and connection duration.

---

## 3. Captive Portal System

- **Flexible Guest Authentication**:
  - **Access Code / Voucher Mode**: Restricts network access until a valid pre-generated voucher code is submitted.
  - **One-Click Guest Mode**: Provides instant one-click *"Connect to Network"* access.
- **Dynamic Custom Branding**:
  - Uploadable Captive Portal Logo image.
  - Customizable background color picker (`CAPTIVE_BG_COLOR`).
  - Editable welcome title and terms message.
- **Flicker-Free Submission & Redirection**:
  - Automatic HTTP redirect (`302`) for unauthenticated clients.
  - Smooth AJAX/Fetch form submission preventing page shifts or flickering on mobile devices.
- **Hot Configuration Toggle**:
  - The Captive Portal can be enabled or disabled at any time via `POST /api/config` (set `CAPTIVE_PORTAL=true` or `false`). Changes take effect instantly, the portal server starts/stops and firewall rules are applied without restarting hostapd or disconnecting clients.

---

## 4. SPAN Port Traffic Analysis & Anomaly Detection (IDS)

- **Standalone & Virtual Machine Execution**:
  - The SPAN analyzer operates on any designated network interface (`eth0`, `eth1`, `ens33`, `enp3s0`, etc.), even if no WiFi hotspot is actively running. It can be deployed on a standalone VM or security monitoring host.
- **Deep Packet Inspection (DPI)**:
  - **DNS Query Parsing**: Decodes UDP port 53 DNS domain requests.
  - **HTTP Request Inspection**: Extracts `Host:` header fields from unencrypted TCP port 80/8080 traffic.
  - **TLS SNI Inspection**: Parses Server Name Indication (SNI) hostnames from TLS ClientHello packets on TCP port 443.
- **Aggressive Security Anomaly Engine**:
  1. `PORT SCAN`: Triggers when an IP targets more than 6 distinct TCP/UDP ports within 8 seconds.
  2. `SYN FLOOD`: Identifies rapid TCP SYN packet bursts without ACK response.
  3. `ICMP FLOOD`: Triggers when ICMP echo request rate exceeds 25 packets/second.
  4. `ARP SPOOF`: Detects IP-to-MAC address mapping conflicts and ARP spoofing attempts.
  5. `TRAFFIC BURST`: Triggers when packet transmission rate exceeds 80 packets/second per host.
- **Real-Time Visualization**:
  - SSE-powered live event stream displaying traffic logs and clean text security badges (`PORT SCAN`, `TRAFFIC BURST`, `SYN FLOOD`, `ARP SPOOF`, `ICMP FLOOD`).
- **Hot Configuration Toggle**:
  - The SPAN Analyzer can be started and stopped at any time via `POST /api/config` (set `SPAN_ENABLED=true` and specify `SPAN_INTERFACE`, or `false` to stop). Changes take effect instantly without restarting the hotspot or disconnecting clients. The analyzer runs as an independent process (`events/span_analyzer.py`) managed by the dashboard server.

---

## 5. Dashboard Security & Authentication Architecture

- **Local-Only First-Run Setup Guard**:
  - Initial Super Admin account creation (`/api/auth/setup`) is strictly restricted to local host requests (`127.0.0.1` or CLI token launch via `sudo oshotspot web`). Remote WiFi users cannot hijack initial setup.
- **Tokenless & Cookie-Based Remote Access**:
  - Supports remote administration over LAN (`http://192.168.50.1:8080` or `http://192.168.50.1:8073`). Port `8080` is automatically redirected to `8073` via an `iptables`/`nftables` NAT PREROUTING rule, so both URLs are interchangeable.
  - Issues secure `HttpOnly; SameSite=Strict` `session_token` cookies for authenticated sessions.
- **Flicker-Free Page Load**:
  - Prevents dashboard rendering (`#appShell` hidden by default) until session status is verified by `/api/auth/status`.
- **Logout**:
  - `GET /api/auth/logout`, clears the session cookie and returns an HTTP 302 redirect to `/`. No request body required.
- **Brute-Force Protection (per-IP + per-user)**:
  - **Per-user** (persisted in `auth.db`): progressive lockout tiers, 5 failures → 60s, 10 → 10min, 15 → 30min, 20+ → 1h. Message `invalid` is generic (no username enumeration); `secrets.compare_digest` provides constant-time password comparison.
  - **Per-IP** (in-memory, silent): failure tiers 5 → 60s, 10 → 5min, 20 → 15min, 30+ → 1h, with idle entries pruned after 1h. A blocked IP is **never disclosed**: it receives the exact same generic `invalid` response (and audit event) as any wrong password, and loopback addresses (`127.0.0.1`, `::1`) are exempt.
  - **Timing**: a 1-second server-side delay is applied after every failed login attempt to equalize response timing and slow brute-force scripts.

---

## 6. Persistent Branding & Image Architecture

- **Dual-Directory Storage Strategy**:
  - Uploaded logos are simultaneously written to system directories `/var/lib/oshotspot/images` and `/etc/oshotspot/images`.
- **Automatic Backup & Restore**:
  - `install.sh` automatically backs up and restores custom logo files during software reinstalls or upgrades.
- **Real-Time Logo Synchronization**:
  - Updating the App Logo in *Configuration* immediately updates the Dashboard brand header, Admin Login screen, and About page logo without page reloads.

---

## 7. User Management & Role-Based Access Control (RBAC)

- **Encrypted SQLite Database (`auth.db`)**:
  - Stores user credentials using PBKDF2-HMAC-SHA256 (100,000 iterations, per-user random 16-byte salt), never stored in plaintext or weak hash.
- **Role Hierarchy**:
  - **Super Admin**: Full administrative control, configuration edits, user account creation, and firewall modifications.
  - **Admin**: Hotspot management, client controls, captive portal settings, and policy views.
- **Audit Access Flag (`can_view_audit`)**:
   - Non-superadmin admin users can be granted `can_view_audit=1` by a superadmin via the User Management page (`POST /api/users/audit-access`).
   - When enabled, the user can view the Audit Log page and query `GET /api/audit-log`, but cannot delete entries or modify user permissions.
   - Superadmins always have audit access; the flag only affects non-superadmin admins.

---

## 8. Domain Policy & Content Filtering

- **DNS Sinkholing & Filtering**:
  - Wildcard domain rules driving local `dnsmasq` blocking configurations.
  - **Forbidden Domains**: Instant high-priority alert generation + optional notification email.
  - **Watched Domains**: Logging and highlight tracking.
   - **Noise Filter**: Silences background telemetry and OS keep-alive requests from event tables.

---

## 8a. Application Category Blocking (App Block)

OSHotspot can block entire categories of network applications, not just by DNS domain, but also by **network port** and **TLS SNI inspection**, preventing bypass via external DNS, cached IPs, or VPNs.

- **Supported Categories**:
  | Category ID | Label | Enforcement |
  |-------------|-------|-------------|
  | `messaging` | WhatsApp, Telegram, Signal, Discord, Viber, Snapchat, Skype | Port-based + SNI |
  | `gaming` | Steam, Epic Games | Port-based + SNI |

- **API Endpoints**:
  | Method | Path | Description |
  |--------|------|-------------|
  | GET | `/api/app-block` | Returns active categories and available category list |
  | POST | `/api/app-block` | Apply or remove category blocking. Body: `{"categories": ["messaging", "gaming"]}`. An empty list removes all blocking. |

- **Blocking Mechanisms**:
  1. **Port-based blocking** (`APP_BLOCK_RULES` in `scripts/firewall.sh`): Drops TCP/UDP traffic to well-known ports used by target applications (e.g., WhatsApp XMPP ports 5222/5223/5228, Steam ports 27015/27016).
  2. **SNI-based blocking** (`SNI_BLOCK_RULES` in `scripts/firewall.sh`): Inspects the TLS Client Hello SNI field on port 443 and drops connections whose SNI matches blocked application domains (e.g., `whatsapp.com`, `telegram.org`, `steampowered.com`).
  3. **Connection kill**: When blocking is applied or removed, `conntrack` is used to terminate existing connections to blocked targets, ensuring immediate effect.

- **State File**: Active categories are persisted in `/run/oshotspot-app-block.conf` as `APP_BLOCK_CATEGORIES="messaging gaming"`.

- **Dashboard Integration**: App Block controls are embedded in the **Domain Policy** page (`policy.js`). No separate dashboard page or navigation section is dedicated to this feature.

- **Dual Firewall Backend**: Both `iptables` (custom chain `OSH_APP_BLOCK` + mangle table for SNI) and `nftables` (`app_block` + `sni_block` chains) are supported.

---

## 9. DNS Traffic Policy & Network Security

### DNS Enforcement
- All DNS traffic from connected clients is transparently forced through OSHotspot's dedicated `dnsmasq` instance.
- **Port 53 redirect**: `iptables`/`nftables` PREROUTING rules redirect all UDP/TCP port 53 traffic from the AP interface to local dnsmasq, regardless of which DNS server the client is manually configured to use.
- **DNS-over-TLS (DoT) block**: TCP/UDP port 853 is blocked, preventing Android Private DNS and OS-level encrypted DNS from bypassing the redirect.
- **DNS-over-HTTPS (DoH) block**: Known DoH resolver IPs (Cloudflare, Google, Quad9, AdGuard, OpenDNS, NextDNS, Mullvad) are blocked on port 443, forcing browsers back to standard DNS.
- **VPN protocol blocking**: WireGuard (51820/UDP), OpenVPN (1194/TCP+UDP), IPsec IKE (500/UDP), IPsec NAT-T (4500/UDP), L2TP (1701/UDP), SoftEther (5555/UDP) are all blocked at the FORWARD chain level.

### Dual Firewall Backend
- Auto-detects `iptables-nft` (native nft) vs legacy `iptables` at runtime.
- All rules maintained identically in both backends for cross-distribution compatibility.

### Dynamic Blocked IP Sets
- When a domain is added to the **Forbidden Domains** list, OSHotspot resolves its IP addresses and populates a dynamic firewall set (`ipset` for iptables, `nft set` for nftables).
- These IPs are dropped at the FORWARD chain level, ensuring that even clients using external DNS servers or cached IPs cannot reach forbidden domains.
- Set entries have a 1-hour timeout, automatically expiring stale IPs without manual cleanup.
- The sets are populated by `reload-dns-blocking.sh` whenever the forbidden domain list changes.

---

## 10. SMTP Email Alerting

- Optional SMTP notification system for critical events.
- Triggers on: `forbidden_domain` match, `watched_domain` match, DNS flood detection, brute-force lockout, critical service failure.
- **Dual SMTP Mode**:
  - `direct`: Python stdlib `smtplib` with STARTTLS support and optional SMTP authentication
  - `msmtp`: System msmtp MTA (lightweight, no Python dependencies)
- Digest buffering: Batches alerts (10 alerts or 60 seconds) to prevent email flooding
- HTML email with dark theme template and optional logo
- Failures are silent, the event is still logged and pushed via SSE.
- Configuration: `ALERT_EMAIL_ENABLED`, `ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_SMTP_HOST`, `ALERT_EMAIL_SMTP_PORT`, `ALERT_EMAIL_USERNAME`, `ALERT_EMAIL_PASSWORD`.

---

## 11. Device Inventory & Unknown Device Detection

- **Known Devices table** (`known_devices` in `events.db`): MAC address, label, device type (phone/laptop/tablet/other), notes, first_seen timestamp.
- **Auto-flagging**: New DHCPACK from an unknown MAC → `unknown_device` event + notification + toast, flagged only once per MAC.
- **Mark as known**: Click any unknown device in the Clients table to open a modal and assign a label, type, and notes.
- **Bulk import**: Paste multiple devices at once (`MAC, Label, Type, Notes` per line) via the Clients page.
- **MAC deny list**: Add/remove MACs from `deny_maclist.conf`, injected into hostapd `deny_acl`, with automatic hostapd restart.

---

## 12. Live Bandwidth Monitor

- Real-time upload/download speed calculation from `/proc/net/dev` (ap0 + WIFI_IFACE).
- Total RX/TX byte counters since last reboot.
- Canvas sparkline chart showing last 60 data points on the Overview page.
- Auto-refresh toggle.

---

## 13. Channel Scanner & 5 GHz Support

- `iw dev <iface> scan` enumerates all nearby access points per channel.
- Ranks channels 1, 6, 11 (non-overlapping 2.4 GHz) by congestion count.
- Recommends the least congested channel.
- 5 GHz support detection via `iw phy`, warns if `HW_MODE=a` is selected on an unsupported adapter.
- Adaptive `hostapd.conf` generation: C tool (`oshotspot-gen`) reads hardware capabilities JSON and generates optimal config (HT caps, supported channels, short GI).

---

## 14. Captive Portal System & Code Management

- **Authentication & Rate Limiting**:
  - Supports permanent access code (`CAPTIVE_CODE`) and temporary guest voucher codes.
  - Progressive rate limiting per client IP/MAC: cooldown of 60s after 5 failed attempts, +60s every additional 5 failures (5→60s, 10→120s, 15→180s …), capped at 1 hour. Failures reset only on a successful login; a 1s server-side delay on each failure also slows brute-force attempts.
  - Case-insensitive & whitespace-trimmed code matching (`VIP-88AB` == `vip-88ab`).
  - CORS preflight support: Handles HTTP `OPTIONS` requests (`Access-Control-Allow-Origin: *`) to ensure mobile captive popups (iOS/Android/Windows probe URLs) submit login forms without cross-origin errors.
- **Server-Side Atomic Batch Code Generation (`POST /api/captive/codes/generate`)**:
  - Generates 1 to 50 temporary codes atomically in a single backend call.
  - Configurable string length (4–12 characters), custom prefix (e.g. `VIP-`), duration (hours), and label.
  - Cryptographically secure random alphabet excluding ambiguous characters (`O, 0, I, 1, L`).
- **First-Use Activation Model**:
  - Created codes remain **unused and unexpired** (`activated_at = None`, `expires_at = None`).
  - The duration countdown (e.g. 24h) is triggered **only upon first login** by a client MAC address (`activated_at = now`, `expires_at = now + duration`).
- **PDF Voucher Export System (`GET /api/captive/codes/export-pdf`)**:
  - Generates printable A4 guest access vouchers (8 ticket cards per page) with cut lines, large monospace codes, duration, label, and instructions.
  - Automatically loads custom admin logo (`captive_logo.png`, `app_logo.png`, `logo.png`).
  - Ticket header banner dynamically styled with the admin's configured captive portal background color (`CAPTIVE_BG_COLOR`).
  - Displays dynamic gateway IP status URL: `Check remaining time: http://<AP_IP>/status`.
  - Includes a dedicated Summary Audit List on a separate page.
- **Live User Session Status View (`GET /api/portal/status`, `http://<AP_IP>/status`)**:
  - Dual-View Portal: Automatically switches between `#loginCard` (unauthenticated) and `#statusCard` (authenticated).
  - Real-time countdown timer updating every second with a glowing white progress bar (`.progress-bar-fill`).
  - Displays connected network SSID, Access Code used, Expiration timestamp, IP address, MAC address, and "Browse Web" button.
  - Instant (0ms) transition upon login success and automatic status view rendering whenever an authenticated client visits `192.168.50.1` or `/status`.
- **Dashboard UI Security & Masking (`web/static/js/captive.js`)**:
  - Permanent access code input rendered as `type="password"`.
  - Access codes table header features a global **Mask Codes / Show Codes** toggle button with click-to-unmask capability and CSS blur effect (`filter: blur(5px)`).

---

## 15. Event Pipeline & Data Architecture

- **Log tailing**: `pygtail` (rotation-safe, `copytruncate=True`) tails `dnsmasq.log`, recovers from dnsmasq restarts without stale offsets.
- **Domain classification**: Auto-categorizes DNS domains into `noise`, `messaging`, `social`, `entertainment`, `browsing`, `unknown` using 60+ hardcoded roots + admin-editable noise patterns.
- **Session aggregation**: Consecutive queries from same client → same domain within 5 minutes merged into one row with `request_count`.
- **SQLite WAL mode**: All three databases (`events.db`, `auth.db`, `live.db`) use Write-Ahead Logging for concurrent reader/writer access without `database is locked` errors.
- **SSE ring buffer**: `live.db` stores last 1000 events as JSON, used for cross-process SSE delivery and the anomaly history modal.
- **Retry/backoff**: `tenacity` wraps all SQLite writes with exponential backoff on `OperationalError` (transient lock).
- **Event Deletion**: Superadmins can delete the N oldest events via `POST /api/events/delete` (calls `delete_oldest_events()` in `events/db.py`). Max 10,000 events per request. This is useful for purging stale data without dropping the entire database.

---

## 16. System Diagnostics, Logs & Telemetry

- **OSHotspot Doctor (`scripts/doctor.sh`)**:
  - Automated diagnostic tool verifying wireless driver capabilities, AP mode support, service status (`hostapd`, `dnsmasq`), firewall rules, and DHCP leases.
- **One-Click Auto-Repair (`/api/repair`)** :
  - Unblocks wireless interface (`rfkill`), recreates virtual AP interfaces, resets DHCP leases, and restarts networking services.
- **Real-Time Bandwidth Telemetry**:
  - Live upload/download rate calculation (bytes/sec) and canvas sparkline charts.

---

## 17. Command-Line Interface (CLI) Reference

```bash
sudo oshotspot start         # Start WiFi hotspot and NAT routing
sudo oshotspot stop          # Stop hotspot services
sudo oshotspot restart       # Restart hotspot and reload configuration
sudo oshotspot status        # Display real-time status and connected devices
sudo oshotspot clients       # List connected devices with MAC & IP
sudo oshotspot monitor       # Terminal live monitoring dashboard
sudo oshotspot repair        # Automatic network repair & recovery
sudo oshotspot web           # Launch web management dashboard
sudo oshotspot doctor        # System readiness diagnostic
sudo oshotspot interfaces    # List available WiFi network adapters
sudo oshotspot scan          # Scan WiFi channels and recommend best channel
sudo oshotspot qr            # Print scannable terminal WiFi QR code
sudo oshotspot logs          # View and follow hotspot logs (--follow, --lines=N)
sudo oshotspot enable        # Enable auto-start at boot via systemd
sudo oshotspot disable       # Disable auto-start at boot
sudo oshotspot update        # Update OSHotspot to latest version
sudo oshotspot config        # Print current configuration
sudo oshotspot config reset  # Restore config from example template
sudo oshotspot set ssid <name>       # Change hotspot SSID (auto-restart if running)
sudo oshotspot set password <pass>   # Change hotspot password (auto-restart if running)
sudo oshotspot set wifi_iface <iface> # Set internet WiFi adapter
sudo oshotspot setup-vpn     # Install and configure Tailscale VPN for remote access
sudo oshotspot setup-mail    # Configure email alerts (msmtp or direct SMTP)
sudo oshotspot uninstall [--purge]  # Remove OSHotspot (--purge removes config & logs)
```

---

## 18. Remote Access via Tailscale VPN

OSHotspot integrates with Tailscale to provide secure remote access to the dashboard without port forwarding or dynamic DNS.

### Features:
- **Mesh VPN Access**: Access the dashboard from any device on your Tailscale network
- **No Port Forwarding**: Uses Tailscale's mesh networking, no router configuration needed
- **Dashboard Integration**: Start/stop/restart VPN directly from the dashboard VPN page
- **Authentication URL**: Automatic detection of `NeedsLogin` state with one-click authentication
- **Firewall Rules**: Automatic Tailscale interface rules added to iptables/nftables

### CLI Command:
```bash
sudo oshotspot setup-vpn     # Install Tailscale and configure for OSHotspot
```

### Configuration Keys:
| Key | Default | Description |
|-----|---------|-------------|
| `VPN_ENABLED` | `false` | Enable Tailscale VPN remote access |
| `VPN_URL` | `""` | Tailscale dashboard URL for remote access |
| `DASHBOARD_BIND_ADDRESS` | `0.0.0.0` | Dashboard bind address (0.0.0.0 for VPN) |

### Dashboard API:
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/vpn/status` | Tailscale VPN status (Running/NeedsLogin/Stopped) |
| POST | `/api/vpn/start` | Start Tailscale VPN (returns auth URL if needed) |
| POST | `/api/vpn/stop` | Stop Tailscale VPN |
| POST | `/api/vpn/restart` | Restart Tailscale VPN |

### Setup Flow:
1. Install Tailscale via official installer (`curl -fsSL https://tailscale.com/install.sh | sh`)
2. Run `tailscale up` to authenticate
3. Configure `DASHBOARD_BIND_ADDRESS="0.0.0.0"` in config.conf
4. Add Tailscale interface rules to firewall
5. Access dashboard via Tailscale IP

### Security:
- Tailscale uses WireGuard encryption under the hood
- Dashboard authentication still required (token/session cookie)
- No exposure of ports to the public internet

---

## 19. Audit Trail & Compliance

OSHotspot maintains a comprehensive audit log of all administrative actions for security compliance and incident investigation.

### Overview
Every significant admin action is recorded with the username, role, timestamp, detailed action description, source IP, and success/failure status. Non-superadmin admin users can be granted read-only audit access via the `can_view_audit` flag.

### `audit_log` Table Schema (`auth.db`)
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment primary key |
| `timestamp` | TEXT | ISO 8601 timestamp (e.g., `2026-08-21T12:34:56`) |
| `username` | TEXT | Username of the acting user |
| `role` | TEXT | Role of the acting user (`admin`, `superadmin`) |
| `action` | TEXT | Action performed (e.g., `login`, `create_user`, `delete_event`, `config_update`) |
| `detail` | TEXT | Human-readable description of the action |
| `source_ip` | TEXT | Client IP address |
| `success` | INTEGER | 1 = success, 0 = failure |

### Audited Actions
- **Authentication**: login (success/failure), logout, setup
- **User Management**: create user, delete user, reset password, role change, audit access toggle
- **Hotspot Control**: start, stop, restart, repair
- **Configuration**: config updates (SSID, password, channel, policy changes, etc.)
- **Policy**: domain policy additions/removals, captive portal changes
- **Events**: event deletion, known device management, MAC blocking/unblocking
- **VPN**: start, stop, restart
- **Email**: SMTP configuration changes, test email sent
- **Audit**: audit log deletion

### API Endpoints
| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/api/audit-log` | Superadmin or `can_view_audit=1` | Query audit log with filters (user, action, date range) and pagination |
| POST | `/api/audit-log/delete` | Superadmin only | Delete audit entries by IDs |
| POST | `/api/users/audit-access` | Superadmin only | Toggle `can_view_audit` flag for a user |

### Retention Policy
- **90-day rolling window**: Entries older than 90 days are automatically purged.
- **72-hour cleanup cycle**: A background daemon thread in `main.py` runs `cleanup_old_audit()` every 72 hours (259,200 seconds) to remove expired entries.

---

## 20. Release Packaging & Distribution

OSHotspot is distributed via GitHub Releases as both a tarball (`.tar.gz`) and a Debian package (`.deb`), built automatically by CI on every tagged `v*` push.

### Packaging Files
| File | Purpose |
|------|---------|
| `package.sh` | Main packaging script, reads `debian/install` as source of truth, builds tarball + `.deb` |
| `debian/control` | Package metadata: dependencies, description, maintainer |
| `debian/install` | File list defining what gets installed where (source of truth) |
| `debian/changelog` | Debian changelog with version history |
| `debian/rules` | dpkg-build rules (uses `dh` with Python 3 addon) |
| `debian/compat` | debhelper compatibility level (13) |
| `.github/workflows/release.yml` | CI pipeline: builds artifacts and uploads to GitHub Releases on tag push |

### Build Process (`package.sh`)
1. Reads `debian/install` to determine the list of files to include
2. Creates a clean staging directory with the correct directory structure
3. Builds a `.tar.gz` tarball (excludes `__pycache__`, `.pyc`, `.o`, `.a` files)
4. Builds a `.deb` package using dpkg-deb
5. Outputs both to `dist/`

### CI Pipeline (`.github/workflows/release.yml`)
- **Trigger**: Push of `v*` tags (e.g., `v4.0`)
- **Steps**:
  1. Checkout code
  2. Install build dependencies (`dpkg-dev`, `debhelper`, `python3-all`, etc.)
  3. Run `./package.sh <version>`
  4. Upload `dist/oshotspot-v<version>.tar.gz` as tarball artifact
  5. Upload `dist/oshotspot_<version>_all.deb` as .deb artifact

### Installation
**From GitHub Release (tarball)**:
```bash
curl -fsSL https://github.com/King03-sam/OSHotspot/releases/latest/download/oshotspot-v4.0.tar.gz | sudo tar xz -C /tmp
sudo /tmp/oshotspot-4.0/install.sh
```

**From GitHub Release (.deb)**:
```bash
curl -fsSL https://github.com/King03-sam/OSHotspot/releases/latest/download/oshotspot_4.0_all.deb -o /tmp/oshotspot.deb
sudo dpkg -i /tmp/oshotspot.deb
```
