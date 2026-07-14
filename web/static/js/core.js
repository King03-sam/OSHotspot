/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * core.js — shared state, section metadata and small DOM helpers used
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
        trafficInterval: null,
        currentLogSource: 'hostapd',
        trafficHistory: { rx: [], tx: [], timestamps: [], maxPoints: 60 },
        lastTraffic: { ap_rx: 0, ap_tx: 0, ts: 0 }
    };

    // Title/subtitle shown in the topbar for each section of the SPA.
    OS.SECTIONS = {
        overview:    { title: 'Overview',      subtitle: 'Real-time hotspot status at a glance' },
        controls:    { title: 'Controls',      subtitle: 'Start, stop, restart, or repair the hotspot' },
        clients:     { title: 'Clients',       subtitle: 'Devices currently connected to the hotspot' },
        config:      { title: 'Configuration', subtitle: 'Edit hotspot and network settings' },
        qr:          { title: 'QR Code',       subtitle: 'Scan to connect a phone instantly' },
        diagnostics: { title: 'Diagnostics',   subtitle: 'Verify system readiness with health checks' },
        logs:        { title: 'Logs',          subtitle: 'Inspect hostapd, dnsmasq and web logs' },
        traffic: { title: 'Traffic Monitor', subtitle: 'Real-time bandwidth usage and throughput' },
        about:       { title: 'About',         subtitle: 'Project information and security details' }
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

    OS.formatBytes = function (b) {
        b = Number(b) || 0;
        if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
        if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
        if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
        return b + ' B';
    };
})(window.OS);
