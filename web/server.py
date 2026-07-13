#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0
#

# server.py - Lightweight local web dashboard for OSHotspot.

import http.server
import json
import os
import re
import secrets
import signal
import socket
import subprocess
import sys
import time
import urllib.parse

PORT = 8073
HOST = "127.0.0.1"
INACTIVITY_TIMEOUT = 1800  # 30 minutes
SCRIPTS_DIR = "/usr/lib/oshotspot/scripts"
CONFIG_FILE = "/etc/oshotspot/config.conf"
LOG_DIR = "/var/log/oshotspot"
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

VALID_CHANNELS = list(range(1, 14))
VALID_HW_MODES = ("g", "a")

ISO_COUNTRIES = {
    "AD","AE","AF","AG","AI","AL","AM","AN","AO","AQ","AR","AS","AT","AU","AW",
    "AX","AZ","BA","BB","BD","BE","BF","BG","BH","BI","BJ","BM","BN","BO","BR",
    "BS","BT","BW","BY","BZ","CA","CD","CF","CG","CH","CI","CK","CL","CM","CN",
    "CO","CR","CU","CV","CY","CZ","DE","DJ","DK","DM","DO","DZ","EC","EE","EG",
    "ER","ES","ET","FI","FJ","FK","FM","FO","FR","GA","GB","GD","GE","GF","GG",
    "GH","GI","GL","GM","GN","GP","GQ","GR","GT","GU","GW","GY","HK","HN","HR",
    "HT","HU","ID","IE","IL","IM","IN","IO","IQ","IR","IS","IT","JE","JM","JO",
    "JP","KE","KG","KH","KI","KM","KN","KP","KR","KW","KY","KZ","LA","LB","LC",
    "LI","LK","LR","LS","LT","LU","LV","LY","MA","MC","MD","ME","MG","MK","ML",
    "MM","MN","MO","MR","MS","MT","MU","MV","MW","MX","MY","MZ","NA","NC","NE",
    "NF","NG","NI","NL","NO","NP","NR","NZ","OM","PA","PE","PF","PG","PH","PK",
    "PL","PM","PN","PR","PS","PT","PW","PY","QA","RE","RO","RS","RU","RW","SA",
    "SB","SC","SD","SE","SG","SH","SI","SK","SL","SM","SN","SO","SR","SS","ST",
    "SV","SY","SZ","TC","TD","TG","TH","TJ","TK","TL","TM","TN","TO","TR","TT",
    "TV","TW","TZ","UA","UG","US","UY","UZ","VA","VC","VE","VG","VN","VU","WF",
    "WS","YE","YT","ZA","ZM","ZW",
}

last_activity = time.time()
token = None


def log_action(action):
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        log_path = os.path.join(LOG_DIR, "web.log")
        with open(log_path, "a") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {action}\n")
    except Exception:
        pass


def run_script(script_name, timeout=30):
    script = os.path.join(SCRIPTS_DIR, script_name)
    if not os.path.isfile(script):
        return 1, "", "Script not found"
    try:
        result = subprocess.run(
            ["bash", script],
            capture_output=True, text=True, timeout=timeout
        )
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return 1, "", "Script timed out"


def parse_status(output):
    status = {
        "wifi_iface": None,
        "wifi_state": "unknown",
        "ap_iface": "ap0",
        "ap_state": "unknown",
        "ap_ip": None,
        "ssid": None,
        "hostapd": False,
        "hostapd_pid": None,
        "dnsmasq": False,
        "dnsmasq_pid": None,
        "ip_forward": False,
        "nat": False,
        "clients": 0,
    }
    for line in output.splitlines():
        line = line.strip()
        if "WiFi Interface:" in line:
            if "NOT FOUND" in line:
                status["wifi_state"] = "missing"
            else:
                parts = line.split()
                for p in parts:
                    if p and not p.endswith(":") and "Interface" not in p:
                        status["wifi_iface"] = p.rstrip(":")
                        status["wifi_state"] = "ok"
                        break
        elif "AP Interface" in line:
            if "NOT CREATED" in line:
                status["ap_state"] = "missing"
            elif "DOWN" in line:
                status["ap_state"] = "down"
            else:
                status["ap_state"] = "up"
                m = re.search(r'\(([^)]+)\)', line)
                if m and m.group(1) != "ap0":
                    ip_val = m.group(1)
                    if re.match(r'\d+\.\d+\.\d+\.\d+', ip_val):
                        status["ap_ip"] = ip_val
        elif "SSID:" in line:
            parts = line.split(":", 1)
            if len(parts) == 2:
                status["ssid"] = parts[1].strip()
        elif "hostapd:" in line.lower() and "RUNNING" in line:
            status["hostapd"] = True
            m = re.search(r'PID\s+(\d+)', line)
            if m:
                status["hostapd_pid"] = int(m.group(1))
        elif "dnsmasq" in line.lower() and "RUNNING" in line:
            status["dnsmasq"] = True
            m = re.search(r'PID\s+(\d+)', line)
            if m:
                status["dnsmasq_pid"] = int(m.group(1))
        elif "IP Forwarding:" in line:
            status["ip_forward"] = "ENABLED" in line
        elif "NAT" in line or "MASQUERADE" in line:
            status["nat"] = "ACTIVE" in line
    return status


