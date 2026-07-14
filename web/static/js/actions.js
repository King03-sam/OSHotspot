/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * actions.js — the Controls page: triggers start/stop/restart/repair
 * and streams their output into the on-page console.
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

    window.doAction = function (action) {
        var validActions = ['start', 'stop', 'restart', 'repair'];
        if (validActions.indexOf(action) < 0) return;

        // Buttons on the dedicated Controls page have IDs; the quick
        // action tiles on Overview don't, so fall back to a class match.
        var btn = OS.$('btn' + OS.capitalize(action));
        var tile = null;
        if (!btn) {
            tile = document.querySelector('.action-' + action);
            if (tile) {
                tile.style.opacity = '0.6';
                tile.style.pointerEvents = 'none';
            }
        } else {
            btn.classList.add('loading');
            btn.disabled = true;
        }

        var labelMap = {
            start: 'Starting hotspot…',
            stop: 'Stopping hotspot…',
            restart: 'Restarting hotspot…',
            repair: 'Repairing hotspot…'
        };
        appendActionOutput('▶ ' + labelMap[action]);

        OS.api('/api/' + action, 'POST').then(function (res) {
            var ok = res && res.ok;
            var out = (res && res.output) || '';
            var err = (res && res.error) || '';
            var msg = OS.capitalize(action) + ' ' + (ok ? 'completed' : 'failed');
            OS.toast(msg, ok ? 'Hotspot state updated' : (err || 'See output for details'), ok ? 'success' : 'error');
            if (out) appendActionOutput(out.trim());
            if (err) appendActionOutput('[stderr] ' + err.trim());
            setTimeout(function () {
                OS.refreshStatus();
                OS.refreshClients();
                if (btn) {
                    btn.classList.remove('loading');
                    btn.disabled = false;
                }
                if (tile) {
                    tile.style.opacity = '';
                    tile.style.pointerEvents = '';
                }
            }, 1200);
        }).catch(function (err) {
            appendActionOutput('[error] ' + (err && err.message ? err.message : 'Request failed'));
            OS.toast('Action failed', 'Could not reach server', 'error');
            if (btn) {
                btn.classList.remove('loading');
                btn.disabled = false;
            }
            if (tile) {
                tile.style.opacity = '';
                tile.style.pointerEvents = '';
            }
        });
    };
})(window.OS);
