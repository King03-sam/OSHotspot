# Architecture

OSHotspot is a WiFi hotspot manager for Linux that creates a virtual Access Point using a single WiFi adapter, sharing the host machine's internet connection with clients via NAT. It provides both a CLI and a local web dashboard for management.

---

## System Overview

```mermaid
graph TB
    subgraph Interfaces
        CLI[CLI<br/>oshotspot]
        WEB[Web Dashboard<br/>Python Server + SPA]
        SYSD[Systemd Services<br/>boot / suspend]
    end

    subgraph CTools["C Tools (optional, auto-detected)"]
        SCAN[oshotspot-scan<br/>nl80211 scanner]
        GEN[oshotspot-gen<br/>config generator]
        WD[oshotspot-watchdog<br/>process monitor]
    end

    subgraph Core["Core Layer (scripts/*.sh)"]
        START[start.sh]
        STOP[stop.sh]
        REPAIR[repair.sh]
        UTILS[utils.sh]
        FW[firewall.sh]
    end

    subgraph Config["Configuration"]
        CONF["/etc/oshotspot/config.conf<br/>(single source of truth)"]
        TPLS["Config Templates<br/>hostapd.conf / dnsmasq.conf"]
    end

    subgraph System["System Tools"]
        HOSTAPD[hostapd<br/>WiFi AP daemon]
        DNSMASQ[dnsmasq<br/>DHCP + DNS]
        IPTABLES[iptables / nftables<br/>NAT + DNS redirect]
        IW[iw<br/>Virtual AP interface]
        IP[iproute2<br/>Interface config]
        SYSCTL[sysctl<br/>IP forwarding]
    end

    subgraph Clients
        PHONES[Phones / Laptops / Tablets]
    end

    CLI --> START & STOP & REPAIR
    WEB -->|"subprocess calls"| START & STOP & REPAIR
    SYSD -->|"ExecStart"| CLI

    START & STOP & REPAIR --> UTILS
    START --> FW --> IPTABLES
    STOP --> FW
    START --> HOSTAPD & DNSMASQ & IW & IP & SYSCTL

    UTILS --> CONF
    START --> TPLS --> HOSTAPD & DNSMASQ
    CONF --> UTILS

    START -->|"auto-detect"| SCAN & GEN
    START -->|"auto-monitor"| WD
    SCAN --> GEN

    HOSTAPD -.->|WiFi AP| PHONES
    DNSMASQ -.->|DHCP / DNS| PHONES
```

---

## Network Topology

```mermaid
graph LR
    INTERNET[Internet]
    ROUTER[WiFi Router / ISP]
    WIFI["WiFi Adapter<br/>(wlp2s0 / wlan0)<br/>Connected to ISP"]
    HOST["Linux Host<br/>IP Forwarding: ON<br/>NAT: MASQUERADE"]
    AP["Virtual AP (ap0)<br/>IP: 192.168.50.1/24"]
    DHCP["dnsmasq<br/>DHCP: 192.168.50.10-100<br/>DNS: 8.8.8.8, 1.1.1.1"]
    C1["Client 1<br/>192.168.50.10"]
    C2["Client 2<br/>192.168.50.11"]
    CN["Client N<br/>192.168.50.x"]

    INTERNET --- ROUTER --- WIFI
    WIFI --- HOST
    HOST --- AP
    AP --- DHCP
    DHCP --- C1 & C2 & CN
```

```mermaid
graph LR
    subgraph Traffic Flow
        C["Client<br/>192.168.50.x"]
        AP["ap0"]
        NAT["iptables NAT<br/>MASQUERADE"]
        WIFI["wlp2s0"]
        R["Internet<br/>Router"]
        INET["Internet"]
    end

    C -->|"WiFi"| AP
    AP --> NAT
    NAT --> WIFI
    WIFI -->|"WiFi"| R
    R --> INET
```

---

## CLI Flow

The CLI is a Bash script dispatcher that routes commands to dedicated shell scripts.

