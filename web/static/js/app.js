/*
 * OSHotspot Dashboard, Premium UI controller
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * app.js, ties every other module together: the About page loader,
 * the "refresh everything" button, the polling intervals, and the
 * bootstrap that runs once the DOM is ready.
 *
 * Load order matters: this file assumes core.js, api.js, theme.js,
 * toast.js, nav.js, status.js, clients.js, config.js, actions.js,
 * qr.js, doctor.js, logs.js, events.js, traffic.js and about.js
 * are already loaded.
 */

(function (OS) {
    'use strict';

    OS.loadVersionInfo = function () {
        OS.api('/api/version').then(function (info) {
            if (!info) return;
            if (info.author) OS.$('aboutAuthor').textContent = info.author;
            if (info.version) OS.$('aboutVersion').textContent = info.version;
        }).catch(function () {});

        OS.api('/api/config').then(function (cfg) {
            if (cfg && OS.updateAboutLogo) {
                OS.updateAboutLogo(cfg.admin_logo_url || '');
            }
            if (cfg && cfg.admin_logo_url) {
                var fav = OS.$('favicon');
                if (fav) fav.href = cfg.admin_logo_url + '?t=' + Date.now();
            }
        }).catch(function () {});
    };

    window.refreshAll = function () {
        OS.refreshStatus();
        OS.refreshClients();
        OS.refreshTraffic();
        if (OS.isViewActive && OS.isViewActive('view-config')) window.loadConfig();
        if (OS.isViewActive && OS.isViewActive('view-logs')) window.loadLogs();
        if (OS.isViewActive && OS.isViewActive('view-events')) window.loadEvents();
        if (OS.isViewActive && OS.isViewActive('view-qr')) window.refreshQR();
        if (OS.isViewActive && OS.isViewActive('view-diagnostics')) window.runDoctor();
        if (OS.isViewActive && OS.isViewActive('view-policy')) { OS.loadDomainPolicy(); OS.loadAppBlock(); }
        if (OS.isViewActive && OS.isViewActive('view-captive') && window.loadCaptive) window.loadCaptive();
        if (OS.isViewActive && OS.isViewActive('view-span') && window.loadSpan) window.loadSpan();

        OS.toast('Refreshed', 'Dashboard data updated', 'info');
    };

    function startPolling() {
        stopPolling();
        var s = OS.state;

        /* Each interval checks document.hidden so a backgrounded tab
           stops hammering the server, and re-checks the active section
           before doing anything expensive. */
        s.statusInterval = setInterval(function () {
            if (!document.hidden) OS.refreshStatus();
        }, 5000);

        s.clientsInterval = setInterval(function () {
            if (!document.hidden) {
                var cb = OS.$('clientsAutoRefresh');
                if (!cb || cb.checked) OS.refreshClients();
            }
        }, 6000);

        s.trafficInterval = setInterval(function () {
            if (!document.hidden) {
                var tb = OS.$('trafficAutoRefresh');
                if (!tb || tb.checked) OS.refreshTraffic();
            }
        }, 3000);

        s.logsInterval = setInterval(function () {
            if (!document.hidden && OS.isViewActive && OS.isViewActive('view-logs')) {
                var lb = OS.$('logsAutoRefresh');
                if (!lb || lb.checked) window.loadLogs();
            }
        }, 5000);

        s.eventsInterval = setInterval(function () {
            if (!document.hidden && OS.isViewActive && OS.isViewActive('view-events')) {
                var eb = OS.$('eventsAutoRefresh');
                if (!eb || eb.checked) window.loadLiveEvents();
            }
        }, 5000);

        /* Keep the inactivity timer alive even when the tab is hidden.
           Mobile browsers kill the tab after a while; a tiny request
           every 30 seconds prevents the server from shutting down. */
        s.keepaliveInterval = setInterval(function () {
            if (document.hidden) {
                OS.api('/api/auth/status').catch(function () {});
            }
        }, 30000);
    }

    function stopPolling() {
        var s = OS.state;
        if (s.statusInterval) clearInterval(s.statusInterval);
        if (s.clientsInterval) clearInterval(s.clientsInterval);
        if (s.trafficInterval) clearInterval(s.trafficInterval);
        if (s.logsInterval) clearInterval(s.logsInterval);
        if (s.eventsInterval) clearInterval(s.eventsInterval);
        if (s.keepaliveInterval) clearInterval(s.keepaliveInterval);
    }

    OS.stopPolling = stopPolling;

    function init() {
        OS.initTheme();

        // Clean up URL if ?token= query parameter is present
        if (window.location.search.indexOf('token=') >= 0) {
            var cleanUrl = window.location.pathname;
            window.history.replaceState({}, document.title, cleanUrl);
        }
        OS.state.token = '';

        /* Check authentication status before rendering the dashboard. */
        OS.api('/api/auth/status').then(function (status) {
            if (status.needs_setup) {
                if (status.can_setup) {
                    OS.showLogin(true);
                } else {
                    document.body.innerHTML =
                        '<div style="padding:60px 40px;color:#f59e0b;font-family:-apple-system,BlinkMacSystemFont,sans-serif;text-align:center;'
                        + 'background:#09090b;min-height:100vh;display:flex;align-items:center;justify-content:center;">'
                        + '<div style="max-width:480px;background:#18181b;padding:40px 32px;border-radius:20px;border:1px solid #27272a;box-shadow:0 20px 40px rgba(0,0,0,0.6);">'
                        + '<svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="#f59e0b" stroke-width="2" style="margin-bottom:20px;">'
                        + '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>'
                        + '<h2 style="color:#ffffff;margin-bottom:12px;font-size:20px;font-weight:700;">Setup Required on Host</h2>'
                        + '<p style="color:#a1a1aa;font-size:14px;line-height:1.6;margin:0;">Initial Super Admin setup must be performed directly on the OSHotspot host computer (or using <code>sudo oshotspot web</code> link) before remote access is granted.</p>'
                        + '</div></div>';
                }
                return;
            }
            if (!status.authenticated) {
                OS.showLogin(false);
                return;
            }
            OS.state.userRole = status.role;
            OS.state.username = status.username;
            OS.state.canViewAudit = status.can_view_audit || false;
            bootDashboard();
        }).catch(function () {
            OS.showLogin(false);
        });
    }

    window.openLogoutModal = function () {
        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML =
            '<div class="modal-card">'
            + '<div class="modal-icon">'
            +     '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            +         '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>'
            +         '<polyline points="16 17 21 12 16 7"/>'
            +         '<line x1="21" y1="12" x2="9" y2="12"/>'
            +     '</svg>'
            + '</div>'
            + '<h2 class="modal-title">Logout</h2>'
            + '<p class="modal-message">Are you sure you want to log out of the dashboard?</p>'
            + '<div class="modal-actions">'
            +     '<button class="btn btn-ghost" onclick="closeLogoutModal()">Cancel</button>'
            +     '<button class="btn btn-danger" onclick="confirmLogout()">Logout</button>'
            + '</div>'
            + '</div>';

        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeLogoutModal();
        });

        document.addEventListener('keydown', function escHandler(e) {
            if (e.key === 'Escape') {
                closeLogoutModal();
                document.removeEventListener('keydown', escHandler);
            }
        });

        document.body.appendChild(overlay);
    };

    window.closeLogoutModal = function () {
        var el = document.querySelector('.modal-overlay');
        if (el) el.remove();
    };

    window.confirmLogout = function () {
        window.location.href = '/api/auth/logout';
    };

    function bootDashboard() {
        OS.state._loginShown = false;
        var shell = document.getElementById('appShell');
        if (shell) shell.style.display = 'flex';

        /* Show/hide User Management nav based on role. */
        var usersNav = document.getElementById('navUsers');
        if (usersNav) {
            usersNav.style.display = OS.state.userRole === 'superadmin' ? '' : 'none';
        }

        /* Show/hide Audit Log nav based on role. */
        var navAudit = document.getElementById('navAudit');
        if (navAudit) {
            var canAudit = OS.state.userRole === 'superadmin' || OS.state.canViewAudit;
            navAudit.style.display = canAudit ? '' : 'none';
        }

        /* Mount only the home screen + controls; other sections render
           on first navigate to keep cold-start DOM and layout cheap. */
        if (OS.ensureSectionRendered) {
            OS.ensureSectionRendered('overview');
            OS.ensureSectionRendered('controls');
        } else {
            OS.renderOverview();
            OS.renderControls();
        }

        /* Render notification bell in topbar. */
        if (OS.renderNotificationBell) OS.renderNotificationBell();

        /* Staggered initial load to avoid a first-paint RAM/CPU spike. */
        OS.refreshStatus();
        startPolling();

        setTimeout(function () {
            OS.refreshClients();
            OS.refreshTraffic();
        }, 200);

        setTimeout(function () {
            window.loadConfig();

            /* Start the unified SSE live stream.  This opens ONE
               EventSource connection per browser tab and dispatches
               incoming messages by `type` to whichever page section has
               registered a listener. */
            if (OS.live && typeof OS.live.start === 'function') {
                OS.live.start();
            }

            if (OS.initEventsLive)         OS.initEventsLive();
            if (OS.initActivityLive)       OS.initActivityLive();
            if (OS.initPolicyLive)         OS.initPolicyLive();
            if (OS.initClientsLive)        OS.initClientsLive();
            if (OS.initNotificationsLive)  OS.initNotificationsLive();
            if (OS.initOverviewLive)       OS.initOverviewLive();

            /* Global alert toast with per-key cooldown so DNS storms
               cannot flood the DOM with toast nodes on connect. */
            var alertToastCooldown = {};
            var ALERT_TOAST_MS = 2000;

            function allowAlertToast(key) {
                var now = Date.now();
                var last = alertToastCooldown[key] || 0;
                if (now - last < ALERT_TOAST_MS) return false;
                alertToastCooldown[key] = now;
                var keys = Object.keys(alertToastCooldown);
                if (keys.length > 200) {
                    var pruned = {};
                    for (var i = 0; i < keys.length; i++) {
                        if (now - alertToastCooldown[keys[i]] < 60000) {
                            pruned[keys[i]] = alertToastCooldown[keys[i]];
                        }
                    }
                    alertToastCooldown = pruned;
                }
                return true;
            }

            if (OS.live) {
                OS.live.on('alert', function (msg) {
                    if (!msg) return;
                    var title = 'Alert';
                    var body = '';
                    var key = msg.alert_type || 'alert';
                    if (msg.alert_type === 'forbidden') {
                        title = 'Forbidden domain';
                        body = (msg.detail && msg.detail.domain) || '';
                        key += ':' + body;
                    } else if (msg.alert_type === 'watched') {
                        title = 'Watched domain hit';
                        body = (msg.detail && msg.detail.domain) || '';
                        key += ':' + body;
                    } else if (msg.alert_type === 'flood') {
                        title = 'DNS flood detected';
                        body = (msg.client_mac || '') + ' \u2014 ' +
                               ((msg.detail && msg.detail.count) || '?') + ' queries';
                        key += ':' + (msg.client_mac || '');
                    }
                    if (!allowAlertToast(key)) return;
                    OS.toast(title, body, 'error');
                });
                OS.live.on('client_change', function (msg) {
                    if (!msg) return;
                    if (msg.subtype === 'unknown_device') {
                        var mac = msg.client_mac || '';
                        if (!allowAlertToast('unknown:' + mac)) return;
                        OS.toast('Unknown device joined',
                                 mac + (msg.hostname ? ' (' + msg.hostname + ')' : ''),
                                 'warn');
                    }
                });
            }
        }, 500);

        /* Tapping outside an open mobile sidebar closes it. */
        document.addEventListener('click', function (e) {
            var sb = OS.$('sidebar');
            var toggle = OS.$('menuToggle');
            if (window.innerWidth <= 900 && sb.classList.contains('open')) {
                if (!sb.contains(e.target) && (!toggle || !toggle.contains(e.target))) {
                    OS.closeSidebar();
                }
            }
        });

        /* Redraw the sparkline on resize, debounced so a window drag
           doesn't trigger dozens of canvas repaints. */
        window.addEventListener('resize', function () {
            clearTimeout(window._oshotspotResize);
            window._oshotspotResize = setTimeout(function () {
                if (OS.drawTrafficChart) OS.drawTrafficChart();
            }, 200);
        });

        /* Favicon + sidebar branding, independent of Config section DOM. */
        OS.api('/api/config').then(function (cfg) {
            if (OS.applyAdminBranding) {
                OS.applyAdminBranding((cfg && cfg.admin_logo_url) || '');
            }
        }).catch(function () {});

        /* If the page is restored from the back-forward cache (bfcache),
           re-check the session: the dashboard UI can be stale after a
           logout or server restart.  If the user is no longer authenticated,
           force a reload to get a fresh login screen. */
        window.addEventListener('pageshow', function (event) {
            if (!event.persisted) {
                return;
            }
            OS.api('/api/auth/status').then(function (status) {
                if (!status.needs_setup && !status.authenticated) {
                    window.location.reload();
                }
            }).catch(function () {});
        });
    }

    document.addEventListener('DOMContentLoaded', init);
})(window.OS);
