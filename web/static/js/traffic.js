/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * traffic.js — polls /api/traffic, derives a rolling RX/TX throughput
 * history from the raw byte counters, and draws it as a small canvas
 * sparkline on the Overview page.
 */

(function (OS) {
    'use strict';

    function hexToRgba(hex, alpha) {
        hex = hex.replace('#', '');
        if (hex.length === 3) {
            hex = hex.split('').map(function (c) { return c + c; }).join('');
        }
        var r = parseInt(hex.substring(0, 2), 16) || 0;
        var g = parseInt(hex.substring(2, 4), 16) || 0;
        var b = parseInt(hex.substring(4, 6), 16) || 0;
        return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }

    OS.refreshTraffic = function () {
        OS.api('/api/traffic').then(function (data) {
            if (!data || !data.ap) return;
            var now = data.timestamp || Date.now() / 1000;
            var rx = data.ap.rx_bytes || 0;
            var tx = data.ap.tx_bytes || 0;
            var last = OS.state.lastTraffic;
            var history = OS.state.trafficHistory;

            // Convert cumulative byte counters into a per-second rate
            // by diffing against the previous sample.
            var drx = rx - last.ap_rx;
            var dtx = tx - last.ap_tx;
            var dt = last.ts ? (now - last.ts) : 0;
            if (last.ts && dt > 0 && drx >= 0 && dtx >= 0) {
                history.rx.push(drx / dt);
                history.tx.push(dtx / dt);
                if (history.rx.length > history.maxPoints) history.rx.shift();
                if (history.tx.length > history.maxPoints) history.tx.shift();
            }
            OS.state.lastTraffic = { ap_rx: rx, ap_tx: tx, ts: now };

            var valTraffic = OS.$('valTraffic');
            if (valTraffic) {
                valTraffic.textContent = '↓' + OS.formatBytes(rx) + ' ↑' + OS.formatBytes(tx);
            }
            OS.drawTrafficSpark();
        }).catch(function () {});
    };

    OS.drawTrafficSpark = function () {
        var canvas = OS.$('trafficSpark');
        if (!canvas) return;
        var ctx = canvas.getContext('2d');
        var dpr = window.devicePixelRatio || 1;
        var w = canvas.width = canvas.offsetWidth * dpr;
        var h = canvas.height = 36 * dpr;
        ctx.clearRect(0, 0, w, h);

        var rx = OS.state.trafficHistory.rx;
        var tx = OS.state.trafficHistory.tx;
        if (rx.length < 2) {
            ctx.fillStyle = 'rgba(100, 116, 139, 0.6)';
            ctx.font = (10 * dpr) + 'px monospace';
            ctx.fillText('Collecting traffic data…', 8, 20 * dpr);
            return;
        }

        var max = 1;
        for (var i = 0; i < rx.length; i++) max = Math.max(max, rx[i], tx[i]);
        var step = w / (OS.state.trafficHistory.maxPoints - 1);
        var accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6366f1';
        var cyan = getComputedStyle(document.documentElement).getPropertyValue('--cyan').trim() || '#06b6d4';

        // RX (download) is drawn as a filled area plus its outline.
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (var j = 0; j < rx.length; j++) {
            ctx.lineTo(j * step, h - (rx[j] / max) * (h - 4) - 2);
        }
        ctx.lineTo((rx.length - 1) * step, h);
        ctx.closePath();
        ctx.fillStyle = hexToRgba(accent, 0.18);
        ctx.fill();

        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        for (var k = 0; k < rx.length; k++) {
            var px = k * step;
            var py = h - (rx[k] / max) * (h - 4) - 2;
            if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();

        // TX (upload) is a plain line, no fill, so it stays readable
        // when it overlaps the RX area.
        ctx.strokeStyle = cyan;
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        for (var m = 0; m < tx.length; m++) {
            var qx = m * step;
            var qy = h - (tx[m] / max) * (h - 4) - 2;
            if (m === 0) ctx.moveTo(qx, qy); else ctx.lineTo(qx, qy);
        }
        ctx.stroke();
    };
})(window.OS);