```mermaid
graph TD
    U["User: sudo oshotspot <command>"]
    CLI[oshotspot]
    DISPATCH{command}

    S[start.sh]
    SP[stop.sh]
    RST[restart.sh]
    RP[repair.sh]
    ST[status.sh]
    CL[clients.sh]
    MN[monitor.sh]
    QR[qr.sh]
    DOC[doctor.sh]
    LOG[logs.sh]
    WEB[web.sh]
    CFG[config / set]
    IF[interfaces]
    EN[enable / disable]

    S & SP & RP & ST & CL & MN & QR & DOC & LOG --> UTILS[utils.sh<br/>load_config / check_commands]
    WEB --> PY[serve.py]

    U --> CLI --> DISPATCH
    DISPATCH -->|start| S
    DISPATCH -->|stop| SP
    DISPATCH -->|restart| SP
    DISPATCH -->|restart| S
    DISPATCH -->|repair| RP
    DISPATCH -->|status| ST
    DISPATCH -->|clients| CL
    DISPATCH -->|monitor| MN
    DISPATCH -->|qr| QR
    DISPATCH -->|doctor| DOC
    DISPATCH -->|logs| LOG
    DISPATCH -->|web| WEB
    DISPATCH -->|config / set| CFG
    DISPATCH -->|interfaces| IF
    DISPATCH -->|enable / disable| EN
```

---

## Web Dashboard Flow

The web dashboard is a Python HTTP server serving a vanilla JS SPA. All API calls are token-authenticated.

```mermaid
graph TD
    subgraph Browser
        SPA["SPA Frontend<br/>index.html + 14 JS modules"]
    end

    subgraph Server["Python Server (127.0.0.1:8073)"]
        MAIN[main.py<br/>Startup + Watchdog]
        HANDLER[handler.py<br/>HTTP Request Handler]
        AUTH[auth.py<br/>Token Validation]
        SCRIPTS[scripts.py<br/>Subprocess Wrappers]
        PARSERS[parsers.py<br/>Output Parsers]
        CFGSTORE[config_store.py<br/>Config Read/Write]
        NETINFO[network_info.py<br/>/proc/net/dev, QR, 5GHz]
        SETTINGS[settings.py<br/>Constants]
    end

    subgraph Backend
        SH[Shell Scripts]
        LOGS["Log Files<br/>/var/log/oshotspot/"]
        PROC["/proc/net/dev"]
        CONF["config.conf"]
        DENY["deny_maclist.conf"]
    end

    SPA -->|"HTTP GET/POST<br/>?token=X"| HANDLER
    HANDLER --> AUTH
    HANDLER -->|"/api/status, /api/doctor"| SCRIPTS --> SH
    HANDLER -->|"/api/status, /api/doctor"| PARSERS
    HANDLER -->|"/api/config, POST /api/config"| CFGSTORE --> CONF
    HANDLER -->|"/api/traffic"| NETINFO --> PROC
    HANDLER -->|"/api/qr"| NETINFO
    HANDLER -->|"/api/logs"| LOGS
    HANDLER -->|"/api/blocked"| DENY
    HANDLER -->|"/api/kick, /api/unblock"| DENY
    MAIN --> HANDLER
```

### API Endpoints

| Method | Path | Backend | Description |
|--------|------|---------|-------------|
| GET | `/api/status` | `status.sh` + `clients.sh` | Full hotspot status |
| GET | `/api/clients` | `clients.sh` | DHCP lease table |
| GET | `/api/config` | `config_store.py` | Current configuration |
| GET | `/api/qr` | `qrencode` | WiFi QR code PNG |
| GET | `/api/doctor` | `doctor.sh` | System diagnostics |
| GET | `/api/logs` | Log files | Hostapd/dnsmasq/web logs |
| GET | `/api/traffic` | `/proc/net/dev` | Bandwidth counters |
| GET | `/api/interfaces` | `/sys/class/net` | WiFi interface list |
| GET | `/api/blocked` | `deny_maclist.conf` | Blocked MACs |
| POST | `/api/start` | `start.sh` | Start hotspot |
| POST | `/api/stop` | `stop.sh` | Stop hotspot |
| POST | `/api/restart` | `stop.sh` + `start.sh` | Restart hotspot |
| POST | `/api/repair` | `repair.sh` | Post-suspend recovery |
| POST | `/api/config` | `config_store.py` | Update configuration |
| POST | `/api/kick` | `deny_maclist.conf` | Block client by MAC |
| POST | `/api/unblock` | `deny_maclist.conf` | Unblock client |

