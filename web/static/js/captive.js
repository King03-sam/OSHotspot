/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * captive.js -- Captive Portal management UI module.
 */

(function (OS) {
    'use strict';

    var _rawCapCode = '';
    var _capCodeVisible = false;
    var _captiveLeaseHours = 0;
    var _accessCodesBlurred = false;

    OS.renderCaptive = function () {
        document.getElementById('content').insertAdjacentHTML('beforeend',
            '<section class="view" id="view-captive">'
            + '<div class="grid-2">'
            +     '<div class="card">'
            +         '<div class="card-header"><h2 class="card-title">Captive Portal Settings</h2></div>'
            +         '<div class="card-body">'
            +             '<form id="captiveForm" onsubmit="submitCaptiveConfig(event)">'
            +                 '<div class="form-row">'
            +                     '<label class="checkbox-label">'
            +                         '<input type="checkbox" id="capEnabled"> Enable Captive Portal'
            +                     '</label>'
            +                     '<span class="form-hint">Intercept unauthenticated HTTP traffic and require login</span>'
            +                 '</div>'
            +                 '<div class="form-row">'
            +                     '<label for="capCode">Permanent Access Code (Optional)</label>'
            +                     '<input type="password" id="capCode" placeholder="Enter new access code (leave blank to keep current)" autocomplete="new-password">'
            +                     '<span class="form-hint">If set, users must enter this code to connect</span>'
            +                     '<div class="access-code-box" style="margin-top:10px;padding:10px 14px;background:rgba(255,255,255,0.03);border:1px solid var(--border-color);border-radius:8px;display:flex;align-items:center;justify-content:space-between;">'
            +                         '<div>'
            +                             '<span class="text-muted" style="font-size:11px;display:block;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px">Current Access Code</span>'
            +                             '<span id="currentCapCodeValue" style="font-family:monospace;font-weight:600;letter-spacing:1px;font-size:14px;">\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022</span>'
            +                         '</div>'
            +                         '<div style="display:flex;align-items:center;gap:8px;">'
            +                             '<button type="button" class="btn btn-ghost btn-sm" id="btnToggleCapCode" onclick="toggleCapCodeVisibility()" title="Show / Hide Code" style="padding:4px 8px;display:flex;align-items:center;gap:6px">'
            +                                 '<svg id="eyeIcon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            +                                     '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'
            +                                 '</svg>'
            +                                 '<span id="eyeBtnText" style="font-size:12px">Show</span>'
            +                             '</button>'
            +                         '</div>'
            +                     '</div>'
            +                 '</div>'
            +                 '<div class="form-row">'
            +                     '<label for="capMsg">Welcome Message</label>'
            +                     '<input type="text" id="capMsg" placeholder="Welcome message shown on login page">'
            +                 '</div>'
            +                 '<div class="form-row">'
            +                     '<label for="capDomain">Custom Portal Domain Name (Optional)</label>'
            +                     '<div style="display:flex;gap:8px;align-items:center;">'
            +                         '<input type="text" id="capDomain" placeholder="e.g. wifi.portal or connect.mywifi.local" oninput="updateDomainHint()" style="flex:1;">'
            +                         '<button type="button" class="btn btn-secondary btn-sm" id="btnApplyDomain" onclick="saveCaptiveDomainOnly()" style="white-space:nowrap;padding:8px 14px;height:38px;display:inline-flex;align-items:center;gap:6px;">'
            +                             '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>'
            +                             '<span>Save Domain</span>'
            +                         '</button>'
            +                     '</div>'
            +                     '<div id="capDomainHintBox" style="margin-top:6px;padding:8px 12px;background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.22);border-radius:7px;display:none;">'
            +                         '<span class="text-muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Portal currently accessible via</span><br>'
            +                         '<span id="capDomainHintVal" style="font-family:monospace;font-size:13px;font-weight:600;color:var(--accent, #818cf8);"></span>'
            +                     '</div>'
            +                     '<span class="form-hint">Used for captive portal URL and printed on access vouchers</span>'
            +                 '</div>'
            +                 '<div class="form-row">'
            +                     '<label for="capBgColor">Portal Background Color</label>'
            +                     '<div style="display:flex;align-items:center;gap:10px;">'
            +                         '<input type="color" id="capBgColorPicker" value="#050505" onchange="OS.$(\'capBgColor\').value = this.value" style="width:40px;height:38px;padding:0;border:none;border-radius:6px;cursor:pointer;background:none;">'
            +                         '<input type="text" id="capBgColor" value="#050505" placeholder="#050505" oninput="if(/^#[0-9A-Fa-f]{6}$/.test(this.value)) OS.$(\'capBgColorPicker\').value = this.value" style="flex:1;">'
            +                     '</div>'
            +                 '</div>'
            +                 '<div class="form-row">'
            +                     '<label>Custom Portal Logo Image (Replaces Default Logo)</label>'
            +                     '<div style="display:flex;align-items:center;gap:10px;">'
            +                         '<input type="file" id="capLogoInput" accept="image/*" onchange="uploadCaptiveLogo(this)" style="display:none;">'
            +                         '<button type="button" class="btn btn-secondary btn-sm" onclick="OS.$(\'capLogoInput\').click()">Upload Logo Image</button>'
            +                         '<button type="button" class="btn btn-danger btn-sm" id="btnRemoveLogo" onclick="confirmRemoveCaptiveLogo()" style="display:none;">Remove Custom Logo</button>'
            +                     '</div>'
            +                     '<div id="capLogoPreviewBox" style="margin-top:10px;display:none;">'
            +                         '<span class="text-muted" style="font-size:11px;display:block;margin-bottom:4px">Logo Preview:</span>'
            +                         '<img id="capLogoPreview" src="" alt="Logo Preview" style="max-width:140px;max-height:70px;object-fit:contain;border:1px solid var(--border-color);border-radius:8px;padding:6px;background:#121214;">'
            +                     '</div>'
            +                 '</div>'
            +                 '<div class="form-row form-actions">'
            +                     '<button type="submit" class="btn btn-primary" id="btnSaveCaptive">Save Settings</button>'
            +                     '<span id="captiveStatus" class="form-status"></span>'
            +                 '</div>'
            +             '</form>'
            +         '</div>'
            +     '</div>'
            +     '<div class="card">'
            +         '<div class="card-header">'
            +             '<h2 class="card-title">Authenticated Clients</h2>'
            +             '<span class="nav-pill" style="background:var(--green);color:#000;font-weight:600;font-size:11px;padding:2px 8px;border-radius:12px;">LIVE</span>'
            +         '</div>'
            +         '<div class="card-body no-pad">'
            +             '<div class="table-wrap">'
            +                 '<table class="data-table">'
            +                     '<thead><tr><th>MAC Address</th><th>Hostname / Device</th><th>Action</th></tr></thead>'
            +                     '<tbody id="captiveClientsBody"><tr><td colspan="3" class="empty-row">Loading authenticated clients\u2026</td></tr></tbody>'
            +                 '</table>'
            +             '</div>'
            +         '</div>'
            +     '</div>'
            + '</div>'
            + '<div class="card" style="margin-top:16px;">'
            +     '<div class="card-header" style="display:flex;align-items:center;justify-content:space-between;">'
            +         '<div>'
            +             '<h2 class="card-title">Access Codes</h2>'
            +             '<span class="text-muted" style="font-size:11px;">Temporary codes with lease + permanent code</span>'
            +         '</div>'
            +         '<button type="button" class="btn btn-ghost btn-sm" id="btnToggleAccessCodesBlur" onclick="toggleAccessCodesBlur()" title="Mask / Unmask Codes" style="padding:4px 10px;display:flex;align-items:center;gap:6px;">'
            +             '<svg id="codesEyeIcon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            +                 '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'
            +             '</svg>'
            +             '<span id="codesEyeBtnText" style="font-size:12px;">Mask Codes</span>'
            +         '</button>'
            +     '</div>'
            +     '<div class="card-body no-pad">'
            +         '<div class="table-wrap">'
            +             '<table class="data-table">'
            +                 '<thead><tr><th>Code</th><th>Type</th><th>Duration</th><th>Expires</th><th>Bound MAC</th><th>Device</th><th>Status</th><th>Actions</th></tr></thead>'
            +                 '<tbody id="captiveCodesBody"><tr><td colspan="8" class="empty-row">Loading access codes\u2026</td></tbody>'
            +             '</table>'
            +         '</div>'
            +     '</div>'
             +     '<div class="card-body" style="border-top:1px solid var(--border);">'
             +         '<form id="tempCodeForm" onsubmit="submitTempCode(event)" style="display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;">'
             +             '<div style="flex:1;min-width:160px;">'
             +                 '<label for="newTempCode" style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px;">Code</label>'
             +                 '<input type="text" id="newTempCode" placeholder="e.g. EVENT2024" style="width:100%;">'
             +             '</div>'
             +             '<div style="width:140px;">'
             +                 '<label for="newTempDuration" style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px;">Duration</label>'
             +                 '<select id="newTempDuration" style="width:100%;">'
             +                     '<option value="0.0833">5 minutes</option>'
             +                     '<option value="0.1667">10 minutes</option>'
             +                     '<option value="0.5">30 minutes</option>'
             +                     '<option value="1">1 hour</option>'
             +                     '<option value="2">2 hours</option>'
             +                     '<option value="6">6 hours</option>'
             +                     '<option value="12">12 hours</option>'
             +                     '<option value="24" selected>24 hours</option>'
             +                     '<option value="48">48 hours</option>'
             +                     '<option value="72">72 hours</option>'
             +                     '<option value="168">1 week</option>'
             +                     '<option value="720">1 month</option>'
             +                 '</select>'
             +             '</div>'
             +             '<div style="flex:1;min-width:140px;">'
             +                 '<label for="newTempLabel" style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px;">Label (optional)</label>'
             +                 '<input type="text" id="newTempLabel" placeholder="e.g. Salle A" style="width:100%;">'
             +             '</div>'
             +             '<button type="submit" class="btn btn-primary" id="btnAddTempCode">Add Temporary Code</button>'
             +             '<button type="button" class="btn btn-secondary" id="btnExportPdf" onclick="exportCodesPDF()">Export PDF</button>'
             +         '</form>'
             +     '</div>'
             +     '<div class="card-body" style="border-top:1px solid var(--border);">'
             +         '<form id="randomCodeForm" onsubmit="generateBulkRandomCodes(event)" style="display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;">'
             +             '<div style="width:100px;">'
             +                 '<label for="randCount" style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px;">Count</label>'
             +                 '<input type="number" id="randCount" min="1" max="50" value="10" style="width:100%;">'
             +             '</div>'
             +             '<div style="width:100px;">'
             +                 '<label for="randLength" style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px;">Length</label>'
             +                 '<select id="randLength" style="width:100%;">'
             +                     '<option value="4">4</option>'
             +                     '<option value="5">5</option>'
             +                     '<option value="6">6</option>'
             +                     '<option value="7">7</option>'
             +                     '<option value="8" selected>8</option>'
             +                     '<option value="10">10</option>'
             +                     '<option value="12">12</option>'
             +                 '</select>'
             +             '</div>'
             +             '<div style="width:110px;">'
             +                 '<label for="randPrefix" style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px;">Prefix (opt)</label>'
             +                 '<input type="text" id="randPrefix" placeholder="e.g. VIP-" style="width:100%;">'
             +             '</div>'
             +             '<div style="width:130px;">'
             +                 '<label for="randDuration" style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px;">Duration</label>'
             +                 '<select id="randDuration" style="width:100%;">'
             +                     '<option value="0.0833">5 minutes</option>'
             +                     '<option value="0.1667">10 minutes</option>'
             +                     '<option value="0.5">30 minutes</option>'
             +                     '<option value="1">1 hour</option>'
             +                     '<option value="2">2 hours</option>'
             +                     '<option value="6">6 hours</option>'
             +                     '<option value="12">12 hours</option>'
             +                     '<option value="24" selected>24 hours</option>'
             +                     '<option value="48">48 hours</option>'
             +                     '<option value="72">72 hours</option>'
             +                     '<option value="168">1 week</option>'
             +                     '<option value="720">1 month</option>'
             +                 '</select>'
             +             '</div>'
             +             '<div style="flex:1;min-width:130px;">'
             +                 '<label for="randLabel" style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px;">Label (optional)</label>'
             +                 '<input type="text" id="randLabel" placeholder="e.g. Event" style="width:100%;">'
             +             '</div>'
             +             '<button type="submit" class="btn btn-primary" id="btnGenerateRandom">Generate Codes</button>'
             +         '</form>'
             +     '</div>'
             + '</div>'
             + '</section>'
         );
     };

    function updateCodeDisplay() {
        var el = OS.$('currentCapCodeValue');
        var btnText = OS.$('eyeBtnText');
        var eyeIcon = OS.$('eyeIcon');
        var btnClear = OS.$('btnClearCapCode');
        if (!el) return;
        if (!_rawCapCode) {
            el.textContent = '(none / TOS only)';
            el.style.color = 'var(--text-muted)';
            if (btnText) btnText.textContent = 'Show';
            return;
        }
        el.style.color = '';
        if (_capCodeVisible) {
            el.textContent = _rawCapCode;
            if (btnText) btnText.textContent = 'Hide';
            if (eyeIcon) {
                eyeIcon.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';
            }
        } else {
            el.textContent = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
            if (btnText) btnText.textContent = 'Show';
            if (eyeIcon) {
                eyeIcon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
            }
        }
    }

    window.toggleCapCodeVisibility = function () {
        _capCodeVisible = !_capCodeVisible;
        updateCodeDisplay();
    };

    window.updateDomainHint = function () {
        var input = OS.$('capDomain');
        var hintBox = OS.$('capDomainHintBox');
        var hintVal = OS.$('capDomainHintVal');
        if (!hintBox || !hintVal) return;
        var rawVal = (input ? input.value : '').trim().toLowerCase();
        var val = rawVal.replace(/^https?:\/\//, '').split('/')[0].split(':')[0].trim();
        if (val) {
            hintVal.textContent = 'http://' + val + '/';
            hintBox.style.display = 'block';
        } else {
            hintBox.style.display = 'none';
            hintVal.textContent = '';
        }
    };

    window.saveCaptiveDomainOnly = function () {
        var input = OS.$('capDomain');
        if (!input) return;
        var domainVal = input.value.trim().toLowerCase();
        var btn = OS.$('btnApplyDomain');
        if (btn) { btn.disabled = true; btn.innerHTML = '<span>Saving…</span>'; }

        OS.api('/api/config', 'POST', { captive_domain: domainVal }).then(function () {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg><span>Save Domain</span>';
            }
            OS.toast('Custom Domain', 'Custom portal domain updated successfully', 'success');
            loadCaptive();
        }).catch(function (err) {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg><span>Save Domain</span>';
            }
            OS.toast('Custom Domain', 'Failed to save domain: ' + (err.message || err), 'error');
        });
    };

    function updateLogoPreview(url) {
        var box = OS.$('capLogoPreviewBox');
        var img = OS.$('capLogoPreview');
        var btnRm = OS.$('btnRemoveLogo');
        if (!box || !img) return;
        if (url) {
            var src = (url.indexOf('data:') === 0) ? url : (url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now());
            img.src = src;
            box.style.display = 'block';
            if (btnRm) btnRm.style.display = 'inline-block';
        } else {
            img.src = '';
            box.style.display = 'none';
            if (btnRm) btnRm.style.display = 'none';
        }
    }

    function resizeLogoImage(file, maxWidth, maxHeight, callback) {
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

    window.uploadCaptiveLogo = function (input) {
        if (!input || !input.files || !input.files[0]) return;
        var file = input.files[0];
        resizeLogoImage(file, 400, 200, function (b64) {
            updateLogoPreview(b64);
            OS.api('/api/captive/logo', 'POST', { logo_base64: b64 }).then(function (res) {
                OS.toast('Captive Portal', 'Logo image uploaded successfully', 'success');
                updateLogoPreview(res.logo_url || '/images/captive_logo.png');
            }).catch(function (err) {
                var errMsg = (err && (err.error || err.message)) ? (err.error || err.message) : 'Failed to upload logo image';
                OS.toast('Captive Portal', errMsg, 'error');
                updateLogoPreview('');
            });
        });
    };

    window.confirmRemoveCaptiveLogo = function () {
        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'removeCaptiveLogoModal';
        overlay.innerHTML = '<div class="modal-card">'
            + '<div class="modal-icon">'
            +   '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            +     '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>'
            +   '</svg>'
            + '</div>'
            + '<h2 class="modal-title">Remove Custom Logo</h2>'
            + '<p class="modal-message">Are you sure you want to remove the captive portal custom logo and revert to default?</p>'
            + '<div class="modal-actions">'
            +   '<button class="btn btn-ghost" onclick="closeRemoveCaptiveLogoModal()">Cancel</button>'
            +   '<button class="btn btn-danger" onclick="doRemoveCaptiveLogo()">Remove Logo</button>'
            + '</div>'
            + '</div>';
        overlay.addEventListener('click', function (e) { if (e.target === overlay) closeRemoveCaptiveLogoModal(); });
        document.addEventListener('keydown', function escHandler(e) { if (e.key === 'Escape') { closeRemoveCaptiveLogoModal(); document.removeEventListener('keydown', escHandler); } });
        document.body.appendChild(overlay);
    };

    window.closeRemoveCaptiveLogoModal = function () {
        var el = document.getElementById('removeCaptiveLogoModal');
        if (el) el.remove();
    };

    window.doRemoveCaptiveLogo = function () {
        closeRemoveCaptiveLogoModal();
        OS.api('/api/captive/logo', 'POST', { action: 'remove' }).then(function () {
            OS.toast('Captive Portal', 'Custom logo removed', 'info');
            updateLogoPreview('');
            var fileInput = OS.$('capLogoInput');
            if (fileInput) fileInput.value = '';
        }).catch(function () {});
    };

    function loadCaptiveClients() {
        OS.api('/api/captive/clients').then(function (macs) {
            var tbody = OS.$('captiveClientsBody');
            if (!tbody) return;
            if (!macs || !macs.length) {
                tbody.innerHTML = '<tr><td colspan="3" class="empty-row">No authenticated clients currently whitelisted</td></tr>';
                return;
            }
            var html = '';
            for (var i = 0; i < macs.length; i++) {
                var item = macs[i];
                var mac = (typeof item === 'string') ? item : (item.mac || '');
                var host = (typeof item === 'object' && item.hostname) ? item.hostname : '';
                var ip = (typeof item === 'object' && item.ip) ? item.ip : '';
                var hostLabel = host ? OS.esc(host) : '<span class="text-muted">\u2014</span>';
                if (ip) {
                    hostLabel += ' <span class="text-muted">(' + OS.esc(ip) + ')</span>';
                }
                html += '<tr class="live-client-row">'
                    + '<td class="mono">' + OS.esc(mac) + '</td>'
                    + '<td>' + hostLabel + '</td>'
                    + '<td><button class="btn btn-danger btn-sm" onclick="confirmRevokeCaptiveClient(\'' + OS.esc(mac) + '\')">Revoke</button></td>'
                    + '</tr>';
            }
            tbody.innerHTML = html;
        }).catch(function () {});
    }
    window.loadCaptiveClients = loadCaptiveClients;

    function generateRandomCode(len) {
        len = len || 8;
        var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        var out = '';
        for (var i = 0; i < len; i++) {
            out += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return out;
    }

    function loadCaptiveCodes() {
        OS.api('/api/captive/codes').then(function (data) {
            if (!data) return;
            _captiveLeaseHours = data.lease_hours || 0;
            renderCaptiveCodes(data.permanent_code, data.permanent_active, data.temporary_codes || []);
        }).catch(function () {
            renderCaptiveCodes('', false, []);
        });
    }
    window.loadCaptiveCodes = loadCaptiveCodes;

    function renderCaptiveCodes(permanentCode, permanentActive, tempCodes) {
        var tbody = OS.$('captiveCodesBody');
        if (!tbody) return;

        var now = Date.now();
        var html = '';

        var codeBlurStyle = _accessCodesBlurred
            ? 'filter:blur(5px);user-select:none;-webkit-user-select:none;'
            : 'filter:none;user-select:text;-webkit-user-select:text;';

        if (permanentActive) {
            var leaseLabel = _captiveLeaseHours > 0
                ? _captiveLeaseHours + 'h lease'
                : 'No lease (unlimited)';
            html += '<tr>'
                + '<td class="mono"><span class="access-code-text" onclick="toggleSingleCodeBlur(this)" style="font-family:monospace;font-weight:600;transition:filter 0.2s ease;cursor:pointer;' + codeBlurStyle + '" title="' + (_accessCodesBlurred ? 'Click to show code' : '') + '">' + OS.esc(permanentCode) + '</span></td>'
                + '<td><span class="badge badge-blue">Permanent</span></td>'
                + '<td>\u2014</td>'
                + '<td>\u2014</td>'
                + '<td>\u2014</td>'
                + '<td>\u2014</td>'
                + '<td><span class="badge badge-cyan">Active</span></td>'
                + '<td><span class="text-muted" style="font-size:11px;">Built-in</span></td>'
                + '</tr>';
        }

        for (var i = 0; i < tempCodes.length; i++) {
            var c = tempCodes[i];
            var mac = c.bound_mac || '';
            var hostname = c.bound_hostname || '';
            var ip = c.bound_ip || '';
            var deviceLabel = '';
            if (hostname) {
                deviceLabel = OS.esc(hostname);
                if (ip) deviceLabel += ' <span class="text-muted">' + OS.esc(ip) + '</span>';
            } else if (ip) {
                deviceLabel = '<span class="text-muted">' + OS.esc(ip) + '</span>';
            } else {
                deviceLabel = '<span class="text-muted">\u2014</span>';
            }

            var remaining = c.remaining_seconds;
            var expiresText = '<span class="text-muted" style="font-style:italic;font-size:11px;">Starts on 1st use</span>';
            var remainingText = '';
            var statusBadge = '<span class="badge badge-cyan">Unused (Ready)</span>';

            if (c.expires_at) {
                var expDate = new Date(c.expires_at);
                var pad = function (n) { return n < 10 ? '0' + n : n; };
                expiresText = pad(expDate.getDate()) + '/' + pad(expDate.getMonth() + 1) + ' ' + pad(expDate.getHours()) + ':' + pad(expDate.getMinutes());
                if (remaining !== null && remaining > 0) {
                    var h = Math.floor(remaining / 3600);
                    var m = Math.floor((remaining % 3600) / 60);
                    remainingText = h > 0 ? h + 'h ' : '';
                    remainingText += m + 'm';
                }
                statusBadge = '<span class="badge badge-green">In Use</span>';
            }

            if (c.status === 'expired') statusBadge = '<span class="badge badge-red">Expired</span>';
            else if (c.status === 'revoked') statusBadge = '<span class="badge badge-red">Revoked</span>';
            else if (c.expires_at && remaining !== null && remaining < 900) statusBadge = '<span class="badge badge-yellow">' + remainingText + ' left</span>';

            var actions = '';
            if (c.status === 'active') {
                actions = '<button class="btn btn-danger btn-sm" onclick="confirmRevokeCode(\'' + OS.esc(c.id) + '\', \'' + OS.esc(c.code) + '\')">Revoke</button>';
            }

            var durVal = c.duration_hours;
            var durLabel = '\u2014';
            if (durVal == 0.0833 || durVal == '0.0833') {
                durLabel = '5m';
            } else if (durVal == 0.1667 || durVal == '0.1667') {
                durLabel = '10m';
            } else if (durVal === 0.5 || durVal === '0.5') {
                durLabel = '30m';
            } else if (durVal) {
                durLabel = durVal + 'h';
            }

            html += '<tr>'
                + '<td class="mono"><span class="access-code-text" onclick="toggleSingleCodeBlur(this)" style="font-family:monospace;font-weight:600;transition:filter 0.2s ease;cursor:pointer;' + codeBlurStyle + '" title="' + (_accessCodesBlurred ? 'Click to show code' : '') + '">' + OS.esc(c.code) + '</span></td>'
                + '<td><span class="badge badge-purple">Temporary</span></td>'
                + '<td>' + durLabel + '</td>'
                + '<td>' + expiresText + '</td>'
                + '<td class="mono">' + (mac ? OS.esc(mac) : '<span class="text-muted">\u2014</span>') + '</td>'
                + '<td>' + deviceLabel + '</td>'
                + '<td>' + statusBadge + '</td>'
                + '<td>' + actions + '</td>'
                + '</tr>';
        }

        if (!html) {
            html = '<tr><td colspan="7" class="empty-row">No temporary codes. Add one below.</td></tr>';
        }
        tbody.innerHTML = html;
    }

    window.submitTempCode = function (e) {
        e.preventDefault();
        var codeInput = OS.$('newTempCode');
        var durationSelect = OS.$('newTempDuration');
        var labelInput = OS.$('newTempLabel');
        var btn = OS.$('btnAddTempCode');

        var code = (codeInput.value || '').trim().toUpperCase();
        var duration = parseFloat(durationSelect.value) || 24;
        var label = (labelInput.value || '').trim();

        if (!code) {
            OS.toast('Error', 'Code is required', 'error');
            return;
        }

        if (btn) { btn.classList.add('loading'); btn.disabled = true; }

        OS.api('/api/captive/codes', 'POST', { code: code, duration_hours: duration, label: label }).then(function (res) {
            OS.toast('Code added', 'Temporary code ' + code + ' created', 'success');
            if (codeInput) codeInput.value = '';
            if (labelInput) labelInput.value = '';
            loadCaptiveCodes();
        }).catch(function (err) {
            OS.toast('Failed', (err && (err.error || err.message)) || 'Could not create code', 'error');
        }).finally(function () {
            if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
        });
    };

    window.generateBulkRandomCodes = function (e) {
        e.preventDefault();
        var countInput = OS.$('randCount');
        var lengthSelect = OS.$('randLength');
        var prefixInput = OS.$('randPrefix');
        var durationSelect = OS.$('randDuration');
        var labelInput = OS.$('randLabel');
        var btn = OS.$('btnGenerateRandom');

        var count = parseInt(countInput.value, 10) || 10;
        var length = parseInt(lengthSelect.value, 10) || 8;
        var prefix = (prefixInput ? prefixInput.value : '').trim();
        var duration = parseFloat(durationSelect.value) || 24;
        var label = (labelInput.value || '').trim();

        if (isNaN(count) || count < 1 || count > 50) {
            OS.toast('Error', 'Count must be between 1 and 50', 'error');
            return;
        }
        if (isNaN(length) || length < 4 || length > 12) {
            OS.toast('Error', 'Length must be between 4 and 12', 'error');
            return;
        }

        if (btn) { btn.classList.add('loading'); btn.disabled = true; }

        OS.api('/api/captive/codes/generate', 'POST', {
            count: count,
            length: length,
            prefix: prefix,
            duration_hours: duration,
            label: label
        }).then(function (res) {
            var n = (res && res.count) ? res.count : count;
            OS.toast('Success', n + ' codes generated successfully', 'success');
            if (labelInput) labelInput.value = '';
            loadCaptiveCodes();
        }).catch(function (err) {
            var msg = (err && (err.error || err.message)) ? (err.error || err.message) : 'Failed to generate random codes';
            OS.toast('Error', msg, 'error');
            loadCaptiveCodes();
        }).finally(function () {
            if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
        });
    };

    window.toggleAccessCodesBlur = function () {
        _accessCodesBlurred = !_accessCodesBlurred;
        var btnText = OS.$('codesEyeBtnText');
        var eyeIcon = OS.$('codesEyeIcon');
        var els = document.querySelectorAll('.access-code-text');

        if (btnText) {
            btnText.textContent = _accessCodesBlurred ? 'Show Codes' : 'Mask Codes';
        }
        if (eyeIcon) {
            if (_accessCodesBlurred) {
                eyeIcon.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';
            } else {
                eyeIcon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
            }
        }

        for (var i = 0; i < els.length; i++) {
            if (_accessCodesBlurred) {
                els[i].style.filter = 'blur(5px)';
                els[i].style.userSelect = 'none';
                els[i].style.webkitUserSelect = 'none';
                els[i].title = 'Click to show code';
            } else {
                els[i].style.filter = 'none';
                els[i].style.userSelect = 'text';
                els[i].style.webkitUserSelect = 'text';
                els[i].title = '';
            }
        }
    };

    window.toggleSingleCodeBlur = function (el) {
        if (!el) return;
        if (el.style.filter && el.style.filter !== 'none') {
            el.style.filter = 'none';
            el.style.userSelect = 'text';
            el.style.webkitUserSelect = 'text';
            el.title = '';
        } else {
            el.style.filter = 'blur(5px)';
            el.style.userSelect = 'none';
            el.style.webkitUserSelect = 'none';
            el.title = 'Click to show code';
        }
    };

    window.exportCodesPDF = function () {
        window.open('/api/captive/codes/export-pdf', '_blank');
    };

    /* ── Confirmation modals ─────────────────────────────────────── */

    window.confirmRevokeCode = function (id, code) {
        if (!id || !code) return;
        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'revokeCodeModal';
        overlay.innerHTML = '<div class="modal-card">'
            + '<div class="modal-icon">'
            +   '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            +     '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>'
            +   '</svg>'
            + '</div>'
            + '<h2 class="modal-title">Revoke code</h2>'
            + '<p class="modal-message">Code "' + OS.esc(code) + '" will be immediately revoked and the bound device will be disconnected.</p>'
            + '<div class="modal-actions">'
            +   '<button class="btn btn-ghost" onclick="closeRevokeCodeModal()">Cancel</button>'
            +   '<button class="btn btn-danger" onclick="doRevokeCode(\'' + OS.esc(id) + '\')">Revoke</button>'
            + '</div>'
            + '</div>';
        overlay.addEventListener('click', function (e) { if (e.target === overlay) closeRevokeCodeModal(); });
        document.addEventListener('keydown', function escHandler(e) { if (e.key === 'Escape') { closeRevokeCodeModal(); document.removeEventListener('keydown', escHandler); } });
        document.body.appendChild(overlay);
    };

    window.closeRevokeCodeModal = function () {
        var el = document.getElementById('revokeCodeModal');
        if (el) el.remove();
    };

    window.doRevokeCode = function (id) {
        closeRevokeCodeModal();
        OS.api('/api/captive/codes/revoke', 'POST', { id: id }).then(function () {
            OS.toast('Code revoked', 'The code has been revoked', 'success');
            loadCaptiveCodes();
        }).catch(function (err) {
            OS.toast('Error', (err && (err.error || err.message)) || 'Could not revoke code', 'error');
        });
    };

    function loadCaptive() {
        OS.api('/api/captive').then(function (data) {
            if (!data) return;
            var chk = OS.$('capEnabled');
            var codeInput = OS.$('capCode');
            var msg = OS.$('capMsg');
            var domainInput = OS.$('capDomain');
            var bgCol = OS.$('capBgColor');
            var bgColPick = OS.$('capBgColorPicker');

            if (chk) chk.checked = !!data.active;
            if (msg) msg.value = data.message || '';
            if (domainInput) domainInput.value = data.domain || '';
            updateDomainHint();
            var bg = data.bg_color || '#050505';
            if (bgCol) bgCol.value = bg;
            if (bgColPick) bgColPick.value = bg;

            _rawCapCode = data.code || '';
            if (codeInput) {
                codeInput.value = '';
            }
            updateCodeDisplay();
            updateLogoPreview(data.logo_url);
        }).catch(function () {});

        loadCaptiveClients();
        loadCaptiveCodes();
    }
    window.loadCaptive = loadCaptive;

    window.submitCaptiveConfig = function (e) {
        e.preventDefault();
        var active = OS.$('capEnabled').checked;
        var codeInputVal = OS.$('capCode').value.trim();
        var code = codeInputVal !== '' ? codeInputVal : _rawCapCode;
        var msg = OS.$('capMsg').value.trim();
        var domain = OS.$('capDomain').value.trim().toLowerCase();
        var bgColor = OS.$('capBgColor').value.trim();
        var status = OS.$('captiveStatus');

        var data = {
            captive_portal: active,
            captive_code: code,
            captive_message: msg,
            captive_domain: domain,
            captive_bg_color: bgColor
        };

        OS.api('/api/config', 'POST', data).then(function () {
            if (status) { status.textContent = 'Saved captive portal config'; status.className = 'form-status ok'; }
            OS.toast('Captive Portal', 'Configuration saved', 'success');
            _rawCapCode = code;
            updateCodeDisplay();
            loadCaptive();
        }).catch(function (err) {
            if (status) { status.textContent = 'Save failed'; status.className = 'form-status error'; }
        });
    };

    window.confirmRevokeCaptiveClient = function (mac) {
        if (!mac) return;
        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'revokeCaptiveClientModal';
        overlay.innerHTML = '<div class="modal-card">'
            + '<div class="modal-icon">'
            +   '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            +     '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>'
            +   '</svg>'
            + '</div>'
            + '<h2 class="modal-title">Revoke Client Access</h2>'
            + '<p class="modal-message">Are you sure you want to revoke access for client "' + OS.esc(mac) + '"? This device will be disconnected immediately.</p>'
            + '<div class="modal-actions">'
            +   '<button class="btn btn-ghost" onclick="closeRevokeCaptiveClientModal()">Cancel</button>'
            +   '<button class="btn btn-danger" onclick="doRevokeCaptiveClient(\'' + OS.esc(mac) + '\')">Revoke Access</button>'
            + '</div>'
            + '</div>';
        overlay.addEventListener('click', function (e) { if (e.target === overlay) closeRevokeCaptiveClientModal(); });
        document.addEventListener('keydown', function escHandler(e) { if (e.key === 'Escape') { closeRevokeCaptiveClientModal(); document.removeEventListener('keydown', escHandler); } });
        document.body.appendChild(overlay);
    };

    window.closeRevokeCaptiveClientModal = function () {
        var el = document.getElementById('revokeCaptiveClientModal');
        if (el) el.remove();
    };

    window.doRevokeCaptiveClient = function (mac) {
        closeRevokeCaptiveClientModal();
        OS.api('/api/captive/revoke', 'POST', { mac: mac }).then(function () {
            OS.toast('Captive Portal', 'Revoked access for ' + mac, 'info');
            loadCaptiveClients();
        }).catch(function () {});
    };

    // Auto-refresh clients and codes when viewing section & listen to SSE live events
    if (OS.onLive) {
        OS.onLive('captive_auth', function () {
            loadCaptiveClients();
            loadCaptiveCodes();
        });
    }

    setInterval(function () {
        var view = OS.$('view-captive');
        if (view && view.classList.contains('active')) {
            loadCaptiveClients();
            loadCaptiveCodes();
        }
    }, 3000);

})(window.OS);
