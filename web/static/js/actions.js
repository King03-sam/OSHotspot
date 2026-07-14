/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * actions.js — the Controls page: triggers start/stop/restart/repair
 * and streams their output into the on-page console.
 *
 * Buttons are ALWAYS re-enabled after the request settles (success,
 * error, or timeout) so they never stay stuck in the loading state.
 */

(function (OS) {
    'use strict';

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
                var ok  = res && res.ok;
                var out = (res && res.output) || '';
                var err = (res && res.error) || '';
                var msg = cap + ' ' + (ok ? 'completed' : 'failed');
                OS.toast(msg, ok ? 'Hotspot state updated' : (err || 'See output below'), ok ? 'success' : 'error');
                if (out) appendActionOutput(out.trim());
                if (err) appendActionOutput('[stderr] ' + err.trim());
                OS.refreshStatus();
                OS.refreshClients();
                reEnableAll(elements);
            },
            function (err) {
                var text = (err && err.message) ? err.message : String(err);
                if (err && err.name === 'AbortError') {
                    appendActionOutput('[timeout] Server did not respond within ' + (timeout / 1000) + 's. The action may still be running.');
                    OS.toast('Timeout', 'Server took too long \u2014 the action may still be running in the background.', 'warn');
                } else {
                    appendActionOutput('[error] ' + text);
                    OS.toast('Action failed', text || 'Could not reach server', 'error');
                }
                reEnableAll(elements);
            }
        );
    };
})(window.OS);
