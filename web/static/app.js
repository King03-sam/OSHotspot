/* OSHotspot Dashboard - Frontend */
(function () {
    'use strict';

    var TOKEN = '';
    var refreshInterval = null;
    var polling = false;

    function applyTheme(theme) {
        document.body.setAttribute('data-theme', theme);
        localStorage.setItem('oshotspot-theme', theme);
        var toggle = $('themeToggle');
        if (toggle) {
            toggle.textContent = theme === 'dark' ? '☀' : '☾';
            toggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
        }
    }

    function init() {
        var savedTheme = localStorage.getItem('oshotspot-theme');
        var preferredTheme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        applyTheme(savedTheme || preferredTheme);

        var params = new URLSearchParams(window.location.search);
        TOKEN = params.get('token') || '';
        if (!TOKEN) {
            document.body.innerHTML = '<div style="padding:40px;color:#ef4444;font-family:monospace">Access denied: no session token.</div>';
            return;
        }
        loadConfig();
        refreshStatus();
        refreshClients();
        startPolling();
    }

    function api(path, method, body) {
        var sep = path.indexOf('?') >= 0 ? '&' : '?';
        var url = path + sep + 'token=' + TOKEN;
        var opts = { method: method || 'GET', headers: {} };
        if (body) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        return fetch(url, opts).then(function (r) {
            if (!r.ok) return r.json().then(function (e) { throw e; });
            return r.json();
        });
    }

    function $(id) { return document.getElementById(id); }

    function refreshStatus() {
        api('/api/status').then(function (data) {
            if (data.error) return;
            var running = data.hostapd;

            var badge = $('statusBadge');
            if (running) {
                badge.textContent = 'ONLINE';
                badge.className = 'badge badge-on';
            } else {
                badge.textContent = 'OFFLINE';
                badge.className = 'badge badge-off';
            }

            setStat('valHostapd', data.hostapd ? 'RUNNING' : 'STOPPED', data.hostapd);
            setStat('valDnsmasq', data.dnsmasq ? 'RUNNING' : 'STOPPED', data.dnsmasq);
            setStat('valClients', data.clients, data.clients > 0 ? true : null);
            setStat('valForwarding', data.ip_forward ? 'ON' : 'OFF', data.ip_forward);
            setStat('valNat', data.nat ? 'ACTIVE' : 'OFF', data.nat);

            $('infoWifiIface').textContent = data.wifi_iface || '--';
            $('infoApIface').textContent = (data.ap_iface || 'ap0') + ' (' + (data.ap_state || '--') + ')';
            $('infoApIp').textContent = data.ap_ip || '--';
            $('infoSsid').textContent = data.ssid || '--';

            var uptime = $('uptime');
            if (data.hostapd_pid) {
                uptime.textContent = 'PID ' + data.hostapd_pid;
            } else {
                uptime.textContent = '';
            }
        }).catch(function () {});
    }

    function setStat(id, text, ok) {
        var el = $(id);
        el.textContent = text;
        if (ok === true) el.className = 'stat-value ok';
        else if (ok === false) el.className = 'stat-value fail';
        else if (ok === null) el.className = 'stat-value warn';
        else el.className = 'stat-value';
    }

    function refreshClients() {
        api('/api/clients').then(function (clients) {
            var tbody = $('clientsBody');
            var count = $('clientCount');
            count.textContent = clients.length;

            if (!clients.length) {
                tbody.innerHTML = '<tr><td colspan="4" class="empty-row">No clients connected</td></tr>';
                return;
            }
            var html = '';
            for (var i = 0; i < clients.length; i++) {
                var c = clients[i];
                var statusClass = c.status === 'active' ? 'client-active' : 'client-inactive';
                html += '<tr>'
                    + '<td>' + esc(c.mac) + '</td>'
                    + '<td>' + esc(c.ip) + '</td>'
                    + '<td>' + esc(c.hostname || '-') + '</td>'
                    + '<td class="' + statusClass + '">' + esc(c.status) + '</td>'
                    + '</tr>';
            }
            tbody.innerHTML = html;
        }).catch(function () {});
    }

    function esc(s) {
        var d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    function loadConfig() {
        api('/api/config').then(function (cfg) {
            if (cfg.ssid) $('cfgSsid').value = cfg.ssid;
            if (cfg.password_set !== undefined) $('cfgPassword').placeholder = cfg.password_set ? 'Set (enter new to change)' : 'Not set';
            if (cfg.channel) $('cfgChannel').value = cfg.channel;
            if (cfg.hw_mode) $('cfgHwMode').value = cfg.hw_mode;
            if (cfg.country_code) $('cfgCountry').value = cfg.country_code;
        }).catch(function () {});
    }

    window.toggleTheme = function () {
        var currentTheme = document.body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        applyTheme(currentTheme);
    };

    window.submitConfig = function (e) {
        e.preventDefault();
        var status = $('configStatus');
        status.textContent = '';
        status.className = 'form-status';

        var data = {};
        var ssid = $('cfgSsid').value.trim();
        var pw = $('cfgPassword').value;
        var ch = $('cfgChannel').value;
        var mode = $('cfgHwMode').value;
        var cc = $('cfgCountry').value.trim().toUpperCase();

        if (ssid) data.ssid = ssid;
        if (pw) data.password = pw;
        if (ch) data.channel = parseInt(ch, 10);
        if (mode) data.hw_mode = mode;
        if (cc) data.country_code = cc;

        if (!Object.keys(data).length) {
            status.textContent = 'No changes to save';
            status.className = 'form-status error';
            return;
        }

        api('/api/config', 'POST', data).then(function (res) {
            status.textContent = 'Saved. ' + (res.updated || []).join(', ');
            status.className = 'form-status ok';
            $('cfgPassword').value = '';
            loadConfig();
            setTimeout(function () { status.textContent = ''; }, 4000);
        }).catch(function (err) {
            var msg = err.errors ? err.errors.join(' ') : (err.error || 'Save failed');
            status.textContent = msg;
            status.className = 'form-status error';
        });
    };

    window.doAction = function (action) {
        var btn = action === 'start' ? $('btnStart') : action === 'stop' ? $('btnStop') : $('btnRestart');
        btn.classList.add('loading');
        btn.disabled = true;

        api('/api/' + action, 'POST').then(function () {
            setTimeout(function () {
                refreshStatus();
                refreshClients();
                btn.classList.remove('loading');
                btn.disabled = false;
            }, 1500);
        }).catch(function () {
            btn.classList.remove('loading');
            btn.disabled = false;
        });
    };

    window.showQR = function () {
        var panel = $('qrPanel');
        panel.style.display = '';
        $('qrImage').src = '/api/qr?token=' + encodeURIComponent(TOKEN);
    };

    window.hideQR = function () {
        $('qrPanel').style.display = 'none';
    };

    window.runDoctor = function () {
        var panel = $('doctorPanel');
        panel.style.display = '';
        var results = $('doctorResults');
        results.innerHTML = '<div style="color:var(--text-muted);padding:8px">Running diagnostics...</div>';

        api('/api/doctor').then(function (checks) {
            if (!checks.length) {
                results.innerHTML = '<div style="color:var(--text-muted);padding:8px">No results.</div>';
                return;
            }
            var html = '';
            for (var i = 0; i < checks.length; i++) {
                var c = checks[i];
                html += '<div class="doctor-check">'
                    + '<div class="doctor-dot ' + c.status + '"></div>'
                    + '<div class="doctor-msg">' + esc(c.message) + '</div>'
                    + '</div>';
            }
            results.innerHTML = html;
        }).catch(function () {
            results.innerHTML = '<div style="color:var(--red);padding:8px">Failed to run diagnostics.</div>';
        });
    };

    window.hideDoctor = function () {
        $('doctorPanel').style.display = 'none';
    };

    window.togglePanel = function (id) {
        var el = $(id);
        var toggle = $(id.replace('Body', 'Toggle'));
        if (el.classList.contains('collapsed')) {
            el.classList.remove('collapsed');
            if (toggle) toggle.innerHTML = '&#9650;';
        } else {
            el.classList.add('collapsed');
            if (toggle) toggle.innerHTML = '&#9660;';
        }
    };

    function startPolling() {
        if (refreshInterval) clearInterval(refreshInterval);
        refreshInterval = setInterval(function () {
            if (!document.hidden) {
                refreshStatus();
                refreshClients();
            }
        }, 4000);
    }

    document.addEventListener('DOMContentLoaded', init);
})();
