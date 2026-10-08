/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * traffic.js, polls /api/traffic, derives a rolling RX/TX throughput
 * history from the raw byte counters, and draws a full-width live
 * bandwidth chart with axes, gridlines, labels and hover inspection.
 */

(function (OS) {
    'use strict';

    function statCard(label, valueId, initial, subId, subText) {
        return '<div class="traffic-stat-card">'
            + '<div class="traffic-stat-label">' + label + '</div>'
            + '<div class="traffic-stat-value" id="' + valueId + '">' + initial + '</div>'
            + '<div class="traffic-stat-sub"' + (subId ? ' id="' + subId + '"' : '') + '>' + subText + '</div>'
            + '</div>';
    }

    OS.renderTraffic = function () {
        document.getElementById('content').insertAdjacentHTML('beforeend',
            '<section class="view" id="view-traffic">'
            + '<div class="traffic-stats" id="trafficStats">'
            +     statCard('Download',   'trafficDownSpeed', '0 B/s', 'trafficDownPeak', 'Peak 0 B/s')
            +     statCard('Upload',     'trafficUpSpeed',   '0 B/s', 'trafficUpPeak',   'Peak 0 B/s')
            +     statCard('Total Down', 'trafficTotalDown', '0 B',   null, 'Received by AP')
            +     statCard('Total Up',   'trafficTotalUp',   '0 B',   null, 'Sent by AP')
            +     statCard('Clients',    'trafficClients',   '0',     null, 'Connected now')
            + '</div>'
            + '<div class="card">'
            +     '<div class="card-header">'
            +         '<h2 class="card-title">Live Bandwidth</h2>'
            +         '<div class="card-header-actions traffic-header-meta">'
            +             '<span class="traffic-readout" id="trafficReadout"></span>'
            +             '<div class="traffic-legend">'
            +                 '<span class="traffic-legend-item"><span class="traffic-legend-dot" data-series="rx"></span>Download</span>'
            +                 '<span class="traffic-legend-item"><span class="traffic-legend-dot" data-series="tx"></span>Upload</span>'
            +             '</div>'
            +             '<label class="toggle">'
            +                 '<input type="checkbox" id="trafficAutoRefresh" checked>'
            +                 '<span class="toggle-slider"></span>'
            +                 '<span class="toggle-label">Live</span>'
            +             '</label>'
            +         '</div>'
            +     '</div>'
            +     '<div class="card-body no-pad">'
            +         '<div class="traffic-chart-wrap"><canvas id="trafficChart"></canvas></div>'
            +     '</div>'
            + '</div>'
            + '</section>'
        );
    };

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

    function getFont() {
        return getComputedStyle(document.body).fontFamily || 'sans-serif';
    }

    function formatRate(bytesPerSec) {
        if (bytesPerSec >= 1073741824) return (bytesPerSec / 1073741824).toFixed(1) + ' GB/s';
        if (bytesPerSec >= 1048576) return (bytesPerSec / 1048576).toFixed(1) + ' MB/s';
        if (bytesPerSec >= 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
        return Math.round(bytesPerSec) + ' B/s';
    }

    function formatRateAxis(bytesPerSec) {
        if (bytesPerSec <= 0) return '0';
        if (bytesPerSec >= 1073741824) return (bytesPerSec / 1073741824).toFixed(1) + ' GB/s';
        if (bytesPerSec >= 1048576) return (bytesPerSec / 1048576).toFixed(0) + ' MB/s';
        if (bytesPerSec >= 1024) return (bytesPerSec / 1024).toFixed(0) + ' KB/s';
        return Math.round(bytesPerSec) + ' B/s';
    }

    function formatTime(ts, withSeconds) {
        var d = new Date(ts * 1000);
        var out = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        if (withSeconds) out += ':' + String(d.getSeconds()).padStart(2, '0');
        return out;
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

    function arrayMax(arr) {
        var m = 0;
        for (var i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
        return m;
    }

    /* Smooth path through points using midpoint quadratic curves (no overshoot). */
    function traceSmooth(ctx, pts) {
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (var i = 1; i < pts.length; i++) {
            var p = pts[i - 1], c = pts[i];
            ctx.quadraticCurveTo(p[0], p[1], (p[0] + c[0]) / 2, (p[1] + c[1]) / 2);
        }
        var last = pts[pts.length - 1];
        ctx.lineTo(last[0], last[1]);
    }

    /* ---------- Data polling ---------- */

    var _isRefreshingTraffic = false;

    OS.refreshTraffic = function () {
        if (_isRefreshingTraffic) return;
        _isRefreshingTraffic = true;
        OS.api('/api/traffic').then(function (data) {
            _isRefreshingTraffic = false;
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

            var elValTraffic = OS.$('valTraffic');
            if (elValTraffic) {
                elValTraffic.textContent = '\u2193' + OS.formatBytes(rx) + ' \u2191' + OS.formatBytes(tx);
            }

            var n = history.rx.length;
            var elDl = OS.$('trafficDownSpeed');
            var elUl = OS.$('trafficUpSpeed');
            var elDlPeak = OS.$('trafficDownPeak');
            var elUlPeak = OS.$('trafficUpPeak');
            var elTotalDl = OS.$('trafficTotalDown');
            var elTotalUl = OS.$('trafficTotalUp');
            var elClients = OS.$('trafficClients');

            if (n > 0) {
                if (elDl) elDl.textContent = formatRate(history.rx[n - 1]);
                if (elUl) elUl.textContent = formatRate(history.tx[n - 1]);
                if (elDlPeak) elDlPeak.textContent = 'Peak ' + formatRate(arrayMax(history.rx));
                if (elUlPeak) elUlPeak.textContent = 'Peak ' + formatRate(arrayMax(history.tx));
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
        }).catch(function () {
            _isRefreshingTraffic = false;
        });
    };

    /* ---------- Chart interaction ---------- */

    var _redrawQueued = false;
    function queueRedraw() {
        if (_redrawQueued) return;
        _redrawQueued = true;
        requestAnimationFrame(function () {
            _redrawQueued = false;
            OS.drawTrafficChart();
            OS.drawTrafficSpark();
        });
    }

    function bindChartEvents(canvas) {
        if (canvas._trafficBound) return;
        canvas._trafficBound = true;

        canvas.addEventListener('mousemove', function (e) {
            var g = canvas._geo;
            if (!g) return;
            var rect = canvas.getBoundingClientRect();
            var x = (e.clientX - rect.left) * g.dpr;
            if (x < g.padLeft - 10 * g.dpr || x > g.padLeft + g.chartW + 10 * g.dpr) {
                if (OS.state.trafficHover != null) { OS.state.trafficHover = null; queueRedraw(); }
                return;
            }
            var idx = g.n - 1 - Math.round((g.padLeft + g.chartW - x) / g.stepX);
            idx = Math.max(0, Math.min(g.n - 1, idx));
            if (idx !== OS.state.trafficHover) {
                OS.state.trafficHover = idx;
                queueRedraw();
            }
        });

        canvas.addEventListener('mouseleave', function () {
            OS.state.trafficHover = null;
            queueRedraw();
        });

        if (window.ResizeObserver && canvas.parentElement) {
            new ResizeObserver(queueRedraw).observe(canvas.parentElement);
        } else {
            window.addEventListener('resize', queueRedraw);
        }
    }

    function paintLegend(colors) {
        var dots = document.querySelectorAll('#view-traffic .traffic-legend-dot');
        for (var i = 0; i < dots.length; i++) {
            dots[i].style.background = dots[i].getAttribute('data-series') === 'tx'
                ? colors.txLine : colors.rxLine;
        }
    }

    function updateReadout(idx, withSeconds) {
        var el = OS.$('trafficReadout');
        if (!el) return;
        var h = OS.state.trafficHistory;
        if (idx == null || idx < 0 || idx >= h.rx.length) { el.textContent = ''; return; }
        el.textContent = formatTime(h.timestamps[idx], true)
            + '   \u2193 ' + formatRate(h.rx[idx])
            + '   \u2191 ' + formatRate(h.tx[idx]);
    }

    /* ---------- Main chart ---------- */

    OS.drawTrafficChart = function () {
        var canvas = OS.$('trafficChart');
        if (!canvas) return;
        bindChartEvents(canvas);

        var ctx = canvas.getContext('2d');
        var dpr = window.devicePixelRatio || 1;
        var displayW = canvas.clientWidth;
        var displayH = canvas.clientHeight || 320;
        if (!displayW) return;
        var w = Math.round(displayW * dpr);
        var h = Math.round(displayH * dpr);
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        ctx.clearRect(0, 0, w, h);

        var colors = getColors();
        var font = getFont();
        paintLegend(colors);

        var hist = OS.state.trafficHistory;
        var rx = hist.rx, tx = hist.tx, ts = hist.timestamps;
        var n = rx.length;

        if (n < 2) {
            canvas._geo = null;
            updateReadout(null);
            ctx.fillStyle = colors.collectText;
            ctx.font = (12 * dpr) + 'px ' + font;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('Collecting traffic data\u2026', w / 2, h / 2);
            return;
        }

        /* Scale */
        var maxVal = Math.max(1, arrayMax(rx), arrayMax(tx));
        maxVal = niceMax(maxVal * 1.15);
        var gridLines = 4;

        /* Layout, left padding fits the widest axis label */
        ctx.font = (10 * dpr) + 'px ' + font;
        var labelW = 0;
        for (var a = 0; a <= gridLines; a++) {
            labelW = Math.max(labelW, ctx.measureText(formatRateAxis(maxVal * a / gridLines)).width);
        }
        var padLeft = labelW + 18 * dpr;
        var padRight = 18 * dpr;
        var padTop = 16 * dpr;
        var padBottom = 30 * dpr;
        var chartW = w - padLeft - padRight;
        var chartH = h - padTop - padBottom;
        var baseY = padTop + chartH;
        var stepX = chartW / Math.max(1, hist.maxPoints - 1);

        function xAt(i) { return padLeft + chartW - (n - 1 - i) * stepX; }
        function yAt(v) { return baseY - (v / maxVal) * chartH; }

        canvas._geo = { dpr: dpr, padLeft: padLeft, chartW: chartW, stepX: stepX, n: n };

        /* Grid */
        ctx.strokeStyle = colors.grid;
        ctx.lineWidth = Math.max(1, dpr);
        for (var g = 0; g <= gridLines; g++) {
            var gy = Math.round(padTop + (chartH / gridLines) * g) + 0.5;
            ctx.setLineDash(g === gridLines ? [] : [3 * dpr, 4 * dpr]);
            ctx.beginPath();
            ctx.moveTo(padLeft, gy);
            ctx.lineTo(padLeft + chartW, gy);
            ctx.stroke();
        }
        ctx.setLineDash([]);

        /* Y axis labels */
        ctx.fillStyle = colors.axisText;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (var y = 0; y <= gridLines; y++) {
            ctx.fillText(
                formatRateAxis(maxVal * (1 - y / gridLines)),
                padLeft - 10 * dpr,
                padTop + (chartH / gridLines) * y
            );
        }

        /* X axis labels, anchored on the newest sample, spaced to avoid overlap */
        var withSeconds = (ts[n - 1] - ts[0]) < 600;
        var every = Math.max(1, Math.ceil((90 * dpr) / stepX));
        ctx.textBaseline = 'top';
        for (var t = n - 1; t >= 0; t -= every) {
            var label = formatTime(ts[t] || 0, withSeconds);
            var lx = xAt(t);
            var half = ctx.measureText(label).width / 2;
            if (t === n - 1) {
                ctx.textAlign = 'right';
            } else {
                if (lx - half < padLeft) break;
                ctx.textAlign = 'center';
            }
            ctx.fillText(label, lx, baseY + 10 * dpr);
        }

        /* Series */
        function points(data) {
            var p = [];
            for (var i = 0; i < n; i++) p.push([xAt(i), yAt(data[i])]);
            return p;
        }

        function drawArea(data, lineColor, fillColor) {
            var pts = points(data);

            var grad = ctx.createLinearGradient(0, padTop, 0, baseY);
            grad.addColorStop(0, fillColor);
            grad.addColorStop(1, 'rgba(0,0,0,0)');

            ctx.beginPath();
            traceSmooth(ctx, pts);
            ctx.lineTo(pts[n - 1][0], baseY);
            ctx.lineTo(pts[0][0], baseY);
            ctx.closePath();
            ctx.fillStyle = grad;
            ctx.fill();

            ctx.beginPath();
            traceSmooth(ctx, pts);
            ctx.strokeStyle = lineColor;
            ctx.lineWidth = 1.75 * dpr;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.stroke();

            /* Live endpoint marker */
            var end = pts[n - 1];
            ctx.fillStyle = fillColor;
            ctx.beginPath();
            ctx.arc(end[0], end[1], 7 * dpr, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = lineColor;
            ctx.beginPath();
            ctx.arc(end[0], end[1], 3 * dpr, 0, Math.PI * 2);
            ctx.fill();
        }

        drawArea(tx, colors.txLine, colors.txFill);
        drawArea(rx, colors.rxLine, colors.rxFill);

        /* Hover crosshair */
        var hi = OS.state.trafficHover;
        if (typeof hi === 'number' && hi >= 0 && hi < n) {
            var hx = Math.round(xAt(hi)) + 0.5;
            ctx.strokeStyle = colors.axisText;
            ctx.lineWidth = Math.max(1, dpr);
            ctx.setLineDash([2 * dpr, 3 * dpr]);
            ctx.beginPath();
            ctx.moveTo(hx, padTop);
            ctx.lineTo(hx, baseY);
            ctx.stroke();
            ctx.setLineDash([]);

            [[tx, colors.txLine], [rx, colors.rxLine]].forEach(function (s) {
                ctx.fillStyle = s[1];
                ctx.beginPath();
                ctx.arc(xAt(hi), yAt(s[0][hi]), 4 * dpr, 0, Math.PI * 2);
                ctx.fill();
            });
            updateReadout(hi);
        } else {
            updateReadout(n - 1);
        }
    };

    /* ---------- Sparkline ---------- */

    OS.drawTrafficSpark = function () {
        var canvas = OS.$('trafficSpark');
        if (!canvas) return;
        var ctx = canvas.getContext('2d');
        var dpr = window.devicePixelRatio || 1;
        var w = canvas.width = canvas.offsetWidth * dpr;
        var h = canvas.height = 36 * dpr;
        ctx.clearRect(0, 0, w, h);

        var colors = getColors();
        var hist = OS.state.trafficHistory;
        var rx = hist.rx, tx = hist.tx, n = rx.length;

        if (n < 2) {
            ctx.fillStyle = colors.collectText;
            ctx.font = (10 * dpr) + 'px ' + getFont();
            ctx.textBaseline = 'middle';
            ctx.fillText('Collecting traffic data\u2026', 8 * dpr, h / 2);
            return;
        }

        var max = Math.max(1, arrayMax(rx), arrayMax(tx));
        var step = w / Math.max(1, hist.maxPoints - 1);
        var pad = 3 * dpr;

        function pts(data) {
            var p = [];
            for (var i = 0; i < n; i++) {
                p.push([w - (n - 1 - i) * step, h - pad - (data[i] / max) * (h - pad * 2)]);
            }
            return p;
        }

        function series(data, lineColor, fillColor) {
            var p = pts(data);
            ctx.beginPath();
            traceSmooth(ctx, p);
            ctx.lineTo(p[n - 1][0], h);
            ctx.lineTo(p[0][0], h);
            ctx.closePath();
            ctx.fillStyle = fillColor;
            ctx.fill();

            ctx.beginPath();
            traceSmooth(ctx, p);
            ctx.strokeStyle = lineColor;
            ctx.lineWidth = 1.5 * dpr;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.stroke();
        }

        series(tx, colors.txLine, colors.txFill);
        series(rx, colors.rxLine, colors.rxFill);
    };
})(window.OS);

