/*
 * OSHotspot Dashboard — Premium UI controller
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * app.js — ties every other module together: the About page loader,
 * the "refresh everything" button, the polling intervals, and the
 * bootstrap that runs once the DOM is ready.
 *
 * Load order matters: this file assumes core.js, api.js, theme.js,
 * toast.js, nav.js, status.js, clients.js, config.js, actions.js,
 * qr.js, doctor.js, logs.js and traffic.js are already loaded.
 */

(function (OS) {
    'use strict';

    OS.loadVersionInfo = function () {
        OS.api('/api/version').then(function (info) {
            if (!info) return;
            if (info.author) OS.$('aboutAuthor').textContent = info.author;
            if (info.version) OS.$('aboutVersion').textContent = info.version;
        }).catch(function () {});
    };

    window.refreshAll = function () {
        OS.refreshStatus();
        OS.refreshClients();
        OS.refreshTraffic();
        if (OS.$('view-config').classList.contains('active')) window.loadConfig();
        if (OS.$('view-logs').classList.contains('active')) window.loadLogs();
        if (OS.$('view-qr').classList.contains('active')) window.refreshQR();
        if (OS.$('view-diagnostics').classList.contains('active')) window.runDoctor();
        OS.toast('Refreshed', 'Dashboard data updated', 'info');
    };

    function startPolling() {
        stopPolling();
        var s = OS.state;

        /* Each interval checks document.hidden so a backgrounded tab
           stops hammering the server, and re-checks the active section
           before doing anything expensive. */
        s.statusInterval = setInterval(function () {
            if (!document.hidden) OS.refreshStatus();
        }, 5000);

        s.clientsInterval = setInterval(function () {
            if (!document.hidden && OS.$('view-clients').classList.contains('active')) {
                var cb = OS.$('clientsAutoRefresh');
                if (!cb || cb.checked) OS.refreshClients();
            }
        }, 6000);

        s.trafficInterval = setInterval(function () {
            if (!document.hidden) OS.refreshTraffic();
        }, 3000);

        s.logsInterval = setInterval(function () {
            if (!document.hidden && OS.$('view-logs').classList.contains('active')) {
                var lb = OS.$('logsAutoRefresh');
                if (!lb || lb.checked) window.loadLogs();
            }
        }, 5000);
    }

    function stopPolling() {
        var s = OS.state;
        if (s.statusInterval) clearInterval(s.statusInterval);
        if (s.clientsInterval) clearInterval(s.clientsInterval);
        if (s.trafficInterval) clearInterval(s.trafficInterval);
        if (s.logsInterval) clearInterval(s.logsInterval);
    }

    function init() {
        OS.initTheme();

        var params = new URLSearchParams(window.location.search);
        OS.state.token = params.get('token') || '';
        if (!OS.state.token) {
            document.body.innerHTML =
                '<div style="padding:60px 40px;color:#ef4444;font-family:monospace;text-align:center;'
                + 'background:#0a0a1a;min-height:100vh;display:flex;align-items:center;justify-content:center;">'
                + '<div style="max-width:480px;">'
                + '<svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#ef4444" stroke-width="2" style="margin-bottom:20px;">'
                + '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>'
                + '<h2 style="color:#fff;margin-bottom:8px;">Access Denied</h2>'
                + '<p style="color:#94a3b8;font-size:14px;">No session token provided. Open the dashboard via <code style="color:#60a5fa;">sudo oshotspot web</code></p>'
                + '</div></div>';
            return;
        }

        /* Initial data load — don't let failures block the UI. */
        OS.refreshStatus();
        OS.refreshClients();
        OS.refreshTraffic();
        window.loadConfig();
        startPolling();

        /* Tapping outside an open mobile sidebar closes it. */
        document.addEventListener('click', function (e) {
            var sb = OS.$('sidebar');
            var toggle = OS.$('menuToggle');
            if (window.innerWidth <= 900 && sb.classList.contains('open')) {
                if (!sb.contains(e.target) && (!toggle || !toggle.contains(e.target))) {
                    OS.closeSidebar();
                }
            }
        });

        /* Redraw the sparkline on resize, debounced so a window drag
           doesn't trigger dozens of canvas repaints. */
        window.addEventListener('resize', function () {
            clearTimeout(window._oshotspotResize);
            window._oshotspotResize = setTimeout(OS.drawTrafficSpark, 200);
        });
    }

    document.addEventListener('DOMContentLoaded', init);
})(window.OS);