---

## Start Sequence

The startup process follows a strict 13-step sequence.

```mermaid
sequenceDiagram
    participant U as User / CLI
    participant S as start.sh
    participant C as C Tools (optional)
    participant UTL as utils.sh
    participant SYS as System Tools

    U->>S: sudo oshotspot start
    S->>UTL: require_root()
    S->>UTL: load_config()
    S->>UTL: check_commands()
    S->>SYS: check_ap_support() [iw phy info]

    alt C tools available
        S->>C: oshotspot-scan --phy=phy0
        C-->>S: JSON capabilities
        S->>SYS: Configure NetworkManager to ignore ap0
        S->>SYS: iw phy add ap0 type __ap
        S->>SYS: ip addr add 192.168.50.1/24 dev ap0
        S->>C: oshotspot-gen --caps=caps.json
        C-->>S: Adaptive hostapd.conf
        S->>SYS: Generate dnsmasq.conf from template
    else Bash fallback
        S->>SYS: Configure NetworkManager to ignore ap0
        S->>SYS: iw phy add ap0 type __ap
        S->>SYS: ip addr add 192.168.50.1/24 dev ap0
        S->>SYS: Generate hostapd.conf from template
        S->>SYS: Generate dnsmasq.conf from template
    end

    S->>SYS: sysctl net.ipv4.ip_forward=1
    S->>SYS: firewall.sh setup<br/>NAT MASQUERADE + FORWARD + DNS redirect

    S->>SYS: hostapd -B (background daemon)
    S->>SYS: dnsmasq --daemon (DHCP + DNS)

    alt C tools available
        S->>C: oshotspot-watchdog monitor --interval=10
        Note over C: Auto-restart on crash
    end

    Note over S,SYS: Hotspot is now active<br/>Clients can connect
```

---

## Firewall Architecture

OSHotspot supports both **iptables** and **nftables** backends, auto-detected at runtime.

```mermaid
graph LR
    subgraph NAT["NAT / Forwarding Rules"]
        F1["FORWARD: ap0 → wifi ACCEPT<br/>(outbound traffic)"]
        F2["FORWARD: wifi → ap0 ESTAB<br/>(return traffic)"]
        F3["POSTROUTING: src 192.168.50.0/24<br/>→ MASQUERADE"]
    end

    subgraph DNS["DNS Policy (when DNS_REDIRECT=true)"]
        D1["PREROUTING: ap0 :53 UDP/TCP<br/>→ REDIRECT to local dnsmasq"]
        D2["FORWARD: ap0 → DoH IPs :443<br/>→ DROP (block encrypted DNS)"]
    end

    subgraph DoH["DoH Block List"]
        IP1[Cloudflare 1.1.1.1, 1.0.0.1]
        IP2[Google 8.8.8.8, 8.8.4.4]
        IP3[Quad9 9.9.9.9]
        IP4[NextDNS, AdGuard, Mullvad]
    end

    D2 --> DoH
```

---

## Configuration Management

`config.conf` is the single source of truth, in shell-sourced `KEY="value"` format.

```mermaid
graph TD
    EX["config.conf.example<br/>(project repo)"]
    INSTALL["install.sh<br/>copies to /etc/oshotspot/"]
    CONF["/etc/oshotspot/config.conf<br/>(single source of truth)"]

    subgraph Consumers
        BASH["Bash Scripts<br/>source directly"]
        PYTHON["Python Server<br/>regex parser"]
        CLI_SET["CLI 'set' command<br/>sed -i update"]
        WEB_POST["Web POST /api/config<br/>validate + write"]
    end

    subgraph Generated
        HAPD["hostapd.conf<br/>(from template)"]
        DNSC["dnsmasq.conf<br/>(from template)"]
    end

    subgraph Daemons
        HOSTAPD[hostapd]
        DNSMASQ[dnsmasq]
    end

    EX -->|"install"| INSTALL --> CONF
    CONF --> BASH & PYTHON & CLI_SET & WEB_POST
    CONF -->|"sed placeholders"| HAPD & DNSC
    HAPD --> HOSTAPD
    DNSC --> DNSMASQ
    CLI_SET -->|"auto-restart"| CONF
    WEB_POST -->|"auto-restart"| CONF
```

