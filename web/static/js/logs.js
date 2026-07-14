/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * logs.js — Logs page: switches between hostapd/dnsmasq/web sources
 * and renders the tail of the selected log.
 */

(function (OS) {
    'use strict';

    window.switchLog = function (source) {
        OS.state.currentLogSource = source;
        var segs = document.querySelectorAll('#logTabs .seg');
        for (var i = 0; i < segs.length; i++) {
            segs[i].classList.toggle('active', segs[i].getAttribute('data-log') === source);
        }
        window.loadLogs();
    };

    window.loadLogs = function () {
        var view = OS.$('logView');
        if (!view) return;
        var source = OS.state.currentLogSource;

        OS.api('/api/logs?component=' + encodeURIComponent(source) + '&lines=200').then(function (data) {
            var lines = [];
            if (Array.isArray(data)) {
                lines = data;
            } else if (data && typeof data === 'object') {
                // The "all" shape keys lines by component; pick the active one.
                lines = data[source] || [];
            }
            if (!lines.length) {
                view.innerHTML = '<span class="console-empty">No log entries yet. Logs appear after the hotspot is started.</span>';
                return;
            }
            view.textContent = lines.join('\n');
            view.scrollTop = view.scrollHeight;
        }).catch(function () {
            view.innerHTML = '<span class="console-empty" style="color:var(--red)">Failed to load logs.</span>';
        });
    };
})(window.OS);
