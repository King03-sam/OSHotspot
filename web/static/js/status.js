/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * status.js — fetches /api/status and reflects the hotspot's current
 * state across the topbar, sidebar pills, hero card and stat grid.
 */

(function (OS) {
    'use strict';

    function setStat(name, value, state) {
        var valEl = OS.$('val' + OS.capitalize(name));
        var pillEl = OS.$('pill' + OS.capitalize(name));
        if (valEl) valEl.textContent = value;
        if (pillEl) {
            pillEl.className = 'stat-pill';
            if (state === true) pillEl.classList.add('ok');
            else if (state === false) pillEl.classList.add('fail');
            else if (state === 'ok') pillEl.classList.add('ok');
        }
    }

    function applyStatus(data) {
        var running = !!data.hostapd;

        var dot = OS.$('topbarStatusDot');
        var txt = OS.$('topbarStatusText');
        if (running) {
            dot.className = 'status-dot online';
            txt.textContent = 'Online';
        } else {
            dot.className = 'status-dot offline';
            txt.textContent = 'Offline';
        }

        var navPillStatus = OS.$('navPillStatus');
        if (navPillStatus) {
            navPillStatus.textContent = running ? 'online' : 'offline';
            navPillStatus.className = 'nav-pill ' + (running ? 'online' : 'offline');
        }
        var sidebarHotspotState = OS.$('sidebarHotspotState');
        if (sidebarHotspotState) {
            sidebarHotspotState.textContent = running ? 'Online' : 'Offline';
            sidebarHotspotState.className = 'health-mini-value ' + (running ? 'online' : 'offline');
        }
        var sidebarUptime = OS.$('sidebarUptime');
        if (sidebarUptime) {
            sidebarUptime.textContent = data.hostapd_pid ? ('PID ' + data.hostapd_pid) : '—';
        }

        var heroCard = OS.$('heroCard');
        heroCard.classList.toggle('online', running);
        OS.$('heroPulse').className = 'hero-pulse';
        OS.$('heroEyebrow').textContent = 'Hotspot Status';
        OS.$('heroTitle').textContent = running ? 'Hotspot Active' : 'Hotspot Inactive';
        OS.$('heroSub').textContent = running
            ? 'Broadcasting — devices can connect now'
            : 'Click Start to bring up the access point';
        OS.$('heroSsid').textContent = data.ssid || '—';
        OS.$('heroAp').textContent = (data.ap_iface || 'ap0') + ' (' + (data.ap_state || '—') + ')';
        OS.$('heroIp').textContent = data.ap_ip || '—';
        OS.$('heroPid').textContent = data.hostapd_pid || '—';

        setStat('hostapd', data.hostapd ? 'RUNNING' : 'STOPPED', data.hostapd);
        setStat('dnsmasq', data.dnsmasq ? 'RUNNING' : 'STOPPED', data.dnsmasq);
        setStat('clients', data.clients || 0, data.clients > 0 ? 'ok' : null);
        setStat('forwarding', data.ip_forward ? 'ENABLED' : 'DISABLED', data.ip_forward);
        setStat('nat', data.nat ? 'ACTIVE' : 'INACTIVE', data.nat);

        OS.$('infoWifiIface').textContent = data.wifi_iface || '—';
        OS.$('infoApIface').textContent = (data.ap_iface || 'ap0') + ' (' + (data.ap_state || '—') + ')';
        OS.$('infoApIp').textContent = data.ap_ip || '—';
        OS.$('infoSsid').textContent = data.ssid || '—';
        var netInfoBadge = OS.$('netInfoBadge');
        if (netInfoBadge) {
            netInfoBadge.textContent = running ? 'online' : 'offline';
        }
    }

    OS.refreshStatus = function () {
        OS.api('/api/status').then(function (data) {
            if (data.error) return;
            applyStatus(data);
        }).catch(function () {});
    };
})(window.OS);