### Configuration Parameters

| Key | Default | Description |
|-----|---------|-------------|
| `SSID` | `OSHotspot` | WiFi network name (1-32 chars) |
| `PASSWORD` | `ChangeMe123` | WiFi password (min 8 chars, WPA2) |
| `CHANNEL` | `6` | WiFi channel (1-13) |
| `HW_MODE` | `g` | Hardware mode (`g` = 2.4GHz, `a` = 5GHz) |
| `COUNTRY_CODE` | `FR` | ISO 3166-1 alpha-2 country code |
| `HOSTNAME` | `oshotspot` | Hostname shown on the network |
| `AP_IFACE` | `ap0` | Virtual AP interface name |
| `WIFI_IFACE` | *(auto-detected)* | Internet WiFi interface |
| `AP_IP` | `192.168.50.1` | Hotspot gateway IP |
| `SUBNET` | `192.168.50.0` | Hotspot subnet |
| `AP_CIDR` | `24` | Subnet CIDR prefix |
| `DHCP_RANGE_START` | `192.168.50.10` | DHCP range start |
| `DHCP_RANGE_END` | `192.168.50.100` | DHCP range end |
| `DHCP_LEASE` | `12h` | DHCP lease duration |
| `DNS_PRIMARY` | `8.8.8.8` | Primary DNS server |
| `DNS_SECONDARY` | `1.1.1.1` | Secondary DNS server |

---

## Security Model

### Token Authentication

```mermaid
sequenceDiagram
    participant P as Python Server
    participant B as Browser
    participant H as handler.py

    P->>P: Generate random 64-char hex token<br/>(secrets.token_hex(32))
    P->>B: Open http://127.0.0.1:8073/?token=X

    B->>H: GET /api/status?token=X
    H->>H: check_token()<br/>secrets.compare_digest() (constant-time)
    alt Token valid
        H-->>B: 200 OK + JSON data
    else Token invalid
        H-->>B: 401 Unauthorized
    end

    Note over P,B: Token is ephemeral (regenerated every start)<br/>Server binds to 127.0.0.1 only<br/>Auto-shutdown after 2 hours of inactivity
```

### Security Layers

