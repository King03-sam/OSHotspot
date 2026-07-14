/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * traffic.js — polls /api/traffic, derives a rolling RX/TX throughput
 * history from the raw byte counters, and draws a full-width live
 * bandwidth chart with axes, gridlines, and labels.
 */

(function (OS) {
    'use strict';

    var chartColors = {
        rxLine: '#ffffff',
        rxFill: 'rgba(255,255,255,0.08)',
        txLine: '#666666',
        txFill: 'rgba(102,102,102,0.08)',
        grid: 'rgba(255,255,255,0.07)',
        axisText: 'rgba(255,255,255,0.45)',
        collectText: 'rgba(100,100,100,0.6)'
    };

    var lightColors = {
        rxLine: '#000000',
        rxFill: 'rgba(0,0,0,0.05)',
        txLine: '#999999',
        txFill: 'rgba(153,153,153,0.05)',
        grid: 'rgba(0,0,0,0.06)',
        axisText: 'rgba(0,0,0,0.4)',
        collectText: 'rgba(150,150,150,0.6)'
    };

    function getColors() {
        return document.documentElement.getAttribute('data-theme') !== 'light'
            ? chartColors : lightColors;
    }

    function formatRate(bytesPerSec) {
        if (bytesPerSec >= 1073741824) return (bytesPerSec / 1073741824).toFixed(1) + ' GB/s';
        if (bytesPerSec >= 1048576) return (bytesPerSec / 1048576).toFixed(1) + ' MB/s';
        if (bytesPerSec >= 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
        return Math.round(bytesPerSec) + ' B/s';
    }

    function formatRateAxis(bytesPerSec) {
        if (bytesPerSec >= 1073741824) return (bytesPerSec / 1073741824).toFixed(1) + ' GB/s';
        if (bytesPerSec >= 1048576) return (bytesPerSec / 1048576).toFixed(0) + ' MB/s';
        if (bytesPerSec >= 1024) return (bytesPerSec / 1024).toFixed(0) + ' KB/s';
        return Math.round(bytesPerSec) + ' B/s';
    }

    function formatTime(ts) {
        var d = new Date(ts * 1000);
        var h = String(d.getHours()).padStart(2, '0');
        var m = String(d.getMinutes()).padStart(2, '0');
        return h + ':' + m;
    }

    function niceMax(val) {
        if (val <= 0) return 1;
        var mag = Math.pow(10, Math.floor(Math.log10(val)));
        var norm = val / mag;
        if (norm <= 1) return mag;
        if (norm <= 2) return 2 * mag;
        if (norm <= 5) return 5 * mag;
        return 10 * mag;
    }

    OS.refreshTraffic = function () {
        OS.api('/api/traffic').then(function (data) {
            if (!data || !data.ap) return;
            var now = data.timestamp || Date.now() / 1000;
            var rx = data.ap.rx_bytes || 0;
            var tx = data.ap.tx_bytes || 0;
            var last = OS.state.lastTraffic;
            var history = OS.state.trafficHistory;

            var drx = rx - last.ap_rx;
            var dtx = tx - last.ap_tx;
            var dt = last.ts ? (now - last.ts) : 0;
            if (last.ts && dt > 0 && drx >= 0 && dtx >= 0) {
                history.rx.push(drx / dt);
                history.tx.push(dtx / dt);
                history.timestamps.push(now);
                if (history.rx.length > history.maxPoints) {
                    history.rx.shift();
                    history.tx.shift();
                    history.timestamps.shift();
                }
            }
            OS.state.lastTraffic = { ap_rx: rx, ap_tx: tx, ts: now };

            var elDl = OS.$('trafficDownSpeed');
            var elUl = OS.$('trafficUpSpeed');
            var elTotalDl = OS.$('trafficTotalDown');
            var elTotalUl = OS.$('trafficTotalUp');
            var elClients = OS.$('trafficClients');

            var elValTraffic = OS.$('valTraffic');
            if (elValTraffic) {
                elValTraffic.textContent = '\u2193' + OS.formatBytes(rx) + ' \u2191' + OS.formatBytes(tx);
            }

            if (elDl && history.rx.length > 0) {
                elDl.textContent = formatRate(history.rx[history.rx.length - 1]);
            }
            if (elUl && history.tx.length > 0) {
                elUl.textContent = formatRate(history.tx[history.tx.length - 1]);
            }
            if (elTotalDl) elTotalDl.textContent = OS.formatBytes(rx);
            if (elTotalUl) elTotalUl.textContent = OS.formatBytes(tx);

            OS.api('/api/status').then(function (status) {
                if (elClients && status) {
                    elClients.textContent = status.clients != null ? status.clients : '0';
                }
            }).catch(function () {});

            OS.drawTrafficChart();
            OS.drawTrafficSpark();
        }).catch(function () {});
    };

    OS.drawTrafficChart = function () {
        var canvas = OS.$('trafficChart');
        if (!canvas) return;
        var ctx = canvas.getContext('2d');
        var dpr = window.devicePixelRatio || 1;
        var displayW = canvas.offsetWidth;
        var displayH = canvas.offsetHeight || 320;
        var w = displayW * dpr;
        var h = displayH * dpr;
        canvas.width = w;
        canvas.height = h;
        ctx.clearRect(0, 0, w, h);

        var colors = getColors();
        var rx = OS.state.trafficHistory.rx;
        var tx = OS.state.trafficHistory.tx;
        var timestamps = OS.state.trafficHistory.timestamps;
        var maxPoints = OS.state.trafficHistory.maxPoints;

        if (rx.length < 2) {
            ctx.fillStyle = colors.collectText;
            ctx.font = (12 * dpr) + 'px ' + getComputedStyle(document.body).fontFamily;
            ctx.textAlign = 'center';
            ctx.fillText('Collecting traffic data\u2026', w / 2, h / 2);
            return;
        }

        var padLeft = 65 * dpr;
        var padRight = 20 * dpr;
        var padTop = 16 * dpr;
        var padBottom = 40 * dpr;
        var chartW = w - padLeft - padRight;
        var chartH = h - padTop - padBottom;

        var maxVal = 1;
        for (var i = 0; i < rx.length; i++) {
            if (rx[i] > maxVal) maxVal = rx[i];
            if (tx[i] > maxVal) maxVal = tx[i];
        }
        maxVal = niceMax(maxVal * 1.15);

        var gridLines = 5;

        ctx.strokeStyle = colors.grid;
        ctx.lineWidth = 1;
        for (var g = 0; g <= gridLines; g++) {
            var gy = padTop + (chartH / gridLines) * g;
            ctx.beginPath();
            ctx.moveTo(padLeft, gy);
            ctx.lineTo(padLeft + chartW, gy);
            ctx.stroke();
        }

        ctx.fillStyle = colors.axisText;
        ctx.font = (10 * dpr) + 'px ' + getComputedStyle(document.body).fontFamily;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (var y = 0; y <= gridLines; y++) {
            var val = maxVal * (1 - y / gridLines);
            var yPos = padTop + (chartH / gridLines) * y;
            ctx.fillText(formatRateAxis(val), padLeft - 8 * dpr, yPos);
        }

        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        var labelEvery = Math.max(1, Math.floor(rx.length / 6));
        for (var t = 0; t < rx.length; t += labelEvery) {
            var tx2 = padLeft + (t / (maxPoints - 1)) * chartW;
            ctx.fillText(formatTime(timestamps[t] || 0), tx2, padTop + chartH + 8 * dpr);
        }
        if ((rx.length - 1) % labelEvery !== 0 && rx.length > 1) {
            var lastX = padLeft + ((rx.length - 1) / (maxPoints - 1)) * chartW;
            ctx.fillText(formatTime(timestamps[timestamps.length - 1] || 0), lastX, padTop + chartH + 8 * dpr);
        }

        function drawArea(data, lineColor, fillColor) {
            ctx.beginPath();
            ctx.moveTo(padLeft, padTop + chartH);
            for (var j = 0; j < data.length; j++) {
                var px = padLeft + (j / (maxPoints - 1)) * chartW;
                var py = padTop + chartH - (data[j] / maxVal) * chartH;
                ctx.lineTo(px, py);
            }
            ctx.lineTo(padLeft + ((data.length - 1) / (maxPoints - 1)) * chartW, padTop + chartH);
            ctx.closePath();
            ctx.fillStyle = fillColor;
            ctx.fill();

            ctx.strokeStyle = lineColor;
            ctx.lineWidth = 2 * dpr;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.beginPath();
            for (var k = 0; k < data.length; k++) {
                var lx = padLeft + (k / (maxPoints - 1)) * chartW;
                var ly = padTop + chartH - (data[k] / maxVal) * chartH;
                if (k === 0) ctx.moveTo(lx, ly); else ctx.lineTo(lx, ly);
            }
            ctx.stroke();
        }

        drawArea(rx, colors.rxLine, colors.rxFill);
        drawArea(tx, colors.txLine, colors.txFill);

        var legendY = h - 12 * dpr;
        ctx.font = (11 * dpr) + 'px ' + getComputedStyle(document.body).fontFamily;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        var legendSpacing = 120 * dpr;
        var legendCenter = w / 2;

        ctx.fillStyle = colors.rxLine;
        ctx.beginPath();
        ctx.arc(legendCenter - legendSpacing / 2 - 40 * dpr, legendY, 4 * dpr, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText('Download', legendCenter - legendSpacing / 2 + 8 * dpr, legendY);

        ctx.fillStyle = colors.txLine;
        ctx.beginPath();
        ctx.arc(legendCenter + legendSpacing / 2 - 40 * dpr, legendY, 4 * dpr, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText('Upload', legendCenter + legendSpacing / 2 + 8 * dpr, legendY);
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
            ctx.fillStyle = 'rgba(100, 100, 100, 0.5)';
            ctx.font = (10 * dpr) + 'px monospace';
            ctx.fillText('Collecting traffic data\u2026', 8, 20 * dpr);
            return;
        }

        var max = 1;
        for (var i = 0; i < rx.length; i++) max = Math.max(max, rx[i], tx[i]);
        var step = w / (OS.state.trafficHistory.maxPoints - 1);

        var colors = getColors();

        ctx.beginPath();
        ctx.moveTo(0, h);
        for (var j = 0; j < rx.length; j++) {
            ctx.lineTo(j * step, h - (rx[j] / max) * (h - 4) - 2);
        }
        ctx.lineTo((rx.length - 1) * step, h);
        ctx.closePath();
        ctx.fillStyle = colors.rxFill;
        ctx.fill();

        ctx.strokeStyle = colors.rxLine;
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        for (var k = 0; k < rx.length; k++) {
            var px = k * step;
            var py = h - (rx[k] / max) * (h - 4) - 2;
            if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();

        ctx.strokeStyle = colors.txLine;
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
