/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * users.js -- User Management page (superadmin only).  Allows creating,
 * listing, disabling, deleting, and password-resetting admin accounts.
 */

(function (OS) {
    'use strict';

    OS.renderUsers = function () {
        document.getElementById('content').insertAdjacentHTML('beforeend',
            '<section class="view" id="view-users">'
            + '<div class="grid-2">'
            +     '<div class="card">'
            +         '<div class="card-header">'
            +             '<h2 class="card-title">Create New Account</h2>'
            +         '</div>'
            +         '<div class="card-body">'
            +             '<form id="createUserForm">'
            +                 '<div class="form-group">'
            +                     '<label class="form-label" for="newUsername">Username</label>'
            +                     '<input class="form-input" type="text" id="newUsername" required minlength="2" maxlength="32">'
            +                 '</div>'
            +                 '<div class="form-group">'
            +                     '<label class="form-label" for="newPassword">Password</label>'
            +                     '<input class="form-input" type="password" id="newPassword" required minlength="8">'
            +                     '<span class="form-hint">Minimum 8 characters</span>'
            +                 '</div>'
            +                 '<div class="form-group">'
            +                     '<label class="form-label" for="newRole">Role</label>'
            +                     '<select class="form-input" id="newRole">'
            +                         '<option value="admin">Admin</option>'
            +                         '<option value="superadmin">Super Admin</option>'
            +                     '</select>'
            +                 '</div>'
            +                 '<button class="btn btn-primary" type="submit">Create Account</button>'
            +             '</form>'
            +         '</div>'
            +     '</div>'
            +     '<div class="card">'
            +         '<div class="card-header">'
            +             '<h2 class="card-title">Existing Accounts</h2>'
            +             '<span class="card-badge" id="usersCountBadge">0</span>'
            +         '</div>'
            +         '<div class="card-body no-pad">'
            +             '<div class="table-wrap">'
            +                 '<table class="data-table">'
            +                     '<thead><tr><th>Username</th><th>Role</th><th>Audit</th><th>Created</th><th>Actions</th></tr></thead>'
            +                     '<tbody id="usersBody"><tr><td colspan="5" class="empty-row">Loading\u2026</td></tr></tbody>'
            +                 '</table>'
            +             '</div>'
            +         '</div>'
            +     '</div>'
            + '</div>'
            + '<div class="card" id="resetPasswordCard" style="display:none;">'
            +     '<div class="card-header">'
            +         '<h2 class="card-title">Reset Password</h2>'
            +     '</div>'
            +     '<div class="card-body">'
            +         '<p class="text-muted" style="margin-bottom:12px;">Reset the password for <strong id="resetUserLabel"></strong></p>'
            +         '<div class="form-group">'
            +             '<label class="form-label" for="resetNewPassword">New Password (leave blank to generate random)</label>'
            +             '<input class="form-input" type="password" id="resetNewPassword" minlength="8" placeholder="Optional -- random password will be generated">'
            +         '</div>'
            +         '<div class="reset-result" id="resetResult" style="display:none;">'
            +             '<p class="text-muted">New password:</p>'
            +             '<code class="reset-password-display" id="resetPasswordDisplay"></code>'
            +             '<button class="btn btn-ghost btn-sm" type="button" onclick="copyResetPassword()">Copy</button>'
            +         '</div>'
            +         '<div class="form-actions">'
            +             '<button class="btn btn-primary" id="confirmResetBtn" onclick="confirmResetPassword()">Reset Password</button>'
            +             '<button class="btn btn-ghost" onclick="cancelResetPassword()">Cancel</button>'
            +         '</div>'
            +     '</div>'
            + '</div>'
            + '</section>'
        );
    };

    function loadUsers() {
        OS.api('/api/users').then(function (users) {
            var tbody = document.getElementById('usersBody');
            var badge = document.getElementById('usersCountBadge');
            if (badge) badge.textContent = users.length;
            if (!tbody) return;
            if (!users.length) {
                tbody.innerHTML = '<tr><td colspan="5" class="empty-row">No users found</td></tr>';
                return;
            }
            var isSuperadmin = OS.state.userRole === 'superadmin';
            var html = '';
            for (var i = 0; i < users.length; i++) {
                var u = users[i];
                var isSelf = u.username === OS.state.username;
                var uIsSuperadmin = u.role === 'superadmin';
                html += '<tr>'
                    + '<td class="mono">' + OS.esc(u.username) + (isSelf ? ' (you)' : '') + '</td>'
                    + '<td><span class="user-role-chip ' + (uIsSuperadmin ? 'role-superadmin' : 'role-admin') + '">'
                    + OS.esc(u.role) + '</span></td>'
                    + '<td>';
                if (isSuperadmin && !isSelf) {
                    var checked = u.can_view_audit ? ' checked' : '';
                    html += '<label class="toggle-switch">'
                        + '<input type="checkbox"' + checked + ' onchange="toggleAuditAccess(' + u.id + ', this.checked)">'
                        + '<span class="toggle-slider"></span>'
                        + '</label>';
                } else if (uIsSuperadmin) {
                    html += '<span class="text-muted">Always</span>';
                } else {
                    html += '<span class="text-muted">--</span>';
                }
                html += '</td>'
                    + '<td class="text-muted">' + OS.esc((u.created_at || '').slice(0, 10)) + '</td>'
                    + '<td class="table-actions">';
                if (!isSelf) {
                    html += '<button class="btn btn-ghost btn-sm" onclick="resetUserPassword(' + u.id + ', \'' + OS.esc(u.username) + '\')">Reset PW</button> ';
                    html += '<button class="btn btn-danger btn-sm" onclick="deleteUser(' + u.id + ', \'' + OS.esc(u.username) + '\')">Delete</button>';
                } else {
                    html += '<span class="text-muted">--</span>';
                }
                html += '</td></tr>';
            }
            tbody.innerHTML = html;
        }).catch(function () {
            var tbody = document.getElementById('usersBody');
            if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="empty-row text-red">Failed to load users</td></tr>';
        });
    }

    window.toggleAuditAccess = function (userId, enabled) {
        OS.api('/api/users/audit-access', 'POST', { user_id: userId, enabled: enabled }).then(function (data) {
            if (data.ok) {
                OS.toast('Updated', 'Audit access ' + (enabled ? 'granted' : 'revoked'), 'success');
            } else {
                OS.toast('Error', data.error || 'Failed to update', 'error');
                loadUsers();
            }
        }).catch(function (err) {
            OS.toast('Error', err.message || 'Failed to update', 'error');
            loadUsers();
        });
    };

    window.createUser = function (e) {
        e.preventDefault();
        var username = document.getElementById('newUsername').value.trim();
        var password = document.getElementById('newPassword').value;
        var role = document.getElementById('newRole').value;
        if (!username || !password) return;
        OS.api('/api/users', 'POST', {
            username: username,
            password: password,
            role: role
        }).then(function (data) {
            if (data.ok) {
                OS.toast('Account created', username + ' (' + role + ')', 'success');
                document.getElementById('newUsername').value = '';
                document.getElementById('newPassword').value = '';
                loadUsers();
            }
        }).catch(function (err) {
            OS.toast('Error', err.message || 'Failed to create account', 'error');
        });
    };

    window.deleteUser = function (id, username) {
        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'deleteUserModal';
        overlay.innerHTML =
            '<div class="modal-card">'
            + '<h2 class="modal-title">Delete account</h2>'
            + '<p class="modal-message">Delete account &laquo; ' + OS.esc(username)
            + ' &raquo;? This cannot be undone.</p>'
            + '<div class="modal-actions">'
            +     '<button class="btn btn-ghost" onclick="closeDeleteUserModal()">Cancel</button>'
            +     '<button class="btn btn-danger" onclick="confirmDeleteUser(' + id + ', \'' + OS.esc(username) + '\')">OK</button>'
            + '</div>'
            + '</div>';

        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeDeleteUserModal();
        });
        document.addEventListener('keydown', function escHandler(e) {
            if (e.key === 'Escape') {
                closeDeleteUserModal();
                document.removeEventListener('keydown', escHandler);
            }
        });
        document.body.appendChild(overlay);
    };

    window.closeDeleteUserModal = function () {
        var el = document.getElementById('deleteUserModal');
        if (el) el.remove();
    };

    window.confirmDeleteUser = function (id, username) {
        closeDeleteUserModal();
        OS.api('/api/users/delete', 'POST', { id: id }).then(function (data) {
            if (data.ok) {
                OS.toast('Deleted', username + ' has been removed', 'success');
                loadUsers();
            }
        }).catch(function (err) {
            OS.toast('Error', err.message || 'Failed to delete', 'error');
        });
    };

    window.resetUserPassword = function (id, username) {
        OS.state._resetUserId = id;
        OS.state._resetUsername = username;
        OS.state._resetPassword = null;
        var card = document.getElementById('resetPasswordCard');
        var label = document.getElementById('resetUserLabel');
        var result = document.getElementById('resetResult');
        if (label) label.textContent = username;
        if (result) result.style.display = 'none';
        if (card) card.style.display = 'block';
    };

    window.confirmResetPassword = function () {
        var id = OS.state._resetUserId;
        var pw = document.getElementById('resetNewPassword').value || undefined;
        OS.api('/api/users/reset-password', 'POST', { id: id, password: pw }).then(function (data) {
            if (data.ok) {
                OS.state._resetPassword = data.new_password;
                var result = document.getElementById('resetResult');
                var display = document.getElementById('resetPasswordDisplay');
                if (display) display.textContent = data.new_password;
                if (result) result.style.display = 'block';
                OS.toast('Password reset', 'New password has been set', 'success');
            }
        }).catch(function (err) {
            OS.toast('Error', err.message || 'Failed to reset password', 'error');
        });
    };

    window.cancelResetPassword = function () {
        var card = document.getElementById('resetPasswordCard');
        if (card) card.style.display = 'none';
    };

    window.copyResetPassword = function () {
        var pw = OS.state._resetPassword;
        if (!pw) return;
        OS.copyText(pw)
            .then(function () { OS.toast('Copied', 'Password copied to clipboard', 'success'); })
            .catch(function () {
                OS.toast('Copy failed', 'Could not copy the password', 'error');
            });
    };

    OS.refreshUsers = loadUsers;

    OS.initUsersPage = function () {
        var form = document.getElementById('createUserForm');
        if (form) form.addEventListener('submit', window.createUser);
        loadUsers();
    };
})(window.OS);