def parse_clients(output):
    clients = []
    lines = output.splitlines()
    for line in lines:
        line = line.strip()
        m = re.match(
            r'([0-9a-fA-F:]{17})\s+'
            r'(\d+\.\d+\.\d+\.\d+)\s+'
            r'(\S+|-|\*)\s+'
            r'(\S+)',
            line
        )
        if m:
            hostname = m.group(3)
            if hostname in ("*", "-"):
                hostname = ""
            clients.append({
                "mac": m.group(1),
                "ip": m.group(2),
                "hostname": hostname,
                "status": m.group(4),
            })
    return clients


def parse_doctor(output):
    checks = []
    for line in output.splitlines():
        line = line.strip()
        m = re.match(r'\[(OK|WARN|FAIL)\]\s+(.*)', line)
        if m:
            checks.append({"status": m.group(1).lower(), "message": m.group(2)})
    return checks


def parse_config():
    config = {}
    if not os.path.isfile(CONFIG_FILE):
        return config
    with open(CONFIG_FILE) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            m = re.match(r'^([A-Z_]+)\s*=\s*"?([^"]*)"?$', line)
            if m:
                config[m.group(1)] = m.group(2)
    return config


def escape_config_value(val):
    val = val.replace("\\", "\\\\")
    val = val.replace('"', '\\"')
    return val


def write_config(updates):
    lines = []
    seen_keys = set()
    if os.path.isfile(CONFIG_FILE):
        with open(CONFIG_FILE) as f:
            for line in f:
                stripped = line.strip()
                m = re.match(r'^([A-Z_]+)\s*=', stripped)
                if m and m.group(1) in updates:
                    key = m.group(1)
                    val = updates[key]
                    if val is None:
                        lines.append(f'{key}=""\n')
                    else:
                        lines.append(f'{key}="{escape_config_value(val)}"\n')
                    seen_keys.add(key)
                else:
                    lines.append(line)
    for key, val in updates.items():
        if key not in seen_keys:
            if val is None:
                lines.append(f'{key}=""\n')
            else:
                lines.append(f'{key}="{escape_config_value(val)}"\n')
    with open(CONFIG_FILE, "w") as f:
        f.writelines(lines)


def generate_qr_png():
    config = parse_config()
    ssid = config.get("SSID", "")
    password = config.get("PASSWORD", "")
    if not ssid or not password:
        return None
    wifi_string = f"WIFI:T:WPA;S:{ssid};P:{password};;"
    try:
        result = subprocess.run(
            ["qrencode", "-o", "-", "--type", "PNG", "--size", "8", wifi_string],
            capture_output=True, timeout=10
        )
        if result.returncode == 0 and result.stdout:
            return result.stdout
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return None


