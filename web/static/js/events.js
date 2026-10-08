/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * events.js, Events page split into two dedicated zones:
 *   1. Live Events  , real-time feed, auto-refresh every 5 s,
 *                       shows the last 5 minutes of activity.
 *   2. Known Devices , device inventory table (unchanged).
 *   3. Historical Events, manual search with type / MAC / time-range
 *                          filters, up to 500 results.
 *
 * Data comes from /api/events which degrades gracefully when the
 * event collector is not installed.
 */

(function (OS) {
    'use strict';

    /* The "Live Events" panel is fed from the SSE live stream (the
       same source that powers Live Activity), NOT overwritten by the
       events-DB poll.  The DB is only used as a one-time backfill on
       first load, and as a fallback when SSE is unavailable.  This is
       what makes visited sites show up live here instead of staying on
       "No events in the last 5 minutes." */
    var liveRows = [];        // newest-first list of row dicts
    var LIVE_CAP = 50;        // cap so the panel never grows unbounded
    var liveSeeded = false;   // have we backfilled from the DB yet?
    var lastLiveAt = 0;
    var lastBackfillAt = 0;
    var BACKFILL_MS = 5000;
    var SSE_STALE_MS = 5000;

    /* ── Render ─────────────────────────────────────────────────── */

    OS.renderEvents = function () {
        document.getElementById('content').insertAdjacentHTML('beforeend',
            '<section class="view" id="view-events">'

            /* ---- Card 1: Live Events ---- */
            + '<div class="card">'
            +     '<div class="card-header">'
            +       '<h2 class="card-title">'
            +             'Live Events '
            +             '<span class="live-pulse" title="Auto-refreshing"></span>'
            +         '</h2>'
            +         '<div class="card-header-actions">'
            +             '<span class="card-badge" id="liveCountBadge">0</span>'
            +             '<label class="toggle">'
            +                 '<input type="checkbox" id="eventsAutoRefresh" checked>'
            +                 '<span class="toggle-slider"></span>'
            +                 '<span class="toggle-label">Live</span>'
            +             '</label>'
            +             '<button class="btn btn-ghost btn-sm" onclick="refreshLiveEvents()">Refresh</button>'
            +         '</div>'
            +     '</div>'
            +     '<div class="card-body no-pad">'
            +         '<div class="table-wrap">'
            +             '<table class="data-table">'
            +                 '<thead><tr><th>Time</th><th>Event</th><th>Client</th><th>Details</th></tr></thead>'
            +                 '<tbody id="liveEventsBody"><tr><td colspan="4" class="empty-row">Waiting for live events\u2026</td></tr></tbody>'
            +             '</table>'
            +         '</div>'
            +     '</div>'
            + '</div>'

            /* ---- Card 2: Known Devices ---- */
            + '<div class="card">'
            +     '<div class="card-header">'
            +         '<h2 class="card-title">Known Devices</h2>'
            +         '<span class="card-badge" id="devicesCountBadge">0</span>'
            +     '</div>'
            +     '<div class="card-body no-pad">'
            +         '<div class="table-wrap">'
            +             '<table class="data-table">'
            +                 '<thead><tr><th>MAC Address</th><th>Hostname</th><th>Known Device</th><th>Status</th><th>First Seen</th><th>Actions</th></tr></thead>'
            +                 '<tbody id="devicesBody"><tr><td colspan="6" class="empty-row">No devices recorded yet</td></tr></tbody>'
            +             '</table>'
            +         '</div>'
            +     '</div>'
            + '</div>'

            /* ---- Card 3: Historical Events ---- */
            + '<div class="card">'
            +     '<div class="card-header">'
            +         '<h2 class="card-title">Historical Events</h2>'
            +         '<div class="card-header-actions">'
+             '<span class="card-badge" id="histCountBadge">0</span>'
+             '<button class="btn btn-danger btn-sm" onclick="openDeleteEventsModal()">Delete Events</button>'
+             '<button class="btn btn-ghost btn-sm" onclick="loadHistoricalEvents()">Search</button>'
            +         '</div>'
            +     '</div>'
            +     '<div class="card-body">'
            +         '<div class="events-filters" id="histFilters">'
            +             '<select id="histTypeFilter" class="events-input" onchange="loadHistoricalEvents()"><option value="">All types</option></select>'
            +             '<input type="text" id="histMacFilter" class="events-input" placeholder="Filter by MAC\u2026" oninput="debouncedHistLoad()">'
            +             '<input type="text" id="histFromFilter" class="events-input" placeholder="From YYYY-MM-DD HH:MM:SS" onchange="loadHistoricalEvents()">'
            +             '<input type="text" id="histToFilter" class="events-input" placeholder="To YYYY-MM-DD HH:MM:SS" onchange="loadHistoricalEvents()">'
            +         '</div>'
            +         '<div class="table-wrap">'
            +             '<table class="data-table">'
            +                 '<thead><tr><th>Time</th><th>Event</th><th>Client</th><th>Details</th></tr></thead>'
            +                 '<tbody id="histEventsBody"><tr><td colspan="4" class="empty-row">Use the filters above to search past events</td></tr></tbody>'
            +             '</table>'
            +         '</div>'
            +     '</div>'
            + '</div>'

            + '</section>'

            + '<div class="modal-overlay" id="deleteEventsModal" style="display:none">'
            +     '<div class="modal-card">'
            +         '<h2 class="modal-title">Delete Event History</h2>'
            +         '<p class="modal-message">Permanently delete events from the database. This cannot be undone.</p>'
            +         '<div class="form-group">'
            +             '<label class="form-label" for="deleteEventsCount">Number of events to delete</label>'
            +             '<input class="form-input" type="number" id="deleteEventsCount" min="1" max="10000" placeholder="e.g. 500">'
            +             '<span class="form-hint" id="deleteEventsHint">Large deletions run in batches of 10,000</span>'
            +         '</div>'
            +         '<div class="modal-actions">'
            +             '<button class="btn btn-ghost" onclick="closeDeleteEventsModal()">Cancel</button>'
            +             '<button class="btn btn-danger" onclick="confirmDeleteEvents()">Delete</button>'
            +         '</div>'
            +     '</div>'
            + '</div>'

            + '<div class="modal-overlay" id="deleteDeviceModal" style="display:none">'
            +     '<div class="modal-card">'
            +         '<h2 class="modal-title">Delete Known Device</h2>'
            +         '<p class="modal-message">Permanently remove <span id="deleteDeviceMac" class="mono"></span> from known devices? It will be treated as unknown on its next connection.</p>'
            +         '<div class="modal-actions">'
            +             '<button class="btn btn-ghost" onclick="closeDeleteDeviceModal()">Cancel</button>'
            +             '<button class="btn btn-danger" onclick="confirmDeleteDevice()">Delete</button>'
            +         '</div>'
            +     '</div>'
            + '</div>'
        );

        /* If the SSE stream already delivered rows before this section
           was opened (listeners are global), show them immediately
           instead of waiting for the next poll/refresh. */
        if (liveRows.length) renderLive();
    };

    /* ── Shared helpers ─────────────────────────────────────────── */

    function chipClass(type, e) {
        // High-priority alerts always use the red chip-alert style so
        // they stand out regardless of their event_type.
        if (e && e.priority === 'high') return 'chip-alert';
        if (type === 'unknown_device') return 'chip-unknown';
        if (type === 'anomaly_dns_flood') return 'chip-alert';
        if (type === 'alert') return 'chip-alert';
        if (type && type.indexOf('dhcp_') === 0) return 'chip-dhcp';
        return 'chip-dns';
    }

    function formatDetail(e) {
        var d = e.detail || {};
        // High-priority alert rows show the matched pattern + alert type.
        if (e.priority === 'high' || e.alert_type) {
            var dom = d.domain || '';
            var bits = [OS.esc(dom)];
            if (d.matched_pattern) {
                bits.push('<span class="text-muted">pattern: ' + OS.esc(d.matched_pattern) + '</span>');
            }
            if (e.alert_type) {
                bits.push('<span class="text-muted">' + OS.esc(e.alert_type) + '</span>');
            }
            if (d.query_type) {
                bits.push('<span class="text-muted">' + OS.esc(d.query_type) + ' \u00b7 ' + OS.esc(d.ip || '') + '</span>');
            }
            return bits.join(' ');
        }
        if (e.event_type === 'dns_query') {
            var dom2 = OS.esc(d.domain || '');
            var extra = [];
            if (e.category) extra.push(OS.esc(e.category));
            if (d.query_type) extra.push(OS.esc(d.query_type));
            if (d.ip) extra.push(OS.esc(d.ip));
            if (e.request_count && e.request_count > 1) extra.push('\u00d7' + e.request_count);
            if (extra.length) {
                dom2 += ' <span class="text-muted">' + extra.join(' \u00b7 ') + '</span>';
            }
            return dom2;
        }
        if (e.event_type && e.event_type.indexOf('dhcp_') === 0) {
            var parts = [OS.esc(d.ip || '')];
            if (d.hostname) parts.push(OS.esc(d.hostname));
            return parts.join(' <span class="text-muted">\u00b7</span> ');
        }
        if (e.event_type === 'unknown_device') {
            return OS.esc(d.hostname || '') || '<span class="text-muted">no hostname</span>';
        }
        if (e.event_type === 'anomaly_dns_flood') {
            return '&gt;' + OS.esc(d.count || '') + ' queries in ' + OS.esc(d.window || '') + 's';
        }
        return '<span class="text-muted">' + OS.esc(JSON.stringify(d)) + '</span>';
    }

    function buildRow(e) {
        return '<tr>'
            + '<td class="mono">' + OS.esc(e.last_seen || e.timestamp || '') + '</td>'
            + '<td><span class="event-chip ' + chipClass(e.event_type, e) + '">' + OS.esc(e.event_type) + '</span></td>'
            + '<td class="mono">' + clientCell(e) + '</td>'
            + '<td class="event-detail">' + formatDetail(e) + '</td>'
            + '</tr>';
    }

    function clientCell(e) {
        var mac = e.client_mac || '';
        var ip = (e.detail && e.detail.ip) || '';
        var hostname = e.hostname || (e.detail && e.detail.hostname) || '';
        var label = e.known_label || (e.known_device && e.known_device.label) || '';
        var lines = [];
        if (mac) {
            lines.push(OS.esc(mac));
        } else if (ip) {
            lines.push('<span class="text-muted">' + OS.esc(ip) + '</span>');
        } else {
            lines.push('-');
        }
        if (hostname) {
            lines.push('<span class="text-muted">' + OS.esc(hostname) + '</span>');
        }
        if (label && label !== 'unknown device') {
            lines.push('<span class="text-muted">' + OS.esc(label) + '</span>');
        }
        return lines.join('<br>');
    }

    function populateHistTypeFilter(types) {
        var sel = OS.$('histTypeFilter');
        if (!sel) return;
        var current = sel.value;
        var opts = ['<option value="">All types</option>'];
        (types || []).forEach(function (t) {
            opts.push('<option value="' + OS.esc(t) + '">' + OS.esc(t) + '</option>');
        });
        sel.innerHTML = opts.join('');
        if (current) sel.value = current;
    }

    function renderDevices(devices) {
        var body = OS.$('devicesBody');
        if (!body) return;
        var badge = OS.$('devicesCountBadge');
        if (badge) badge.textContent = devices.length;
        if (!devices.length) {
            body.innerHTML = '<tr><td colspan="6" class="empty-row">No devices recorded yet</td></tr>';
            return;
        }
        body.innerHTML = devices.map(function (d) {
            var status = d.label === 'unknown device'
                ? '<span class="event-chip chip-unknown">unknown</span>'
                : '<span class="event-chip chip-known">known</span>';
            return '<tr>'
                + '<td class="mono">' + OS.esc(d.mac) + '</td>'
                + '<td>' + (d.hostname ? OS.esc(d.hostname) : '<span class="text-muted">-</span>') + '</td>'
                + '<td>' + OS.esc(d.label || 'known device') + '</td>'
                + '<td>' + status + '</td>'
                + '<td class="mono">' + OS.esc(d.first_seen) + '</td>'
                + '<td class="kick-cell">'
                + '<button class="btn btn-danger btn-sm" onclick="openDeleteDeviceModal(\'' + OS.esc(d.mac) + '\')">Delete</button>'
                + '</td>'
                + '</tr>';
        }).join('');
    }

    /* Fetch only the known-devices inventory and re-render the table
       (used after a device is deleted so the Historical Events panel
       is not needlessly refreshed). */
    function loadDevices() {
        OS.api('/api/known-devices').then(function (data) {
            if (!Array.isArray(data)) data = [];
            renderDevices(data);
        }).catch(function () {});
    }

    /* ── Live Events ────────────────────────────────────────────── */

    /* Format a Date as "YYYY-MM-DD HH:MM:SS" in LOCAL time (not UTC).
       The server stores event timestamps via Python's time.strftime
       which uses the server's local timezone, so the query filter must
       also be in local time to match.  Using toISOString() here was a
       bug that caused events to be invisible when the browser's
       timezone is behind UTC. */
    function localIso(date) {
        var y = date.getFullYear();
        var m = String(date.getMonth() + 1).padStart(2, '0');
        var d = String(date.getDate()).padStart(2, '0');
        var h = String(date.getHours()).padStart(2, '0');
        var mi = String(date.getMinutes()).padStart(2, '0');
        var s = String(date.getSeconds()).padStart(2, '0');
        return y + '-' + m + '-' + d + ' ' + h + ':' + mi + ':' + s;
    }

    function renderLive() {
        var body = OS.$('liveEventsBody');
        if (!body) return;
        var badge = OS.$('liveCountBadge');
        if (badge) badge.textContent = liveRows.length;
        if (!liveRows.length) {
            body.innerHTML = '<tr><td colspan="4" class="empty-row">No events in the last 5 minutes.</td></tr>';
            return;
        }
        body.innerHTML = liveRows.map(buildRow).join('');
    }

    var liveRenderPending = false;
    var liveNeedsFlash = false;

    function scheduleLiveRender(flash) {
        if (flash) liveNeedsFlash = true;
        if (!(OS.isViewActive && OS.isViewActive('view-events'))) return;
        if (liveRenderPending) return;
        liveRenderPending = true;
        requestAnimationFrame(function () {
            liveRenderPending = false;
            renderLive();
            if (liveNeedsFlash) {
                liveNeedsFlash = false;
                flashLiveEvent();
            }
        });
    }

    /* Seed the Live panel from the events DB, but only ONCE and only if
       the SSE stream hasn't already delivered anything.  From then on
       the poll never clears rows here -- it just re-renders; the panel
       is fed purely by SSE (prependLiveEvent).  Pass force=true to
       replace rows from the DB (SSE stale / visibility restore). */
    window.loadLiveEvents = function (force) {
        var body = OS.$('liveEventsBody');
        if (!body) return;
        if (!force && (liveRows.length || liveSeeded)) {
            renderLive();
            return;
        }
        var nowMs = Date.now();
        if (!force && nowMs - lastBackfillAt < BACKFILL_MS) {
            renderLive();
            return;
        }
        lastBackfillAt = nowMs;

        /* from = now − 5 min in local time (must match server's local
           time since that's how event timestamps are stored). */
        var now = new Date(nowMs - 5 * 60 * 1000);
        var fromIso = localIso(now);

        OS.api('/api/events?from=' + encodeURIComponent(fromIso) + '&limit=50').then(function (data) {
            if (!data) {
                renderLive();
                return;
            }
            if (data.db_ok === false) {
                // DB not readable right now -- leave liveSeeded unset so
                // the poll automatically retries the backfill once the
                // database becomes readable again.
                body.innerHTML = '<tr><td colspan="4" class="empty-row" style="color:var(--red)">Events database is not readable in this moment.</td></tr>';
                return;
            }
            if (data.error) {
                liveSeeded = true;
                body.innerHTML = '<tr><td colspan="4" class="empty-row">' + OS.esc(data.error) + '</td></tr>';
                return;
            }
            liveSeeded = true;
            var events = data.events || [];
            if (events.length) {
                liveRows = events.slice(0, LIVE_CAP);
            } else if (force) {
                liveRows = [];
            }
            renderLive();
        }).catch(function () {
            renderLive();
        });
    };

    /* The 'Refresh' button forces a fresh backfill from the DB.  Unlike
       the auto-refresh poll, this clears the accumulated SSE rows first
       so the admin gets a clean, authoritative snapshot. */
    window.refreshLiveEvents = function () {
        liveRows = [];
        liveSeeded = false;
        window.loadLiveEvents();
        window.loadHistoricalEvents();
        OS.toast('Live Events refreshed',
                 'Reloaded the latest activity from the database', 'info');
    };

    /* ── Historical Events ──────────────────────────────────────── */

    var histMacTimer = null;

    window.debouncedHistLoad = function () {
        if (histMacTimer) clearTimeout(histMacTimer);
        histMacTimer = setTimeout(window.loadHistoricalEvents, 350);
    };

    function histFilters() {
        return {
            type: (OS.$('histTypeFilter') || {}).value || '',
            mac: ((OS.$('histMacFilter') || {}).value || '').trim(),
            from: ((OS.$('histFromFilter') || {}).value || '').trim(),
            to: ((OS.$('histToFilter') || {}).value || '').trim(),
            limit: 500
        };
    }

    window.loadHistoricalEvents = function () {
        var body = OS.$('histEventsBody');
        if (!body) return;

        var raw = histFilters();
        /* build query string, skipping empty values */
        var qs = [];
        if (raw.type)  qs.push('type='  + encodeURIComponent(raw.type));
        if (raw.mac)   qs.push('mac='   + encodeURIComponent(raw.mac));
        if (raw.from)  qs.push('from='  + encodeURIComponent(raw.from));
        if (raw.to)    qs.push('to='    + encodeURIComponent(raw.to));
        qs.push('limit=' + raw.limit);

        OS.api('/api/events?' + qs.join('&')).then(function (data) {
            if (!data) return;
            if (data.error) {
                body.innerHTML = '<tr><td colspan="4" class="empty-row">' + OS.esc(data.error) + '</td></tr>';
                return;
            }
            if (data.db_ok === false) {
                body.innerHTML = '<tr><td colspan="4" class="empty-row" style="color:var(--red)">Events database is not readable. Check Diagnostics &rsaquo; Event collector.</td></tr>';
                return;
            }
            var badge = OS.$('histCountBadge');
            var events = data.events || [];
            if (badge) badge.textContent = data.total != null ? data.total : events.length;
            populateHistTypeFilter(data.event_types);
            renderDevices(data.known_devices || []);
            if (!events.length) {
                body.innerHTML = '<tr><td colspan="4" class="empty-row">No events match the current filters</td></tr>';
                return;
            }
            body.innerHTML = events.map(buildRow).join('');
        }).catch(function () {
            body.innerHTML = '<tr><td colspan="4" class="empty-row" style="color:var(--red)">Failed to load events.</td></tr>';
        });
    };

    /* ── SSE live subscription ────────────────────────────────────
     *
     * If the unified SSE stream delivers a `dns_event` or `alert`
     * message while the Events page is visible, prepend it to the Live
     * Events table instantly -- no need to wait for the 5-second poll.
     * The existing polling interval continues to run as a fallback so
     * the page still works if SSE is unavailable (very old browser or
     * a misbehaving reverse proxy).
     */

    function liveRowFromMessage(msg) {
        msg = OS.normalizeLiveMessage ? OS.normalizeLiveMessage(msg) : msg;
        if (!msg) return null;
        return {
            timestamp: msg.timestamp || '',
            client_mac: msg.client_mac || '',
            hostname: msg.hostname || '',
            known_label: msg.known_label || '',
            event_type: msg.event_type || (msg.type === 'alert' ? 'alert' : 'dns_query'),
            detail: msg.detail || {},
            category: msg.category || '',
            priority: msg.priority || '',
            alert_type: msg.alert_type || '',
            request_count: msg.request_count || 1,
            _live: true
        };
    }

    function prependLiveEvent(e) {
        if (!e) return;
        lastLiveAt = Date.now();
        // Newest-first accumulation, capped.  DOM rebuild is deferred
        // and skipped while the Events view is inactive.
        liveRows.unshift(e);
        if (liveRows.length > LIVE_CAP) liveRows.length = LIVE_CAP;
        scheduleLiveRender(true);
    }

    function flashLiveEvent() {
        // Visual highlight: briefly nudge the newest row's background.
        // We rely on the existing .chip-alert / .chip-dns classes for
        // the chip color; here we just draw the admin's eye.
        try {
            var body = OS.$('liveEventsBody');
            if (body && body.firstChild) {
                body.firstChild.style.transition = 'background 0.5s';
                body.firstChild.style.background = 'var(--bg-hover)';
                setTimeout(function () {
                    body.firstChild.style.background = '';
                }, 600);
            }
        } catch (_) {}
    }

    OS.initEventsLive = function () {
        if (!OS.live) return;
        OS.live.on('dns_event', function (msg) {
            var row = liveRowFromMessage(msg);
            if (row) prependLiveEvent(row);
        });
        OS.live.on('alert', function (msg) {
            var row = liveRowFromMessage(msg);
            if (row) prependLiveEvent(row);
        });
        OS.live.on('_sse_stale', function () {
            if (!(OS.isViewActive && OS.isViewActive('view-events'))) return;
            liveSeeded = false;
            window.loadLiveEvents(true);
        });
        // When the tab becomes visible after being hidden (mobile users
        // switching back from another app), re-backfill from the DB so
        // events that arrived during the disconnection are not lost.
        OS.live.on('_visibility_restored', function () {
            if (!(OS.isViewActive && OS.isViewActive('view-events'))) return;
            liveSeeded = false;
            liveRows = [];
            window.loadLiveEvents(true);
        });

        setInterval(function () {
            if (document.hidden) return;
            var view = OS.$('view-events');
            if (!view || !view.classList.contains('active')) return;
            if (Date.now() - lastLiveAt < SSE_STALE_MS) return;
            liveSeeded = false;
            window.loadLiveEvents(true);
        }, 5000);
    };

    /* ── Backward-compat alias (used by app.js refreshAll) ──────── */
    window.loadEvents = function () {
        window.loadLiveEvents();
        window.loadHistoricalEvents();
    };
    window.refreshEvents = window.loadEvents;

    window.openDeleteEventsModal = function () {
        var modal = OS.$('deleteEventsModal');
        if (modal) modal.style.display = 'flex';
        var cnt = OS.$('deleteEventsCount');
        if (cnt) {
            cnt.disabled = false;
            cnt.value = '';
        }
    };

    window.closeDeleteEventsModal = function () {
        var modal = OS.$('deleteEventsModal');
        if (modal) modal.style.display = 'none';
    };

    var _deletingEvents = false;

    window.confirmDeleteEvents = function () {
        var input = OS.$('deleteEventsCount');
        var count = parseInt(input.value, 10);
        if (!count || count < 1) {
            OS.toast('Error', 'Enter a valid number', 'error');
            return;
        }
        if (_deletingEvents) return;

        var CHUNK = 10000;
        var total = 0;
        var remaining = count;
        var hintEl = OS.$('deleteEventsHint');

        var btnEls = document.querySelectorAll('#deleteEventsModal .btn');
        // Keep going until the requested number is reached or the
        // database runs out of events (a short chunk means none left).
        var runChunk = function () {
            var want = Math.min(CHUNK, remaining);
            OS.api('/api/events/delete', 'POST', { count: want }, OS.TIMEOUT_ACTION).then(function (data) {
                if (!data.ok) {
                    _deletingEvents = false;
                    if (hintEl) hintEl.textContent = 'Large deletions run in batches of 10,000';
                    for (var i = 0; i < btnEls.length; i++) btnEls[i].disabled = false;
                    OS.toast('Error', data.error || 'Failed to delete', 'error');
                    return;
                }
                total += data.deleted;
                remaining -= data.deleted;
                if (hintEl) hintEl.textContent = 'Deleting\u2026 ' + total + ' of ' + count + ' removed';
                if (data.deleted < want || remaining <= 0) {
                    done();
                    return;
                }
                runChunk();
            }).catch(function (err) {
                _deletingEvents = false;
                if (hintEl) hintEl.textContent = 'Large deletions run in batches of 10,000';
                for (var i = 0; i < btnEls.length; i++) btnEls[i].disabled = false;
                OS.toast('Error', err.message || 'Failed to delete', 'error');
            });
        };

        var done = function () {
            _deletingEvents = false;
            closeDeleteEventsModal();
            if (hintEl) hintEl.textContent = 'Large deletions run in batches of 10,000';
            for (var i = 0; i < btnEls.length; i++) btnEls[i].disabled = false;
            OS.toast('Deleted', total + ' events removed', 'success');
            loadHistoricalEvents();
        };

        // Close button should not be clickable mid-run; re-openers only
        // show the modal again.  Keep the overlay usable for the count
        // only at confirm time, so disable the action buttons instead.
        _deletingEvents = true;
        var cnt = OS.$('deleteEventsCount');
        if (cnt) cnt.disabled = true;
        for (var i = 0; i < btnEls.length; i++) btnEls[i].disabled = true;
        if (hintEl) hintEl.textContent = 'Deleting\u2026 0 of ' + count + ' removed';
        runChunk();
    };

    /* ── Delete known device ────────────────────────────────────── */

    var pendingDeleteMac = '';

    window.openDeleteDeviceModal = function (mac) {
        pendingDeleteMac = mac || '';
        var macEl = OS.$('deleteDeviceMac');
        if (macEl) macEl.textContent = pendingDeleteMac;
        var modal = OS.$('deleteDeviceModal');
        if (modal) modal.style.display = 'flex';
    };

    window.closeDeleteDeviceModal = function () {
        var modal = OS.$('deleteDeviceModal');
        if (modal) modal.style.display = 'none';
        pendingDeleteMac = '';
    };

    window.confirmDeleteDevice = function () {
        var mac = pendingDeleteMac;
        if (!mac) {
            closeDeleteDeviceModal();
            return;
        }
        closeDeleteDeviceModal();
        OS.api('/api/known-devices/delete', 'POST', { mac: mac }).then(function (data) {
            if (data.ok) {
                OS.toast('Deleted', mac + ' removed from known devices', 'success');
                loadDevices();
            } else {
                OS.toast('Error', data.error || 'Failed to delete', 'error');
            }
        }).catch(function (err) {
            OS.toast('Error', err.message || 'Failed to delete', 'error');
        });
    };
})(window.OS);
