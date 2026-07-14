/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * toast.js — small transient notifications shown after actions
 * (start/stop, config save, refresh, etc).
 */

(function (OS) {
    'use strict';

    OS.toast = function (title, msg, type) {
        var container = OS.$('toastContainer');
        if (!container) return;

        var el = document.createElement('div');
        el.className = 'toast ' + (type || 'info');
        var icon = type === 'success' ? '✓' : type === 'error' ? '!' : type === 'warn' ? '!' : 'i';
        el.innerHTML =
            '<div class="toast-icon">' + OS.esc(icon) + '</div>' +
            '<div class="toast-content">' +
                '<div class="toast-title">' + OS.esc(title) + '</div>' +
                (msg ? '<div class="toast-msg">' + OS.esc(msg) + '</div>' : '') +
            '</div>';
        container.appendChild(el);

        setTimeout(function () {
            el.classList.add('removing');
            setTimeout(function () {
                if (el.parentNode) el.parentNode.removeChild(el);
            }, 300);
        }, 4200);
    };
})(window.OS);
