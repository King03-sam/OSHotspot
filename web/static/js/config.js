/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * config.js — loads and saves the hotspot configuration form (SSID,
 * password, channel, hardware mode, country code) and renders the
 * detected WiFi interfaces table.
 */

(function (OS) {
    'use strict';

    function loadConfig() {
        OS.api('/api/config').then(function (cfg) {
            if (cfg.ssid) OS.$('cfgSsid').value = cfg.ssid;
            if (cfg.password_set !== undefined) {
                OS.$('cfgPassword').placeholder = cfg.password_set ? 'Set (enter new to change)' : 'Not set';
            }
            if (cfg.channel) OS.$('cfgChannel').value = cfg.channel;
            if (cfg.hw_mode) OS.$('cfgHwMode').value = cfg.hw_mode;
            if (cfg.country_code) OS.$('cfgCountry').value = cfg.country_code;

            // Mirror a few fields into the Overview page's network info card.
            if (cfg.channel) OS.$('infoChannel').textContent = cfg.channel;
            if (cfg.hw_mode) OS.$('infoHwMode').textContent = cfg.hw_mode + (cfg.hw_mode === 'g' ? ' (2.4 GHz)' : ' (5 GHz)');
            if (cfg.country_code) OS.$('infoCountry').textContent = cfg.country_code;
        }).catch(function () {});

        OS.api('/api/interfaces').then(function (data) {
            var tbody = OS.$('interfacesBody');
            if (!tbody) return;
            var ifaces = data.wifi_interfaces || [];
            if (!ifaces.length) {
                tbody.innerHTML = '<tr><td colspan="3" class="empty-row">No WiFi interfaces detected</td></tr>';
                return;
            }
            var html = '';
            for (var i = 0; i < ifaces.length; i++) {
                var iface = ifaces[i];
                var isCurrent = iface.name === data.current_wifi_iface;
                html += '<tr>'
                    + '<td>' + OS.esc(iface.name) + '</td>'
                    + '<td>' + OS.esc(iface.state || '—') + '</td>'
                    + '<td>' + (isCurrent ? '<span class="client-active">in use</span>' : '—') + '</td>'
                    + '</tr>';
            }
            tbody.innerHTML = html;
        }).catch(function () {});
    }
    window.loadConfig = loadConfig;

    window.submitConfig = function (e) {
        e.preventDefault();
        var status = OS.$('configStatus');
        status.textContent = '';
        status.className = 'form-status';

        var data = {};
        var ssid = OS.$('cfgSsid').value.trim();
        var pw = OS.$('cfgPassword').value;
        var ch = OS.$('cfgChannel').value;
        var mode = OS.$('cfgHwMode').value;
        var cc = OS.$('cfgCountry').value.trim().toUpperCase();

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

        OS.api('/api/config', 'POST', data).then(function (res) {
            status.textContent = 'Saved: ' + (res.updated || []).join(', ');
            status.className = 'form-status ok';
            OS.$('cfgPassword').value = '';
            OS.toast('Configuration saved', 'Updated: ' + (res.updated || []).join(', '), 'success');
            loadConfig();
            setTimeout(function () {
                status.textContent = '';
                status.className = 'form-status';
            }, 4000);
        }).catch(function (err) {
            var msg = err && err.errors ? err.errors.join(' ') : (err && err.error || 'Save failed');
            status.textContent = msg;
            status.className = 'form-status error';
            OS.toast('Save failed', msg, 'error');
        });
    };

    window.togglePasswordVisibility = function (inputId) {
        var input = OS.$(inputId);
        if (!input) return;
        input.type = input.type === 'password' ? 'text' : 'password';
    };
})(window.OS);
