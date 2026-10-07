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

    OS.renderOverview = function () {
        document.getElementById('content').insertAdjacentHTML('beforeend',
            '<section class="view active" id="view-overview">'
            + '<div class="hero-card" id="heroCard">'
            +     '<div class="hero-left">'
            +         '<div class="hero-eyebrow">'
            +             '<span class="hero-pulse" id="heroPulse"></span>'
            +             '<span id="heroEyebrow">Hotspot Status</span>'
            +         '</div>'
            +         '<div class="hero-title" id="heroTitle">Initializing\u2026</div>'
            +         '<div class="hero-sub" id="heroSub">Reading system state</div>'
            +             '<div class="hero-meta">'
            +                 '<div class="hero-meta-item"><span class="hero-meta-label">SSID</span><span class="hero-meta-value mono" id="heroSsid">\u2014</span></div>'
            +                 '<div class="hero-meta-item"><span class="hero-meta-label">AP Interface</span><span class="hero-meta-value mono" id="heroAp">\u2014</span></div>'
            +                 '<div class="hero-meta-item"><span class="hero-meta-label">Gateway IP</span><span class="hero-meta-value mono" id="heroIp">\u2014</span></div>'
            +                 '<div class="hero-meta-item"><span class="hero-meta-label">PID</span><span class="hero-meta-value mono" id="heroPid">\u2014</span></div>'
            +                 '<div class="hero-meta-item"><span class="hero-meta-label">Admin</span><span class="hero-meta-value mono" id="heroAdminName">\u2014</span></div>'
            +                 '<div class="hero-meta-item"><span class="hero-meta-label">Role</span><span class="hero-meta-value mono" id="heroAdminRole">\u2014</span></div>'
            +             '</div>'
            +     '</div>'
            +     '<div class="hero-right">'
            +         '<div class="hero-actions">'
            +             '<button class="btn btn-primary" id="btnStart" onclick="doAction(\'start\')">'
            +                 '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
            +                 ' Start'
            +             '</button>'
            +             '<button class="btn btn-danger" id="btnStop" onclick="doAction(\'stop\')">'
            +                 '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>'
            +                 ' Stop'
            +             '</button>'
            +             '<button class="btn btn-ghost" id="btnRestart" onclick="doAction(\'restart\')">'
            +                 '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>'
            +                 ' Restart'
            +             '</button>'
            +         '</div>'
            +     '</div>'
            + '</div>'
            + '<div class="stat-grid" id="statGrid">'
            +     '<article class="stat-card" data-stat="hostapd">'
            +         '<div class="stat-card-head">'
            +             '<div class="stat-icon hostapd"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg></div>'
            +             '<span class="stat-name">hostapd</span>'
            +             '<span class="stat-pill" id="pillHostapd">\u2014</span>'
            +         '</div>'
            +         '<div class="stat-value" id="valHostapd">\u2014</div>'
            +         '<div class="stat-meta" id="metaHostapd">Access Point daemon</div>'
            +     '</article>'
            +     '<article class="stat-card" data-stat="dnsmasq">'
            +         '<div class="stat-card-head">'
            +             '<div class="stat-icon dnsmasq"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></div>'
            +             '<span class="stat-name">dnsmasq</span>'
            +             '<span class="stat-pill" id="pillDnsmasq">\u2014</span>'
            +         '</div>'
            +         '<div class="stat-value" id="valDnsmasq">\u2014</div>'
            +         '<div class="stat-meta" id="metaDnsmasq">DHCP &amp; DNS server</div>'
            +     '</article>'
            +     '<article class="stat-card" data-stat="clients">'
            +         '<div class="stat-card-head">'
            +             '<div class="stat-icon clients"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div>'
            +             '<span class="stat-name">Clients</span>'
            +         '</div>'
            +         '<div class="stat-value" id="valClients">0</div>'
            +         '<div class="stat-meta">Devices connected</div>'
            +     '</article>'
            +     '<article class="stat-card" data-stat="forwarding">'
            +         '<div class="stat-card-head">'
            +             '<div class="stat-icon forwarding"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg></div>'
            +             '<span class="stat-name">IP Forwarding</span>'
            +             '<span class="stat-pill" id="pillForwarding">\u2014</span>'
            +         '</div>'
            +         '<div class="stat-value" id="valForwarding">\u2014</div>'
            +         '<div class="stat-meta">IPv4 packet routing</div>'
            +     '</article>'
            +     '<article class="stat-card" data-stat="nat">'
            +         '<div class="stat-card-head">'
            +             '<div class="stat-icon nat"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg></div>'
            +             '<span class="stat-name">NAT / Masquerade</span>'
            +             '<span class="stat-pill" id="pillNat">\u2014</span>'
            +         '</div>'
            +         '<div class="stat-value" id="valNat">\u2014</div>'
            +         '<div class="stat-meta">iptables MASQUERADE rules</div>'
            +     '</article>'
            +     '<article class="stat-card" data-stat="traffic">'
            +         '<div class="stat-card-head">'
            +             '<div class="stat-icon traffic"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg></div>'
            +             '<span class="stat-name">AP Traffic</span>'
            +             '<span class="stat-pill" id="pillTraffic">live</span>'
            +         '</div>'
            +         '<div class="stat-value mono" id="valTraffic">\u21930 B \u21910 B</div>'
            +         '<div class="stat-meta" id="metaTraffic">Cumulative RX/TX on ap0</div>'
            +         '<div class="sparkline-wrap"><canvas id="trafficSpark" width="220" height="36"></canvas></div>'
            +     '</article>'
            + '</div>'
            + '<div class="card">'
            +     '<div class="card-header">'
            +         '<h2 class="card-title">'
            +             'Live Events '
            +             '<span class="live-pulse" title="Real-time feed"></span>'
            +         '</h2>'
            +         '<div class="card-header-actions">'
            +             '<span class="card-badge">live</span>'
            +             '<button class="btn btn-ghost btn-sm" onclick="navigate(\'activity\')">View All</button>'
            +         '</div>'
            +     '</div>'
            +     '<div class="card-body no-pad">'
            +         '<div class="overview-events-wrap">'
            +             '<table class="data-table">'
            +                 '<thead><tr><th>Time</th><th>Type</th><th>Client</th><th>Detail</th></tr></thead>'
            +                 '<tbody id="overviewEventsBody">'
            +                     '<tr><td colspan="4" class="empty-row">Waiting for live events\u2026</td></tr>'
            +                 '</tbody>'
            +             '</table>'
            +         '</div>'
            +     '</div>'
            + '</div>'
            + '<div class="grid-2">'
            +     '<section class="card">'
            +         '<div class="card-header">'
            +             '<h2 class="card-title">Network Information</h2>'
            +             '<span class="card-badge" id="netInfoBadge">\u2014</span>'
            +         '</div>'
            +         '<div class="card-body">'
            +             '<div class="kv-list">'
            +                 '<div class="kv-row"><span class="kv-key">WiFi Interface</span><span class="kv-val mono" id="infoWifiIface">\u2014</span></div>'
            +                 '<div class="kv-row"><span class="kv-key">AP Interface</span><span class="kv-val mono" id="infoApIface">\u2014</span></div>'
            +                 '<div class="kv-row"><span class="kv-key">AP IP</span><span class="kv-val mono" id="infoApIp">\u2014</span></div>'
            +                 '<div class="kv-row"><span class="kv-key">SSID</span><span class="kv-val mono" id="infoSsid">\u2014</span></div>'
            +                 '<div class="kv-row"><span class="kv-key">Channel</span><span class="kv-val mono" id="infoChannel">\u2014</span></div>'
            +                 '<div class="kv-row"><span class="kv-key">Hardware Mode</span><span class="kv-val mono" id="infoHwMode">\u2014</span></div>'
            +                 '<div class="kv-row"><span class="kv-key">Country Code</span><span class="kv-val mono" id="infoCountry">\u2014</span></div>'
            +             '</div>'
            +         '</div>'
            +     '</section>'
            +     '<section class="card">'
            +         '<div class="card-header"><h2 class="card-title">Quick Actions</h2></div>'
            +         '<div class="card-body">'
            +             '<div class="quick-actions">'
            +                 '<button class="quick-action" onclick="navigate(\'qr\')">'
            +                     '<span class="qa-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="5" height="5"/><rect x="16" y="3" width="5" height="5"/><rect x="3" y="16" width="5" height="5"/><path d="M14 14h7v7h-7z"/></svg></span>'
            +                     '<span class="qa-text"><span class="qa-title">Show QR Code</span><span class="qa-sub">Scan to connect instantly</span></span>'
            +                 '</button>'
            +                 '<button class="quick-action" onclick="navigate(\'diagnostics\')">'
            +                     '<span class="qa-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3"/><path d="M8 15v1a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6v-4"/><circle cx="20" cy="10" r="2"/></svg></span>'
            +                     '<span class="qa-text"><span class="qa-title">Run Diagnostics</span><span class="qa-sub">Verify system readiness</span></span>'
            +                 '</button>'
            +                 '<button class="quick-action" onclick="doAction(\'repair\')">'
            +                     '<span class="qa-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg></span>'
            +                     '<span class="qa-text"><span class="qa-title">Repair Hotspot</span><span class="qa-sub">Recover after suspend/driver issue</span></span>'
            +                 '</button>'
            +                 '<button class="quick-action" onclick="navigate(\'logs\')">'
            +                     '<span class="qa-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>'
            +                     '<span class="qa-text"><span class="qa-title">View Logs</span><span class="qa-sub">Inspect hostapd &amp; dnsmasq</span></span>'
            +                 '</button>'
            +             '</div>'
            +         '</div>'
            +     '</section>'
            + '</div>'
            + '</section>'
        );
    };

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

        /* --- Live pulse dots (Activity / Events) --- */
        document.querySelectorAll('.live-pulse').forEach(function (el) {
            el.classList.toggle('offline', !running);
        });

        /* --- Sidebar pills --- */
        var navPillStatus = OS.$('navPillStatus');
        if (navPillStatus) {
            navPillStatus.textContent = running ? 'online' : 'offline';
            navPillStatus.className = 'nav-pill ' + (running ? 'online' : 'offline');
        }
        var topbarUptime = OS.$('topbarUptime');
        if (topbarUptime) {
            topbarUptime.textContent = data.hostapd_uptime || '';
        }


        /* --- Hero card --- */
        var heroCard = OS.$('heroCard');
        heroCard.classList.remove('error');
        heroCard.classList.toggle('online', running);
        OS.$('heroPulse').className = 'hero-pulse';
        OS.$('heroEyebrow').textContent = 'Hotspot Status';
        OS.$('heroTitle').textContent = running ? 'Hotspot Active' : 'Hotspot Inactive';
        OS.$('heroSub').textContent = running
            ? 'Broadcasting. Devices can connect'
            : 'Click Start to bring up the access point';
        OS.$('heroSsid').textContent = data.ssid || '\u2014';
        OS.$('heroAp').textContent = (data.ap_iface || 'ap0') + ' (' + (data.ap_state || '\u2014') + ')';
        OS.$('heroIp').textContent = data.ap_ip || '\u2014';
        OS.$('heroPid').textContent = data.hostapd_pid || '\u2014';

        /* --- Admin session info --- */
        var adminNameEl = OS.$('heroAdminName');
        var adminRoleEl = OS.$('heroAdminRole');
        if (adminNameEl && adminRoleEl) {
            if (OS.state.username) {
                adminNameEl.textContent = OS.state.username;
                adminRoleEl.textContent = OS.state.userRole || '\u2014';
            } else {
                adminNameEl.textContent = '\u2014';
                adminRoleEl.textContent = '\u2014';
            }
        }

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

        var infoChannel = OS.$('infoChannel');
        if (infoChannel && data.channel) {
            infoChannel.textContent = String(data.channel);
        }
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

        /* --- Live pulse dots (Activity / Events) --- */
        document.querySelectorAll('.live-pulse').forEach(function (el) {
            el.classList.add('offline');
        });

        var navPillStatus = OS.$('navPillStatus');
        if (navPillStatus) {
            navPillStatus.textContent = 'error';
            navPillStatus.className = 'nav-pill offline';
        }

        /* Reflect an unreachable server on the hero card too, so a
           previously successful "Active" state doesn't stay stuck with
           a pulsing icon once the server goes away. */
        var heroCard = OS.$('heroCard');
        heroCard.classList.add('error');
        heroCard.classList.remove('online');
        OS.$('heroPulse').className = 'hero-pulse';
        OS.$('heroEyebrow').textContent = 'Connection Error';
        OS.$('heroTitle').textContent = 'Server Unreachable';
        OS.$('heroSub').textContent = 'Make sure the OSHotspot web server is running (sudo oshotspot web)';
    }

    var _isRefreshingStatus = false;

    OS.refreshStatus = function () {
        if (_isRefreshingStatus) return;
        _isRefreshingStatus = true;
        OS.api('/api/status').then(function (data) {
            _isRefreshingStatus = false;
            if (data && data.error) return;
            applyStatus(data);
        }).catch(function () {
            _isRefreshingStatus = false;
            applyErrorState();
        });
    };

    /* ── Live Events feed (Overview card) ────────────────────────── */

    OS.initOverviewLive = function () {
        var MAX_ROWS = 20;
        var events = [];

        function localTime(ts) {
            if (!ts) return '';
            var d = new Date(typeof ts === 'number' ? ts * 1000 : ts);
            if (isNaN(d.getTime())) return '';
            var h = String(d.getHours()).padStart(2, '0');
            var m = String(d.getMinutes()).padStart(2, '0');
            var s = String(d.getSeconds()).padStart(2, '0');
            return h + ':' + m + ':' + s;
        }

        function chipClass(msg) {
            if (!msg) return 'chip-dns';
            if (msg.type === 'alert') return 'chip-alert';
            if (msg.type === 'client_change') {
                if (msg.subtype === 'unknown_device') return 'chip-unknown';
                if (msg.subtype === 'disconnect') return 'chip-alert';
                return 'chip-known';
            }
            if (msg.type === 'dns_event') {
                var cat = msg.category || '';
                if (cat === 'messaging' || cat === 'social' || cat === 'entertainment') return 'chip-dhcp';
                return 'chip-dns';
            }
            return 'chip-dns';
        }

        function typeLabel(msg) {
            if (!msg) return 'event';
            if (msg.type === 'dns_event') return msg.is_update ? 'dns\u00b7update' : 'dns_query';
            if (msg.type === 'alert') {
                if (msg.alert_type === 'forbidden') return 'forbidden';
                if (msg.alert_type === 'watched') return 'watched';
                if (msg.alert_type === 'flood') return 'dns_flood';
                return 'alert';
            }
            if (msg.type === 'client_change') {
                if (msg.subtype === 'unknown_device') return 'unknown_dev';
                if (msg.subtype === 'connect') return 'connected';
                if (msg.subtype === 'disconnect') return 'disconnected';
                return 'client_change';
            }
            return msg.type || 'event';
        }

        function clientLabel(msg) {
            var name = msg.hostname || msg.known_label || '';
            if (name) return OS.esc(name);
            if (msg.client_mac) return OS.esc(msg.client_mac);
            return '\u2014';
        }

        function formatDetail(msg) {
            if (!msg) return '';
            var d = msg.detail || msg;
            if (msg.type === 'dns_event') {
                var dom = d.domain || '';
                var extra = [];
                if (d.query_type) extra.push(OS.esc(d.query_type));
                if (d.ip) extra.push(OS.esc(d.ip));
                if (msg.request_count > 1) extra.push('\u00d7' + OS.esc(msg.request_count));
                if (!extra.length) return OS.esc(dom);
                return OS.esc(dom) + ' <span class="text-muted">' + extra.join(' \u00b7 ') + '</span>';
            }
            if (msg.type === 'alert') {
                var dom = d.domain || '';
                var pat = d.matched_pattern ? ' <span class="text-muted">(' + OS.esc(d.matched_pattern) + ')</span>' : '';
                return OS.esc(dom) + pat;
            }
            if (msg.type === 'client_change') {
                if (msg.subtype === 'unknown_device') return 'New device: ' + OS.esc(msg.hostname || msg.client_mac || 'no hostname');
                if (msg.subtype === 'connect') return 'Device connected: ' + OS.esc(msg.hostname || msg.ip || '');
                if (msg.subtype === 'disconnect') return 'Device disconnected';
                return OS.esc(msg.subtype || 'change');
            }
            return OS.esc(JSON.stringify(d).substring(0, 60));
        }

        function addEvent(msg) {
            msg = OS.normalizeLiveMessage ? OS.normalizeLiveMessage(msg) : msg;
            if (!msg) return;
            events.unshift(msg);
            if (events.length > MAX_ROWS) events.pop();
            scheduleOverviewRender();
        }

        var overviewRenderPending = false;

        function scheduleOverviewRender() {
            if (!(OS.isViewActive && OS.isViewActive('view-overview'))) return;
            if (overviewRenderPending) return;
            overviewRenderPending = true;
            requestAnimationFrame(function () {
                overviewRenderPending = false;
                renderLiveEvents();
            });
        }

        function renderLiveEvents() {
            var tbody = OS.$('overviewEventsBody');
            if (!tbody) return;
            if (!events.length) {
                tbody.innerHTML = '<tr><td colspan="4" class="empty-row">Waiting for live events\u2026</td></tr>';
                return;
            }
            var html = '';
            for (var i = 0; i < events.length; i++) {
                var m = events[i];
                html += '<tr>'
                    + '<td class="mono">' + localTime(m.timestamp) + '</td>'
                    + '<td><span class="' + chipClass(m) + '">' + typeLabel(m) + '</span></td>'
                    + '<td>' + clientLabel(m) + '</td>'
                    + '<td>' + formatDetail(m) + '</td>'
                    + '</tr>';
            }
            tbody.innerHTML = html;
        }

        OS.flushOverviewLive = function () {
            renderLiveEvents();
        };

        if (OS.live) {
            OS.live.on('dns_event', addEvent);
            OS.live.on('alert', addEvent);
            OS.live.on('client_change', addEvent);
        }
    };
})(window.OS);
