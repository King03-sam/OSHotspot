/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * actions.js, the Controls page: triggers start/stop/restart/repair
 * and streams their output into the on-page console.
 *
 * Buttons are ALWAYS re-enabled after the request settles (success,
 * error, or timeout) so they never stay stuck in the loading state.
 */

(function (OS) {
    'use strict';

    OS.renderControls = function () {
        document.getElementById('content').insertAdjacentHTML('beforeend',
            '<section class="view" id="view-controls">'
            + '<div class="card">'
            +     '<div class="card-header"><h2 class="card-title">Hotspot Lifecycle</h2></div>'
            +     '<div class="card-body">'
            +         '<p class="text-muted">Control the hotspot daemon lifecycle. Each action runs the corresponding system script with root privileges through the local OSHotspot web server.</p>'
            +         '<div class="action-grid">'
            +             '<button class="action-tile action-start" onclick="doAction(\'start\')">'
            +                 '<div class="action-tile-icon"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>'
            +                 '<div class="action-tile-text"><div class="action-tile-title">Start Hotspot</div><div class="action-tile-sub">Bring up ap0, hostapd, dnsmasq and NAT</div></div>'
            +             '</button>'
            +             '<button class="action-tile action-stop" onclick="doAction(\'stop\')">'
            +                 '<div class="action-tile-icon"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1"/></svg></div>'
            +                 '<div class="action-tile-text"><div class="action-tile-title">Stop Hotspot</div><div class="action-tile-sub">Tear down all hotspot services cleanly</div></div>'
            +             '</button>'
            +             '<button class="action-tile action-restart" onclick="doAction(\'restart\')">'
            +                 '<div class="action-tile-icon"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></div>'
            +                 '<div class="action-tile-text"><div class="action-tile-title">Restart Hotspot</div><div class="action-tile-sub">Stop then start, applying new config</div></div>'
            +             '</button>'
            +             '<button class="action-tile action-repair" onclick="doAction(\'repair\')">'
            +                 '<div class="action-tile-icon"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg></div>'
            +                 '<div class="action-tile-text"><div class="action-tile-title">Repair Hotspot</div><div class="action-tile-sub">Recover after suspend or driver failure</div></div>'
            +             '</button>'
            +         '</div>'
            +     '</div>'
            + '</div>'
            + '<div class="card">'
            +     '<div class="card-header">'
            +         '<h2 class="card-title">Last Action Output</h2>'
            +         '<button class="btn btn-ghost btn-sm" onclick="clearActionOutput()">Clear</button>'
            +     '</div>'
            +     '<div class="card-body">'
            +         '<pre class="console" id="actionOutput"><span class="console-empty">No action executed yet. Pick an operation above to see its output here.</span></pre>'
            +     '</div>'
            + '</div>'
            + '</section>'
        );
    };

    function appendActionOutput(text) {
        var pre = OS.$('actionOutput');
        if (!pre) return;
        var empty = pre.querySelector('.console-empty');
        if (empty) pre.textContent = '';
        pre.textContent += (pre.textContent ? '\n' : '') + text;
        pre.scrollTop = pre.scrollHeight;
    }

    window.clearActionOutput = function () {
        var pre = OS.$('actionOutput');
        if (pre) {
            pre.innerHTML = '<span class="console-empty">No action executed yet. Pick an operation above to see its output here.</span>';
        }
    };

    /** Remove loading state from every element that was disabled. */
    function reEnableAll(elements) {
        elements.forEach(function (el) {
            el.classList.remove('loading');
            el.disabled = false;
        });
    }

    window.doAction = function (action) {
        var validActions = ['start', 'stop', 'restart', 'repair'];
        if (validActions.indexOf(action) < 0) return;

        var cap = OS.capitalize(action);

        /* Collect every element that triggers this action:
           hero-card button, controls-page tiles, quick-action buttons. */
        var elements = [];
        var heroBtn = OS.$('btn' + cap);
        if (heroBtn) elements.push(heroBtn);
        var tiles = document.querySelectorAll('.action-' + action);
        for (var i = 0; i < tiles.length; i++) elements.push(tiles[i]);
        var quickBtns = document.querySelectorAll(
            '.quick-action[onclick*="doAction(\'' + action + '\')"]'
        );
        for (var j = 0; j < quickBtns.length; j++) elements.push(quickBtns[j]);

        /* Disable immediately so the user can't double-click. */
        elements.forEach(function (el) {
            el.classList.add('loading');
            el.disabled = true;
        });

        var labelMap = {
            start:   'Starting hotspot\u2026',
            stop:    'Stopping hotspot\u2026',
            restart: 'Restarting hotspot\u2026',
            repair:  'Repairing hotspot\u2026'
        };
        appendActionOutput('\u25b6 ' + labelMap[action]);

        /* Repair gets extra time; other actions get the standard timeout. */
        var timeout = (action === 'repair') ? OS.TIMEOUT_REPAIR : OS.TIMEOUT_ACTION;

        OS.api('/api/' + action, 'POST', null, timeout).then(
            function (res) {
                try {
                    var ok  = res && res.ok;
                    var out = (res && res.output) || '';
                    var err = (res && res.error) || '';
                    var msg = cap + ' ' + (ok ? 'completed' : 'failed');
                    OS.toast(msg, ok ? 'Hotspot state updated' : (err || 'See output below'), ok ? 'success' : 'error', ok ? {force: true} : undefined);
                    if (out) appendActionOutput(out.trim());
                    if (err) appendActionOutput('[stderr] ' + err.trim());
                    OS.refreshStatus();
                    OS.refreshClients();
                } finally {
                    reEnableAll(elements);
                }
            },
            function (err) {
                try {
                    var text = (err && err.message) ? err.message : String(err);
                    if (err && err.name === 'AbortError') {
                        appendActionOutput('[timeout] Server did not respond within ' + (timeout / 1000) + 's. The action may still be running.');
                        OS.toast('Timeout', 'Server took too long \u2014 the action may still be running in the background.', 'warn');
                    } else {
                        appendActionOutput('[error] ' + text);
                        OS.toast('Action failed', text || 'Could not reach server', 'error');
                    }
                } finally {
                    reEnableAll(elements);
                }
            }
        );
    };
})(window.OS);
