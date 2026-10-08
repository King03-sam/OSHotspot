/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * config.js, loads and saves the hotspot configuration form (SSID,
 * password, channel, hardware mode, country code) and renders the
 * detected WiFi interfaces table.
 */

(function (OS) {
    'use strict';

    OS.renderConfig = function () {
        var channelOpts = '';
        for (var i = 1; i <= 13; i++) {
            channelOpts += '<option value="' + i + '">' + i + '</option>';
        }
        document.getElementById('content').insertAdjacentHTML('beforeend',
            '<section class="view" id="view-config">'
            + '<div class="grid-2">'
            +     '<div class="card">'
            +         '<div class="card-header"><h2 class="card-title">Hotspot Configuration</h2></div>'
            +         '<div class="card-body">'
            +             '<form id="configForm" onsubmit="return submitConfig(event)">'
            +                 '<div class="form-row">'
            +                     '<label for="cfgSsid">Network Name (SSID)</label>'
            +                     '<input type="text" id="cfgSsid" maxlength="32" placeholder="e.g. OSHotspot" autocomplete="off">'
            +                     '<span class="form-hint">1\u201332 characters</span>'
            +                 '</div>'
            +                 '<div class="form-row">'
            +                     '<label for="cfgPassword">Password</label>'
            +                     '<div class="input-with-action">'
            +                         '<input type="password" id="cfgPassword" minlength="8" placeholder="Min 8 characters">'
            +                         '<button type="button" class="input-btn" onclick="togglePasswordVisibility(\'cfgPassword\', this)" aria-label="Show password">'
            +                             '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
            +                         '</button>'
            +                     '</div>'
            +                     '<span class="form-hint">Leave empty to keep current password</span>'
            +                 '</div>'
            +                 '<div class="form-row">'
            +                     '<label class="checkbox-label">'
            +                         '<input type="checkbox" id="cfgWifiOpen" onchange="toggleWifiOpenField()">'
            +                         ' Open Network (Disable password)'
            +                     '</label>'
            +                 '</div>'
            +                 '<div class="form-row form-half">'
            +                     '<div>'
            +                         '<label for="cfgChannel">Channel</label>'
            +                         '<select id="cfgChannel">' + channelOpts + '</select>'
            +                     '</div>'
            +                     '<div>'
            +                         '<label for="cfgHwMode">Hardware Mode</label>'
            +                         '<select id="cfgHwMode" onchange="checkHwModeWarning()">'
            +                             '<option value="g">g (2.4 GHz)</option>'
            +                             '<option value="a">a (5 GHz)</option>'
            +                         '</select>'
            +                         '<div id="hwModeWarning" class="config-warning">Your WiFi adapter does not appear to support 5 GHz. Selecting mode "a" may cause hostapd to fail.</div>'
            +                     '</div>'
            +                 '</div>'
            +                 '<div class="form-row">'
            +                     '<label for="cfgCountry">Country Code</label>'
            +                     '<input type="text" id="cfgCountry" maxlength="2" placeholder="US" style="text-transform:uppercase">'
            +                     '<span class="form-hint">ISO 3166-1 alpha-2 (e.g. US, FR, GB)</span>'
            +                 '</div>'
            +                 '<hr style="border:none;border-top:1px solid var(--border-color);margin:16px 0">'
            +                 '<div class="form-row">'
            +                     '<label class="checkbox-label">'
            +                         '<input type="checkbox" id="cfgRemoteAccess"> Remote Dashboard Access'
            +                     '</label>'
            +                     '<span class="form-hint">Allow accessing admin dashboard over network interfaces</span>'
            +                 '</div>'
            +                 '<div class="form-row">'
            +                     '<label for="cfgInactivityTimeout">Dashboard Auto-Shutdown</label>'
            +                     '<select id="cfgInactivityTimeout">'
            +                         '<option value="7200">2 hours</option>'
            +                         '<option value="18000">5 hours</option>'
            +                         '<option value="36000">10 hours</option>'
            +                         '<option value="0">Never</option>'
            +                     '</select>'
            +                     '<span class="form-hint">Dashboard will auto-shutdown after this period of inactivity</span>'
            +                 '</div>'
            +                 '<hr style="border:none;border-top:1px solid var(--border-color);margin:16px 0">'
            +                 '<div class="form-row">'
            +                     '<label for="cfgAdminLoginBgColor">Admin Login Background Color</label>'
            +                     '<div style="display:flex;align-items:center;gap:10px;">'
            +                         '<input type="color" id="cfgAdminLoginBgColorPicker" value="#050505" onchange="OS.$(\'cfgAdminLoginBgColor\').value = this.value" style="width:40px;height:38px;padding:0;border:none;border-radius:6px;cursor:pointer;background:none;">'
            +                         '<input type="text" id="cfgAdminLoginBgColor" value="#050505" placeholder="#050505" oninput="if(/^#[0-9A-Fa-f]{6}$/.test(this.value)) OS.$(\'cfgAdminLoginBgColorPicker\').value = this.value" style="flex:1;">'
            +                     '</div>'
            +                 '</div>'
            +                 '<div class="form-row">'
            +                     '<label>Dashboard Theme</label>'
            +                     '<div style="display:flex;align-items:center;gap:10px;">'
            +                         '<button type="button" class="icon-btn" id="themeToggle" onclick="toggleTheme()" aria-label="Switch theme" title="Switch theme">'
            +                             '<svg class="icon-moon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
            +                             '<svg class="icon-sun" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
            +                         '</button>'
            +                         '<span id="themeCurrent" class="form-hint" style="margin:0;">Dark mode</span>'
            +                     '</div>'
            +                     '<span class="form-hint">Switch between dark and light mode (saved in this browser)</span>'
            +                 '</div>'
            +                 '<div class="form-row">'
            +                     '<label>Dashboard & Admin Login Custom Logo</label>'
            +                     '<div style="display:flex;align-items:center;gap:10px;">'
            +                         '<input type="file" id="appLogoInput" accept="image/*" onchange="uploadAppLogo(this)" style="display:none;">'
            +                         '<button type="button" class="btn btn-secondary btn-sm" onclick="OS.$(\'appLogoInput\').click()">Upload Custom Logo</button>'
            +                         '<button type="button" class="btn btn-danger btn-sm" id="btnRemoveAppLogo" onclick="confirmRemoveAppLogo()" style="display:none;">Remove Custom Logo</button>'
            +                     '</div>'
            +                     '<div id="appLogoPreviewBox" style="margin-top:10px;display:none;">'
            +                         '<span class="text-muted" style="font-size:11px;display:block;margin-bottom:4px">Logo Preview:</span>'
            +                         '<img id="appLogoPreview" src="" alt="Logo Preview" style="max-width:140px;max-height:70px;object-fit:contain;border:1px solid var(--border-color);border-radius:8px;padding:6px;background:#121214;">'
            +                     '</div>'
            +                 '</div>'
            +                 '<div class="form-row form-actions">'
            +                     '<button type="submit" class="btn btn-primary" id="btnSaveConfig">'
            +                         '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>'
            +                         ' Save Configuration'
            +                     '</button>'
            +                     '<button type="button" class="btn btn-ghost" onclick="loadConfig()">Reset</button>'
            +                     '<span id="configStatus" class="form-status"></span>'
            +                 '</div>'
            +             '</form>'
            +         '</div>'
            +     '</div>'
            +     '<div class="card">'
            +         '<div class="card-header"><h2 class="card-title">WiFi Interfaces</h2></div>'
            +         '<div class="card-body no-pad">'
            +             '<div class="table-wrap">'
            +                 '<table class="data-table">'
            +                     '<thead><tr><th>Interface</th><th>State</th><th>Action</th></tr></thead>'
            +                     '<tbody id="interfacesBody"><tr><td colspan="3" class="empty-row">Loading interfaces\u2026</td></tr></tbody>'
            +                 '</table>'
            +             '</div>'
            +         '</div>'
            +     '</div>'
            + '</div>'

/* ---- Channel Scan card ---- */
            + '<div class="card" style="margin-top:20px">'
            +     '<div class="card-header"><h2 class="card-title">Channel Scan</h2></div>'
            +     '<div class="card-body">'
            +         '<p class="text-muted" style="margin-bottom:12px">Scan nearby WiFi networks to find the least congested channel. Stop the hotspot before scanning.</p>'
            +         '<button type="button" class="btn btn-primary" id="btnScanChannels" onclick="runChannelScan()">'
            +             '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
            +             ' Scan Channels'
            +         '</button>'
            +         '<div id="scanStatus" class="form-status" style="margin-bottom:8px"></div>'
            +         '<div id="scanResults" style="display:none">'
            +             '<table class="data-table" style="margin-top:8px">'
            +                 '<thead><tr><th>Channel</th><th>Networks</th><th>Strongest Signal</th></tr></thead>'
            +                 '<tbody id="scanResultsBody"></tbody>'
            +             '</table>'
            +             '<div id="scanRecommendation" style="margin-top:12px"></div>'
            +         '</div>'
            +     '</div>'
            + '</div>'
            + '</section>'
        );
    };


    var DEFAULT_ICON_URL = '/images/default-icon.svg';

    function isSvgUrl(url) {
        return (url.indexOf('data:image/svg') === 0) || /\.svg(\?|$)/i.test(url);
    }

    function renderWifiSvgBox(box) {
        box.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>';
        box.style.background = '';
    }

    /* Apply favicon + sidebar (+ About if mounted) without needing the
       Config section DOM. Used at boot after lazy section rendering. */
    OS.applyAdminBranding = function (url) {
        if (url) {
            var src = (url.indexOf('data:') === 0) ? url : (url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now());
            updateSidebarLogo(src);
            if (OS.updateAboutLogo) OS.updateAboutLogo(src);
            var fav = document.getElementById('favicon');
            if (fav) {
                fav.href = src;
                fav.type = isSvgUrl(src) ? 'image/svg+xml' : 'image/png';
            }
            return src;
        }
        var def = DEFAULT_ICON_URL + '?t=' + Date.now();
        updateSidebarLogo('');
        if (OS.updateAboutLogo) OS.updateAboutLogo('');
        var fav2 = document.getElementById('favicon');
        if (fav2) {
            fav2.href = def;
            fav2.type = 'image/svg+xml';
        }
        return '';
    };

    function updateAppLogoPreview(url) {
        var src = OS.applyAdminBranding(url || '');
        var box = OS.$('appLogoPreviewBox');
        var img = OS.$('appLogoPreview');
        var btnRm = OS.$('btnRemoveAppLogo');
        if (!box || !img) return;
        if (src) {
            img.src = src;
            box.style.display = 'block';
            if (btnRm) btnRm.style.display = 'inline-block';
        } else {
            img.src = '';
            box.style.display = 'none';
            if (btnRm) btnRm.style.display = 'none';
        }
    }

    function updateSidebarLogo(src) {
        var logoBox = document.querySelector('.sidebar-brand .brand-logo');
        if (!logoBox) return;
        if (src) {
            logoBox.innerHTML = '<img src="' + src + '" alt="Logo" style="max-width:28px;max-height:28px;object-fit:contain;">';
            logoBox.style.background = 'none';
        } else {
            logoBox.innerHTML = '<img src="' + DEFAULT_ICON_URL + '" alt="Logo" style="max-width:28px;max-height:28px;object-fit:contain;" onerror="OS._sidebarLogoFallback(this)">';
            logoBox.style.background = 'none';
        }
    }

    OS._sidebarLogoFallback = function (img) {
        var box = img && img.parentNode;
        if (box) renderWifiSvgBox(box);
    };

    function resizeAppLogoImage(file, maxWidth, maxHeight, callback) {
        var reader = new FileReader();
        reader.onload = function (e) {
            var img = new Image();
            img.onload = function () {
                var canvas = document.createElement('canvas');
                var w = img.width;
                var h = img.height;
                if (w > maxWidth) {
                    h = Math.round((h * maxWidth) / w);
                    w = maxWidth;
                }
                if (h > maxHeight) {
                    w = Math.round((w * maxHeight) / h);
                    h = maxHeight;
                }
                canvas.width = w;
                canvas.height = h;
                var ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                callback(canvas.toDataURL('image/png', 0.9));
            };
            img.onerror = function () {
                callback(e.target.result);
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }

    window.uploadAppLogo = function (input) {
        if (!input || !input.files || !input.files[0]) return;
        var file = input.files[0];
        resizeAppLogoImage(file, 400, 200, function (b64) {
            updateAppLogoPreview(b64);
            OS.api('/api/app/logo', 'POST', { logo_base64: b64 }).then(function (res) {
                OS.toast('Configuration', 'Custom logo uploaded successfully', 'success');
                updateAppLogoPreview(res.logo_url || '/images/app_logo.png');
            }).catch(function (err) {
                var errMsg = (err && err.error) ? err.error : 'Failed to upload logo image';
                OS.toast('Configuration', errMsg, 'error');
                updateAppLogoPreview('');
            });
        });
    };

    window.confirmRemoveAppLogo = function () {
        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'removeAppLogoModal';
        overlay.innerHTML = '<div class="modal-card">'
            + '<div class="modal-icon">'
            +   '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            +     '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>'
            +   '</svg>'
            + '</div>'
            + '<h2 class="modal-title">Remove Custom Logo</h2>'
            + '<p class="modal-message">Are you sure you want to remove the custom logo for the dashboard and admin login?</p>'
            + '<div class="modal-actions">'
            +   '<button class="btn btn-ghost" onclick="closeRemoveAppLogoModal()">Cancel</button>'
            +   '<button class="btn btn-danger" onclick="doRemoveAppLogo()">Remove Logo</button>'
            + '</div>'
            + '</div>';
        overlay.addEventListener('click', function (e) { if (e.target === overlay) closeRemoveAppLogoModal(); });
        document.addEventListener('keydown', function escHandler(e) { if (e.key === 'Escape') { closeRemoveAppLogoModal(); document.removeEventListener('keydown', escHandler); } });
        document.body.appendChild(overlay);
    };

    window.closeRemoveAppLogoModal = function () {
        var el = document.getElementById('removeAppLogoModal');
        if (el) el.remove();
    };

    window.doRemoveAppLogo = function () {
        closeRemoveAppLogoModal();
        OS.api('/api/app/logo', 'POST', { action: 'remove' }).then(function () {
            OS.toast('Configuration', 'Custom logo removed', 'info');
            updateAppLogoPreview('');
            var fileInput = OS.$('appLogoInput');
            if (fileInput) fileInput.value = '';
        }).catch(function () {});
    };

    function loadConfig() {
        var curTheme = document.documentElement.getAttribute('data-theme');
        var themeLbl = OS.$('themeCurrent');
        if (themeLbl) themeLbl.textContent = curTheme === 'light' ? 'Light mode' : 'Dark mode';

        OS.api('/api/config').then(function (cfg) {
            if (cfg.ssid) OS.$('cfgSsid').value = cfg.ssid;
            if (cfg.password_set !== undefined) {
                OS.$('cfgPassword').placeholder = cfg.password_set ? 'Set (enter new to change)' : 'Not set';
            }
            if (cfg.channel) OS.$('cfgChannel').value = cfg.channel;
            if (cfg.hw_mode) OS.$('cfgHwMode').value = cfg.hw_mode;
            if (cfg.country_code) OS.$('cfgCountry').value = cfg.country_code;
            if (OS.$('cfgWifiOpen')) OS.$('cfgWifiOpen').checked = cfg.wifi_open === 'true';
            if (OS.$('cfgRemoteAccess')) OS.$('cfgRemoteAccess').checked = cfg.dashboard_remote_access === 'true';
            if (OS.$('cfgInactivityTimeout')) OS.$('cfgInactivityTimeout').value = cfg.inactivity_timeout || '7200';

            var adminBg = cfg.admin_login_bg_color || '#050505';
            if (OS.$('cfgAdminLoginBgColor')) OS.$('cfgAdminLoginBgColor').value = adminBg;
            if (OS.$('cfgAdminLoginBgColorPicker')) OS.$('cfgAdminLoginBgColorPicker').value = adminBg;

            updateAppLogoPreview(cfg.admin_logo_url);

            /* Mirror fields into the Overview page's network info card. */
            if (cfg.channel) OS.$('infoChannel').textContent = cfg.channel;
            if (cfg.hw_mode) OS.$('infoHwMode').textContent = cfg.hw_mode + (cfg.hw_mode === 'g' ? ' (2.4 GHz)' : ' (5 GHz)');
            if (cfg.country_code) OS.$('infoCountry').textContent = cfg.country_code;

            OS._supports5ghz = cfg.supports_5ghz;
            checkHwModeWarning();
            toggleWifiOpenField();
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
                    + '<td>' + OS.esc(iface.state || '\u2014') + '</td>'
                    + '<td>' + (isCurrent ? '<span class="client-active">in use</span>' : '\u2014') + '</td>'
                    + '</tr>';
            }
            tbody.innerHTML = html;
        }).catch(function () {});
    }
    window.loadConfig = loadConfig;

    window.toggleWifiOpenField = function () {
        var openChk = OS.$('cfgWifiOpen');
        var pwInput = OS.$('cfgPassword');
        if (openChk && pwInput) {
            pwInput.disabled = openChk.checked;
            if (openChk.checked) pwInput.value = '';
        }
    };

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
        var wifiOpen = OS.$('cfgWifiOpen') ? OS.$('cfgWifiOpen').checked : false;
        var remoteAccess = OS.$('cfgRemoteAccess') ? OS.$('cfgRemoteAccess').checked : false;
        var adminBgColor = OS.$('cfgAdminLoginBgColor') ? OS.$('cfgAdminLoginBgColor').value.trim() : '';

        if (ssid) data.ssid = ssid;
        if (pw && !wifiOpen) data.password = pw;
        if (ch) data.channel = parseInt(ch, 10);
        if (mode) data.hw_mode = mode;
        if (cc) data.country_code = cc;
        data.wifi_open = wifiOpen;
        data.dashboard_remote_access = remoteAccess;
        if (adminBgColor) data.admin_login_bg_color = adminBgColor;

        var inactivityTimeout = OS.$('cfgInactivityTimeout') ? OS.$('cfgInactivityTimeout').value : '';
        if (inactivityTimeout !== '') data.inactivity_timeout = parseInt(inactivityTimeout, 10);

        if (!Object.keys(data).length) {
            status.textContent = 'No changes to save';
            status.className = 'form-status error';
            return;
        }

        var btn = OS.$('btnSaveConfig');
        if (btn) { btn.classList.add('loading'); btn.disabled = true; }

        OS.api('/api/config', 'POST', data).then(function (res) {
            status.textContent = 'Saved: ' + (res.updated || []).join(', ');
            status.className = 'form-status ok';
            OS.$('cfgPassword').value = '';
            OS.toast('Configuration saved', 'Updated: ' + (res.updated || []).join(', '), 'success');
            loadConfig();
            var btn = OS.$('btnSaveConfig');
            if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
            setTimeout(function () {
                status.textContent = '';
                status.className = 'form-status';
            }, 4000);
        }).catch(function (err) {
            var msg = err && err.errors ? err.errors.join(' ') : (err && err.error || 'Save failed');
            status.textContent = msg;
            status.className = 'form-status error';
            OS.toast('Save failed', msg, 'error');
            var btn = OS.$('btnSaveConfig');
            if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
        });
    };

    window.togglePasswordVisibility = function (inputId, btn) {
        var input = OS.$(inputId);
        if (!input) return;
        var showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        if (btn) {
            btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
            btn.innerHTML = showing
                ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
                : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
        }
    };

    window.checkHwModeWarning = function () {
        var mode = OS.$('cfgHwMode').value;
        var warn = OS.$('hwModeWarning');
        if (!warn) return;
        if (mode === 'a' && OS._supports5ghz === false) {
            warn.classList.add('visible');
        } else {
            warn.classList.remove('visible');
        }
    };

    window.runChannelScan = function () {
        var btn = OS.$('btnScanChannels');
        var status = OS.$('scanStatus');
        var results = OS.$('scanResults');
        if (btn) { btn.classList.add('loading'); btn.disabled = true; }
        if (status) { status.textContent = 'Scanning\u2026 this may take a few seconds.'; status.className = 'form-status'; }
        if (results) results.style.display = 'none';

        OS.api('/api/scan').then(function (data) {
            if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
            if (!data || !data.ok) {
                var msg = (data && data.message) || (data && data.error) || 'Scan failed';
                if (status) { status.textContent = msg; status.className = 'form-status error'; }
                return;
            }
            if (status) { status.textContent = ''; status.className = 'form-status'; }
            if (results) results.style.display = 'block';
            var tbody = OS.$('scanResultsBody');
            var rec = OS.$('scanRecommendation');
            if (!tbody) return;
            var channels = data.channels || [];
            var recCh = data.recommendation;
            var html = '';
            for (var i = 0; i < channels.length; i++) {
                var ch = channels[i];
                var count = ch.count || 0;
                var sig = (typeof ch.signal === 'number' && ch.signal > -100) ? ch.signal + ' dBm' : '\u2014';
                var highlight = (ch.channel === recCh) ? ' style="background:var(--green-bg);font-weight:600"' : '';
                html += '<tr' + highlight + '>'
                    + '<td>' + ch.channel + '</td>'
                    + '<td>' + count + '</td>'
                    + '<td>' + sig + '</td>'
                    + '</tr>';
            }
            tbody.innerHTML = html || '<tr><td colspan="3" class="empty-row">No data</td></tr>';
            if (rec) {
                var netTotal = data.total_networks || 0;
                rec.innerHTML = '<span style="color:var(--green);font-weight:600">Recommended channel: ' + recCh + '</span>'
                    + ' \u2014 ' + netTotal + ' network(s) detected. Channels 1, 6, 11 are non-overlapping (2.4 GHz).';
            }
        }).catch(function (err) {
            if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
            if (status) { status.textContent = 'Scan request failed'; status.className = 'form-status error'; }
        });
    };
})(window.OS);
