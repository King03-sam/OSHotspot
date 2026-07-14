/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * status.js — fetches /api/status and reflects the hotspot's current
 * state across the topbar, sidebar pills, hero card and stat grid.
 *
 * On error the hero card shows a clear "Connection Error" state
 * instead of staying stuck on "Initializing…".
 */

(function (OS) {
    'use strict';

    /* Track whether we've ever successfully loaded status. */
    var hasLoaded = false;

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
        hasLoaded = true;
        var running = !!data.hostapd;

        /* --- Topbar --- */
        var dot = OS.$('topbarStatusDot');
        var txt = OS.$('topbarStatusText');
        if (running) {
            dot.className = 'status-dot online';
            txt.textContent = 'Online';
        } else {
            dot.className = 'status-dot offline';
            txt.textContent = 'Offline';
        }

        /* --- Sidebar pills --- */
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
            sidebarUptime.textContent = data.hostapd_pid ? ('PID ' + data.hostapd_pid) : '\u2014';
        }

        /* --- Hero card --- */
        var heroCard = OS.$('heroCard');
        heroCard.classList.remove('error');
        heroCard.classList.toggle('online', running);
        OS.$('heroPulse').className = 'hero-pulse';
        OS.$('heroEyebrow').textContent = 'Hotspot Status';
        OS.$('heroTitle').textContent = running ? 'Hotspot Active' : 'Hotspot Inactive';
        OS.$('heroSub').textContent = running
            ? 'Broadcasting \u2014 devices can connect now'
            : 'Click Start to bring up the access point';
        OS.$('heroSsid').textContent = data.ssid || '\u2014';
        OS.$('heroAp').textContent = (data.ap_iface || 'ap0') + ' (' + (data.ap_state || '\u2014') + ')';
        OS.$('heroIp').textContent = data.ap_ip || '\u2014';
        OS.$('heroPid').textContent = data.hostapd_pid || '\u2014';

        /* --- Stat grid --- */
        setStat('hostapd', data.hostapd ? 'RUNNING' : 'STOPPED', data.hostapd);
        setStat('dnsmasq', data.dnsmasq ? 'RUNNING' : 'STOPPED', data.dnsmasq);
        setStat('clients', data.clients || 0, data.clients > 0 ? 'ok' : null);
        setStat('forwarding', data.ip_forward ? 'ENABLED' : 'DISABLED', data.ip_forward);
        setStat('nat', data.nat ? 'ACTIVE' : 'INACTIVE', data.nat);

        /* --- Network info card --- */
        OS.$('infoWifiIface').textContent = data.wifi_iface || '\u2014';
        OS.$('infoApIface').textContent = (data.ap_iface || 'ap0') + ' (' + (data.ap_state || '\u2014') + ')';
        OS.$('infoApIp').textContent = data.ap_ip || '\u2014';
        OS.$('infoSsid').textContent = data.ssid || '\u2014';
        var netInfoBadge = OS.$('netInfoBadge');
        if (netInfoBadge) {
            netInfoBadge.textContent = running ? 'online' : 'offline';
        }
    }

    /**
     * Called when the /api/status request fails entirely (network error,
     * timeout, server not running).  Instead of silently doing nothing
     * we show a clear error state so the user knows what's happening.
     */
    function applyErrorState() {
        var dot = OS.$('topbarStatusDot');
        var txt = OS.$('topbarStatusText');
        if (dot) dot.className = 'status-dot offline';
        if (txt) txt.textContent = 'Unreachable';

        var navPillStatus = OS.$('navPillStatus');
        if (navPillStatus) {
            navPillStatus.textContent = 'error';
            navPillStatus.className = 'nav-pill offline';
        }
        var sidebarHotspotState = OS.$('sidebarHotspotState');
        if (sidebarHotspotState) {
            sidebarHotspotState.textContent = 'Error';
            sidebarHotspotState.className = 'health-mini-value offline';
        }

        /* Only update the hero card on the very first load so we don't
           overwrite a valid "Inactive" state with an error flash. */
        if (!hasLoaded) {
            var heroCard = OS.$('heroCard');
            heroCard.classList.add('error');
            heroCard.classList.remove('online');
            OS.$('heroPulse').className = 'hero-pulse';
            OS.$('heroEyebrow').textContent = 'Connection Error';
            OS.$('heroTitle').textContent = 'Server Unreachable';
            OS.$('heroSub').textContent = 'Make sure the OSHotspot web server is running (sudo oshotspot web)';
        }
    }

    OS.refreshStatus = function () {
        OS.api('/api/status').then(function (data) {
            if (data && data.error) return;
            applyStatus(data);
        }).catch(function () {
            applyErrorState();
        });
    };
})(window.OS);
