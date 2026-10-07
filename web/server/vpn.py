#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

"""Tailscale VPN manager — status, start, stop."""

import json
import re
import subprocess
import time


class VPNManager:
    """Manage Tailscale VPN for remote dashboard access."""

    def __init__(self):
        self._cache = {}
        self._cache_ts = 0

    def status(self):
        """Return Tailscale status: running, IP, auth URL."""
        now = time.time()
        if self._cache and (now - self._cache_ts) < 3:
            return self._cache

        result = {
            "installed": False,
            "running": False,
            "needs_login": False,
            "tailscale_ip": None,
            "hostname": None,
            "dashboard_url": None,
            "auth_url": None,
        }

        # Check if tailscale is installed
        try:
            check = subprocess.run(
                ["which", "tailscale"],
                capture_output=True, text=True, timeout=5,
            )
            if check.returncode != 0:
                self._cache = result
                self._cache_ts = now
                return result
            result["installed"] = True
        except Exception:
            self._cache = result
            self._cache_ts = now
            return result

        # Get status as JSON
        try:
            proc = subprocess.run(
                ["tailscale", "status", "--json"],
                capture_output=True, text=True, timeout=10,
            )
            if proc.returncode != 0:
                self._cache = result
                self._cache_ts = now
                return result

            data = json.loads(proc.stdout)
            backend = data.get("BackendState", "")

            if backend == "Running":
                result["running"] = True
            elif backend == "NeedsLogin":
                result["needs_login"] = True
                # Capture auth URL from status
                auth_url = data.get("AuthURL", "")
                if auth_url:
                    result["auth_url"] = auth_url
                else:
                    # Try to get auth URL via tailscale up --timeout
                    result["auth_url"] = self._get_auth_url()

            if not result["running"]:
                self._cache = result
                self._cache_ts = now
                return result

            # Self info
            self_info = data.get("Self", {})
            tailscale_ips = self_info.get("TailscaleIPs", [])
            result["tailscale_ip"] = tailscale_ips[0] if tailscale_ips else None
            result["hostname"] = self_info.get("HostName", "unknown")

            if result["tailscale_ip"]:
                result["dashboard_url"] = "http://{}:8073".format(
                    result["tailscale_ip"]
                )

        except Exception:
            pass

        self._cache = result
        self._cache_ts = now
        return result

    def start(self):
        """Start Tailscale and return auth URL if needed."""
        result = {"ok": False, "auth_url": None, "error": None}

        try:
            proc = subprocess.run(
                ["tailscale", "up", "--timeout=30s"],
                capture_output=True, text=True, timeout=45,
            )
            output = proc.stdout + proc.stderr

            if proc.returncode == 0:
                result["ok"] = True
                return result

            # Check if it needs login
            auth_url = self._extract_auth_url(output)
            if auth_url:
                result["auth_url"] = auth_url
                result["error"] = "Authentication required. Open the URL to login."
            else:
                result["error"] = output.strip() or "tailscale up failed"

        except subprocess.TimeoutExpired:
            result["error"] = "Tailscale start timed out. Try: sudo tailscale up"
        except Exception as e:
            result["error"] = str(e)

        return result

    def stop(self):
        """Stop Tailscale."""
        try:
            proc = subprocess.run(
                ["tailscale", "down"],
                capture_output=True, text=True, timeout=10,
            )
            return proc.returncode == 0
        except Exception:
            return False

    def restart(self):
        """Restart Tailscale (down then up)."""
        self.stop()
        time.sleep(1)
        return self.start()

    def _get_auth_url(self):
        """Get auth URL by running tailscale up with short timeout."""
        try:
            proc = subprocess.run(
                ["tailscale", "up", "--timeout=5s"],
                capture_output=True, text=True, timeout=15,
            )
            output = proc.stdout + proc.stderr
            return self._extract_auth_url(output)
        except Exception:
            return None

    def _extract_auth_url(self, text):
        """Extract Tailscale auth URL from output."""
        for line in text.split("\n"):
            # Match https://login.tailscale.com/... or similar
            match = re.search(r'(https?://\S*tailscale\S*)', line)
            if match:
                return match.group(1)
        return None


# Singleton
vpn = VPNManager()
