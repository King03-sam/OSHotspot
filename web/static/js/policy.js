/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * policy.js -- "Domain Policy" page: lets the admin add/remove wildcard
 * patterns to three editable SQLite tables that drive the DNS event
 * pipeline:
 *
 *   forbidden_domains  -- a match here triggers a HIGH-priority alert
 *                         (event is recorded immediately, never batched
 *                         into a session, SMTP notification is sent if
 *                         email alerts are enabled, and a toast pops
 *                         on every open dashboard via the live stream).
 *
 *   watched_domains    -- same as forbidden, but for "suspicious /
 *                         keep an eye on this" domains that shouldn't
 *                         outright block but should be flagged.
 *
 *   noise_patterns     -- a match here causes the DNS query to be
 *                         dropped from the events table entirely
 *                         (it's still in the raw dnsmasq log file for
 *                         audit).  Use this to silence connectivity
 *                         checks, OS telemetry, push-notification
 *                         keep-alives, etc.
 *
 * Pattern syntax:
 *   *.example.com      -- matches "example.com" and any "*.example.com"
 *   example.com        -- exact match only
 *
 * All three tables are read on page load via GET /api/domain-policy and
 * edited in place via POST /api/domain-policy (no page reload).  When a
 * policy_change event arrives over the live stream, the affected table
 * is refreshed automatically so two admins editing at the same time
 * don't end up with stale views.
 */

