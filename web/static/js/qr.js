/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * qr.js, QR Code page: loads the generated WiFi QR image and labels
 * it with the current SSID.
 */

(function (OS) {
    'use strict';

    OS.renderQR = function () {
        document.getElementById('content').insertAdjacentHTML('beforeend',
            '<section class="view" id="view-qr">'
            + '<div class="card qr-card">'
            +     '<div class="card-header">'
            +         '<h2 class="card-title">WiFi QR Code</h2>'
            +         '<button class="btn btn-ghost btn-sm" onclick="refreshQR()">Refresh</button>'
            +     '</div>'
            +     '<div class="card-body qr-body">'
            +         '<div class="qr-frame">'
            +             '<img id="qrImage" src="" alt="WiFi QR Code">'
            +             '<div class="qr-placeholder" id="qrPlaceholder">'
            +                 '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="5" height="5"/><rect x="16" y="3" width="5" height="5"/><rect x="3" y="16" width="5" height="5"/><path d="M14 14h7v7h-7z"/></svg>'
            +                 '<span>Click "Refresh" to generate</span>'
            +             '</div>'
            +         '</div>'
            +         '<div class="qr-info">'
            +             '<p>Scan this QR code with your phone\'s camera to instantly connect to the hotspot. The WiFi credentials are embedded directly in the code, so no manual password entry is needed.</p>'
            +             '<div class="kv-list">'
            +                 '<div class="kv-row"><span class="kv-key">Encryption</span><span class="kv-val mono">WPA2-PSK</span></div>'
            +                 '<div class="kv-row"><span class="kv-key">Network</span><span class="kv-val mono" id="qrSsid">\u2014</span></div>'
            +             '</div>'
            +         '</div>'
            +     '</div>'
            + '</div>'
            + '</section>'
        );
    };

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
        img.src = '/api/qr?t=' + Date.now();
    };
})(window.OS);
