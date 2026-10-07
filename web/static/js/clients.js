/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * clients.js — connected-device table on the Clients page, plus the
 * small client-count badges shown elsewhere in the UI, the
 * blocked-devices list, and the "Mark as known" action that lets the
 * admin attach a friendly label to a device MAC.
 *
 * The known-devices inventory is fetched from /api/known-devices on
 * every refresh (it's a small list, so the extra round-trip is
 * cheap) and used to decorate each row with a "known" / "unknown"
 * chip plus the friendly label if one has been set.
 *
 * Marking a device as known also fires a `client_change` event on the
 * live stream so any open Events / Live Activity page picks it up
 * instantly without polling.
 */

(function (OS) {
    'use strict';

    // Cache of known-devices so we can decorate rows without waiting
    // for two fetches to round-trip.  Refreshed on every refreshClients().
    var knownDevices = {};

    OS.renderClients = function () {
        document.getElementById('content').insertAdjacentHTML('beforeend',
            '<section class="view" id="view-clients">'
            + '<div class="card">'
            +         '<div class="card-header">'
            +             '<h2 class="card-title">Connected Clients</h2>'
            +             '<div class="card-header-actions">'
            +                 '<span class="card-badge" id="clientsCountBadge">0</span>'
            +                 '<button class="btn btn-ghost btn-sm" onclick="openBulkImport()">Bulk import</button>'
            +                 '<label class="toggle">'
            +                     '<input type="checkbox" id="clientsAutoRefresh" checked>'
            +                     '<span class="toggle-slider"></span>'
            +                     '<span class="toggle-label">Auto-refresh</span>'
            +                 '</label>'
            +             '</div>'
            +         '</div>'
            +     '<div class="card-body no-pad">'
            +         '<div class="table-wrap">'
            +             '<table class="data-table">'
            +                 '<thead><tr><th>#</th><th>MAC Address</th><th>IP Address</th><th>Hostname</th><th>Status</th><th>Known</th><th>Actions</th></tr></thead>'
            +                 '<tbody id="clientsBody"><tr><td colspan="7" class="empty-row">No clients connected</td></tr></tbody>'
            +             '</table>'
            +         '</div>'
            +     '</div>'
            + '</div>'
            + '<div class="card" id="blockedSection" style="display:none">'
            +     '<div class="card-header">'
            +         '<h2 class="card-title">Blocked Devices</h2>'
            +         '<span class="card-badge" id="blockedCountBadge">0</span>'
            +     '</div>'
            +     '<div class="card-body no-pad">'
            +         '<div class="table-wrap">'
            +             '<table class="data-table">'
            +                 '<thead><tr><th>#</th><th>MAC Address</th><th>Actions</th></tr></thead>'
            +                 '<tbody id="blockedBody"><tr><td colspan="3" class="empty-row">No blocked devices</td></tr></tbody>'
            +             '</table>'
            +         '</div>'
            +     '</div>'
            + '</div>'
            + '</section>'
        );
    };

    function fetchKnownDevices() {
        return OS.api('/api/known-devices').then(function (devs) {
            if (!Array.isArray(devs)) devs = [];
            knownDevices = {};
            for (var i = 0; i < devs.length; i++) {
                var d = devs[i];
                if (d && d.mac) {
                    knownDevices[d.mac.toLowerCase()] = d;
                }
            }
        }).catch(function () {});
    }

    function setClientCount(count) {
        var navPillClients = OS.$('navPillClients');
        if (navPillClients) navPillClients.textContent = count;
        var valClients = OS.$('valClients');
        if (valClients) valClients.textContent = count;
        var clientsCountBadge = OS.$('clientsCountBadge');
        if (clientsCountBadge) clientsCountBadge.textContent = count;
    }

    function renderClientsUnavailable(message) {
        setClientCount(0);
        var tbody = OS.$('clientsBody');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty-row text-red">'
                + OS.esc(message || 'Server unreachable')
                + '</td></tr>';
        }
        var blockedSection = OS.$('blockedSection');
        if (blockedSection) blockedSection.style.display = 'none';
    }

    var _isRefreshingClients = false;

    OS.refreshClients = function () {
        if (_isRefreshingClients) return;
        _isRefreshingClients = true;
        // Fetch the known-devices cache in parallel with the client
        // list so the row decoration doesn't add latency.
        var knownPromise = fetchKnownDevices();
        OS.api('/api/clients').then(function (clients) {
            _isRefreshingClients = false;
            if (!Array.isArray(clients)) clients = [];
            var tbody = OS.$('clientsBody');
            var activeClients = [];
            for (var k = 0; k < clients.length; k++) {
                if (clients[k].status === 'active') activeClients.push(clients[k]);
            }
            var count = activeClients.length;
            setClientCount(count);

            if (!count) {
                tbody.innerHTML = '<tr><td colspan="7" class="empty-row">No clients connected</td></tr>';
                loadBlocked();
                return;
            }

            // Wait for the known-devices cache before rendering so we
            // can decorate each row with the right chip + label.
            knownPromise.then(function () {
                var html = '';
                for (var i = 0; i < count; i++) {
                    var c = activeClients[i];
                    var statusHtml = c.status === 'active'
                        ? '<span class="client-active">active</span>'
                        : '<span class="client-inactive">' + OS.esc(c.status || '—') + '</span>';
                    var kickBtn = c.status === 'active'
                        ? '<button class="btn btn-ghost btn-sm" onclick="kickClient(\'' + OS.esc(c.mac) + '\')">Kick</button>'
                        : '';

                    // Known-device decoration.
                    var macLower = (c.mac || '').toLowerCase();
                    var known = knownDevices[macLower];
                    var knownChip;
                    var markBtn;
                    var removeBtn = '';
                    if (known && known.label && known.label !== 'unknown device') {
                        knownChip = '<span class="event-chip chip-known" title="' + OS.esc(known.label) + '">' + OS.esc(known.label) + '</span>';
                        markBtn = '<button class="btn btn-ghost btn-sm" onclick="markClientKnown(\'' + OS.esc(c.mac) + '\')">Edit</button>';
                        removeBtn = ' <button class="btn btn-ghost btn-sm" onclick="confirmRemoveKnown(\'' + OS.esc(c.mac) + '\')">Remove</button>';
                    } else {
                        knownChip = '<span class="event-chip chip-unknown">unknown</span>';
                        markBtn = '<button class="btn btn-ghost btn-sm" onclick="markClientKnown(\'' + OS.esc(c.mac) + '\')">Mark known</button>';
                    }

                    html += '<tr>'
                        + '<td>' + (i + 1) + '</td>'
                        + '<td class="mono">' + OS.esc(c.mac) + '</td>'
                        + '<td>' + OS.esc(c.ip) + '</td>'
                        + '<td>' + OS.esc(c.hostname || '—') + '</td>'
                        + '<td>' + statusHtml + '</td>'
                        + '<td>' + knownChip + '</td>'
                        + '<td class="kick-cell">' + markBtn + removeBtn + ' ' + kickBtn + '</td>'
                        + '</tr>';
                }
                tbody.innerHTML = html;
                loadBlocked();
            });
        }).catch(function () {
            _isRefreshingClients = false;
            renderClientsUnavailable('Server unreachable - client status unavailable');
        });
    };

    function loadBlocked() {
        OS.api('/api/blocked').then(function (macs) {
            if (!Array.isArray(macs)) macs = [];
            var section = OS.$('blockedSection');
            var tbody = OS.$('blockedBody');
            var badge = OS.$('blockedCountBadge');
            if (!section || !tbody) return;

            if (!macs.length) {
                section.style.display = 'none';
                return;
            }
            section.style.display = '';
            if (badge) badge.textContent = macs.length;

            var html = '';
            for (var i = 0; i < macs.length; i++) {
                html += '<tr>'
                    + '<td>' + (i + 1) + '</td>'
                    + '<td>' + OS.esc(macs[i]) + '</td>'
                    + '<td class="kick-cell">'
                    + '<button class="btn btn-ghost btn-sm" onclick="unblockClient(\'' + OS.esc(macs[i]) + '\')">Unblock</button>'
                    + '</td>'
                    + '</tr>';
            }
            tbody.innerHTML = html;
        }).catch(function () {});
    }

    window.kickClient = function (mac) {
        OS.api('/api/kick', 'POST', { mac: mac }, OS.TIMEOUT_ACTION).then(function (res) {
            OS.toast(res.ok ? 'Client blocked & disconnected' : 'Kick failed',
                     res.ok ? mac : (res.error || 'Unknown error'),
                     res.ok ? 'success' : 'error');
            OS.refreshClients();
        }).catch(function (err) {
            OS.toast('Kick failed', err.message || 'Could not reach server', 'error');
        });
    };

    window.unblockClient = function (mac) {
        OS.api('/api/unblock', 'POST', { mac: mac }, OS.TIMEOUT_ACTION).then(function (res) {
            OS.toast(res.ok ? 'Client unblocked' : 'Unblock failed',
                     res.ok ? mac : (res.error || 'Unknown error'),
                     res.ok ? 'success' : 'error');
            OS.refreshClients();
        }).catch(function (err) {
            OS.toast('Unblock failed', err.message || 'Could not reach server', 'error');
        });
    };

    /* ── Mark as known ────────────────────────────────────────────
     *
     * Uses a small inline prompt (browser native) so we don't need to
     * build a modal.  The chosen label is sent to /api/known-devices
     * which upserts into the known_devices table.  The server pushes
     * a `client_change` event on the live stream so any open Events /
     * Live Activity page reflects the change instantly.
     */
    window.markClientKnown = function (mac) {
        if (!mac) return;
        var current = knownDevices[mac.toLowerCase()] || {};
        var currentLabel = (current.label && current.label !== 'unknown device')
            ? current.label : '';
        var currentType = current.device_type || '';
        var currentNotes = current.notes || '';

        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'markKnownModal';
        overlay.innerHTML =
            '<div class="modal-card">'
            + '<h2 class="modal-title">Mark ' + OS.esc(mac) + ' as known</h2>'
            + '<p class="modal-message">Enter a friendly label for this device '
            + '(e.g. "Sam\'s iPhone", "Lobby laptop", "Guest tablet").</p>'
            + '<div class="form-group" style="text-align:left">'
            +     '<label class="form-label" for="mkLabel">Label</label>'
            +     '<input class="form-input" type="text" id="mkLabel" '
            +         'placeholder="known device" value="' + OS.esc(currentLabel) + '">'
            + '</div>'
            + '<div class="form-group" style="text-align:left">'
            +     '<label class="form-label" for="mkType">Device type (optional)</label>'
            +     '<select class="form-input" id="mkType">'
            +         '<option value="">--</option>'
            +         '<option value="phone"' + (currentType === 'phone' ? ' selected' : '') + '>Phone</option>'
            +         '<option value="laptop"' + (currentType === 'laptop' ? ' selected' : '') + '>Laptop</option>'
            +         '<option value="tablet"' + (currentType === 'tablet' ? ' selected' : '') + '>Tablet</option>'
            +         '<option value="other"' + (currentType === 'other' ? ' selected' : '') + '>Other</option>'
            +     '</select>'
            + '</div>'
            + '<div class="form-group" style="text-align:left">'
            +     '<label class="form-label" for="mkNotes">Notes (optional)</label>'
            +     '<input class="form-input" type="text" id="mkNotes" '
            +         'placeholder="Any additional notes" value="' + OS.esc(currentNotes) + '">'
            + '</div>'
            + '<div class="modal-actions">'
            +     '<button class="btn btn-ghost" onclick="closeMarkKnownModal()">Cancel</button>'
            +     '<button class="btn btn-primary" onclick="submitMarkKnown(\'' + OS.esc(mac) + '\')">OK</button>'
            + '</div>'
            + '</div>';

        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeMarkKnownModal();
        });
        document.addEventListener('keydown', function escHandler(e) {
            if (e.key === 'Escape') {
                closeMarkKnownModal();
                document.removeEventListener('keydown', escHandler);
            }
        });
        document.body.appendChild(overlay);
        document.getElementById('mkLabel').focus();
    };

    window.closeMarkKnownModal = function () {
        var el = document.getElementById('markKnownModal');
        if (el) el.remove();
    };

    window.submitMarkKnown = function (mac) {
        var label = (document.getElementById('mkLabel').value || '').trim();
        var deviceType = (document.getElementById('mkType').value || '').trim();
        var notes = (document.getElementById('mkNotes').value || '').trim();
        closeMarkKnownModal();
        OS.api('/api/known-devices', 'POST', {
            mac: mac,
            label: label,
            device_type: deviceType,
            notes: notes
        }).then(function (res) {
            if (!res || !res.ok) {
                OS.toast('Mark known failed', (res && res.error) || 'Unknown error', 'error');
                return;
            }
            OS.toast('Marked as known', mac + (res.label ? ' \u2192 ' + res.label : ''), 'success');
            OS.refreshClients();
        }).catch(function (err) {
            OS.toast('Could not reach server', err.message || 'Please retry', 'error');
        });
    };

    /* ── Remove known device ────────────────────────────────────── */

    window.confirmRemoveKnown = function (mac) {
        if (!mac) return;
        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'removeKnownModal';
        overlay.innerHTML =
            '<div class="modal-card">'
            + '<h2 class="modal-title">Remove from known devices</h2>'
            + '<p class="modal-message">' + OS.esc(mac) + ' will be treated as '
            + 'unknown on its next connection.</p>'
            + '<div class="modal-actions">'
            +     '<button class="btn btn-ghost" onclick="closeRemoveKnownModal()">Cancel</button>'
            +     '<button class="btn btn-danger" onclick="removeKnownDevice(\'' + OS.esc(mac) + '\')">Remove</button>'
            + '</div>'
            + '</div>';
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeRemoveKnownModal();
        });
        document.addEventListener('keydown', function escHandler(e) {
            if (e.key === 'Escape') {
                closeRemoveKnownModal();
                document.removeEventListener('keydown', escHandler);
            }
        });
        document.body.appendChild(overlay);
    };

    window.closeRemoveKnownModal = function () {
        var el = document.getElementById('removeKnownModal');
        if (el) el.remove();
    };

    window.removeKnownDevice = function (mac) {
        closeRemoveKnownModal();
        OS.api('/api/known-devices/delete', 'POST', { mac: mac }).then(function (res) {
            if (!res || !res.ok) {
                OS.toast('Remove failed', (res && res.error) || 'Unknown error', 'error');
                return;
            }
            OS.toast('Removed', mac + ' is now unknown', 'success');
            OS.refreshClients();
        }).catch(function (err) {
            OS.toast('Remove failed', err.message || 'Could not reach server', 'error');
        });
    };

    /* ── Bulk import ────────────────────────────────────────────── */

    window.openBulkImport = function () {
        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'bulkImportModal';
        overlay.innerHTML =
            '<div class="modal-card" style="max-width:440px">'
            + '<h2 class="modal-title">Bulk import known devices</h2>'
            + '<p class="modal-message">Paste one device per line.  Format: '
            + '<code>MAC, Label, Type, Notes</code>.  Only MAC is required; '
            + 'leave the rest blank to skip.  Types: phone, laptop, tablet, other.</p>'
            + '<div class="form-group" style="text-align:left">'
            +     '<textarea class="form-input" id="bulkImportText" rows="10" '
            +         'placeholder="aa:bb:cc:dd:ee:ff, Sam\'s iPhone, phone\n'
            + '11:22:33:44:55:66, Lobby laptop, laptop, front desk"></textarea>'
            + '</div>'
            + '<div class="modal-actions">'
            +     '<button class="btn btn-ghost" onclick="closeBulkImport()">Cancel</button>'
            +     '<button class="btn btn-primary" onclick="submitBulkImport()">Import</button>'
            + '</div>'
            + '</div>';

        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeBulkImport();
        });
        document.addEventListener('keydown', function escHandler(e) {
            if (e.key === 'Escape') {
                closeBulkImport();
                document.removeEventListener('keydown', escHandler);
            }
        });
        document.body.appendChild(overlay);
        document.getElementById('bulkImportText').focus();
    };

    window.closeBulkImport = function () {
        var el = document.getElementById('bulkImportModal');
        if (el) el.remove();
    };

    window.submitBulkImport = function () {
        var text = (document.getElementById('bulkImportText').value || '').trim();
        if (!text) {
            OS.toast('Bulk import', 'Nothing to import', 'warning');
            return;
        }
        var lines = text.split('\n');
        var devices = [];
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line || line.charAt(0) === '#') continue;
            var parts = line.split(',');
            var mac = (parts[0] || '').trim();
            if (!mac) continue;
            devices.push({
                mac: mac,
                label: (parts[1] || '').trim(),
                device_type: (parts[2] || '').trim(),
                notes: (parts[3] || '').trim()
            });
        }
        if (!devices.length) {
            OS.toast('Bulk import', 'No valid MAC addresses found', 'warning');
            return;
        }
        closeBulkImport();
        OS.api('/api/known-devices/bulk', 'POST', { devices: devices }).then(function (res) {
            if (!res || !res.ok) {
                OS.toast('Bulk import failed', (res && res.error) || 'Unknown error', 'error');
                return;
            }
            OS.toast('Bulk import complete', res.added + ' added, ' + res.failed + ' failed', 'success');
            OS.refreshClients();
        }).catch(function (err) {
            OS.toast('Bulk import failed', err.message || 'Could not reach server', 'error');
        });
    };

    /* ── Live updates ─────────────────────────────────────────────
     *
     * If a `client_change` event arrives saying this MAC was marked
     * known (by this user in another tab, or by the collector for an
     * unknown_device), refresh the table so the chip flips.
     */
    OS.initClientsLive = function () {
        if (!OS.live) return;
        OS.live.on('client_change', function (msg) {
            if (msg && (msg.subtype === 'marked_known' || msg.subtype === 'removed_known')) {
                OS.refreshClients();
            }
        });
    };
})(window.OS);