def validate_config_update(data):
    errors = []
    validated = {}

    if "ssid" in data:
        ssid = data["ssid"]
        if not isinstance(ssid, str) or len(ssid) < 1 or len(ssid) > 32:
            errors.append("SSID must be 1-32 characters.")
        elif any(ord(c) < 32 for c in ssid):
            errors.append("SSID contains invalid control characters.")
        else:
            validated["SSID"] = ssid

    if "password" in data:
        pw = data["password"]
        if not isinstance(pw, str) or len(pw) < 8:
            errors.append("Password must be at least 8 characters.")
        else:
            validated["PASSWORD"] = pw

    if "channel" in data:
        try:
            ch = int(data["channel"])
            if ch not in VALID_CHANNELS:
                errors.append(f"Channel must be one of: {', '.join(str(c) for c in VALID_CHANNELS)}.")
            else:
                validated["CHANNEL"] = str(ch)
        except (ValueError, TypeError):
            errors.append("Channel must be an integer.")

    if "hw_mode" in data:
        mode = data["hw_mode"]
        if mode not in VALID_HW_MODES:
            errors.append(f"Hardware mode must be one of: {', '.join(VALID_HW_MODES)}.")
        else:
            validated["HW_MODE"] = mode

    if "country_code" in data:
        cc = data["country_code"].upper()
        if not re.match(r'^[A-Z]{2}$', cc):
            errors.append("Country code must be exactly 2 uppercase letters.")
        elif cc not in ISO_COUNTRIES:
            errors.append(f"'{cc}' is not a valid ISO 3166-1 alpha-2 country code.")
        else:
            validated["COUNTRY_CODE"] = cc

    return validated, errors


class OShotspotHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send_security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")

    def check_token(self):
        global token
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        auth_token = params.get("token", [None])[0]
        if not auth_token:
            auth_header = self.headers.get("Authorization", "")
            if auth_header.startswith("Bearer "):
                auth_token = auth_header[7:]
        if auth_token and secrets.compare_digest(auth_token, token):
            return True
        self.send_response(401)
        self.send_header("Content-Type", "application/json")
        self.send_security_headers()
        self.end_headers()
        self.wfile.write(json.dumps({"error": "Unauthorized"}).encode())
        return False

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_security_headers()
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def send_html_file(self, path):
        if not os.path.isfile(path):
            self.send_response(404)
            self.end_headers()
            return
        ext = os.path.splitext(path)[1]
        content_types = {
            ".html": "text/html",
            ".css": "text/css",
            ".js": "application/javascript",
        }
        ct = content_types.get(ext, "application/octet-stream")
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(body)))
        self.send_security_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        global last_activity, token
        last_activity = time.time()
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/":
            params = urllib.parse.parse_qs(parsed.query)
            req_token = params.get("token", [None])[0]
            if not req_token or not secrets.compare_digest(req_token, token):
                self.send_response(403)
                self.send_header("Content-Type", "text/plain")
                self.send_security_headers()
                self.end_headers()
                self.wfile.write(b"Access denied: invalid or missing token.")
                return
            self.send_html_file(os.path.join(STATIC_DIR, "index.html"))
        elif path == "/style.css":
            self.send_html_file(os.path.join(STATIC_DIR, "style.css"))
        elif path == "/app.js":
            self.send_html_file(os.path.join(STATIC_DIR, "app.js"))
        elif path == "/api/status":
            if not self.check_token():
                return
            code, stdout, _ = run_script("status.sh")
            data = parse_status(stdout) if code == 0 else {"error": stdout}
            # GET ACCURATE CLIENT COUNT FROM clients.sh INSTEAD OF TRUSTING status.sh
            clients_code, clients_stdout, _ = run_script("clients.sh")
            if clients_code == 0:
                clients_list = parse_clients(clients_stdout)
                data["clients"] = len(clients_list)  # Override with accurate count from DHCP leases
            self.send_json(data)
        elif path == "/api/clients":
            if not self.check_token():
                return
            code, stdout, _ = run_script("clients.sh")
            clients = parse_clients(stdout) if code == 0 else []
            self.send_json(clients)
        elif path == "/api/config":
            if not self.check_token():
                return
            config = parse_config()
            response = {}
            for k, v in config.items():
                if k == "PASSWORD":
                    response["password_set"] = bool(v)
                else:
                    response[k.lower()] = v
            self.send_json(response)
        elif path == "/api/qr":
            if not self.check_token():
                return
            png_data = generate_qr_png()
            if png_data:
                import base64
                b64 = base64.b64encode(png_data).decode()
                self.send_json({"image": f"data:image/png;base64,{b64}"})
            else:
                self.send_json({"error": "Could not generate QR code"}, 500)
        elif path == "/api/doctor":
            if not self.check_token():
                return
            code, stdout, _ = run_script("doctor.sh")
            checks = parse_doctor(stdout) if code == 0 else []
            self.send_json(checks)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        global last_activity, token
        last_activity = time.time()
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if not self.check_token():
            return

        if path == "/api/start":
            code, stdout, stderr = run_script("start.sh")
            log_action("web:start")
            self.send_json({"ok": code == 0, "output": stdout, "error": stderr}, 200 if code == 0 else 500)
        elif path == "/api/stop":
            code, stdout, stderr = run_script("stop.sh")
            log_action("web:stop")
            self.send_json({"ok": code == 0, "output": stdout, "error": stderr}, 200 if code == 0 else 500)
        elif path == "/api/restart":
            run_script("stop.sh")
            code, stdout, stderr = run_script("start.sh")
            log_action("web:restart")
            self.send_json({"ok": code == 0, "output": stdout, "error": stderr}, 200 if code == 0 else 500)
        elif path == "/api/config":
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length > 4096:
                self.send_json({"error": "Request too large"}, 413)
                return
            body = self.rfile.read(content_length)
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                self.send_json({"error": "Invalid JSON"}, 400)
                return

            validated, errors = validate_config_update(data)
            if errors:
                self.send_json({"errors": errors}, 400)
                return
            if not validated:
                self.send_json({"error": "No valid fields to update"}, 400)
                return

            write_config(validated)
            log_action(f"web:config:{list(validated.keys())}")
            
            # Add debug logging (without password) for troubleshooting
            log_action(f"web:config_updated:{','.join(k for k in validated.keys() if k != 'PASSWORD')}")

            is_running = os.path.isfile("/run/oshotspot-hostapd.pid")
            if is_running:
                run_script("stop.sh")
                time.sleep(1)  # Ensure clean shutdown
                run_script("start.sh")

            self.send_json({"ok": True, "updated": list(validated.keys())})
        else:
            self.send_json({"error": "Not found"}, 404)


