/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * clients.js — connected-device table on the Clients page, plus the
 * small client-count badges shown elsewhere in the UI, and the
 * blocked-devices list.
 */

(function (OS) {
    'use strict';

    OS.refreshClients = function () {
        OS.api('/api/clients').then(function (clients) {
            if (!Array.isArray(clients)) clients = [];
            var tbody = OS.$('clientsBody');
            var activeCount = 0;
            for (var k = 0; k < clients.length; k++) {
                if (clients[k].status === 'active') activeCount++;
            }
            var count = activeCount;

            var navPillClients = OS.$('navPillClients');
            if (navPillClients) navPillClients.textContent = count;
            var pillClients = OS.$('pillClients');
            if (pillClients) pillClients.textContent = count;
            var valClients = OS.$('valClients');
            if (valClients) valClients.textContent = count;
            var clientsCountBadge = OS.$('clientsCountBadge');
            if (clientsCountBadge) clientsCountBadge.textContent = count;

            if (!count) {
                tbody.innerHTML = '<tr><td colspan="6" class="empty-row">No clients connected</td></tr>';
                loadBlocked();
                return;
            }

            var html = '';
            for (var i = 0; i < count; i++) {
                var c = clients[i];
                var statusHtml = c.status === 'active'
                    ? '<span class="client-active">active</span>'
                    : '<span class="client-inactive">' + OS.esc(c.status || '—') + '</span>';
                var kickBtn = c.status === 'active'
                    ? '<button class="btn btn-ghost btn-sm" onclick="kickClient(\'' + OS.esc(c.mac) + '\')">Kick</button>'
                    : '';
                html += '<tr>'
                    + '<td>' + (i + 1) + '</td>'
                    + '<td>' + OS.esc(c.mac) + '</td>'
                    + '<td>' + OS.esc(c.ip) + '</td>'
                    + '<td>' + OS.esc(c.hostname || '—') + '</td>'
                    + '<td>' + statusHtml + '</td>'
                    + '<td class="kick-cell">' + kickBtn + '</td>'
                    + '</tr>';
            }
            tbody.innerHTML = html;
            loadBlocked();
        }).catch(function () {});
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
        OS.api('/api/kick', 'POST', { mac: mac }).then(function (res) {
            OS.toast(res.ok ? 'Client blocked & disconnected' : 'Kick failed',
                     res.ok ? mac : (res.error || 'Unknown error'),
                     res.ok ? 'success' : 'error');
            OS.refreshClients();
        }).catch(function (err) {
            OS.toast('Kick failed', err.message || 'Could not reach server', 'error');
        });
    };

    window.unblockClient = function (mac) {
        OS.api('/api/unblock', 'POST', { mac: mac }).then(function (res) {
            OS.toast(res.ok ? 'Client unblocked' : 'Unblock failed',
                     res.ok ? mac : (res.error || 'Unknown error'),
                     res.ok ? 'success' : 'error');
            OS.refreshClients();
        }).catch(function (err) {
            OS.toast('Unblock failed', err.message || 'Could not reach server', 'error');
        });
    };
})(window.OS);