(function (OS) {
    'use strict';

    OS.renderPolicy = function () {
        document.getElementById('content').insertAdjacentHTML('beforeend',
            '<section class="view" id="view-policy">'

            /* ---- Application Blocking (NEW) ---- */
            + '<div class="card">'
            +     '<div class="card-header">'
            +         '<h2 class="card-title">Application Blocking</h2>'
            +         '<span class="card-badge" id="appBlockBadge">0</span>'
            +     '</div>'
            +     '<div class="card-body">'
            +         '<p class="text-muted" style="margin-bottom:12px;font-size:12px;line-height:1.5;">'
             +             '<strong>Defense-in-depth application blocking.</strong> '
             +             'This uses <strong>2 layers</strong> to block apps even when users try to bypass: '
             +             '(1) <strong>port-based blocking</strong> for known app ports (e.g. WhatsApp 5222/5223), '
             +             '(2) <strong>conntrack killing</strong> to immediately terminate existing connections. '
            +             'Combined with domain blocking above, this makes bypassing extremely difficult.'
            +         '</p>'
            +         '<div id="appBlockLoading" class="text-muted" style="text-align:center;padding:20px;">Loading categories...</div>'
            +         '<div id="appBlockCategories" style="display:none;">'
            +             '<div class="app-category-grid">'
            +                 '<label class="app-category-card">'
            +                     '<input type="checkbox" id="cat_messaging" onchange="toggleAppCategory(\'messaging\', this.checked)">'
            +                     '<div>'
            +                         '<div class="app-category-title">Messaging</div>'
            +                         '<div class="app-category-sub">WhatsApp, Telegram, Signal, Discord, Viber, Snapchat</div>'
            +                     '</div>'
            +                 '</label>'

            +                 '<label class="app-category-card">'
            +                     '<input type="checkbox" id="cat_gaming" onchange="toggleAppCategory(\'gaming\', this.checked)">'
            +                     '<div>'
            +                         '<div class="app-category-title">Gaming</div>'
            +                         '<div class="app-category-sub">Steam, Epic Games</div>'
            +                     '</div>'
            +                 '</label>'
            +             '</div>'
            +             '<div style="display:flex;gap:8px;align-items:center;">'
            +                 '<button class="btn btn-danger btn-sm" id="appBlockApplyBtn" onclick="applyAppBlock()" style="display:none;">Apply Blocking</button>'
            +                 '<button class="btn btn-ghost btn-sm" id="appBlockDisableAll" onclick="disableAllAppBlock()" style="display:none;">Disable All</button>'
            +                 '<span id="appBlockStatus" class="text-muted" style="font-size:11px;"></span>'
            +             '</div>'
            +         '</div>'
            +     '</div>'
            + '</div>'

            /* ---- Forbidden Domains ---- */
            + '<div class="card">'
            +     '<div class="card-header">'
            +         '<h2 class="card-title">Forbidden Domains</h2>'
            +         '<span class="card-badge" id="forbiddenCountBadge">0</span>'
            +     '</div>'
            +     '<div class="card-body">'
            +         '<p class="text-muted" style="margin-bottom:12px;font-size:12px;line-height:1.5;">'
            +             '<strong>Forbidden domains are actually BLOCKED at the DNS level.</strong> '
            +             'When a pattern is added or removed, the dnsmasq block file is regenerated and dnsmasq '
            +             'is restarted so that any client query for a matching domain returns 0.0.0.0 (connection '
            +             'refused).  A high-priority alert is also recorded, an SMTP notification is sent if email '
            +             'alerts are enabled, and every open dashboard shows a toast.  Use this for known phishing, '
            +             'malware C2, or any domain you want to block and be notified about.'
            +         '</p>'
            +         '<div class="policy-form" style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">'
            +             '<input type="text" id="forbiddenPatternInput" class="events-input" style="flex:1;min-width:200px;" placeholder="*.phishing-example.com" onkeydown="if(event.key===\'Enter\')addForbiddenPattern()">'
            +             '<input type="text" id="forbiddenLabelInput" class="events-input" style="flex:1;min-width:160px;" placeholder="Reason / label (optional)" onkeydown="if(event.key===\'Enter\')addForbiddenPattern()">'
            +             '<button class="btn btn-danger btn-sm" onclick="addForbiddenPattern()">Add</button>'
            +         '</div>'
            +         '<div class="policy-form" style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center;">'
            +             '<label class="btn btn-ghost btn-sm" style="cursor:pointer;">'
            +                 'Import file\u2026'
            +                 '<input type="file" id="forbiddenFileInput" accept=".txt,.csv,.lst" style="display:none;" onchange="importPolicyFile(\'forbidden_domains\', this)">'
            +             '</label>'
            +             '<span class="text-muted" style="font-size:11px;">Upload a .txt/.csv file with domains separated by commas or new lines</span>'
            +         '</div>'
            +         '<div class="table-wrap">'
            +             '<table class="data-table">'
            +                 '<thead><tr><th>Pattern</th><th>Label</th><th>Added</th><th>Actions</th></tr></thead>'
            +                 '<tbody id="forbiddenBody"><tr><td colspan="4" class="empty-row">No forbidden domains\u2026</td></tr></tbody>'
            +             '</table>'
            +         '</div>'
            +     '</div>'
            + '</div>'

            /* ---- Watched Domains ---- */
            + '<div class="card">'
            +     '<div class="card-header">'
            +         '<h2 class="card-title">Watched Domains</h2>'
            +         '<span class="card-badge" id="watchedCountBadge">0</span>'
            +     '</div>'
            +     '<div class="card-body">'
            +         '<p class="text-muted" style="margin-bottom:12px;font-size:12px;line-height:1.5;">'
            +             'Same mechanism as Forbidden, but for "suspicious / keep an eye on this" domains that '
            +             'shouldn\'t outright block but should be flagged each time a client resolves them.  Useful '
            +             'for newly-registered domains, known ad networks, or any category you want to monitor '
            +             'without raising the same urgency as forbidden.'
            +         '</p>'
            +         '<div class="policy-form" style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">'
            +             '<input type="text" id="watchedPatternInput" class="events-input" style="flex:1;min-width:200px;" placeholder="*.suspicious-example.com" onkeydown="if(event.key===\'Enter\')addWatchedPattern()">'
            +             '<input type="text" id="watchedLabelInput" class="events-input" style="flex:1;min-width:160px;" placeholder="Reason / label (optional)" onkeydown="if(event.key===\'Enter\')addWatchedPattern()">'
            +             '<button class="btn btn-ghost btn-sm" onclick="addWatchedPattern()">Add</button>'
            +         '</div>'
            +         '<div class="policy-form" style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center;">'
            +             '<label class="btn btn-ghost btn-sm" style="cursor:pointer;">'
            +                 'Import file\u2026'
            +                 '<input type="file" id="watchedFileInput" accept=".txt,.csv,.lst" style="display:none;" onchange="importPolicyFile(\'watched_domains\', this)">'
            +             '</label>'
            +             '<span class="text-muted" style="font-size:11px;">Upload a .txt/.csv file with domains separated by commas or new lines</span>'
            +         '</div>'
            +         '<div class="table-wrap">'
            +             '<table class="data-table">'
            +                 '<thead><tr><th>Pattern</th><th>Label</th><th>Added</th><th>Actions</th></tr></thead>'
            +                 '<tbody id="watchedBody"><tr><td colspan="4" class="empty-row">No watched domains\u2026</td></tr></tbody>'
            +             '</table>'
            +         '</div>'
            +     '</div>'
            + '</div>'

            /* ---- Noise Patterns ---- */
            + '<div class="card">'
            +     '<div class="card-header">'
            +         '<h2 class="card-title">Noise Patterns</h2>'
            +         '<span class="card-badge" id="noiseCountBadge">0</span>'
            +     '</div>'
            +     '<div class="card-body">'
            +         '<p class="text-muted" style="margin-bottom:12px;font-size:12px;line-height:1.5;">'
            +             'A DNS query matching one of these patterns is dropped from the events table entirely -- '
            +             'it\'s still in the raw dnsmasq log file (Logs page) for full audit, but it never reaches '
            +             'the Events page, the Live Activity feed, or the high-priority alert pipeline.  Use this '
            +             'to silence connectivity checks, OS telemetry, push-notification keep-alives, NTP, '
            +             'captive-portal probes, etc.  The list ships with sensible defaults; feel free to extend.'
            +         '</p>'
            +         '<div class="policy-form" style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">'
            +             '<input type="text" id="noisePatternInput" class="events-input" style="flex:1;min-width:200px;" placeholder="*.telemetry.example.com" onkeydown="if(event.key===\'Enter\')addNoisePattern()">'
            +             '<input type="text" id="noiseLabelInput" class="events-input" style="flex:1;min-width:160px;" placeholder="Reason / label (optional)" onkeydown="if(event.key===\'Enter\')addNoisePattern()">'
            +             '<button class="btn btn-ghost btn-sm" onclick="addNoisePattern()">Add</button>'
            +         '</div>'
            +         '<div class="policy-form" style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center;">'
            +             '<label class="btn btn-ghost btn-sm" style="cursor:pointer;">'
            +                 'Import file\u2026'
            +                 '<input type="file" id="noiseFileInput" accept=".txt,.csv,.lst" style="display:none;" onchange="importPolicyFile(\'noise_patterns\', this)">'
            +             '</label>'
            +             '<span class="text-muted" style="font-size:11px;">Upload a .txt/.csv file with domains separated by commas or new lines</span>'
            +         '</div>'
            +         '<div class="table-wrap">'
            +             '<table class="data-table">'
            +                 '<thead><tr><th>Pattern</th><th>Label</th><th>Added</th><th>Actions</th></tr></thead>'
            +                 '<tbody id="noiseBody"><tr><td colspan="4" class="empty-row">No noise patterns\u2026</td></tr></tbody>'
            +             '</table>'
            +         '</div>'
            +     '</div>'
            + '</div>'

            + '</section>'
        );
    };

    /* ── Data loading + rendering ───────────────────────────────── */

    function renderTable(table, rows) {
        var bodyId = table === 'forbidden_domains' ? 'forbiddenBody'
                   : table === 'watched_domains'   ? 'watchedBody'
                   : 'noiseBody';
        var body = OS.$(bodyId);
        if (!body) return;
        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="4" class="empty-row">No patterns yet\u2026</td></tr>';
            return;
        }
        body.innerHTML = rows.map(function (r) {
            var btnClass = table === 'forbidden_domains' ? 'btn-danger' : 'btn-ghost';
            return '<tr>'
                + '<td class="mono">' + OS.esc(r.pattern) + '</td>'
                + '<td>' + OS.esc(r.label || '\u2014') + '</td>'
                + '<td class="mono">' + OS.esc(r.added_date || '') + '</td>'
                + '<td class="kick-cell"><button class="btn ' + btnClass + ' btn-sm" onclick="removePolicyPattern(\'' + OS.esc(table) + '\',\'' + OS.esc(r.pattern).replace(/'/g, "\\'") + '\')">Remove</button></td>'
                + '</tr>';
        }).join('');
    }

    function updateBadges(data) {
        var f = OS.$('forbiddenCountBadge');
        var w = OS.$('watchedCountBadge');
        var n = OS.$('noiseCountBadge');
        if (f) f.textContent = (data.forbidden_domains || []).length;
        if (w) w.textContent = (data.watched_domains || []).length;
        if (n) n.textContent = (data.noise_patterns || []).length;
    }

    OS.loadDomainPolicy = function () {
        OS.api('/api/domain-policy').then(function (data) {
            if (!data) return;
            if (data.error) {
                OS.toast('Domain policy unavailable', data.error, 'error');
                return;
            }
            updateBadges(data);
            renderTable('forbidden_domains', data.forbidden_domains || []);
            renderTable('watched_domains',   data.watched_domains   || []);
            renderTable('noise_patterns',    data.noise_patterns    || []);
        }).catch(function () {});
    };

    /* ── Add / remove ───────────────────────────────────────────── */

    function addPattern(table, patternInputId, labelInputId) {
        var patternEl = OS.$(patternInputId);
        var labelEl = OS.$(labelInputId);
        if (!patternEl) return;
        var pattern = patternEl.value.trim();
        var label = labelEl ? labelEl.value.trim() : '';
        if (!pattern) {
            OS.toast('Pattern required', 'Enter a domain or wildcard like *.example.com', 'warn');
            return;
        }
        OS.api('/api/domain-policy', 'POST', {
            action: 'add', table: table, pattern: pattern, label: label
        }).then(function (res) {
            if (!res || !res.ok) {
                OS.toast('Add failed', (res && res.error) || 'Unknown error', 'error');
                return;
            }
            patternEl.value = '';
            if (labelEl) labelEl.value = '';
            renderTable(table, res.updated_list || []);
            var badge = OS.$(table === 'forbidden_domains' ? 'forbiddenCountBadge'
                          : table === 'watched_domains'   ? 'watchedCountBadge'
                          : 'noiseCountBadge');
            if (badge) badge.textContent = (res.updated_list || []).length;
            var msg = pattern + ' added';
            if (res.dns_reloaded) msg += ' \u2014 dnsmasq reloaded, DNS blocking active';
            OS.toast('Pattern added', msg, 'success');
        }).catch(function (err) {
            OS.toast('Add failed', err.message || 'Could not reach server', 'error');
        });
    }

    window.addForbiddenPattern = function () {
        addPattern('forbidden_domains', 'forbiddenPatternInput', 'forbiddenLabelInput');
    };
    window.addWatchedPattern = function () {
        addPattern('watched_domains', 'watchedPatternInput', 'watchedLabelInput');
    };
    window.addNoisePattern = function () {
        addPattern('noise_patterns', 'noisePatternInput', 'noiseLabelInput');
    };

    function finishRemovePolicyPattern(table, pattern, res) {
        renderTable(table, res.updated_list || []);
        var badge = OS.$(table === 'forbidden_domains' ? 'forbiddenCountBadge'
                  : table === 'watched_domains'   ? 'watchedCountBadge'
                  : 'noiseCountBadge');
        if (badge) badge.textContent = (res.updated_list || []).length;
        OS.toast('Pattern removed', pattern + ' removed from ' + table, 'info');
    }

    function removePolicyPatternRequest(table, pattern, adminPassword) {
        var payload = {
            action: 'remove', table: table, pattern: pattern
        };
        if (adminPassword) payload.admin_password = adminPassword;
        return OS.api('/api/domain-policy', 'POST', payload).then(function (res) {
            if (!res || !res.ok) {
                throw new Error((res && res.error) || 'Unknown error');
            }
            finishRemovePolicyPattern(table, pattern, res);
            return res;
        });
    }

    window.removePolicyPattern = function (table, pattern) {
        if (table === 'noise_patterns') {
            openRemoveNoisePatternModal(pattern);
            return;
        }
        removePolicyPatternRequest(table, pattern).catch(function (err) {
            OS.toast('Remove failed', err.message || 'Could not reach server', 'error');
        });
    };

    function openRemoveNoisePatternModal(pattern) {
        OS.state._pendingNoisePattern = pattern;

        var existing = document.getElementById('removeNoisePatternModal');
        if (existing) existing.remove();

        var username = OS.state.username ? ' for ' + OS.esc(OS.state.username) : '';
        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'removeNoisePatternModal';
        overlay.innerHTML =
            '<div class="modal-card">'
            + '<h2 class="modal-title">Remove noise pattern</h2>'
            + '<p class="modal-message">Enter the connected admin password' + username
            + ' before removing <span class="mono">' + OS.esc(pattern) + '</span>.</p>'
            + '<form id="removeNoisePatternForm">'
            +     '<div class="auth-field" style="margin-bottom:14px;">'
            +         '<label class="auth-label" for="removeNoisePatternPassword">Admin password</label>'
            +         '<input class="auth-input" type="password" id="removeNoisePatternPassword" autocomplete="current-password" required autofocus>'
            +         '<p class="auth-error" id="removeNoisePatternError" style="display:none;margin-top:8px;"></p>'
            +     '</div>'
            +     '<div class="modal-actions">'
            +         '<button type="button" class="btn btn-ghost" onclick="closeRemoveNoisePatternModal()">Cancel</button>'
            +         '<button type="submit" class="btn btn-danger" id="removeNoisePatternSubmit">Remove</button>'
            +     '</div>'
            + '</form>'
            + '</div>';

        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeRemoveNoisePatternModal();
        });
        document.addEventListener('keydown', function escHandler(e) {
            if (e.key === 'Escape') {
                closeRemoveNoisePatternModal();
                document.removeEventListener('keydown', escHandler);
            }
        });
        document.body.appendChild(overlay);

        var form = document.getElementById('removeNoisePatternForm');
        var passwordInput = document.getElementById('removeNoisePatternPassword');
        if (passwordInput) passwordInput.focus();
        if (form) {
            form.addEventListener('submit', function (e) {
                e.preventDefault();
                confirmRemoveNoisePattern();
            });
        }
    }

    window.closeRemoveNoisePatternModal = function () {
        var el = document.getElementById('removeNoisePatternModal');
        if (el) el.remove();
        OS.state._pendingNoisePattern = null;
    };

    window.confirmRemoveNoisePattern = function () {
        var pattern = OS.state._pendingNoisePattern;
        var passwordInput = document.getElementById('removeNoisePatternPassword');
        var submit = document.getElementById('removeNoisePatternSubmit');
        var errorEl = document.getElementById('removeNoisePatternError');
        var password = passwordInput ? passwordInput.value : '';
        if (errorEl) {
            errorEl.style.display = 'none';
            errorEl.textContent = '';
        }
        if (!pattern) {
            closeRemoveNoisePatternModal();
            return;
        }
        if (!password) {
            if (errorEl) {
                errorEl.textContent = 'Admin password is required.';
                errorEl.style.display = 'block';
            }
            if (passwordInput) passwordInput.focus();
            return;
        }
        if (submit) {
            submit.disabled = true;
            submit.classList.add('loading');
        }
        removePolicyPatternRequest('noise_patterns', pattern, password).then(function () {
            closeRemoveNoisePatternModal();
        }).catch(function (err) {
            OS.toast('Remove failed', err.message || 'Could not reach server', 'error');
            if (submit) {
                submit.disabled = false;
                submit.classList.remove('loading');
            }
            if (passwordInput) {
                passwordInput.value = '';
                passwordInput.focus();
            }
            if (errorEl && err.message === 'Invalid admin password') {
                errorEl.textContent = 'The admin password is incorrect.';
                errorEl.style.display = 'block';
            }
        });
    };

    /* ── File import ────────────────────────────────────────────── */

    /* Parse a text file's content into a list of domain patterns.
       Supports:
         - comma-separated:   "a.com, b.com, c.com"
         - newline-separated: "a.com\nb.com\nc.com"
         - mixed:             "a.com, b.com\nc.com"
         - comments:          lines starting with # are ignored
         - whitespace:        trimmed from each pattern
       Returns a deduplicated list of non-empty patterns. */
    function parseFileContent(text) {
        if (!text) return [];
        // Split on commas AND newlines
        var parts = text.split(/[,\n\r]+/);
        var seen = {};
        var patterns = [];
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i].trim().toLowerCase();
            // Skip comments and empty lines
            if (!p || p.charAt(0) === '#') continue;
            // Basic validation: must contain a dot and no spaces
            if (p.indexOf('.') < 0 || p.indexOf(' ') >= 0) continue;
            if (!seen[p]) {
                seen[p] = true;
                patterns.push(p);
            }
        }
        return patterns;
    }

    window.importPolicyFile = function (table, fileInput) {
        if (!fileInput || !fileInput.files || !fileInput.files[0]) return;
        var file = fileInput.files[0];
        if (file.size > 512 * 1024) {
            OS.toast('File too large', 'Maximum 512KB per import', 'error');
            fileInput.value = '';
            return;
        }
        var reader = new FileReader();
        reader.onload = function (e) {
            var text = e.target.result || '';
            var patterns = parseFileContent(text);
            if (!patterns.length) {
                OS.toast('No patterns found', 'The file contains no valid domain patterns (separate by commas or new lines)', 'warn');
                fileInput.value = '';
                return;
            }
            // Ask for a label (optional)
            var label = window.prompt(
                'Importing ' + patterns.length + ' patterns into ' + table + '\n\n' +
                'Enter an optional label for this batch (or leave blank):',
                'imported batch'
            );
            if (label === null) {
                fileInput.value = '';
                return;
            }
            OS.api('/api/domain-policy', 'POST', {
                action: 'bulk_import',
                table: table,
                patterns: patterns,
                label: label || ''
            }).then(function (res) {
                if (!res || !res.ok) {
                    OS.toast('Import failed', (res && res.error) || 'Unknown error', 'error');
                    return;
                }
                renderTable(table, res.updated_list || []);
                var badge = OS.$(table === 'forbidden_domains' ? 'forbiddenCountBadge'
                              : table === 'watched_domains'   ? 'watchedCountBadge'
                              : 'noiseCountBadge');
                if (badge) badge.textContent = (res.updated_list || []).length;
                var msg = 'Added ' + res.added + ' patterns';
                if (res.skipped > 0) msg += ', ' + res.skipped + ' already existed';
                if (res.dns_reloaded) msg += ', dnsmasq reloaded';
                OS.toast('Import complete', msg, 'success');
                fileInput.value = '';
            }).catch(function (err) {
                OS.toast('Import failed', err.message || 'Could not reach server', 'error');
                fileInput.value = '';
            });
        };
        reader.onerror = function () {
            OS.toast('Read failed', 'Could not read the selected file', 'error');
            fileInput.value = '';
        };
        reader.readAsText(file);
    };

    /* ── Live updates ───────────────────────────────────────────── */

    OS.initPolicyLive = function () {
        if (!OS.live) return;
        OS.live.on('policy_change', function (msg) {
            // Another admin (or this admin in another tab) edited a
            // policy table -- reload it so we stay in sync.
            if (msg && msg.table) OS.loadDomainPolicy();
        });
    };

    /* ── Application Blocking (NEW) ───────────────────────────── */

    var _appBlockState = [];
    var _appBlockDirty = false;

    OS.loadAppBlock = function () {
        OS.api('/api/app-block').then(function (data) {
            if (!data) return;
            _appBlockState = data.active_categories || [];
            _appBlockDirty = false;
            var loading = OS.$('appBlockLoading');
            var container = OS.$('appBlockCategories');
            if (loading) loading.style.display = 'none';
            if (container) container.style.display = 'block';
            for (var i = 0; i < _appBlockState.length; i++) {
                var cb = OS.$('cat_' + _appBlockState[i]);
                if (cb) cb.checked = true;
            }
            _updateAppBlockUI();
        }).catch(function () {
            var loading = OS.$('appBlockLoading');
            if (loading) loading.textContent = 'Failed to load app block state';
        });
    };

    function _updateAppBlockUI() {
        var activeCount = 0;
        var checkboxes = document.querySelectorAll('[id^="cat_"]');
        for (var i = 0; i < checkboxes.length; i++) {
            if (checkboxes[i].checked) activeCount++;
        }
        var badge = OS.$('appBlockBadge');
        if (badge) badge.textContent = activeCount;
        var applyBtn = OS.$('appBlockApplyBtn');
        var disableBtn = OS.$('appBlockDisableAll');
        if (applyBtn) applyBtn.style.display = _appBlockDirty ? 'inline-block' : 'none';
        if (disableBtn) disableBtn.style.display = activeCount > 0 ? 'inline-block' : 'none';
        var status = OS.$('appBlockStatus');
        if (status) {
            if (activeCount > 0) {
                status.textContent = activeCount + ' categorie(s) active(s)' + (_appBlockDirty ? ' (unsaved changes)' : '');
            } else {
                status.textContent = 'No categories active';
            }
        }
    }

    window.toggleAppCategory = function (category, checked) {
        _appBlockDirty = true;
        _updateAppBlockUI();
    };

    window.applyAppBlock = function () {
        var categories = [];
        var checkboxes = document.querySelectorAll('[id^="cat_"]');
        for (var i = 0; i < checkboxes.length; i++) {
            if (checkboxes[i].checked) {
                categories.push(checkboxes[i].id.replace('cat_', ''));
            }
        }
        var applyBtn = OS.$('appBlockApplyBtn');
        if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = 'Applying...'; }
        OS.api('/api/app-block', 'POST', { categories: categories }).then(function (res) {
            if (!res || !res.ok) {
                var detail = (res && res.error) || 'Unknown error';
                if (!res || !res.error) {
                    detail = (res && res.output) || detail;
                }
                OS.toast('App blocking failed', detail, 'error');
            } else {
                _appBlockState = categories;
                _appBlockDirty = false;
                var msg = categories.length + ' categories blocked';
                if (categories.length === 0) msg = 'All app blocking disabled';
                OS.toast('App blocking updated', msg + ' (ports + conntrack kill)', 'success');
            }
            _updateAppBlockUI();
            if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = 'Apply Blocking'; }
        }).catch(function (err) {
            OS.toast('App blocking failed', err.message || 'Could not reach server', 'error');
            if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = 'Apply Blocking'; }
        });
    };

    window.disableAllAppBlock = function () {
        var checkboxes = document.querySelectorAll('[id^="cat_"]');
        for (var i = 0; i < checkboxes.length; i++) {
            checkboxes[i].checked = false;
        }
        _appBlockDirty = true;
        _updateAppBlockUI();
        window.applyAppBlock();
    };

})(window.OS);
