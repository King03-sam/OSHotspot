/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * traffic-monitor.js — DNS query and connection tracking UI for the
 * Traffic Monitor page.  Fetches data from /api/dns-queries,
 * /api/connections, and /api/traffic-summary.
 */

(function (OS) {
    'use strict';

    function formatTs(ts) {
        if (!ts) return '—';
        var d = new Date(ts * 1000);
        var h = String(d.getHours()).padStart(2, '0');
        var m = String(d.getMinutes()).padStart(2, '0');
        var s = String(d.getSeconds()).padStart(2, '0');
        return h + ':' + m + ':' + s;
    }

    function getClientFilter() {
        var el = OS.$('trafficClientFilter');
        return el ? el.value.trim() : '';
    }

    /* ---- DNS Queries ---- */

    OS.refreshDnsLog = function () {
        var clientIp = getClientFilter();
        var url = '/api/dns-queries?limit=300';
        if (clientIp) url += '&client_ip=' + encodeURIComponent(clientIp);

        OS.api(url).then(function (data) {
            if (!data || !data.queries) return;
            var body = OS.$('dnsBody');
            if (!body) return;
            if (data.queries.length === 0) {
                body.innerHTML = '<tr><td colspan="3" class="empty-row">No DNS queries recorded yet</td></tr>';
                return;
            }
            var html = '';
            for (var i = 0; i < data.queries.length; i++) {
                var q = data.queries[i];
                html += '<tr>'
                    + '<td class="mono">' + OS.esc(formatTs(q.ts)) + '</td>'
                    + '<td class="mono">' + OS.esc(q.client_ip) + '</td>'
                    + '<td>' + OS.esc(q.domain) + '</td>'
                    + '</tr>';
            }
            body.innerHTML = html;
        }).catch(function () {});
    };

    /* ---- Connections ---- */

    OS.refreshConnections = function () {
        var clientIp = getClientFilter();
        var url = '/api/connections?limit=300';
        if (clientIp) url += '&client_ip=' + encodeURIComponent(clientIp);

        OS.api(url).then(function (data) {
            if (!data || !data.connections) return;
            var body = OS.$('connBody');
            if (!body) return;
            if (data.connections.length === 0) {
                body.innerHTML = '<tr><td colspan="5" class="empty-row">No connections recorded yet</td></tr>';
                return;
            }
            var html = '';
            for (var i = 0; i < data.connections.length; i++) {
                var c = data.connections[i];
                html += '<tr>'
                    + '<td class="mono">' + OS.esc(formatTs(c.ts)) + '</td>'
                    + '<td class="mono">' + OS.esc(c.client_ip) + '</td>'
                    + '<td class="mono">' + OS.esc(c.dest_ip) + '</td>'
                    + '<td class="mono">' + OS.esc(c.dest_port) + '</td>'
                    + '<td>' + OS.esc(c.proto) + '</td>'
                    + '</tr>';
            }
            body.innerHTML = html;
        }).catch(function () {});
    };

    /* ---- Summary ---- */

    OS.refreshTrafficSummary = function () {
        OS.api('/api/traffic-summary').then(function (data) {
            if (!data) return;

            // Stats bar
            var eq = OS.$('trafficTotalQueries');
            var ec = OS.$('trafficTotalConns');
            var eac = OS.$('trafficActiveClients');
            var es = OS.$('trafficSince');
            if (eq) eq.textContent = data.total_queries || 0;
            if (ec) ec.textContent = data.total_connections || 0;
            if (eac) eac.textContent = data.active_clients ? data.active_clients.length : 0;
            if (es) es.textContent = data.tracking_since ? formatTs(data.tracking_since) : '—';

            // Top domains
            var domainsBody = OS.$('topDomainsBody');
            if (domainsBody) {
                if (!data.top_domains || data.top_domains.length === 0) {
                    domainsBody.innerHTML = '<tr><td colspan="3" class="empty-row">No data yet</td></tr>';
                } else {
                    var dh = '';
                    for (var i = 0; i < data.top_domains.length; i++) {
                        var d = data.top_domains[i];
                        dh += '<tr>'
                            + '<td>' + (i + 1) + '</td>'
                            + '<td>' + OS.esc(d.domain) + '</td>'
                            + '<td class="mono">' + d.count + '</td>'
                            + '</tr>';
                    }
                    domainsBody.innerHTML = dh;
                }
            }

            // Active clients
            var clientsBody = OS.$('activeClientsBody');
            if (clientsBody) {
                if (!data.active_clients || data.active_clients.length === 0) {
                    clientsBody.innerHTML = '<tr><td colspan="4" class="empty-row">No data yet</td></tr>';
                } else {
                    var ch = '';
                    for (var j = 0; j < data.active_clients.length; j++) {
                        var cl = data.active_clients[j];
                        ch += '<tr>'
                            + '<td class="mono">' + OS.esc(cl.client_ip) + '</td>'
                            + '<td class="mono">' + cl.dns_queries + '</td>'
                            + '<td class="mono">' + cl.connections + '</td>'
                            + '<td class="mono">' + OS.esc(formatTs(cl.last_seen)) + '</td>'
                            + '</tr>';
                    }
                    clientsBody.innerHTML = ch;
                }
            }
        }).catch(function () {});
    };

    /* ---- Tab switching ---- */

    window.switchTrafficTab = function (tab) {
        OS.state.currentTrafficTab = tab;
        var tabs = document.querySelectorAll('#trafficTabs .seg');
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === tab);
        }
        var panels = document.querySelectorAll('.traffic-tab');
        for (var j = 0; j < panels.length; j++) panels[j].classList.remove('active');
        var target = OS.$('trafficTab' + OS.capitalize(tab));
        if (target) target.classList.add('active');
        OS.refreshTrafficMonitor();
    };

    /* ---- Combined refresh ---- */

    OS.refreshTrafficMonitor = function () {
        var tab = OS.state.currentTrafficTab;
        if (tab === 'dns') OS.refreshDnsLog();
        else if (tab === 'connections') OS.refreshConnections();
        else if (tab === 'summary') OS.refreshTrafficSummary();
        OS.refreshTrafficSummary();
    };

    window.filterTraffic = function () {
        OS.refreshTrafficMonitor();
    };

    window.clearTrafficLogs = function () {
        if (!confirm('Delete all DNS queries and connection records? This cannot be undone.')) return;
        OS.api('/api/traffic-clear', 'POST').then(function (data) {
            if (data && data.ok) {
                OS.toast('Cleared', 'All traffic logs have been deleted', 'info');
                OS.refreshTrafficMonitor();
            } else {
                OS.toast('Error', 'Failed to clear traffic logs', 'error');
            }
        }).catch(function () {
            OS.toast('Error', 'Failed to clear traffic logs', 'error');
        });
    };
})(window.OS);
