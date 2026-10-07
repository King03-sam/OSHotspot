/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * notifications.js -- notification bell icon with unread-count badge
 * and dropdown panel.  Lives in the topbar.  Subscribes to the SSE
 * stream for real-time notification delivery.
 */

(function (OS) {
    'use strict';

    var UNREAD_COUNT = 0;

    OS.renderNotificationBell = function () {
        var right = document.querySelector('.topbar-right');
        if (!right) return;
        var bell = document.createElement('div');
        bell.className = 'notification-bell-wrap';
        bell.innerHTML =
            '<button class="icon-btn notification-bell" id="notifBell" title="Notifications" onclick="toggleNotifDropdown(event)">'
            + '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            + '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>'
            + '<path d="M13.73 21a2 2 0 0 1-3.46 0"/>'
            + '</svg>'
            + '<span class="notif-badge" id="notifBadge" style="display:none;">0</span>'
            + '</button>'
            + '<div class="notif-dropdown" id="notifDropdown">'
            +     '<div class="notif-dropdown-header">'
            +         '<span class="notif-dropdown-title">Notifications</span>'
            +         '<div class="notif-actions">'
            +             '<button type="button" class="btn btn-ghost btn-sm" onclick="markAllNotifRead(event)">Mark all read</button>'
            +             '<button type="button" class="btn btn-ghost btn-sm" onclick="deleteReadNotifications(event)">Delete read</button>'
            +         '</div>'
            +     '</div>'
            +     '<div class="notif-dropdown-list" id="notifList">'
            +         '<div class="notif-empty">No notifications yet</div>'
            +     '</div>'
            + '</div>';
        right.insertBefore(bell, right.firstChild);

        document.addEventListener('click', function (e) {
            var wrap = document.querySelector('.notification-bell-wrap');
            if (wrap && !wrap.contains(e.target)) {
                closeNotifDropdown();
            }
        });

        refreshUnreadCount();
    };

    function refreshUnreadCount() {
        OS.api('/api/notifications/unread-count').then(function (data) {
            UNREAD_COUNT = data.count || 0;
            updateBadge();
        }).catch(function () {});
    }

    function updateBadge() {
        var badge = document.getElementById('notifBadge');
        if (!badge) return;
        if (UNREAD_COUNT > 0) {
            badge.textContent = UNREAD_COUNT > 99 ? '99+' : String(UNREAD_COUNT);
            badge.style.display = 'flex';
        } else {
            badge.style.display = 'none';
        }
    }

    function severityIcon(sev) {
        if (sev === 'high') return '<span class="notif-severity notif-sev-high">!</span>';
        if (sev === 'warn') return '<span class="notif-severity notif-sev-warn">!</span>';
        return '<span class="notif-severity notif-sev-info">i</span>';
    }

    function timeAgo(iso) {
        if (!iso) return '';
        var diff = (Date.now() - new Date(iso).getTime()) / 1000;
        if (diff < 60) return 'just now';
        if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
        if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
        return Math.floor(diff / 86400) + 'd ago';
    }

    function loadNotifications() {
        OS.api('/api/notifications?limit=30').then(function (notifications) {
            var list = document.getElementById('notifList');
            if (!list) return;
            if (!notifications || !notifications.length) {
                list.innerHTML = '<div class="notif-empty">No notifications yet</div>';
                return;
            }
            var html = '';
            for (var i = 0; i < notifications.length; i++) {
                var n = notifications[i];
                var unread = !n.read ? ' notif-unread' : '';
                html += '<div class="notif-item' + unread + '" onclick="markNotifRead(' + n.id + ', this)">'
                    + severityIcon(n.severity)
                    + '<div class="notif-content">'
                    +     '<div class="notif-message">' + OS.esc(n.message) + '</div>'
                    +     '<div class="notif-time">' + timeAgo(n.created_at) + '</div>'
                    + '</div>'
                    + '</div>';
            }
            list.innerHTML = html;
        }).catch(function () {});
    }

    window.toggleNotifDropdown = function (e) {
        e.stopPropagation();
        var dd = document.getElementById('notifDropdown');
        if (!dd) return;
        if (dd.classList.contains('open')) {
            closeNotifDropdown();
        } else {
            dd.classList.add('open');
            loadNotifications();
        }
    };

    function closeNotifDropdown() {
        var dd = document.getElementById('notifDropdown');
        if (dd) dd.classList.remove('open');
    }

    window.markNotifRead = function (id, el) {
        OS.api('/api/notifications/read', 'POST', { id: id }).then(function () {
            if (el) el.classList.remove('notif-unread');
            UNREAD_COUNT = Math.max(0, UNREAD_COUNT - 1);
            updateBadge();
        }).catch(function () {});
    };

    window.markAllNotifRead = function (e) {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        OS.api('/api/notifications/read-all', 'POST', {}).then(function () {
            UNREAD_COUNT = 0;
            updateBadge();
            var items = document.querySelectorAll('.notif-unread');
            for (var i = 0; i < items.length; i++) items[i].classList.remove('notif-unread');
        }).catch(function () {});
    };

    window.deleteReadNotifications = function (e) {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'deleteReadNotificationsModal';
        overlay.innerHTML =
            '<div class="modal-card">'
            + '<div class="modal-icon">'
            + '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            + '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>'
            + '</svg>'
            + '</div>'
            + '<h2 class="modal-title">Delete read notifications</h2>'
            + '<p class="modal-message">Are you sure you want to delete all notifications that have already been read?</p>'
            + '<div class="modal-actions">'
            +     '<button type="button" class="btn btn-ghost" onclick="closeDeleteReadNotificationsModal()">Cancel</button>'
            +     '<button type="button" class="btn btn-danger" onclick="confirmDeleteReadNotifications()">Delete</button>'
            + '</div>'
            + '</div>';
        document.body.appendChild(overlay);
        overlay.addEventListener('click', function (event) {
            if (event.target === overlay) closeDeleteReadNotificationsModal();
        });
        window.setTimeout(function () {
            var button = overlay.querySelector('.btn-danger');
            if (button) button.focus();
        }, 0);
    };

    window.closeDeleteReadNotificationsModal = function () {
        var overlay = document.getElementById('deleteReadNotificationsModal');
        if (overlay) overlay.remove();
    };

    window.confirmDeleteReadNotifications = function () {
        closeDeleteReadNotificationsModal();
        OS.api('/api/notifications/delete-read', 'POST', {}).then(function (res) {
            loadNotifications();
            refreshUnreadCount();
            OS.toast(
                'Notifications deleted',
                ((res && res.deleted) || 0) + ' read notification(s) removed',
                'success'
            );
        }).catch(function (err) {
            OS.toast('Delete failed', err.message || 'Could not reach server', 'error');
        });
    };

    OS.initNotificationsLive = function () {
        if (!OS.live) return;
        OS.live.on('notification', function (msg) {
            UNREAD_COUNT++;
            updateBadge();
            var dd = document.getElementById('notifDropdown');
            if (dd && dd.classList.contains('open')) {
                loadNotifications();
            }
        });
    };

    OS.refreshNotifications = refreshUnreadCount;
})(window.OS);
