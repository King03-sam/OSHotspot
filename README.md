# OSHotspot

<p align="center">
  <b>Automatic WiFi Hotspot Manager for Linux</b><br>
  Share your computer's WiFi Internet connection with any device, even when NetworkManager hotspot fails.
</p>

---

## About OSHotspot

OSHotspot is a lightweight Linux automation tool designed to create a working WiFi hotspot using native networking tools:

- `hostapd` → WiFi Access Point management
- `dnsmasq` → Dedicated DHCP and DNS service
- `iptables` → Internet connection sharing (NAT)
- `iw` → Virtual WiFi interface management

This project was created after facing a real Linux networking limitation where the default Ubuntu hotspot feature could not share an active WiFi connection correctly.

OSHotspot provides a reliable alternative by creating a virtual Access Point interface (`ap0`) and routing Internet traffic through the existing WiFi connection, without disabling NetworkManager.

---

## Creator

OSHotspot was created and is maintained by **OLOJEDE Samuel**.

The project was developed to provide an automated and reliable WiFi hotspot solution for Linux systems using native networking tools.

---

# Features

- Automatic WiFi hotspot creation with one command
- Internet sharing from an existing WiFi connection
- Works alongside NetworkManager (never disables it)
- Dedicated dnsmasq instance (no conflicts with Docker, LXC, or libvirt)
- Virtual AP interface (`ap0`) created via `iw` and `nl80211`
- Automatic iptables NAT and forwarding rules
- 802.11n support for better device compatibility
- Suspend/resume auto-repair
- Simple CLI: `oshotspot start / stop / status / repair / clients / monitor / qr`
- Change SSID or password instantly with `set ssid` / `set password`
- Real-time monitoring of connected clients and traffic
- QR code display to share hotspot with phones instantly
- Bash tab completion for the CLI
- Supports Ubuntu, Debian, Mint, Fedora, Arch, and more

---

# How it works

OSHotspot creates a virtual WiFi access point on the same adapter that provides your Internet connection. Your computer acts as a router between the two networks.

```
              Internet
                 |
                 |
          Existing WiFi
           wlp2s0
                 |
           Linux Laptop
            (router)
                 |
          Virtual AP Interface
               ap0
           192.168.50.1
                 |
            Smartphone
         192.168.50.x
```

Traffic flow:

```
  Phone (192.168.50.x)
       |
       | WiFi
       |
     ap0
       |
  iptables NAT (MASQUERADE)
       |
     wlp2s0
       |
       | WiFi
       |
  Internet Router
       |
     Internet
```

OSHotspot does NOT disable NetworkManager. Your laptop keeps its original WiFi connection and simultaneously broadcasts a second network through `ap0`.

---

# Requirements

## Hardware

Your wireless adapter must support **AP mode**.

Check with:

```bash
iw list
```

Look for:

```
Supported interface modes:
        * AP
```

Example supported hardware:

- Intel Wireless 7265
- Intel AX200 / AX210
- Many modern Linux-compatible WiFi adapters

## Software

Required packages:

```bash
sudo apt install hostapd dnsmasq iw iptables iproute2 qrencode
```

---

# Installation

One-liner install:

```bash
curl -fsSL https://raw.githubusercontent.com/King03-sam/OSHotspot/main/install.sh | sudo bash
```

Or clone and install manually:

```bash
git clone https://github.com/King03-sam/OSHotspot.git
cd OSHotspot
chmod +x install.sh oshotspot
sudo ./install.sh
```

The installer will:

1. Install `hostapd`, `dnsmasq`, `iw`, `iptables`, `iproute2`, `qrencode`
2. Create configuration directory at `/etc/oshotspot/`
3. Install the `oshotspot` CLI to `/usr/local/bin/`
4. Set up systemd services and suspend/resume hooks

---

# Configuration

Edit the configuration file:

```bash
sudo nano /etc/oshotspot/config.conf
```

Or use the CLI:

```bash
sudo oshotspot set ssid MyWiFi
sudo oshotspot set password MySecretPassword
```

When the hotspot is running, changes are applied automatically (hotspot restarts).

### Configuration Options

