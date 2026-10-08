/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * core.js, shared state, section metadata and small DOM helpers used
 * by every other module. Loaded first, before anything that depends
 * on OS.$ or OS.state.
 */

window.OS = window.OS || {};

(function (OS) {
    'use strict';

    // Session token and the various setInterval handles for polling.
    // Everything lives on one object so modules can read/write it
    // without each declaring their own module-level globals.
    OS.state = {
        token: '',
        statusInterval: null,
        clientsInterval: null,
        logsInterval: null,
        eventsInterval: null,
        trafficInterval: null,
        currentLogSource: 'hostapd',
        trafficHistory: { rx: [], tx: [], timestamps: [], maxPoints: 60 },
        lastTraffic: { ap_rx: 0, ap_tx: 0, ts: 0 }
    };

    // Title/subtitle shown in the topbar for each section of the SPA.
    OS.SECTIONS = {
        overview:    { title: 'Overview',      subtitle: 'Real-time status at a glance' },
        controls:    { title: 'Controls',      subtitle: 'Start, stop, restart, or repair the hotspot' },
        clients:     { title: 'Clients',       subtitle: 'Devices currently connected to the hotspot' },
        config:      { title: 'Configuration', subtitle: 'Edit hotspot and network settings' },
        qr:          { title: 'QR Code',       subtitle: 'Scan to connect a phone instantly' },
        traffic: { title: 'Traffic Monitor', subtitle: 'Real-time bandwidth usage and throughput' },
        activity:    { title: 'Live Activity', subtitle: 'Real-time feed of sites visited and alerts' },
        policy:      { title: 'Domain Policy', subtitle: 'Forbidden / watched / noise domain lists' },
        captive:     { title: 'Captive Portal', subtitle: 'Authentication and access control for clients' },
        span:        { title: 'SPAN Analysis', subtitle: 'Switch mirror port log capture and analysis' },
        diagnostics: { title: 'Diagnostics',   subtitle: 'Verify system readiness with health checks' },
        logs:        { title: 'Logs',          subtitle: 'Inspect hostapd, dnsmasq and web logs' },
        events:      { title: 'Events',        subtitle: 'DNS, DHCP and device activity from clients' },
        about:       { title: 'About',         subtitle: 'Project information and security details' },
        users:       { title: 'User Management', subtitle: 'Manage admin accounts and roles' },
        mail:        { title: 'Email Alerts',   subtitle: 'Configure email notifications for security alerts' },
        vpn:         { title: 'VPN',             subtitle: 'Remote access via Tailscale mesh VPN' },
        audit:        { title: 'Audit Log',       subtitle: 'Admin action history and security audit trail' }
    };

    OS.$ = function (id) {
        return document.getElementById(id);
    };

    // Escapes text before it's dropped into innerHTML, so client
    // hostnames, log lines, etc. can't break out of their container.
    OS.esc = function (s) {
        if (s === null || s === undefined) s = '';
        var d = document.createElement('div');
        d.textContent = String(s);
        return d.innerHTML;
    };

    OS.capitalize = function (s) {
        return s.charAt(0).toUpperCase() + s.slice(1);
    };

    function _legacyCopy(text) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        var ok = false;
        try {
            ok = document.execCommand('copy');
        } catch (_) {
            ok = false;
        }
        document.body.removeChild(ta);
        return ok;
    }

    OS.copyText = function (text) {
        return new Promise(function (resolve, reject) {
            if (!text) {
                reject(new Error('Nothing to copy'));
                return;
            }
            if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(resolve, function () {
                    if (_legacyCopy(text)) resolve();
                    else reject(new Error('Copy failed'));
                });
            } else if (_legacyCopy(text)) {
                resolve();
            } else {
                reject(new Error('Copy failed'));
            }
        });
    };

    OS.formatBytes = function (b) {
        b = Number(b) || 0;
        if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
        if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
        if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
        return b + ' B';
    };

    function parseDetail(detail) {
        if (detail && typeof detail === 'object') return detail;
        if (typeof detail !== 'string') return {};
        try {
            var parsed = JSON.parse(detail);
            return parsed && typeof parsed === 'object' ? parsed : { raw: detail };
        } catch (_) {
            return { raw: detail };
        }
    }

    OS.normalizeLiveMessage = function (raw) {
        if (!raw) return null;
        if (typeof raw === 'string') {
            try { raw = JSON.parse(raw); } catch (_) { return null; }
        }
        if (!raw || typeof raw !== 'object') return null;

        var msg = {};
        for (var key in raw) {
            if (Object.prototype.hasOwnProperty.call(raw, key)) {
                msg[key] = raw[key];
            }
        }

        msg.detail = parseDetail(msg.detail);

        if (!msg.type) {
            if (msg.priority === 'high' || msg.alert_type) {
                msg.type = 'alert';
            } else if (msg.event_type === 'dns_query') {
                msg.type = 'dns_event';
            } else if (msg.event_type === 'unknown_device') {
                msg.type = 'client_change';
                if (!msg.subtype) msg.subtype = 'unknown_device';
            } else if (msg.event_type === 'marked_known') {
                msg.type = 'client_change';
                if (!msg.subtype) msg.subtype = 'marked_known';
            }
        }

        if (!msg.event_type) {
            if (msg.type === 'dns_event' || msg.type === 'alert') {
                msg.event_type = 'dns_query';
            } else if (msg.type === 'client_change' && msg.subtype) {
                msg.event_type = msg.subtype;
            }
        }

        if (msg.type === 'client_change' && !msg.subtype && msg.event_type) {
            msg.subtype = msg.event_type;
        }
        if (!msg.category && msg.detail && msg.detail.category) {
            msg.category = msg.detail.category;
        }
        if (!msg.hostname && msg.detail && msg.detail.hostname) {
            msg.hostname = msg.detail.hostname;
        }
        if (!msg.label && msg.known_label) {
            msg.label = msg.known_label;
        }
        if (msg.request_count == null) msg.request_count = 1;
        if (!msg.client_mac) msg.client_mac = '';
        if (!msg.timestamp) msg.timestamp = '';
        return msg;
    };
})(window.OS);
