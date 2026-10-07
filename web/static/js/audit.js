/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * audit.js -- Audit Log page.  Shows admin action history with filters,
 * pagination, and entry deletion (superadmin only).
 */

(function (OS) {
    'use strict';

    var _page = 0;
    var _limit = 50;
    var _total = 0;
    var _selected = {};
    var _isSuperadmin = false;
    var _entries = [];
    var _reqId = 0;
    var _debounce = null;
    var _deleting = false;

    var ACTION_COLORS = {
        login_success:   'audit-badge-green',
        login_failed:    'audit-badge-red',
        login_locked:    'audit-badge-red',
        logout:          'audit-badge-gray',
        setup_superadmin:'audit-badge-green',
        create_user:     'audit-badge-orange',
        delete_user:     'audit-badge-red',
        reset_password:  'audit-badge-orange',
        set_role:        'audit-badge-orange',
        audit_access:    'audit-badge-pink',
        start:           'audit-badge-cyan',
        stop:            'audit-badge-cyan',
        restart:         'audit-badge-cyan',
        repair:          'audit-badge-cyan',
        kick:            'audit-badge-yellow',
        unblock:         'audit-badge-yellow',
        config_update:   'audit-badge-blue',
        domain_policy:   'audit-badge-blue',
        vpn_start:       'audit-badge-purple',
        vpn_stop:        'audit-badge-purple',
        vpn_restart:     'audit-badge-purple',
        mail_test:       'audit-badge-purple',
        audit_delete:    'audit-badge-pink'
    };

    var ACTION_OPTIONS = [
        ['', 'All actions'],
        ['login', 'Login'],
        ['logout', 'Logout'],
        ['create_user', 'Create User'],
        ['delete_user', 'Delete User'],
        ['reset_password', 'Reset Password'],
        ['set_role', 'Set Role'],
        ['kick', 'Kick'],
        ['unblock', 'Unblock'],
        ['config_update', 'Config Update'],
        ['domain_policy', 'Domain Policy'],
        ['start', 'Start'],
        ['stop', 'Stop'],
        ['restart', 'Restart'],
        ['vpn_start', 'VPN Start'],
        ['vpn_stop', 'VPN Stop'],
        ['audit_access', 'Audit Access']
    ];

    var SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
    var ICON_SHIELD = '<svg ' + SVG_ATTRS + ' width="18" height="18"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>';
    var ICON_SEARCH = '<svg ' + SVG_ATTRS + ' width="14" height="14"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';
    var ICON_PREV   = '<svg ' + SVG_ATTRS + ' width="14" height="14"><path d="M15 18l-6-6 6-6"/></svg>';
    var ICON_NEXT   = '<svg ' + SVG_ATTRS + ' width="14" height="14"><path d="M9 18l6-6-6-6"/></svg>';
    var ICON_TRASH  = '<svg ' + SVG_ATTRS + ' width="14" height="14"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>';
    var ICON_OK     = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
    var ICON_FAIL   = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';

    /* ---------- Helpers ---------- */

    function _cols() { return _isSuperadmin ? 8 : 7; }

    function _attr(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function _humanize(action) {
        return String(action || '').split('_').map(function (w) {
            if (w === 'vpn') return 'VPN';
            return w.charAt(0).toUpperCase() + w.slice(1);
        }).join(' ');
    }

    function _splitTs(ts) {
        var m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(ts || '');
        return m ? { date: m[1], time: m[2] } : null;
    }

    function _plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

    function _val(id) { return (OS.$(id) || {}).value || ''; }

    function _hasFilters() {
        return !!(_val('auditFilterUser') || _val('auditFilterAction')
            || _val('auditFilterFrom') || _val('auditFilterTo'));
    }

    function _emptyRow(inner) {
        return '<tr><td colspan="' + _cols() + '" class="empty-row"><div class="audit-empty-state">' + inner + '</div></td></tr>';
    }

    /* ---------- Render ---------- */

    OS.renderAudit = function () {
        _isSuperadmin = OS.state.userRole === 'superadmin';

        var options = ACTION_OPTIONS.map(function (o) {
            return '<option value="' + o[0] + '">' + o[1] + '</option>';
        }).join('');

        document.getElementById('content').insertAdjacentHTML('beforeend',
            '<section class="view" id="view-audit">'

            /* Header + filters */
            + '<div class="card">'
            +     '<div class="card-header">'
            +         '<div class="audit-heading">'
            +             '<h2 class="card-title audit-title">' + ICON_SHIELD + 'Audit Log</h2>'
            +             '<span class="audit-subtitle">History of administrative actions</span>'
            +         '</div>'
            +         '<span class="card-badge" id="auditCountBadge">0</span>'
            +     '</div>'
            +     '<div class="card-body">'
            +         '<div class="audit-filters">'
            +             '<div class="audit-field audit-field-search">'
            +                 '<label class="audit-field-label" for="auditFilterUser">User</label>'
            +                 '<div class="audit-input-icon">' + ICON_SEARCH
            +                     '<input class="form-input" type="search" id="auditFilterUser" placeholder="Filter by user..." autocomplete="off">'
            +                 '</div>'
            +             '</div>'
            +             '<div class="audit-field">'
            +                 '<label class="audit-field-label" for="auditFilterAction">Action</label>'
            +                 '<select class="form-input" id="auditFilterAction">' + options + '</select>'
            +             '</div>'
            +             '<div class="audit-field">'
            +                 '<label class="audit-field-label" for="auditFilterFrom">From</label>'
            +                 '<input class="form-input" type="date" id="auditFilterFrom">'
            +             '</div>'
            +             '<div class="audit-field">'
            +                 '<label class="audit-field-label" for="auditFilterTo">To</label>'
            +                 '<input class="form-input" type="date" id="auditFilterTo">'
            +             '</div>'
            +             '<div class="audit-field audit-field-actions">'
            +                 '<button class="btn btn-ghost btn-sm" id="auditResetBtn" onclick="resetAuditFilters()" disabled>Reset</button>'
            +                 '<button class="btn btn-ghost btn-sm" onclick="loadAuditLog()">Apply</button>'
            +             '</div>'
            +         '</div>'
            +     '</div>'
            + '</div>'

            /* Table */
            + '<div class="card">'
            +     (_isSuperadmin
                    ? '<div class="audit-bulkbar" id="auditBulkBar" hidden>'
                    +     '<span class="audit-bulk-count" id="auditSelCount">0 selected</span>'
                    +     '<div class="audit-bulk-actions">'
                    +         '<button class="btn btn-ghost btn-sm" onclick="clearAuditSelection()">Clear</button>'
                    +         '<button class="btn btn-danger btn-sm" id="auditDeleteBtn" onclick="deleteAuditSelected()">' + ICON_TRASH + ' Delete</button>'
                    +     '</div>'
                    + '</div>'
                    : '')
            +     '<div class="card-body no-pad">'
            +         '<div class="table-wrap audit-table-wrap" id="auditTableWrap">'
            +             '<table class="data-table audit-table' + (_isSuperadmin ? ' is-selectable' : '') + '">'
            +                 '<thead><tr>'
            +                     (_isSuperadmin ? '<th class="audit-col-check"><input type="checkbox" id="auditSelectAll" aria-label="Select all on this page" onchange="toggleAuditSelectAll(this)"></th>' : '')
            +                     '<th>Time</th><th>User</th><th>Role</th><th>Action</th><th>Detail</th><th>IP</th><th class="audit-col-status">Status</th>'
            +                 '</tr></thead>'
            +                 '<tbody id="auditBody">' + _emptyRow('Loading\u2026') + '</tbody>'
            +             '</table>'
            +         '</div>'
            +     '</div>'
            +     '<div class="audit-footer" id="auditPagination"></div>'
            + '</div>'
            + '</section>'
        );

        _bindEvents();
    };

    function _bindEvents() {
        var user = OS.$('auditFilterUser');
        var action = OS.$('auditFilterAction');
        var from = OS.$('auditFilterFrom');
        var to = OS.$('auditFilterTo');
        var tbody = OS.$('auditBody');

        if (user) {
            user.addEventListener('input', function () {
                _syncResetBtn();
                clearTimeout(_debounce);
                _debounce = setTimeout(loadAuditLog, 350);
            });
            user.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { clearTimeout(_debounce); loadAuditLog(); }
            });
        }
        if (action) action.addEventListener('change', loadAuditLog);
        if (from) from.addEventListener('change', function () {
            if (to) to.min = from.value || '';
            loadAuditLog();
        });
        if (to) to.addEventListener('change', function () {
            if (from) from.max = to.value || '';
            loadAuditLog();
        });

        if (tbody && _isSuperadmin) {
            tbody.addEventListener('click', function (e) {
                if (e.target.closest('input, button, a')) return;
                var tr = e.target.closest('tr[data-id]');
                if (!tr) return;
                var cb = tr.querySelector('.audit-check');
                if (!cb) return;
                cb.checked = !cb.checked;
                window.toggleAuditCheck(Number(cb.value), cb.checked);
            });
        }
    }

    function _syncResetBtn() {
        var btn = OS.$('auditResetBtn');
        if (btn) btn.disabled = !_hasFilters();
    }

    window.resetAuditFilters = function () {
        ['auditFilterUser', 'auditFilterAction', 'auditFilterFrom', 'auditFilterTo'].forEach(function (id) {
            var el = OS.$(id);
            if (el) { el.value = ''; el.min = ''; el.max = ''; }
        });
        loadAuditLog();
    };

    /* ---------- Data ---------- */

    OS.loadAudit = function () {
        _selected = {};
        _updateDeleteBtn();
        loadAuditLog();
    };

    function _buildQuery() {
        var params = [];
        var user = _val('auditFilterUser');
        var action = _val('auditFilterAction');
        var from = _val('auditFilterFrom');
        var to = _val('auditFilterTo');
        if (user) params.push('user=' + encodeURIComponent(user));
        if (action) params.push('action=' + encodeURIComponent(action));
        if (from) params.push('from=' + encodeURIComponent(from));
        if (to) params.push('to=' + encodeURIComponent(to));
        params.push('limit=' + _limit);
        params.push('offset=' + (_page * _limit));
        return '/api/audit-log?' + params.join('&');
    }

    function loadAuditLog() {
        _page = 0;
        _syncResetBtn();
        _fetch();
    }
    OS.loadAuditLog = loadAuditLog;
    window.loadAuditLog = loadAuditLog;

    function _setLoading(on) {
        var wrap = OS.$('auditTableWrap');
        if (!wrap) return;
        wrap.classList.toggle('is-loading', on);
        wrap.setAttribute('aria-busy', on ? 'true' : 'false');
    }

    function _fetch() {
        var id = ++_reqId;
        _setLoading(true);
        OS.api(_buildQuery()).then(function (data) {
            if (id !== _reqId) return;
            data = data || {};
            _total = data.total || 0;
            _entries = data.entries || [];

            if (!_entries.length && _page > 0 && _total > 0) {
                _page = Math.max(0, Math.ceil(_total / _limit) - 1);
                _fetch();
                return;
            }

            _setLoading(false);
            _renderTable();
            _renderPagination();
            _syncSelectAll();
            _updateDeleteBtn();
            var badge = OS.$('auditCountBadge');
            if (badge) badge.textContent = _total;
        }).catch(function () {
            if (id !== _reqId) return;
            _setLoading(false);
            var tbody = OS.$('auditBody');
            if (tbody) {
                tbody.innerHTML = _emptyRow(
                    '<span class="text-red">Failed to load audit log</span>'
                    + '<button class="btn btn-ghost btn-sm" onclick="auditRetry()">Retry</button>'
                );
            }
            var pag = OS.$('auditPagination');
            if (pag) pag.innerHTML = '';
        });
    }

    window.auditRetry = function () { _fetch(); };

    function _renderTable() {
        var tbody = OS.$('auditBody');
        if (!tbody) return;

        if (!_entries.length) {
            tbody.innerHTML = _hasFilters()
                ? _emptyRow('<span>No entries match the current filters</span>'
                    + '<button class="btn btn-ghost btn-sm" onclick="resetAuditFilters()">Reset filters</button>')
                : _emptyRow('<span>No audit entries yet</span>');
            return;
        }

        var dash = '<span class="audit-empty">\u2014</span>';
        var html = '';
        for (var i = 0; i < _entries.length; i++) {
            var e = _entries[i];
            var id = Number(e.id);
            var cls = ACTION_COLORS[e.action] || 'audit-badge-gray';
            var success = e.success === 1;
            var ts = _splitTs(e.timestamp);

            html += '<tr data-id="' + id + '">';
            if (_isSuperadmin) {
                html += '<td class="audit-col-check"><input type="checkbox" class="audit-check" value="' + id + '" aria-label="Select entry"'
                    + (_selected[id] ? ' checked' : '')
                    + ' onchange="toggleAuditCheck(' + id + ', this.checked)"></td>';
            }

            html += ts
                ? '<td class="audit-col-time" title="' + _attr(e.timestamp) + '">'
                    + '<span class="audit-time mono">' + OS.esc(ts.time) + '</span>'
                    + '<span class="audit-date mono text-muted">' + OS.esc(ts.date) + '</span></td>'
                : '<td class="mono text-muted audit-col-time">' + OS.esc(e.timestamp) + '</td>';

            html += '<td class="mono audit-user">' + (e.username ? OS.esc(e.username) : dash) + '</td>'
                + '<td><span class="user-role-chip ' + (e.role === 'superadmin' ? 'role-superadmin' : 'role-admin') + '">' + OS.esc(e.role) + '</span></td>'
                + '<td><span class="audit-badge ' + cls + '" title="' + _attr(e.action) + '">' + OS.esc(_humanize(e.action)) + '</span></td>'
                + '<td class="text-muted">' + (e.detail
                    ? '<span class="audit-detail" title="' + _attr(e.detail) + '">' + OS.esc(e.detail) + '</span>'
                    : dash) + '</td>'
                + '<td class="mono text-muted audit-ip">' + (e.source_ip ? OS.esc(e.source_ip) : dash) + '</td>'
                + '<td class="audit-col-status"><span class="audit-status" title="' + (success ? 'Success' : 'Failed') + '" aria-label="' + (success ? 'Success' : 'Failed') + '">'
                +     (success ? ICON_OK : ICON_FAIL)
                + '</span></td>'
                + '</tr>';
        }
        tbody.innerHTML = html;
    }

    /* ---------- Pagination ---------- */

    function _pageList(total, cur) {
        if (total <= 7) {
            var all = [];
            for (var i = 0; i < total; i++) all.push(i);
            return all;
        }
        var pages = [0];
        var start = Math.max(1, cur - 1);
        var end = Math.min(total - 2, cur + 1);
        if (cur <= 2) end = 3;
        if (cur >= total - 3) start = total - 4;
        if (start > 1) pages.push('gap');
        for (var p = start; p <= end; p++) pages.push(p);
        if (end < total - 2) pages.push('gap');
        pages.push(total - 1);
        return pages;
    }

    function _renderPagination() {
        var el = OS.$('auditPagination');
        if (!el) return;
        if (!_total) { el.innerHTML = ''; return; }

        var totalPages = Math.ceil(_total / _limit);
        var from = _page * _limit + 1;
        var to = Math.min(_total, (_page + 1) * _limit);

        var html = '<span class="audit-page-info">Showing <strong>' + from + '\u2013' + to + '</strong> of <strong>' + _total + '</strong></span>';

        if (totalPages > 1) {
            html += '<div class="audit-pages">'
                + '<button class="btn btn-ghost btn-sm audit-page-btn" aria-label="Previous page"' + (_page === 0 ? ' disabled' : '') + ' onclick="auditPrevPage()">' + ICON_PREV + '</button>';
            _pageList(totalPages, _page).forEach(function (p) {
                if (p === 'gap') {
                    html += '<span class="audit-page-gap">\u2026</span>';
                } else {
                    html += '<button class="btn btn-ghost btn-sm audit-page-btn"'
                        + (p === _page ? ' aria-current="page"' : '')
                        + ' onclick="auditGoPage(' + p + ')">' + (p + 1) + '</button>';
                }
            });
            html += '<button class="btn btn-ghost btn-sm audit-page-btn" aria-label="Next page"' + (_page >= totalPages - 1 ? ' disabled' : '') + ' onclick="auditNextPage()">' + ICON_NEXT + '</button>'
                + '</div>';
        }
        el.innerHTML = html;
    }

    function _goPage(p) {
        var tp = Math.ceil(_total / _limit);
        if (p < 0 || p >= tp || p === _page) return;
        _page = p;
        _fetch();
        var wrap = OS.$('auditTableWrap');
        if (wrap && wrap.scrollIntoView) wrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    window.auditGoPage = _goPage;
    window.auditPrevPage = function () { _goPage(_page - 1); };
    window.auditNextPage = function () { _goPage(_page + 1); };

    /* ---------- Selection ---------- */

    window.toggleAuditCheck = function (id, checked) {
        if (checked) _selected[id] = true;
        else delete _selected[id];
        _syncSelectAll();
        _updateDeleteBtn();
    };

    window.toggleAuditSelectAll = function (cb) {
        var checks = document.querySelectorAll('#auditBody .audit-check');
        for (var i = 0; i < checks.length; i++) {
            var id = parseInt(checks[i].value, 10);
            checks[i].checked = cb.checked;
            if (cb.checked) _selected[id] = true;
            else delete _selected[id];
        }
        _syncSelectAll();
        _updateDeleteBtn();
    };

    window.clearAuditSelection = function () {
        _selected = {};
        var checks = document.querySelectorAll('#auditBody .audit-check');
        for (var i = 0; i < checks.length; i++) checks[i].checked = false;
        _syncSelectAll();
        _updateDeleteBtn();
    };

    function _syncSelectAll() {
        var all = OS.$('auditSelectAll');
        if (!all) return;
        var checks = document.querySelectorAll('#auditBody .audit-check');
        var on = 0;
        for (var i = 0; i < checks.length; i++) if (checks[i].checked) on++;
        all.checked = checks.length > 0 && on === checks.length;
        all.indeterminate = on > 0 && on < checks.length;
        all.disabled = checks.length === 0;
    }

    function _updateDeleteBtn() {
        var count = Object.keys(_selected).length;
        var bar = OS.$('auditBulkBar');
        var label = OS.$('auditSelCount');
        var btn = OS.$('auditDeleteBtn');
        if (bar) bar.hidden = count === 0;
        if (label) label.textContent = count + ' selected';
        if (btn) {
            btn.innerHTML = ICON_TRASH + ' Delete (' + count + ')';
            btn.disabled = _deleting;
        }
    }

    /* ---------- Delete ---------- */

    function _onModalKey(e) {
        if (e.key === 'Escape') window.closeDeleteAuditModal();
    }

    window.deleteAuditSelected = function () {
        var ids = Object.keys(_selected).map(Number);
        if (!ids.length || OS.$('deleteAuditModal')) return;

        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'deleteAuditModal';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.innerHTML =
            '<div class="modal-card">'
            + '<h2 class="modal-title">Delete audit entries</h2>'
            + '<p class="modal-message">Delete <strong>' + _plural(ids.length, 'selected entry', 'selected entries') + '</strong>? This cannot be undone.</p>'
            + '<div class="modal-actions">'
            +     '<button class="btn btn-ghost" id="deleteAuditCancel" onclick="closeDeleteAuditModal()">Cancel</button>'
            +     '<button class="btn btn-danger" onclick="confirmDeleteAudit()">' + ICON_TRASH + ' Delete</button>'
            + '</div>'
            + '</div>';
        overlay.addEventListener('click', function (e) { if (e.target === overlay) window.closeDeleteAuditModal(); });
        document.body.appendChild(overlay);
        document.addEventListener('keydown', _onModalKey);

        var cancel = OS.$('deleteAuditCancel');
        if (cancel) cancel.focus();
    };

    window.closeDeleteAuditModal = function () {
        document.removeEventListener('keydown', _onModalKey);
        var el = OS.$('deleteAuditModal');
        if (el) el.remove();
    };

    window.confirmDeleteAudit = function () {
        window.closeDeleteAuditModal();
        var ids = Object.keys(_selected).map(Number);
        if (!ids.length || _deleting) return;

        _deleting = true;
        _updateDeleteBtn();

        OS.api('/api/audit-log/delete', 'POST', { ids: ids }).then(function (data) {
            _deleting = false;
            if (data && data.ok) {
                OS.toast('Deleted', _plural(data.deleted, 'entry', 'entries') + ' removed', 'success');
                _selected = {};
                _updateDeleteBtn();
                _fetch();
            } else {
                _updateDeleteBtn();
                OS.toast('Error', (data && data.error) || 'Failed to delete entries', 'error');
            }
        }).catch(function (err) {
            _deleting = false;
            _updateDeleteBtn();
            OS.toast('Error', err.message || 'Failed to delete entries', 'error');
        });
    };

})(window.OS);