| Key | Default | Description |
|-----|---------|-------------|
| `SSID` | `OSHotspot` | WiFi network name (1-32 characters) |
| `PASSWORD` | `ChangeMe123` | WiFi password (minimum 8 characters, WPA2) |
| `CHANNEL` | `6` | WiFi channel (1-13) |
| `HW_MODE` | `g` | Hardware mode (`g` for 2.4GHz, `a` for 5GHz) |
| `COUNTRY_CODE` | `FR` | Country code (FR, US, GB...) - required by some drivers |
| `WIFI_IFACE` | *(auto-detected)* | Your internet WiFi interface |
| `AP_IP` | `192.168.50.1` | Hotspot gateway IP |
| `DHCP_RANGE_START` | `192.168.50.10` | DHCP range start |
| `DHCP_RANGE_END` | `192.168.50.100` | DHCP range end |
| `DNS_PRIMARY` | `8.8.8.8` | Primary DNS server |
| `DNS_SECONDARY` | `1.1.1.1` | Secondary DNS server |

---

# Start Hotspot

```bash
sudo oshotspot start
```

Your phone should see:

```
OSHotspot
```

Connect using the configured password.

# Stop Hotspot

```bash
sudo oshotspot stop
```

# Check Status

```bash
sudo oshotspot status
```

Displays: WiFi interface, AP status, hostapd status, dnsmasq status, IP forwarding, NAT rules, and connected clients.

# Show Connected Clients

```bash
sudo oshotspot clients
```

Displays a list of all devices connected to the hotspot with their MAC address, IP address, hostname, and connection status.

# Real-time Monitoring

```bash
sudo oshotspot monitor
```

Live monitoring view that refreshes every 3 seconds showing:

- Connected clients with MAC, IP, hostname
- AP interface traffic (RX/TX bytes and speed)
- hostapd and dnsmasq status

Press `Ctrl+C` to quit.

# Repair Hotspot

After suspend, resume, or driver issues:

```bash
sudo oshotspot repair
```

This will stop broken components, wait for the WiFi interface to reappear, recreate the AP interface, and restart everything.

# Restart Hotspot

```bash
sudo oshotspot restart
```

# Show QR Code

```bash
sudo oshotspot qr
```

Displays a QR code in the terminal that your phone can scan to connect to the hotspot instantly. No need to type the password manually.

---

# Systemd

After installation, you can also manage the hotspot with systemd:

```bash
sudo systemctl start oshotspot
sudo systemctl stop oshotspot
sudo systemctl status oshotspot
```

A suspend/resume hook is automatically installed so the hotspot repairs itself after the laptop wakes up.

---

# Bash Completion

Tab completion is installed automatically. After installation, press `<TAB>` to auto-complete commands:

```bash
sudo oshotspot <TAB>
# start  stop  restart  repair  status  clients  monitor  config  qr  set  help

sudo oshotspot set <TAB>
# ssid  password
```

If completion doesn't work immediately, run:

```bash
source /etc/bash_completion.d/oshotspot
```

---

# Uninstallation

```bash
sudo ./uninstall.sh
```

Or manually:

```bash
sudo oshotspot stop
sudo rm /usr/local/bin/oshotspot
sudo rm -rf /usr/lib/oshotspot
sudo rm -f /etc/sysctl.d/oshotspot.conf
sudo rm -f /etc/systemd/system/oshotspot*.service
sudo systemctl daemon-reload
sudo rm -rf /etc/oshotspot
sudo rm -rf /var/log/oshotspot
```

---

# Troubleshooting

## Phone connects but no Internet

Check IP forwarding:

```bash
cat /proc/sys/net/ipv4/ip_forward
```

Expected:

```
net.ipv4.ip_forward = 1
```

Check iptables rules:

```bash
sudo iptables -L FORWARD -v
sudo iptables -t nat -L POSTROUTING -v
```

Verify the WiFi interface has internet access:

```bash
ping -I wlp2s0 8.8.8.8
```

## DHCP stuck on "Obtaining IP address"

Check if dnsmasq is running:

```bash
sudo oshotspot status
```

Check for conflicting services on port 67:

```bash
sudo ss -lunp | grep :67
```

If another dnsmasq instance is blocking:

```bash
sudo oshotspot restart
```

## hostapd errors

Check the log:

```bash
sudo cat /var/log/oshotspot/hostapd.log
```

Common causes:

- Another hostapd instance is already running
- The AP interface was not created
- The WiFi adapter does not support the configured mode

