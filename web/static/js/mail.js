/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * mail.js, Email Alerts configuration page.
 * Manages SMTP mode (msmtp / direct), recipient, sender, credentials,
 * test email, and shows the CLI setup-mail hint.
 */

(function (OS) {
    'use strict';

    OS.renderMail = function () {
        document.getElementById('content').insertAdjacentHTML('beforeend',
            '<section class="view" id="view-mail">'
            + '<div class="grid-2">'

            /* ── Left: Email Settings card ──────────────────────── */
            + '<div class="card">'
            +     '<div class="card-header"><h2 class="card-title">Email Settings</h2></div>'
            +     '<div class="card-body">'
            +         '<form id="mailForm" onsubmit="return OS.saveMail(event)">'
            +             '<div id="mailConfiguredIndicator" class="form-status ok" style="display:none;margin-bottom:12px;padding:10px 12px;background:var(--green-light);border:1px solid rgba(34,197,94,0.3);border-radius:var(--radius-md);align-items:center;gap:8px;">'
            +                 '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><polyline points="20 6 9 17 4 12"/></svg>'
            +                 '<span>Email alerts are configured and active</span>'
            +             '</div>'
            +             '<div class="form-row">'
            +                 '<label class="checkbox-label">'
            +                     '<input type="checkbox" id="mailEnabled" onchange="OS.mailToggleFields()">'
            +                     ' Enable Email Alerts'
            +                 '</label>'
            +                 '<span class="form-hint">Receive email notifications for security alerts</span>'
            +             '</div>'
            +             '<div id="mailFieldsGroup" style="display:none">'
            +                 '<div class="form-row">'
            +                     '<label for="mailSmtpMode">SMTP Mode</label>'
            +                     '<select id="mailSmtpMode" onchange="OS.mailToggleSmtpFields()">'
            +                         '<option value="msmtp">Local MTA (msmtp), recommended</option>'
            +                         '<option value="direct">Direct SMTP, requires credentials</option>'
            +                     '</select>'
            +                     '<span class="form-hint">msmtp requires <code>sudo oshotspot setup-mail</code> first</span>'
            +                 '</div>'
            +                 '<div class="form-row">'
            +                     '<label for="mailTo">Recipient Email</label>'
            +                     '<input type="email" id="mailTo" placeholder="admin@example.com">'
            +                 '</div>'
            +                 '<div class="form-row">'
            +                     '<label for="mailFrom">Sender Email</label>'
            +                     '<input type="email" id="mailFrom" placeholder="oshotspot@localhost">'
            +                     '<span class="form-hint">From address shown in emails</span>'
            +                 '</div>'
            +                 '<div class="form-row">'
            +                     '<label for="mailTemplate">Custom HTML Template Path (optional)</label>'
            +                     '<input type="text" id="mailTemplate" placeholder="/etc/oshotspot/email_template.html">'
            +                     '<span class="form-hint">Leave empty to use dashboard theme template. Supports placeholders: <code>{{BRAND_HEADER}}</code>, <code>{{CARDS_HTML}}</code>, <code>{{HOSTNAME}}</code>, <code>{{ADMIN_URL}}</code></span>'
            +                 '</div>'
            +                 '<div class="form-row">'
            +                     '<label style="font-weight:600;margin-bottom:6px;display:block;">Email Alert Subscriptions</label>'
            +                     '<span class="form-hint" style="margin-bottom:8px;display:block;">Select which security events dispatch an email notification:</span>'
            +                     '<div style="display:flex;flex-direction:column;gap:8px;padding:12px 14px;background:var(--bg-input,#fafafa);border:1px solid var(--border-color,rgba(0,0,0,0.08));border-radius:var(--radius-md,8px);">'
            +                         '<label class="checkbox-label" style="font-size:13px;">'
            +                             '<input type="checkbox" id="catForbidden" checked>'
            +                             '<strong>Security Policy Violations</strong>: Forbidden domain matches'
            +                         '</label>'
            +                         '<label class="checkbox-label" style="font-size:13px;">'
            +                             '<input type="checkbox" id="catUnknown" checked>'
            +                             '<strong>Rogue / Unknown Devices</strong>: Unregistered clients connecting to WiFi'
            +                         '</label>'
            +                         '<label class="checkbox-label" style="font-size:13px;">'
            +                             '<input type="checkbox" id="catLockout" checked>'
            +                             '<strong>Brute-Force &amp; Lockout Attacks</strong>: Admin &amp; captive portal bans'
            +                         '</label>'
            +                         '<label class="checkbox-label" style="font-size:13px;">'
            +                             '<input type="checkbox" id="catCriticalService" checked>'
            +                             '<strong>Critical Service Failures</strong>: Daemon crashes (hostapd/dnsmasq)'
            +                         '</label>'
            +                         '<label class="checkbox-label" style="font-size:13px;">'
            +                             '<input type="checkbox" id="catWatched">'
            +                             '<strong>Watched Domain Activity</strong>: Monitored domain queries'
            +                         '</label>'
            +                         '<label class="checkbox-label" style="font-size:13px;color:var(--text-muted,#777);">'
            +                             '<input type="checkbox" id="catFlood">'
            +                             '<strong>DNS Query Floods</strong> <span style="font-size:11px;">(Disabled by default to avoid mailbox noise)</span>'
            +                         '</label>'
            +                     '</div>'
            +                 '</div>'
            +                 '<div id="mailDirectFields" style="display:none">'
            +                     '<div class="form-row form-half">'
            +                         '<div>'
            +                             '<label for="mailSmtpHost">SMTP Host</label>'
            +                             '<input type="text" id="mailSmtpHost" placeholder="smtp.gmail.com">'
            +                         '</div>'
            +                         '<div>'
            +                             '<label for="mailSmtpPort">SMTP Port</label>'
            +                             '<input type="number" id="mailSmtpPort" value="587" min="1" max="65535">'
            +                         '</div>'
            +                     '</div>'
            +                     '<div class="form-row">'
            +                         '<label for="mailUsername">SMTP Username</label>'
            +                         '<input type="text" id="mailUsername" placeholder="your-email@gmail.com">'
            +                     '</div>'
            +                     '<div class="form-row">'
            +                         '<label for="mailPassword">SMTP Password</label>'
            +                         '<div class="input-with-action">'
            +                             '<input type="password" id="mailPassword" placeholder="App password or account password">'
            +                             '<button type="button" class="input-btn" onclick="OS.togglePasswordField(\'mailPassword\', this)" aria-label="Show password">'
            +                                 '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
            +                             '</button>'
            +                         '</div>'
            +                         '<span class="form-hint">Leave empty for local MTA (no auth)</span>'
            +                     '</div>'
            +                 '</div>'
            +                 '<div class="form-row" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">'
            +                     '<button type="button" class="btn btn-secondary btn-sm" id="btnTestMail" onclick="OS.testMail()">'
            +                         '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>'
            +                         ' Send Test Email'
            +                     '</button>'
            +                     '<button type="button" class="btn btn-ghost btn-sm" id="btnPreviewMail" onclick="OS.previewMail()">'
            +                         '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
            +                         ' Preview Email Template'
            +                     '</button>'
            +                     '<span id="mailTestStatus" class="form-status"></span>'
            +                 '</div>'
            +             '</div>'
            +             '<div class="form-row form-actions">'
            +                 '<button type="submit" class="btn btn-primary" id="btnSaveMail">'
            +                     '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>'
            +                     ' Save Configuration'
            +                 '</button>'
            +                 '<button type="button" class="btn btn-ghost" onclick="OS.loadMail()">Reset</button>'
            +                 '<span id="mailStatus" class="form-status"></span>'
            +             '</div>'
            +         '</form>'
            +     '</div>'
            + '</div>'

            /* ── Right: Quick Setup card ──────────────────────── */
            + '<div class="card">'
            +     '<div class="card-header"><h2 class="card-title">Quick Setup (CLI)</h2></div>'
            +     '<div class="card-body">'
            +         '<p class="text-muted" style="margin-bottom:12px">Configure msmtp interactively from the terminal. Supports Gmail, Outlook, and custom SMTP servers.</p>'
            +         '<div style="background:var(--bg-sidebar);border:1px solid var(--border-color);border-radius:var(--radius-md);padding:14px 16px;font-family:var(--font-mono);font-size:13px;color:var(--green);margin-bottom:16px;">'
            +             'sudo oshotspot setup-mail'
            +         '</div>'
            +         '<p class="text-muted" style="font-size:12px;margin:0 0 20px">This generates <code>/etc/oshotspot/msmtprc</code> with your SMTP credentials (chmod 600). The OSHotspot dashboard then sends via <code>sendmail</code> (localhost:25) to msmtp for delivery.</p>'

            +         '<h3 style="font-size:14px;font-weight:600;margin:0 0 10px;">How it works</h3>'
            +         '<table class="data-table">'
            +             '<thead><tr><th>Component</th><th>Role</th></tr></thead>'
            +             '<tbody>'
            +                 '<tr><td style="font-weight:600">msmtp</td><td>Local MTA, handles SMTP auth & TLS</td></tr>'
            +                 '<tr><td style="font-weight:600">OSHotspot</td><td>Sends via <code>sendmail</code> to msmtp</td></tr>'
            +                 '<tr><td style="font-weight:600">Gmail/Outlook</td><td>Receives relay, delivers to inbox</td></tr>'
            +             '</tbody>'
            +         '</table>'

            +         '<h3 style="font-size:14px;font-weight:600;margin:20px 0 10px;">SMTP Modes</h3>'
            +         '<table class="data-table">'
            +             '<thead><tr><th>Mode</th><th>Auth</th><th>Best for</th></tr></thead>'
            +             '<tbody>'
            +                 '<tr><td style="font-weight:600">msmtp</td><td>By msmtp (not in dashboard)</td><td>Recommended, password stays outside config.conf</td></tr>'
            +                 '<tr><td style="font-weight:600">direct</td><td>By Python smtplib</td><td>Quick testing, no msmtp needed</td></tr>'
            +             '</tbody>'
            +         '</table>'
            +     '</div>'
            + '</div>'

            + '</div>' /* end grid-2 */
            + '</section>'
        );
    };

    /* ── Toggle email fields group ──────────────────────────────── */
    OS.mailToggleFields = function () {
        var chk = OS.$('mailEnabled');
        var grp = OS.$('mailFieldsGroup');
        if (chk && grp) grp.style.display = chk.checked ? 'block' : 'none';
    };

    /* ── Toggle direct SMTP fields ──────────────────────────────── */
    OS.mailToggleSmtpFields = function () {
        var mode = OS.$('mailSmtpMode');
        var direct = OS.$('mailDirectFields');
        if (mode && direct) direct.style.display = mode.value === 'direct' ? 'block' : 'none';
    };

    /* ── Password eye toggle ────────────────────────────────────── */
    OS.togglePasswordField = function (inputId, btn) {
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

    /* ── Load email config from API ─────────────────────────────── */
    OS.loadMail = function () {
        OS.api('/api/config').then(function (cfg) {
            if (OS.$('mailEnabled')) OS.$('mailEnabled').checked = cfg.alert_email_enabled === 'true';
            if (OS.$('mailSmtpMode')) OS.$('mailSmtpMode').value = cfg.alert_email_smtp_mode || 'msmtp';
            if (OS.$('mailTo')) OS.$('mailTo').value = cfg.alert_email_to || '';
            if (OS.$('mailFrom')) OS.$('mailFrom').value = cfg.alert_email_from || '';
            if (OS.$('mailTemplate')) OS.$('mailTemplate').value = cfg.alert_email_template || '';

            var rawCats = cfg.alert_email_categories !== undefined ? cfg.alert_email_categories : 'forbidden_domain,unknown_device,admin_lockout,critical_service';
            var cats = String(rawCats).split(',').map(function (s) { return s.trim().toLowerCase(); });
            if (OS.$('catForbidden')) OS.$('catForbidden').checked = cats.indexOf('forbidden_domain') !== -1 || cats.indexOf('forbidden') !== -1;
            if (OS.$('catUnknown')) OS.$('catUnknown').checked = cats.indexOf('unknown_device') !== -1 || cats.indexOf('unknown_client') !== -1;
            if (OS.$('catLockout')) OS.$('catLockout').checked = cats.indexOf('admin_lockout') !== -1 || cats.indexOf('lockout') !== -1;
            if (OS.$('catCriticalService')) OS.$('catCriticalService').checked = cats.indexOf('critical_service') !== -1 || cats.indexOf('service') !== -1;
            if (OS.$('catWatched')) OS.$('catWatched').checked = cats.indexOf('watched_domain') !== -1 || cats.indexOf('watched') !== -1;
            if (OS.$('catFlood')) OS.$('catFlood').checked = cats.indexOf('dns_flood') !== -1 || cats.indexOf('flood') !== -1;

            if (OS.$('mailSmtpHost')) OS.$('mailSmtpHost').value = cfg.alert_email_smtp_host || '';
            if (OS.$('mailSmtpPort')) OS.$('mailSmtpPort').value = cfg.alert_email_smtp_port || '587';
            if (OS.$('mailUsername')) OS.$('mailUsername').value = cfg.alert_email_username || '';
            if (OS.$('mailPassword')) {
                OS.$('mailPassword').value = '';
                OS.$('mailPassword').placeholder = cfg.alert_email_password ? 'Set (enter new to change)' : 'App password or account password';
            }
            OS.mailToggleFields();
            OS.mailToggleSmtpFields();
            var indicator = OS.$('mailConfiguredIndicator');
            if (indicator) {
                var isEnabled = OS.$('mailEnabled') && OS.$('mailEnabled').checked;
                var hasTo = OS.$('mailTo') && OS.$('mailTo').value.trim();
                indicator.style.display = (isEnabled && hasTo) ? 'flex' : 'none';
            }
        }).catch(function () {});
    };

    /* ── Save email config ──────────────────────────────────────── */
    OS.saveMail = function (e) {
        e.preventDefault();
        var status = OS.$('mailStatus');
        status.textContent = '';
        status.className = 'form-status';

        var data = {};
        if (OS.$('mailEnabled')) data.alert_email_enabled = OS.$('mailEnabled').checked;
        if (OS.$('mailSmtpMode')) data.alert_email_smtp_mode = OS.$('mailSmtpMode').value;
        if (OS.$('mailTo')) data.alert_email_to = OS.$('mailTo').value.trim();
        if (OS.$('mailFrom')) data.alert_email_from = OS.$('mailFrom').value.trim();
        if (OS.$('mailTemplate')) data.alert_email_template = OS.$('mailTemplate').value.trim();

        var selectedCats = [];
        if (OS.$('catForbidden') && OS.$('catForbidden').checked) selectedCats.push('forbidden_domain');
        if (OS.$('catUnknown') && OS.$('catUnknown').checked) selectedCats.push('unknown_device');
        if (OS.$('catLockout') && OS.$('catLockout').checked) selectedCats.push('admin_lockout');
        if (OS.$('catCriticalService') && OS.$('catCriticalService').checked) selectedCats.push('critical_service');
        if (OS.$('catWatched') && OS.$('catWatched').checked) selectedCats.push('watched_domain');
        if (OS.$('catFlood') && OS.$('catFlood').checked) selectedCats.push('dns_flood');
        data.alert_email_categories = selectedCats.join(',');

        if (OS.$('mailSmtpMode') && OS.$('mailSmtpMode').value === 'direct') {
            if (OS.$('mailSmtpHost')) data.alert_email_smtp_host = OS.$('mailSmtpHost').value.trim();
            if (OS.$('mailSmtpPort')) data.alert_email_smtp_port = parseInt(OS.$('mailSmtpPort').value, 10);
            if (OS.$('mailUsername')) data.alert_email_username = OS.$('mailUsername').value.trim();
        }
        var smtpPw = OS.$('mailPassword') ? OS.$('mailPassword').value : '';
        if (smtpPw) data.alert_email_password = smtpPw;

        if (!Object.keys(data).length) {
            status.textContent = 'No changes to save';
            status.className = 'form-status error';
            return;
        }

        var btn = OS.$('btnSaveMail');
        if (btn) { btn.classList.add('loading'); btn.disabled = true; }

        OS.api('/api/config', 'POST', data).then(function (res) {
            status.textContent = 'Saved: ' + (res.updated || []).join(', ');
            status.className = 'form-status ok';
            OS.toast('Email config saved', 'Updated: ' + (res.updated || []).join(', '), 'success');
            if (OS.$('mailPassword')) OS.$('mailPassword').value = '';
            OS.loadMail();
            if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
            setTimeout(function () {
                status.textContent = '';
                status.className = 'form-status';
            }, 4000);
        }).catch(function (err) {
            var msg = (err && err.errors) ? err.errors.join(' ') : (err && err.message ? err.message : 'Save failed');
            status.textContent = msg;
            status.className = 'form-status error';
            OS.toast('Save failed', msg, 'error');
            if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
        });
    };

    /* ── Send test email ────────────────────────────────────────── */
    OS.testMail = function () {
        var btn = OS.$('btnTestMail');
        var status = OS.$('mailTestStatus');
        if (btn) { btn.classList.add('loading'); btn.disabled = true; }
        if (status) { status.textContent = 'Sending test email\u2026'; status.className = 'form-status'; }
        OS.api('/api/mail/test', 'POST', {}).then(function (res) {
            if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
            if (status) { status.textContent = res.message || 'Test email sent!'; status.className = 'form-status ok'; }
            OS.toast('Email', res.message || 'Test email sent', 'success');
        }).catch(function (err) {
            if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
            var msg = (err && err.message) ? err.message : 'Failed to send test email';
            if (status) { status.textContent = msg; status.className = 'form-status error'; }
            OS.toast('Email failed', msg, 'error');
        });
    };

    /* ── Preview email template modal ────────────────────────────── */
    OS.previewMail = function (initialType) {
        var existing = document.getElementById('mailPreviewModal');
        if (existing) existing.remove();

        var currentType = initialType || 'alert';
        var currentMode = 'desktop';

        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'mailPreviewModal';
        overlay.style.zIndex = '1000';

        overlay.innerHTML =
            '<div class="modal-card" style="max-width:780px;width:95%;padding:20px;max-height:92vh;display:flex;flex-direction:column;">'
            + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;border-bottom:1px solid var(--border-color);padding-bottom:12px;">'
            +     '<div>'
            +         '<h2 class="modal-title" style="margin:0;font-size:16px;">Email Template Live Preview</h2>'
            +         '<p style="color:var(--text-muted);font-size:12px;margin:2px 0 0;">Inspect the responsive layout as received by the administrator</p>'
            +     '</div>'
            +     '<button type="button" class="btn btn-ghost btn-sm" onclick="closeMailPreviewModal()" aria-label="Close" style="padding:4px 8px;font-size:18px;">&times;</button>'
            + '</div>'
            + '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:14px;">'
            +     '<div style="display:inline-flex;background:var(--bg-card);border:1px solid var(--border-color);border-radius:6px;padding:3px;">'
            +         '<button type="button" id="prevTabAlert" class="btn btn-sm btn-primary" style="font-size:12px;padding:5px 12px;" onclick="OS.setPreviewTab(\'alert\')">Security Alert Digest</button>'
            +         '<button type="button" id="prevTabTest" class="btn btn-sm btn-ghost" style="font-size:12px;padding:5px 12px;" onclick="OS.setPreviewTab(\'test\')">Test Diagnostic Email</button>'
            +     '</div>'
            +     '<div style="display:inline-flex;gap:6px;align-items:center;">'
            +         '<button type="button" id="prevViewDesktop" class="btn btn-sm btn-secondary" style="font-size:11px;padding:4px 10px;" onclick="OS.setPreviewViewport(\'desktop\')">'
            +             '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:4px;"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>Desktop (600px)'
            +         '</button>'
            +         '<button type="button" id="prevViewMobile" class="btn btn-sm btn-ghost" style="font-size:11px;padding:4px 10px;" onclick="OS.setPreviewViewport(\'mobile\')">'
            +             '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:4px;"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>Mobile (375px)'
            +         '</button>'
            +         '<a id="prevOpenExternal" href="/api/mail/preview?type=alert" target="_blank" class="btn btn-sm btn-ghost" style="font-size:11px;padding:4px 8px;" title="Open raw HTML in new tab">'
            +             '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>'
            +         '</a>'
            +     '</div>'
            + '</div>'
            + '<div style="flex:1;min-height:480px;background:var(--bg-input,#f4f4f4);border:1px solid var(--border);border-radius:8px;padding:14px;overflow:auto;display:flex;justify-content:center;align-items:flex-start;">'
            +     '<iframe id="mailPreviewFrame" src="/api/mail/preview?type=alert" style="width:600px;max-width:100%;height:540px;border:1px solid var(--border);border-radius:8px;background:#ffffff;box-shadow:0 4px 14px rgba(0,0,0,0.08);transition:width 0.2s ease;"></iframe>'
            + '</div>'
            + '<div class="modal-actions" style="margin-top:14px;display:flex;justify-content:space-between;align-items:center;">'
            +     '<span style="font-size:11px;color:var(--text-muted);">Rendered using active system configuration &amp; host parameters</span>'
            +     '<button type="button" class="btn btn-ghost btn-sm" onclick="closeMailPreviewModal()">Close Preview</button>'
            + '</div>'
            + '</div>';

        document.body.appendChild(overlay);

        OS.setPreviewTab = function (type) {
            currentType = type;
            var frame = document.getElementById('mailPreviewFrame');
            var tabAlert = document.getElementById('prevTabAlert');
            var tabTest = document.getElementById('prevTabTest');
            var extLink = document.getElementById('prevOpenExternal');
            if (frame) frame.src = '/api/mail/preview?type=' + type + '&t=' + Date.now();
            if (extLink) extLink.href = '/api/mail/preview?type=' + type;
            if (tabAlert && tabTest) {
                if (type === 'alert') {
                    tabAlert.className = 'btn btn-sm btn-primary';
                    tabTest.className = 'btn btn-sm btn-ghost';
                } else {
                    tabAlert.className = 'btn btn-sm btn-ghost';
                    tabTest.className = 'btn btn-sm btn-primary';
                }
            }
        };

        OS.setPreviewViewport = function (mode) {
            currentMode = mode;
            var frame = document.getElementById('mailPreviewFrame');
            var btnDesk = document.getElementById('prevViewDesktop');
            var btnMob = document.getElementById('prevViewMobile');
            if (frame) {
                frame.style.width = mode === 'mobile' ? '375px' : '600px';
            }
            if (btnDesk && btnMob) {
                if (mode === 'desktop') {
                    btnDesk.className = 'btn btn-sm btn-secondary';
                    btnMob.className = 'btn btn-sm btn-ghost';
                } else {
                    btnDesk.className = 'btn btn-sm btn-ghost';
                    btnMob.className = 'btn btn-sm btn-secondary';
                }
            }
        };

        window.closeMailPreviewModal = function () {
            var el = document.getElementById('mailPreviewModal');
            if (el) el.remove();
        };

        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeMailPreviewModal();
        });

        var escHandler = function (e) {
            if (e.key === 'Escape') {
                closeMailPreviewModal();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
    };
})(window.OS);
