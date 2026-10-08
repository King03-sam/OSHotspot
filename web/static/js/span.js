/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * span.js -- Switch SPAN Port Traffic Analysis & Anomaly Detection UI.
 */

(function (OS) {
    'use strict';

    var spanEventsList = [];
    var stats = {
        totalPackets: 0,
        dnsQueries: 0,
        webFlows: 0,
        anomalies: 0
    };

    function detailText(d) {
        if (!d) return '';
        if (typeof d === 'string') return d;
        if (d.hostname) return d.hostname;
        if (d.raw) return d.raw;
        return String(d);
    }

    OS.renderSpan = function () {
        document.getElementById('content').insertAdjacentHTML('beforeend',
            '<section class="view" id="view-span">'
            + '<div class="grid-2">'
            +     '<div class="card">'
            +         '<div class="card-header">'
            +             '<h2 class="card-title">'
            +                 '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:6px"><circle cx="12" cy="12" r="9"/><path d="M12 12l4.5-4.5"/><path d="M12 3a9 9 0 0 1 9 9"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>'
            +                 'SPAN Port Interface Configuration'
            +             '</h2>'
            +         '</div>'
            +         '<div class="card-body">'
            +             '<p class="text-muted" style="margin-bottom:16px">Configure a mirror port (SPAN) interface to capture and analyze network traffic logs from an external switch.</p>'
            +             '<form id="spanForm" onsubmit="submitSpanConfig(event)">'
            +                 '<div class="form-row">'
            +                     '<label class="checkbox-label">'
            +                         '<input type="checkbox" id="spanEnabled"> Enable SPAN Port Packet Capture'
            +                     '</label>'
            +                 '</div>'
            +                 '<div class="form-row">'
            +                     '<label for="spanIface">SPAN Interface</label>'
            +                     '<select id="spanIface"><option value="">Loading interfaces...</option></select>'
            +                     '<span class="form-hint">Network interface connected to the switch mirror port</span>'
            +                 '</div>'
            +                 '<div class="form-row form-actions">'
            +                     '<button type="submit" class="btn btn-primary" id="btnSaveSpan">Save SPAN Settings</button>'
            +                     '<span id="spanStatus" class="form-status"></span>'
            +                 '</div>'
            +             '</form>'
            +         '</div>'
            +     '</div>'

            +     '<div class="card">'
            +         '<div class="card-header"><h2 class="card-title">SPAN Analysis Summary</h2></div>'
            +         '<div class="card-body">'
            +             '<div class="metrics-grid" style="grid-template-columns: repeat(2, 1fr); gap: 12px;">'
            +                 '<div class="metric-card">'
            +                     '<span class="metric-label">Analyzed Packets</span>'
            +                     '<span class="metric-val" id="spanTotalPkts">0</span>'
            +                 '</div>'
            +                 '<div class="metric-card">'
            +                     '<span class="metric-label">DNS &amp; HTTP Queries</span>'
            +                     '<span class="metric-val" id="spanTotalFlows">0</span>'
            +                 '</div>'
            +                 '<div class="metric-card">'
            +                     '<span class="metric-label">Active Interface</span>'
            +                     '<span class="metric-val" id="spanActiveIface" style="font-size:15px;color:var(--accent)">-</span>'
            +                 '</div>'
            +                 '<div class="metric-card">'
            +                     '<span class="metric-label">Anomalies Detected</span>'
            +                     '<span class="metric-val text-red" id="spanTotalAnomalies">0</span>'
            +                     '<span onclick="openAnomalyHistory()" style="display:block;margin-top:8px;width:fit-content;padding:3px 10px;font-size:11px;font-weight:600;color:#fff;background:#3b82f6;border-radius:4px;cursor:pointer;transition:background 0.15s;" onmouseenter="this.style.background=\'#2563eb\'" onmouseleave="this.style.background=\'#3b82f6\'">View History</span>'
            +                 '</div>'
            +             '</div>'
            +         '</div>'
            +     '</div>'
            + '</div>'

            + '<div class="card" style="margin-top:20px">'
            +     '<div class="card-header" style="display:flex;justify-content:space-between;align-items:center">'
            +         '<h2 class="card-title">Real-Time Traffic &amp; Anomaly Stream</h2>'
            +         '<button type="button" class="btn btn-ghost btn-sm" onclick="clearSpanFeed()">Clear Feed</button>'
            +     '</div>'
            +     '<div class="card-body">'
            +         '<div class="table-container">'
            +             '<table class="data-table">'
                +                 '<thead><tr><th>Timestamp</th><th>Client MAC</th><th>Source IP</th><th>Type</th><th>Details / Target</th><th>Status</th></tr></thead>'
                +                 '<tbody id="spanEventsBody"><tr><td colspan="6" class="empty-row">Listening for SPAN port traffic flow &amp; anomalies...</td></tr></tbody>'
            +             '</table>'
            +         '</div>'
            +     '</div>'
            + '</div>'
            + '</section>'
        );

        // Listen for live SPAN events from SSE stream
        OS.live.on('span_event', function (msg) {
            handleSpanEvent(msg);
        });
    };

    function handleSpanEvent(data) {
        if (!data) return;
        stats.totalPackets++;
        if (data.event_type === 'anomaly' || data.anomaly) {
            stats.anomalies++;
        } else if (data.event_type === 'dns_query' || data.event_type === 'span_dns') {
            stats.dnsQueries++;
        } else {
            stats.webFlows++;
        }

        updateMetrics();

        spanEventsList.unshift(data);
        if (spanEventsList.length > 50) spanEventsList.pop();
        renderEventsTable();
    }

    function updateMetrics() {
        var elPkts = OS.$('spanTotalPkts');
        var elFlows = OS.$('spanTotalFlows');
        var elAnom = OS.$('spanTotalAnomalies');
        if (elPkts) elPkts.textContent = stats.totalPackets.toLocaleString();
        if (elFlows) elFlows.textContent = (stats.dnsQueries + stats.webFlows).toLocaleString();
        if (elAnom) elAnom.textContent = stats.anomalies.toLocaleString();
    }

    function renderEventsTable() {
        var tbody = OS.$('spanEventsBody');
        if (!tbody) return;
        if (spanEventsList.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty-row">Listening for SPAN port traffic flow &amp; anomalies...</td></tr>';
            return;
        }

        var html = '';
        for (var i = 0; i < spanEventsList.length; i++) {
            var item = spanEventsList[i];
            var badgeClass = 'badge-blue';
            var statusBadge = '<span class="status-chip chip-online">Normal</span>';

            if (item.anomaly || item.event_type === 'anomaly') {
                badgeClass = 'badge-red';
                statusBadge = '<span class="status-chip chip-offline" style="background:rgba(239,68,68,0.2);color:#ef4444;border:1px solid rgba(239,68,68,0.4);font-weight:600">' + (item.anomaly || 'ANOMALY') + '</span>';
            } else if (item.event_type === 'dns_query' || item.event_type === 'span_dns') {
                badgeClass = 'badge-gray';
            } else if (item.event_type === 'tls_connect') {
                badgeClass = 'badge-green';
            }

            var detail = detailText(item.detail) || item.domain || '-';
            html += '<tr>'
                + '<td class="mono" style="font-size:12px">' + (item.timestamp || '') + '</td>'
                + '<td class="mono">' + (item.client_mac || '-') + '</td>'
                + '<td class="mono">' + (item.ip || '-') + '</td>'
                + '<td><span class="badge ' + badgeClass + '">' + (item.event_type || 'span') + '</span></td>'
                + '<td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + OS.esc(detail) + '">' + OS.esc(detail) + '</td>'
                + '<td>' + statusBadge + '</td>'
                + '</tr>';
        }
        tbody.innerHTML = html;
    }

    window.clearSpanFeed = function () {
        spanEventsList = [];
        renderEventsTable();
    };

    function loadSpan() {
        var sel = OS.$('spanIface');

        OS.api('/api/span/interfaces').then(function (data) {
            if (!sel || !data || !data.interfaces) return;
            var ifaces = data.interfaces;
            sel.innerHTML = '';
            if (!ifaces.length) {
                sel.innerHTML = '<option value="">No interfaces found</option>';
                return;
            }
            for (var i = 0; i < ifaces.length; i++) {
                var opt = document.createElement('option');
                opt.value = ifaces[i].name;
                opt.textContent = ifaces[i].name + ' (' + (ifaces[i].state || '?') + ')';
                sel.appendChild(opt);
            }

            // After populating, load saved config to set the right value
            OS.api('/api/span').then(function (cfg) {
                if (!cfg) return;
                var chk = OS.$('spanEnabled');
                var activeIface = OS.$('spanActiveIface');
                if (chk) chk.checked = !!cfg.enabled;
                if (cfg.interface) sel.value = cfg.interface;
                if (activeIface) {
                    activeIface.textContent = cfg.enabled ? (cfg.interface || 'active') : 'Disabled';
                    activeIface.style.color = cfg.enabled ? 'var(--green)' : 'var(--text-muted)';
                }
            }).catch(function () {});
        }).catch(function () {
            // Fallback: if interface list fails, try loading config directly
            OS.api('/api/span').then(function (cfg) {
                if (!cfg) return;
                var chk = OS.$('spanEnabled');
                var activeIface = OS.$('spanActiveIface');
                if (chk) chk.checked = !!cfg.enabled;
                if (sel && cfg.interface) {
                    sel.innerHTML = '<option value="' + OS.esc(cfg.interface) + '">' + OS.esc(cfg.interface) + '</option>';
                }
                if (activeIface) {
                    activeIface.textContent = cfg.enabled ? (cfg.interface || 'active') : 'Disabled';
                    activeIface.style.color = cfg.enabled ? 'var(--green)' : 'var(--text-muted)';
                }
            }).catch(function () {});
        });
    }
    window.loadSpan = loadSpan;

    window.submitSpanConfig = function (e) {
        e.preventDefault();
        var enabled = OS.$('spanEnabled').checked;
        var iface = OS.$('spanIface').value.trim();
        var status = OS.$('spanStatus');

        var data = {
            span_enabled: enabled,
            span_interface: iface
        };

        OS.api('/api/config', 'POST', data).then(function () {
            if (status) { status.textContent = 'Saved SPAN configuration'; status.className = 'form-status ok'; }
            OS.toast('SPAN Analysis', 'Configuration saved', 'success');
            loadSpan();
        }).catch(function () {
            if (status) { status.textContent = 'Save failed'; status.className = 'form-status error'; }
        });
    };

    window.openAnomalyHistory = function () {
        OS.api('/api/span/anomalies').then(function (d) {
            var anomalies = (d && d.anomalies) ? d.anomalies : [];
            var rows = '';
            anomalies.forEach(function (a, i) {
                var bg = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.03)';
                rows += '<tr style="background:' + bg + ';border-bottom:1px solid var(--border);">'
                    + '<td style="padding:10px 12px;white-space:nowrap;">' + OS.esc(a.timestamp || '') + '</td>'
                    + '<td style="padding:10px 12px;font-family:var(--font-mono);font-size:13px;">' + OS.esc(a.client_mac || '') + '</td>'
                    + '<td style="padding:10px 12px;font-family:var(--font-mono);font-size:13px;">' + OS.esc(a.ip || '') + '</td>'
                    + '<td style="padding:10px 12px;"><span style="display:inline-block;padding:3px 10px;border-radius:20px;background:var(--red-light);color:var(--red);font-size:12px;font-weight:600;white-space:nowrap;">' + OS.esc(a.anomaly || '') + '</span></td>'
                    + '<td style="padding:10px 12px;color:var(--text-secondary);">' + OS.esc(detailText(a.detail)) + '</td>'
                    + '</tr>';
            });
            if (!rows) {
                rows = '<tr><td colspan="5" style="text-align:center;padding:40px 12px;color:var(--text-muted);">No anomalies recorded yet</td></tr>';
            }
            var overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.innerHTML =
                '<div class="modal-card" style="max-width:860px;width:95%;text-align:left;padding:0;">'
                + '<div style="display:flex;justify-content:space-between;align-items:center;padding:20px 24px;border-bottom:1px solid var(--border);">'
                + '<h2 style="margin:0;font-size:18px;color:var(--text-primary);">Anomaly History (Last 100)</h2>'
                + '<div style="display:flex;align-items:center;gap:12px;">'
                + '<button id="closeAnomalyModal" style="padding:6px 16px;border-radius:6px;background:var(--danger);color:#fff;cursor:pointer;border:none;font-size:13px;">Close</button>'
                + '<button id="closeAnomalyModalX" style="width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,0.08);color:var(--text-secondary);cursor:pointer;border:1px solid var(--border);font-size:18px;display:flex;align-items:center;justify-content:center;transition:background 0.15s;">&times;</button>'
                + '</div>'
                + '</div>'
                + '<div style="padding:0 24px 20px;max-height:60vh;overflow-y:auto;">'
                + '<table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px;">'
                + '<thead><tr style="border-bottom:2px solid var(--border-strong);text-align:left;">'
                + '<th style="padding:10px 12px;color:var(--text-muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Timestamp</th>'
                + '<th style="padding:10px 12px;color:var(--text-muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">MAC</th>'
                + '<th style="padding:10px 12px;color:var(--text-muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">IP</th>'
                + '<th style="padding:10px 12px;color:var(--text-muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Type</th>'
                + '<th style="padding:10px 12px;color:var(--text-muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Detail</th>'
                + '</tr></thead>'
                + '<tbody>' + rows + '</tbody>'
                + '</table></div></div>';
            document.body.appendChild(overlay);
            overlay.addEventListener('click', function (e) {
                if (e.target === overlay || e.target.id === 'closeAnomalyModal' || e.target.id === 'closeAnomalyModalX') {
                    overlay.remove();
                }
            });
            var xBtn = document.getElementById('closeAnomalyModalX');
            if (xBtn) {
                xBtn.addEventListener('mouseenter', function () { this.style.background = 'rgba(255,255,255,0.15)'; });
                xBtn.addEventListener('mouseleave', function () { this.style.background = 'rgba(255,255,255,0.08)'; });
            }
        }).catch(function () {
            OS.toast('SPAN Analysis', 'Failed to load anomaly history', 'error');
        });
    };
})(window.OS);