## dnsmasq conflicts with existing services

OSHotspot runs its **own dedicated dnsmasq instance** that only serves the `ap0` interface. It does **not** use `systemctl restart dnsmasq` and will not interfere with:

- libvirt / LXC dnsmasq
- Docker's built-in DNS
- NetworkManager's DNS

## Interface ap0 fails to create

Check your driver supports virtual interfaces:

```bash
iw phy phy0 info
```

Try deleting the interface first:

```bash
sudo iw dev ap0 del
sudo oshotspot start
```

Some drivers need the WiFi to be disconnected first:

```bash
sudo nmcli device disconnect wlp2s0
sudo oshotspot start
```

## Suspend / resume problems

After resuming from sleep:

```bash
sudo oshotspot repair
```

This will:

1. Stop any broken components
2. Wait for the WiFi interface to reappear
3. Recreate the AP interface
4. Restart hostapd, dnsmasq, and firewall rules

## No WiFi interface found

Your adapter may not be detected:

```bash
iwconfig
ip link
sudo systemctl restart NetworkManager
```

## Adapter does not support AP mode

```bash
iw phy phy0 info | grep -A 10 "Supported interface modes"
```

Look for `AP` in the output. If missing, you need a different adapter or driver.

## Phone connects then disconnects after a few seconds

This is usually caused by missing 802.11n settings or country code.

Check your hostapd config:

```bash
sudo cat /etc/oshotspot/hostapd.conf
```

Make sure these lines are present:

```
country_code=FR
ieee80211n=1
ht_capab=[HT20][SHORT-GI-20]
```

Change `FR` to your country code. Then restart:

```bash
sudo oshotspot stop
sudo oshotspot start
```

## Hostname does not change

The hostname is configured in `/etc/oshotspot/config.conf` via the `HOSTNAME` field. It does not change the system hostname automatically.

---

# Why not NetworkManager hotspot?

Ubuntu NetworkManager hotspot works for many users, but some WiFi adapters or drivers have limitations when:

- The laptop receives Internet through WiFi
- The same adapter must create another WiFi network
- Virtual AP interfaces are required

OSHotspot uses a lower-level approach with `hostapd`, `dnsmasq`, and `iptables` to bypass these limitations, while keeping NetworkManager running for the original connection.

---

# Supported distributions

Tested on:

- Ubuntu 18.04+
- Debian 10+
- Linux Mint
- Fedora
- Arch Linux

Any distribution with `hostapd`, `dnsmasq`, `iw`, and `iptables` should work.

---

# Project structure

```
OSHotspot/
├── README.md
├── LICENSE
├── install.sh
├── uninstall.sh
├── oshotspot                    # Main CLI
├── config.conf.example          # Configuration template
├── scripts/
│   ├── utils.sh                 # Shared functions
│   ├── firewall.sh              # iptables NAT management
│   ├── start.sh                 # Start hotspot
│   ├── stop.sh                  # Stop hotspot
│   ├── repair.sh                # Repair after suspend
│   ├── status.sh                # Status display
│   ├── clients.sh               # Show connected clients
│   ├── monitor.sh               # Real-time monitoring
│   └── qr.sh                    # QR code display
├── configs/
│   ├── hostapd.conf.template    # hostapd config template
│   ├── dnsmasq.conf.template    # dnsmasq config template
│   └── nm-oshotspot.conf        # NetworkManager ignore ap0
├── completions/
│   └── oshotspot                # Bash tab completion
└── systemd/
    ├── oshotspot.service        # Main systemd unit
    └── oshotspot-dnsmasq.service
```

---

# Roadmap

Future improvements:

- Automatic driver compatibility check
- GUI interface
- Multi-language support
- 5GHz channel support with auto-detection
- Client bandwidth limiting
- Web-based configuration panel

---

# License

Copyright 2026 OLOJEDE Samuel

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at:

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

See the [LICENSE](LICENSE) file for the full license text.

---

# Acknowledgments

Thanks to the Linux networking community and open-source projects:

- [hostapd](https://w1.fi/hostapd/)
- [dnsmasq](https://thekelleys.org.uk/dnsmasq/doc.html)
- [iw](https://wireless.kernel.org/en/users/Documentation/iw)
- [iptables](https://www.netfilter.org/)

Made with Linux and passion by **OLOJEDE Samuel**
