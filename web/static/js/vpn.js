/**
 * OSHotspot, VPN Page (Tailscale)
 * Remote access management via Tailscale mesh VPN.
 */
(function (OS) {
    'use strict';

    var vpnData = null;

    OS.renderVpn = function () {
        document.getElementById('content').insertAdjacentHTML('beforeend',
            '<section class="view" id="view-vpn">'
            +     '<div class="card">'
            +         '<div class="card-header"><h2 class="card-title">'
            +             '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:6px"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
            +             'VPN Status'
            +         '</h2></div>'
            +         '<div class="card-body" id="vpnStatus">'
            +             '<p class="text-muted">Loading\u2026</p>'
            +         '</div>'
            +     '</div>'
            + '<div class="card">'
            +     '<div class="card-header"><h2 class="card-title">Setup Guide</h2></div>'
            +     '<div class="card-body">'
            +         '<table class="data-table">'
            +             '<thead><tr><th>#</th><th>Step</th><th>Description</th></tr></thead>'
            +             '<tbody>'
            +                 '<tr><td>1</td><td><strong>Install Tailscale</strong></td><td>Download from <a href="https://tailscale.com/download" target="_blank">tailscale.com/download</a> (Windows, macOS, Linux, iOS, Android)</td></tr>'
            +                 '<tr><td>2</td><td><strong>Login</strong></td><td>Open Tailscale app and login with the same account used on the server</td></tr>'
            +                 '<tr><td>3</td><td><strong>Access Dashboard</strong></td><td>Open the dashboard URL shown in VPN Status above</td></tr>'
            +             '</tbody>'
            +         '</table>'
            +     '</div>'
            + '</div>'
            + '</section>'
        );
    };

    OS.loadVpn = function () {
        _refresh();
    };

    function _refresh() {
        fetch('/api/vpn/status')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                vpnData = d;
                _renderStatus(d);
            })
            .catch(function () {
                var el = OS.$('vpnStatus');
                if (el) el.innerHTML = '<p class="text-muted">Could not load VPN status.</p>';
            });
    }

    function _isAccessingViaVpn() {
        if (!vpnData || !vpnData.tailscale_ip) return false;
        var host = window.location.hostname;
        return host === vpnData.tailscale_ip;
    }

    function _renderStatus(d) {
        var el = OS.$('vpnStatus');
        if (!el) return;

        var html = '';

        if (!d.installed) {
            html = '<p class="form-status" style="color:var(--warn)">Tailscale is not installed on this server.</p>'
                + '<p class="text-muted">Run <code>sudo oshotspot setup-vpn</code> to install and configure Tailscale.</p>';
            el.innerHTML = html;
            return;
        }

        // Not running + needs login -> show auth URL
        if (d.needs_login) {
            html += '<div class="form-row">'
                + '<span class="status-dot offline"></span> '
                + '<strong>Authentication Required</strong>'
                + '</div>'
                + '<p class="text-muted" style="margin:8px 0">Tailscale needs authentication. Click the link below to login:</p>';

            if (d.auth_url) {
                html += '<div class="form-row" style="background:var(--bg-secondary);padding:12px;border-radius:8px;margin:8px 0;">'
                    + '<a href="' + _esc(d.auth_url) + '" target="_blank" rel="noopener" style="color:var(--accent);word-break:break-all;">'
                    + _esc(d.auth_url)
                    + '</a>'
                    + '</div>'
                    + '<div class="form-row form-actions">'
                    + '<button type="button" class="btn btn-primary btn-sm" onclick="window.open(\'' + _esc(d.auth_url) + '\',\'_blank\')">Open Auth URL</button>'
                    + '<button type="button" class="btn btn-secondary btn-sm" onclick="OS.copyAuthUrl()">Copy URL</button>'
                    + '<button type="button" class="btn btn-secondary btn-sm" onclick="OS.loadVpn()">Refresh</button>'
                    + '</div>';
            } else {
                html += '<div class="form-row form-actions">'
                    + '<button type="button" class="btn btn-primary btn-sm" onclick="OS.vpnStart()">Get Auth URL</button>'
                    + '<button type="button" class="btn btn-secondary btn-sm" onclick="OS.loadVpn()">Refresh</button>'
                    + '</div>';
            }

            el.innerHTML = html;
            return;
        }

        // Running
        if (d.running) {
            html += '<div class="form-row">'
                + '<span class="status-dot online"></span> '
                + '<strong>Connected</strong>'
                + '</div>';

            if (_isAccessingViaVpn()) {
                html += '<div class="form-row" style="background:rgba(255,193,7,0.1);padding:10px;border-radius:8px;margin:8px 0;border-left:3px solid var(--warn);">'
                    + '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--warn)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
                    + '<strong style="color:var(--warn)">Warning:</strong> '
                    + '<span class="text-muted">You are currently accessing this dashboard via VPN. Stopping the VPN will disconnect you.</span>'
                    + '</div>';
            }

            if (d.tailscale_ip) {
                html += '<div class="form-row">'
                    + '<span class="text-muted">Tailscale IP:</span> '
                    + '<code>' + _esc(d.tailscale_ip) + '</code>'
                    + '</div>'
                    + '<div class="form-row">'
                    + '<span class="text-muted">Dashboard URL:</span> '
                    + '<code id="vpnUrl">' + _esc(d.dashboard_url) + '</code> '
                    + '<button type="button" class="btn btn-secondary btn-sm" onclick="OS.copyVpnUrl()">Copy</button>'
                    + '</div>';
            }

            html += '<div class="form-row form-actions">'
                + '<button type="button" class="btn btn-secondary btn-sm" onclick="OS.vpnRestart()">Restart</button>'
                + '<button type="button" class="btn btn-secondary btn-sm" style="color:var(--danger)" onclick="OS.vpnStopConfirm()">Stop VPN</button>'
                + '</div>';
        } else {
            // Not running, no login needed
            html += '<div class="form-row">'
                + '<span class="status-dot offline"></span> '
                + '<strong>Disconnected</strong>'
                + '</div>'
                + '<div class="form-row form-actions">'
                + '<button type="button" class="btn btn-primary btn-sm" onclick="OS.vpnStart()">Start VPN</button>'
                + '</div>'
                + '<p class="text-muted" style="margin:6px 0 0;font-size:12px;">'
                + 'Tip: Startup can take up to a minute. If it seems stuck, you can safely click "Start VPN" again.</p>';
        }

        el.innerHTML = html;
    }

    OS.vpnStart = function () {
        var btn = document.querySelector('[onclick="OS.vpnStart()"]');
        if (btn) { btn.textContent = 'Starting\u2026'; }

        fetch('/api/vpn/start', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.auth_url) {
                    window.open(d.auth_url, '_blank');
                }
                _refresh();
            })
            .catch(function () { _refresh(); });
    };

    OS.vpnStopConfirm = function () {
        var viaVpn = _isAccessingViaVpn();
        var msg = 'Are you sure you want to stop the VPN?';
        if (viaVpn) {
            msg = 'You are currently connected via VPN. Stopping the VPN will disconnect you from this dashboard. Are you sure?';
        }
        if (window.confirm(msg)) {
            OS.vpnStop();
        }
    };

    OS.vpnStop = function () {
        var btn = document.querySelector('[onclick="OS.vpnStopConfirm()"]');
        if (btn) { btn.classList.add('loading'); btn.disabled = true; btn.textContent = 'Stopping\u2026'; }

        fetch('/api/vpn/stop', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function () { _refresh(); })
            .catch(function () { _refresh(); })
            .finally(function () {
                if (btn) { btn.classList.remove('loading'); btn.disabled = false; btn.textContent = 'Stop VPN'; }
            });
    };

    OS.vpnRestart = function () {
        var btn = document.querySelector('[onclick="OS.vpnRestart()"]');
        if (btn) { btn.classList.add('loading'); btn.disabled = true; btn.textContent = 'Restarting\u2026'; }

        fetch('/api/vpn/restart', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function () { _refresh(); })
            .catch(function () { _refresh(); })
            .finally(function () {
                if (btn) { btn.classList.remove('loading'); btn.disabled = false; btn.textContent = 'Restart'; }
            });
    };

    OS.copyVpnUrl = function () {
        if (!vpnData || !vpnData.dashboard_url) return;
        OS.copyText(vpnData.dashboard_url)
            .then(function () { OS.toast('URL copied to clipboard'); })
            .catch(function () {
                OS.toast('Copy failed', 'Could not copy the dashboard URL', 'error');
            });
    };

    OS.copyAuthUrl = function () {
        if (!vpnData || !vpnData.auth_url) return;
        OS.copyText(vpnData.auth_url)
            .then(function () { OS.toast('Auth URL copied to clipboard'); })
            .catch(function () {
                OS.toast('Copy failed', 'Could not copy the auth URL', 'error');
            });
    };

    function _esc(s) {
        if (!s) return '';
        var d = document.createElement('div');
        d.appendChild(document.createTextNode(s));
        return d.innerHTML;
    }
})(OS);
