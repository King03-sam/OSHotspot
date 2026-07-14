/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * clients.js — connected-device table on the Clients page, plus the
 * small client-count badges shown elsewhere in the UI.
 */

(function (OS) {
    'use strict';

    OS.refreshClients = function () {
        OS.api('/api/clients').then(function (clients) {
            if (!Array.isArray(clients)) clients = [];
            var tbody = OS.$('clientsBody');
            var count = clients.length;

            var navPillClients = OS.$('navPillClients');
            if (navPillClients) navPillClients.textContent = count;
            var pillClients = OS.$('pillClients');
            if (pillClients) pillClients.textContent = count;
            var clientsCountBadge = OS.$('clientsCountBadge');
            if (clientsCountBadge) clientsCountBadge.textContent = count;

            if (!count) {
                tbody.innerHTML = '<tr><td colspan="5" class="empty-row">No clients connected</td></tr>';
                return;
            }

            var html = '';
            for (var i = 0; i < count; i++) {
                var c = clients[i];
                var statusHtml = c.status === 'active'
                    ? '<span class="client-active">active</span>'
                    : '<span class="client-inactive">' + OS.esc(c.status || '—') + '</span>';
                html += '<tr>'
                    + '<td>' + (i + 1) + '</td>'
                    + '<td>' + OS.esc(c.mac) + '</td>'
                    + '<td>' + OS.esc(c.ip) + '</td>'
                    + '<td>' + OS.esc(c.hostname || '—') + '</td>'
                    + '<td>' + statusHtml + '</td>'
                    + '</tr>';
            }
            tbody.innerHTML = html;
        }).catch(function () {});
    };
})(window.OS);
