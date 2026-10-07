/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * activity.js -- "Live Activity" page: renders the unified SSE stream
 * as a single newest-first feed so the admin can watch what clients
 * are doing in real time (sites visited, alerts triggered, devices
 * joining/leaving).
 *
 * Subscribes to four message types from the live stream:
 *   dns_event      -> a client resolved a domain (new or updated session)
 *   alert          -> forbidden / watched / flood alert (high priority)
 *   client_change  -> unknown_device / marked_known
 *   policy_change  -> admin edited a domain policy list (informational)
 *
 * The page is purely additive -- it doesn't touch the existing Events
 * page, which continues to work the way it always has.
 *
 * Live Activity keeps up to 200 rows in memory; older rows roll off
 * the top.  High-priority alerts are visually distinguished using the
 * existing chip-alert / chip-known CSS classes -- no new colors.
 */

(function (OS) {
    'use strict';

    var MAX_ROWS = 200;
    var rows = [];              // newest-first [{...}]
    var paused = false;
    var activitySeeded = false;
    var lastLiveAt = 0;
    var lastBackfillAt = 0;
    var BACKFILL_MS = 5000;
    var SSE_STALE_MS = 5000;

    function localIso(date) {
        var y = date.getFullYear();
        var m = String(date.getMonth() + 1).padStart(2, '0');
        var d = String(date.getDate()).padStart(2, '0');
        var h = String(date.getHours()).padStart(2, '0');
        var mi = String(date.getMinutes()).padStart(2, '0');
        var s = String(date.getSeconds()).padStart(2, '0');
        return y + '-' + m + '-' + d + ' ' + h + ':' + mi + ':' + s;
    }

    OS.renderActivity = function () {
        document.getElementById('content').insertAdjacentHTML('beforeend',
            '<section class="view" id="view-activity">'
            + '<div class="card">'
            +     '<div class="card-header">'
            +         '<h2 class="card-title">'
            +             'Live Activity '
            +             '<span class="live-pulse" id="activityLivePulse" title="Real-time feed"></span>'
            +         '</h2>'
            +         '<div class="card-header-actions">'
            +             '<span class="card-badge" id="activityStreamBadge" title="Live stream status">live</span>'
            +             '<span class="card-badge" id="activityCountBadge">0</span>'
            +             '<button class="btn btn-ghost btn-sm" id="activityPauseBtn" onclick="toggleActivityPause()">Pause</button>'
            +             '<button class="btn btn-ghost btn-sm" onclick="clearActivityFeed()">Clear</button>'
            +         '</div>'
            +     '</div>'
            +     '<div class="card-body no-pad">'
            +         '<div class="table-wrap">'
            +             '<table class="data-table">'
            +                 '<thead><tr><th>Time</th><th>Type</th><th>Client</th><th>Detail</th></tr></thead>'
            +                 '<tbody id="activityBody"><tr><td colspan="4" class="empty-row">Waiting for live events\u2026</td></tr></tbody>'
            +             '</table>'
            +         '</div>'
            +     '</div>'
            + '</div>'
            + '<div class="card">'
            +     '<div class="card-header"><h2 class="card-title">How it works</h2></div>'
            +     '<div class="card-body">'
            +         '<p class="text-muted" style="line-height:1.5;">'
            +             'This page shows every DNS lookup, alert and client change as it happens, pushed from the '
            +             'server over a single Server-Sent Events (SSE) connection.  Background noise (connectivity '
            +             'checks, OS telemetry) is filtered out before it reaches this feed -- use the Logs page to '
            +             'see the raw dnsmasq log if you need the full audit trail.  Consecutive DNS queries from '
            +             'the same client toward the same domain are merged into a single row with a request count; '
            +             'a new row is only added when the client moves on to a different site, or after 5 minutes '
            +             'of inactivity.'
            +         '</p>'
            +     '</div>'
            + '</div>'
            + '</section>'
        );
    };

    /* ── Row rendering ──────────────────────────────────────────── */

    function chipClass(msg) {
        msg = OS.normalizeLiveMessage ? OS.normalizeLiveMessage(msg) : msg;
        if (!msg) return 'chip-dns';
        if (msg.type === 'alert') return 'chip-alert';
        if (msg.type === 'client_change') {
            if (msg.subtype === 'unknown_device') return 'chip-unknown';
            if (msg.subtype === 'disconnect') return 'chip-alert';
            return 'chip-known';
        }
        if (msg.type === 'policy_change') return 'chip-dhcp';
        if (msg.type === 'dns_event') {
            var cat = msg.category || '';
            if (cat === 'messaging')     return 'chip-dhcp';
            if (cat === 'social')        return 'chip-dhcp';
            if (cat === 'entertainment') return 'chip-dhcp';
            return 'chip-dns';
        }
        return 'chip-dns';
    }

    function typeLabel(msg) {
        msg = OS.normalizeLiveMessage ? OS.normalizeLiveMessage(msg) : msg;
        if (!msg) return 'event';
        if (msg.type === 'dns_event') {
            if (msg.is_update) return 'dns\u00b7update';
            return 'dns_query';
        }
        if (msg.type === 'alert') {
            if (msg.alert_type === 'forbidden') return 'forbidden';
            if (msg.alert_type === 'watched')   return 'watched';
            if (msg.alert_type === 'flood')     return 'dns_flood';
            return 'alert';
        }
        if (msg.type === 'client_change') {
            if (msg.subtype === 'unknown_device') return 'unknown_dev';
            if (msg.subtype === 'marked_known')   return 'marked_known';
            if (msg.subtype === 'connect')        return 'connected';
            if (msg.subtype === 'disconnect')     return 'disconnected';
            return 'client_change';
        }
        if (msg.type === 'policy_change') {
            return 'policy_' + (msg.action || 'change');
        }
        return msg.type || 'event';
    }

    function formatDetail(msg) {
        msg = OS.normalizeLiveMessage ? OS.normalizeLiveMessage(msg) : msg;
        if (!msg) return '<span class="text-muted">unknown</span>';
        var d = msg.detail || msg;
        if (msg.type === 'dns_event') {
            var dom = d.domain || '';
            var extra = [];
            if (msg.category) extra.push(OS.esc(msg.category));
            if (d.query_type) extra.push(OS.esc(d.query_type));
            if (d.ip) extra.push(OS.esc(d.ip));
            if (msg.request_count > 1) extra.push('\u00d7' + OS.esc(msg.request_count));
            if (!extra.length) return OS.esc(dom);
            return OS.esc(dom) + ' <span class="text-muted">' + extra.join(' \u00b7 ') + '</span>';
        }
        if (msg.type === 'alert') {
            var dom = d.domain || '';
            var pat = d.matched_pattern ? ' <span class="text-muted">(' + OS.esc(d.matched_pattern) + ')</span>' : '';
            return OS.esc(dom) + pat;
        }
        if (msg.type === 'client_change') {
                if (msg.subtype === 'unknown_device') {
                    return 'New device: ' + OS.esc(msg.hostname || msg.client_mac || 'no hostname');
                }
            if (msg.subtype === 'marked_known') {
                return 'Marked as known: ' + OS.esc(msg.label || 'known device');
            }
            if (msg.subtype === 'connect') {
                return 'Device connected: ' + OS.esc(msg.hostname || msg.ip || 'no hostname');
            }
            if (msg.subtype === 'disconnect') {
                return 'Device disconnected';
            }
            return OS.esc(msg.subtype || '');
        }
        if (msg.type === 'policy_change') {
            return OS.esc(msg.action || '') + ' ' + OS.esc(msg.pattern || '') + ' in ' + OS.esc(msg.table || '');
        }
        return '<span class="text-muted">' + OS.esc(JSON.stringify(d)) + '</span>';
    }

    function buildRow(msg) {
        msg = OS.normalizeLiveMessage ? OS.normalizeLiveMessage(msg) : msg;
        if (!msg) return '';
        var ts = msg.last_seen || msg.timestamp || '';
        // Take only the time portion for compactness when the date is today.
        if (ts.length === 19 && ts.indexOf(' ') > 0) {
            var today = new Date().toISOString().slice(0, 10);
            if (ts.indexOf(today) === 0) ts = ts.slice(11);
        }
        return '<tr>'
            + '<td class="mono">' + OS.esc(ts) + '</td>'
            + '<td><span class="event-chip ' + chipClass(msg) + '">' + OS.esc(typeLabel(msg)) + '</span></td>'
            + '<td class="mono">' + clientCell(msg) + '</td>'
            + '<td class="event-detail">' + formatDetail(msg) + '</td>'
            + '</tr>';
    }

    function clientCell(msg) {
        msg = OS.normalizeLiveMessage ? OS.normalizeLiveMessage(msg) : msg;
        if (!msg) return OS.esc('\u2014');
        var mac = msg.client_mac || '\u2014';
        var hostname = msg.hostname || (msg.detail && msg.detail.hostname) || '';
        var label = msg.known_label || msg.label || '';
        var lines = [OS.esc(mac)];
        if (hostname) {
            lines.push('<span class="text-muted">' + OS.esc(hostname) + '</span>');
        }
        if (label && label !== 'unknown device') {
            lines.push('<span class="text-muted">' + OS.esc(label) + '</span>');
        }
        return lines.join('<br>');
    }

    function render() {
        var body = OS.$('activityBody');
        if (!body) return;
        var badge = OS.$('activityCountBadge');
        if (badge) badge.textContent = rows.length;
        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="4" class="empty-row">No live events yet\u2026</td></tr>';
            return;
        }
        body.innerHTML = rows.map(buildRow).filter(Boolean).join('');
    }

    var renderPending = false;
    var needsFlash = false;

    function scheduleRender(flash) {
        if (flash) needsFlash = true;
        if (!(OS.isViewActive && OS.isViewActive('view-activity'))) return;
        if (renderPending) return;
        renderPending = true;
        requestAnimationFrame(function () {
            renderPending = false;
            render();
            if (needsFlash) {
                needsFlash = false;
                flashActivityRow();
            }
        });
    }

    function pushRow(msg) {
        if (paused) return;
        msg = OS.normalizeLiveMessage ? OS.normalizeLiveMessage(msg) : msg;
        if (!msg) return;
        lastLiveAt = Date.now();
        rows.unshift(msg);
        if (rows.length > MAX_ROWS) rows.length = MAX_ROWS;
        scheduleRender(true);
    }

    function updateRow(msg) {
        if (paused) return;
        msg = OS.normalizeLiveMessage ? OS.normalizeLiveMessage(msg) : msg;
        if (!msg) return;
        lastLiveAt = Date.now();
        // Try to find an existing row with the same id and update it, moving to top.
        if (msg.id != null) {
            for (var i = 0; i < rows.length; i++) {
                if (rows[i].id === msg.id) {
                    rows.splice(i, 1);
                    rows.unshift(msg);
                    scheduleRender(true);
                    return;
                }
            }
        }
        // No matching id -- just push as a new row.
        pushRow(msg);
    }

    function flashActivityRow() {
        try {
            var body = OS.$('activityBody');
            if (body && body.firstChild) {
                body.firstChild.style.transition = 'background 0.5s';
                body.firstChild.style.background = 'var(--bg-hover)';
                setTimeout(function () {
                    if (body.firstChild) body.firstChild.style.background = '';
                }, 600);
            }
        } catch (_) {}
    }

    function updateStreamBadge(mode) {
        var badge = OS.$('activityStreamBadge');
        var pulse = OS.$('activityLivePulse');
        if (!badge) return;
        if (mode === 'live') {
            badge.textContent = 'live';
            badge.style.color = 'var(--green)';
            if (pulse) pulse.classList.remove('offline');
        } else if (mode === 'reconnecting') {
            badge.textContent = 'reconnecting';
            badge.style.color = 'var(--amber)';
            if (pulse) pulse.classList.add('offline');
        } else {
            badge.textContent = 'polling';
            badge.style.color = 'var(--text-muted)';
            if (pulse) pulse.classList.add('offline');
        }
    }

    function mergeBackfillRows(events) {
        var incoming = [];
        (events || []).forEach(function (event) {
            var msg = OS.normalizeLiveMessage ? OS.normalizeLiveMessage(event) : event;
            if (msg) incoming.push(msg);
        });
        incoming.sort(function (a, b) {
            var tsA = a.last_seen || a.timestamp || '';
            var tsB = b.last_seen || b.timestamp || '';
            return tsB.localeCompare(tsA);
        });
        rows = incoming.slice(0, MAX_ROWS);
        scheduleRender(false);
    }

    window.loadActivityFeed = function (force) {
        var body = OS.$('activityBody');
        if (!body) return;
        if (!force && (activitySeeded || rows.length)) {
            render();
            return;
        }
        var nowMs = Date.now();
        if (!force && nowMs - lastBackfillAt < BACKFILL_MS) return;
        lastBackfillAt = nowMs;

        var from = new Date(nowMs - 5 * 60 * 1000);
        OS.api('/api/events?from=' + encodeURIComponent(localIso(from)) + '&limit=50').then(function (data) {
            if (!data) {
                render();
                return;
            }
            if (data.db_ok === false) {
                body.innerHTML = '<tr><td colspan="4" class="empty-row" style="color:var(--red)">Events database is not readable in this moment.</td></tr>';
                return;
            }
            if (data.error) {
                activitySeeded = true;
                body.innerHTML = '<tr><td colspan="4" class="empty-row">' + OS.esc(data.error) + '</td></tr>';
                return;
            }
            activitySeeded = true;
            mergeBackfillRows(data.events || []);
        }).catch(function () {
            render();
        });
    };

    /* ── SSE subscription ───────────────────────────────────────── */

    OS.initActivityLive = function () {
        if (!OS.live) return;
        updateStreamBadge('polling');
        OS.live.on('dns_event', function (msg) {
            updateStreamBadge('live');
            if (msg.is_update) updateRow(msg);
            else pushRow(msg);
        });
        OS.live.on('alert', function (msg) {
            updateStreamBadge('live');
            pushRow(msg);
        });
        OS.live.on('client_change', function (msg) {
            updateStreamBadge('live');
            pushRow(msg);
        });
        OS.live.on('policy_change', function (msg) {
            updateStreamBadge('live');
            pushRow(msg);
        });
        OS.live.on('traffic_sample', function (msg) {
            updateStreamBadge('live');
            pushRow(msg);
        });
        OS.live.on('_sse_stale', function () {
            updateStreamBadge('polling');
            if (!(OS.isViewActive && OS.isViewActive('view-activity'))) return;
            activitySeeded = false;
            window.loadActivityFeed(true);
        });
        // When the tab becomes visible after being hidden, re-fetch
        // recent events from the DB to catch up on anything missed
        // while the SSE connection was down (mobile backgrounding).
        OS.live.on('_visibility_restored', function () {
            if (!(OS.isViewActive && OS.isViewActive('view-activity'))) return;
            activitySeeded = false;
            window.loadActivityFeed(true);
        });

        setInterval(function () {
            if (document.hidden) return;
            var view = OS.$('view-activity');
            if (!view || !view.classList.contains('active')) return;
            if (OS.live.connected === false) {
                updateStreamBadge('reconnecting');
            } else if (OS.live.lastPayloadAt && Date.now() - OS.live.lastPayloadAt < SSE_STALE_MS) {
                updateStreamBadge('live');
            }
            if (Date.now() - lastLiveAt < SSE_STALE_MS) return;
            updateStreamBadge('polling');
            activitySeeded = false;
            window.loadActivityFeed(true);
        }, 5000);
    };

    /* ── Buttons ────────────────────────────────────────────────── */

    window.toggleActivityPause = function () {
        paused = !paused;
        var btn = OS.$('activityPauseBtn');
        if (btn) btn.textContent = paused ? 'Resume' : 'Pause';
        OS.toast(paused ? 'Live feed paused' : 'Live feed resumed',
                 paused ? 'New events will be hidden until you resume' : 'Showing new events again',
                 paused ? 'warn' : 'success');
    };

    window.clearActivityFeed = function () {
        rows = [];
        activitySeeded = false;
        render();
    };
})(window.OS);
