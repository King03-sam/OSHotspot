/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * qr.js — QR Code page: loads the generated WiFi QR image and labels
 * it with the current SSID.
 */

(function (OS) {
    'use strict';

    window.refreshQR = function () {
        var img = OS.$('qrImage');
        var frame = img ? img.parentElement : null;
        var placeholder = OS.$('qrPlaceholder');
        if (!img) return;

        img.onload = function () {
            if (frame) frame.classList.remove('empty');
            if (placeholder) placeholder.style.display = 'none';
            OS.api('/api/config').then(function (cfg) {
                var lbl = OS.$('qrSsid');
                if (lbl && cfg.ssid) lbl.textContent = cfg.ssid;
            }).catch(function () {});
        };
        img.onerror = function () {
            if (frame) frame.classList.add('empty');
            if (placeholder) placeholder.style.display = 'flex';
        };
        // Cache-bust so a freshly saved password produces a new image.
        img.src = '/api/qr?token=' + encodeURIComponent(OS.state.token) + '&t=' + Date.now();
    };
})(window.OS);