def find_free_port(preferred):
    if preferred:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((HOST, preferred))
            s.close()
            return preferred
        except OSError:
            pass
    for port in range(8073, 8173):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((HOST, port))
            s.close()
            return port
        except OSError:
            continue
    print("Error: no free port found", file=sys.stderr)
    sys.exit(1)


def inactivity_watchdog():
    while True:
        time.sleep(60)
        if time.time() - last_activity > INACTIVITY_TIMEOUT:
            print(f"\nInactivity timeout ({INACTIVITY_TIMEOUT}s). Shutting down.")
            os._exit(0)


def main():
    global token, last_activity

    token = secrets.token_hex(32)

    if os.geteuid() != 0:
        print("Warning: not running as root. Hotspot scripts may fail.", file=sys.stderr)

    port = find_free_port(PORT)
    last_activity = time.time()

    watchdog = subprocess.Popen(
        ["python3", "-c", f"""
import time, os
timeout = {INACTIVITY_TIMEOUT}
while True:
    time.sleep(60)
    if os.path.getmtime('/proc/self/stat') and time.time() - {time.time()} > timeout:
        print(f'Inactivity timeout ({{timeout}}s). Shutting down.')
        os._exit(0)
"""],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )

    server = http.server.HTTPServer((HOST, port), OShotspotHandler)
    server.timeout = 1

    url = f"http://{HOST}:{port}/?token={token}"

    print(f"\n  OSHotspot Web Dashboard")
    print(f"  Listening on {url}\n")

    opened = False
    for cmd in (["xdg-open", url], ["open", url]):
        try:
            subprocess.Popen(
                cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
            opened = True
            break
        except FileNotFoundError:
            continue

    if not opened:
        print(f"  Open this URL in your browser:\n")
        print(f"  {url}\n")

    print("  Press Ctrl+C to stop.\n")

    def shutdown_handler(sig, frame):
        print("\nShutting down...")
        try:
            watchdog.kill()
        except Exception:
            pass
        server.server_close()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown_handler)
    signal.signal(signal.SIGTERM, shutdown_handler)

    try:
        while True:
            server.handle_request()
            if time.time() - last_activity > INACTIVITY_TIMEOUT:
                break
    except KeyboardInterrupt:
        pass
    finally:
        try:
            watchdog.kill()
        except Exception:
            pass
        server.server_close()
        print("Dashboard stopped.")


if __name__ == "__main__":
    main()