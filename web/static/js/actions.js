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

    /** Re-enable a button or tile that was disabled during an action. */
    function reEnable(btn, tile) {
        if (btn) {
            btn.classList.remove('loading');
            btn.disabled = false;
        }
        if (tile) {
            tile.style.opacity = '';
            tile.style.pointerEvents = '';
        }
    }

    window.doAction = function (action) {
        var validActions = ['start', 'stop', 'restart', 'repair'];
        if (validActions.indexOf(action) < 0) return;

        /* Look for the hero-card button first, then the controls-page tile. */
        var btn  = OS.$('btn' + OS.capitalize(action));
        var tile = btn ? null : document.querySelector('.action-' + action);

        /* Disable immediately so the user can't double-click. */
        if (btn) {
            btn.classList.add('loading');
            btn.disabled = true;
        }
        if (tile) {
            tile.style.opacity = '0.6';
            tile.style.pointerEvents = 'none';
        }

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
                /* --- success --- */
                var ok  = res && res.ok;
                var out = (res && res.output) || '';
                var err = (res && res.error) || '';
                var msg = OS.capitalize(action) + ' ' + (ok ? 'completed' : 'failed');
                OS.toast(msg, ok ? 'Hotspot state updated' : (err || 'See output below'), ok ? 'success' : 'error');
                if (out) appendActionOutput(out.trim());
                if (err) appendActionOutput('[stderr] ' + err.trim());
                OS.refreshStatus();
                OS.refreshClients();
            },
            function (err) {
                /* --- error / timeout / network failure --- */
                var text = (err && err.message) ? err.message : String(err);
                if (err && err.name === 'AbortError') {
                    appendActionOutput('[timeout] Server did not respond within ' + (timeout / 1000) + 's. The action may still be running.');
                    OS.toast('Timeout', 'Server took too long \u2014 the action may still be running in the background.', 'warn');
                } else {
                    appendActionOutput('[error] ' + text);
                    OS.toast('Action failed', text || 'Could not reach server', 'error');
                }
            }
        );

        /* Re-enable buttons after a short delay.  The timeout covers
           the worst case (server blocked on a long script + browser
           fetch timeout), so the buttons won't be disabled forever. */
        setTimeout(function () { reEnable(btn, tile); }, timeout + 1500);
    };
})(window.OS);
