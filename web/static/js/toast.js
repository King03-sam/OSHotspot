/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * toast.js, small transient notifications shown after actions
 * (start/stop, config save, refresh, etc).
 *
 * Success toasts are intentionally suppressed by default: every
 * successful action already gives inline feedback (table re-render,
 * chip/badge update, list refresh), so a floating confirmation only
 * adds noise.  Only errors and warnings are surfaced, and errors stay
 * on screen longer so they are not missed.  Long asynchronous actions
 * (e.g. start/stop/restart of the hotspot) can opt back into a success
 * toast by passing {force: true} as the 4th argument.
 */

(function (OS) {
    'use strict';

    var MAX_TOASTS = 3;
    var DURATION_INFO  = 4200;   // info / warn / success(forced)
    var DURATION_ERROR = 8000;   // errors stay longer so they are seen

    OS.toast = function (title, msg, type, opts) {
        type = type || 'info';
        if (type === 'success' && !(opts && opts.force)) return;

        var container = OS.$('toastContainer');
        if (!container) return;

        while (container.children.length >= MAX_TOASTS) {
            container.removeChild(container.firstChild);
        }

        var el = document.createElement('div');
        el.className = 'toast ' + type;
        var icon = type === 'success' ? '✓' : type === 'error' ? '!' : type === 'warn' ? '!' : 'i';
        el.innerHTML =
            '<div class="toast-icon">' + OS.esc(icon) + '</div>' +
            '<div class="toast-content">' +
                '<div class="toast-title">' + OS.esc(title) + '</div>' +
                (msg ? '<div class="toast-msg">' + OS.esc(msg) + '</div>' : '') +
            '</div>';
        container.appendChild(el);

        var duration = type === 'error' ? DURATION_ERROR : DURATION_INFO;
        setTimeout(function () {
            el.classList.add('removing');
            setTimeout(function () {
                if (el.parentNode) el.parentNode.removeChild(el);
            }, 300);
        }, duration);
    };
})(window.OS);