| Layer | Mechanism |
|-------|-----------|
| Network binding | `127.0.0.1` only (no external access) |
| Authentication | Random 256-bit token, constant-time comparison |
| Token delivery | URL query parameter (`?token=...`) |
| Request validation | Every API call requires valid token |
| Security headers | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` |
| Password protection | WiFi password never returned via API (only `password_set: boolean`) |
| File permissions | `config.conf` and `hostapd.conf` are `chmod 600` |
| Inactivity timeout | Auto-shutdown after 2 hours (out-of-process watchdog) |
| MAC filtering | `deny_maclist.conf` for kick/block clients |
| DNS enforcement | PREROUTING redirect + DoH IP blocking |

---

## File Structure

```
OSHotspot/
├── oshotspot                    # CLI entry point (bash)
├── Makefile                     # Build system for C tools
├── install.sh                   # Installer (local or remote)
├── uninstall.sh                 # Uninstaller (--purge option)
├── config.conf.example          # Configuration template
├── agents.json                  # AI agent metadata
├── include/
│   └── oshotspot.h              # Shared C types
├── src/
│   ├── oshotspot-scan.c         # nl80211 WiFi scanner
│   ├── oshotspot-gen.c          # Adaptive config generator
│   └── oshotspot-watchdog.c     # Process watchdog
├── scripts/
│   ├── utils.sh                 # Shared functions, config loader
│   ├── start.sh                 # Hotspot startup (13 steps)
│   ├── stop.sh                  # Hotspot shutdown
│   ├── repair.sh                # Post-suspend recovery
│   ├── firewall.sh              # iptables/nftables NAT setup
│   ├── status.sh                # System status report
│   ├── clients.sh               # DHCP lease table
│   ├── monitor.sh               # Real-time CLI monitoring
│   ├── qr.sh                    # Terminal QR code
│   ├── doctor.sh                # System diagnostics
│   ├── logs.sh                  # Log viewer
│   └── web.sh                   # Launches Python server
├── configs/
│   ├── hostapd.conf.template    # hostapd config template
│   ├── dnsmasq.conf.template    # dnsmasq config template
│   └── nm-oshotspot.conf        # NetworkManager ignore ap0
├── systemd/
│   ├── oshotspot.service        # Main systemd unit
│   └── oshotspot-dnsmasq.service # Dedicated dnsmasq unit
├── completions/
│   ├── oshotspot                # Bash completion
│   ├── oshotspot.zsh            # Zsh completion
│   └── oshotspot.fish           # Fish completion
└── web/
    ├── serve.py                 # Python entry point
    ├── server/
    │   ├── main.py              # Server startup + watchdog
    │   ├── handler.py           # HTTP API routes
    │   ├── auth.py              # Token management
    │   ├── scripts.py           # Subprocess wrappers
    │   ├── parsers.py           # Output parsers
    │   ├── config_store.py      # Config read/write/validate
    │   ├── network_info.py      # /proc/net/dev, QR, 5GHz
    │   └── settings.py          # Constants
    └── static/
        ├── index.html           # SPA shell (9 views)
        ├── style.css            # Styles (dark/light themes)
        └── js/
            ├── core.js          # Shared state + DOM helpers
            ├── api.js           # Fetch wrapper + token injection
            ├── app.js           # Bootstrap + polling
            ├── nav.js           # SPA navigation
            ├── theme.js         # Dark/light toggle
            ├── toast.js         # Notifications
            ├── status.js        # Overview panel
            ├── clients.js       # Client table + kick/block
            ├── actions.js       # Start/stop/restart/repair
            ├── config.js        # Configuration form
            ├── traffic.js       # Bandwidth chart (Canvas)
            ├── doctor.js        # Diagnostics panel
            ├── qr.js            # QR code display
            └── logs.js          # Log viewer
```

---

## Key Architectural Decisions

1. **Zero dependencies** — The Python server uses only stdlib (`http.server`, `json`, `subprocess`). No pip packages required.

2. **Single source of truth** — `config.conf` is a shell-sourced `KEY="value"` file, readable by both Bash (`source`) and Python (regex parser).

3. **Scripts as execution layer** — All system operations go through Bash scripts. Both CLI and web server are thin dispatchers invoking the same scripts.

4. **Template-based config generation** — hostapd.conf and dnsmasq.conf are regenerated from templates on every start, ensuring they always match current config.

5. **Virtual AP interface** — `ap0` is created via `iw`, allowing the same physical adapter to serve both client connection and AP roles simultaneously.

6. **Dual firewall backend** — Auto-detection of iptables vs nftables for cross-distribution compatibility.

7. **DNS policy enforcement** — Two-layer approach: PREROUTING redirect for standard DNS, FORWARD DROP for DoH bypass prevention.

8. **Out-of-process watchdog** — Inactivity timeout runs as a separate subprocess, continuing even if the main server is blocked.

9. **ThreadingHTTPServer** — Long-running scripts don't block status polling and other API requests.

10. **Auto-restart on config change** — Both CLI and web dashboard automatically restart the hotspot after configuration updates.

11. **Graceful degradation** — C tools are optional. If not compiled (missing gcc or libnl), bash fallback handles everything. The user experience is identical.

12. **Adaptive hardware support** — C tools detect actual WiFi adapter capabilities (HT, VHT, short GI) and generate hostapd.conf accordingly, preventing common "Failed to set beacon parameters" errors.
