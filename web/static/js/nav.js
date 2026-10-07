/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * nav.js — single-page navigation between dashboard sections, plus
 * the mobile sidebar open/close behavior.
 */

(function (OS) {
    'use strict';

    function closeSidebar() {
        OS.$('sidebar').classList.remove('open');
    }
    OS.closeSidebar = closeSidebar;

    /* ── Sidebar collapse (icons-only mode) ────────────────────── */

    function applySidebarState() {
        var collapsed = localStorage.getItem('oshotspot-sidebar-collapsed') === '1';
        var sb = OS.$('sidebar');
        var app = sb ? sb.parentElement : null;
        if (collapsed) {
            if (sb) sb.classList.add('collapsed');
            if (app) app.classList.add('sidebar-collapsed');
        }
    }

    window.toggleSidebarCollapse = function () {
        var sb = OS.$('sidebar');
        var app = sb ? sb.parentElement : null;
        var collapsed = sb.classList.toggle('collapsed');
        if (app) app.classList.toggle('sidebar-collapsed', collapsed);
        localStorage.setItem('oshotspot-sidebar-collapsed', collapsed ? '1' : '0');
    };

    applySidebarState();

    window.toggleSidebar = function () {
        var sb = OS.$('sidebar');
        if (sb.classList.contains('open')) closeSidebar();
        else sb.classList.add('open');
    };

    /* Section HTML is mounted on first visit to keep cold-start DOM small. */
    var _renderedSections = {};

    var SECTION_RENDERERS = {
        overview:    function () { if (OS.renderOverview) OS.renderOverview(); },
        controls:    function () { if (OS.renderControls) OS.renderControls(); },
        clients:     function () { if (OS.renderClients) OS.renderClients(); },
        config:      function () { if (OS.renderConfig) OS.renderConfig(); },
        qr:          function () { if (OS.renderQR) OS.renderQR(); },
        diagnostics: function () { if (OS.renderDoctor) OS.renderDoctor(); },
        logs:        function () { if (OS.renderLogs) OS.renderLogs(); },
        events:      function () { if (OS.renderEvents) OS.renderEvents(); },
        traffic:     function () { if (OS.renderTraffic) OS.renderTraffic(); },
        activity:    function () { if (OS.renderActivity) OS.renderActivity(); },
        policy:      function () { if (OS.renderPolicy) OS.renderPolicy(); },
        captive:     function () { if (OS.renderCaptive) OS.renderCaptive(); },
        span:        function () { if (OS.renderSpan) OS.renderSpan(); },
        mail:        function () { if (OS.renderMail) OS.renderMail(); },
        vpn:         function () { if (OS.renderVpn) OS.renderVpn(); },
        audit:       function () { if (OS.renderAudit) OS.renderAudit(); },
        about:       function () { if (OS.renderAbout) OS.renderAbout(); },
        users:       function () { if (OS.renderUsers) OS.renderUsers(); }
    };

    OS.ensureSectionRendered = function (section) {
        if (!section || _renderedSections[section]) return;
        var render = SECTION_RENDERERS[section];
        if (!render) return;
        render();
        _renderedSections[section] = true;
    };

    OS.isViewActive = function (viewId) {
        var view = OS.$(viewId);
        return !!(view && view.classList.contains('active'));
    };

    window.navigate = function (section) {
        if (!OS.SECTIONS[section]) section = 'overview';

        OS.ensureSectionRendered(section);

        var views = document.querySelectorAll('.view');
        for (var i = 0; i < views.length; i++) views[i].classList.remove('active');

        var target = OS.$('view-' + section);
        if (target) target.classList.add('active');

        var navItems = document.querySelectorAll('.nav-item');
        for (var j = 0; j < navItems.length; j++) navItems[j].classList.remove('active');
        var activeNav = document.querySelector('.nav-item[data-section="' + section + '"]');
        if (activeNav) activeNav.classList.add('active');

        var meta = OS.SECTIONS[section];
        OS.$('pageTitle').textContent = meta.title;
        OS.$('pageSubtitle').textContent = meta.subtitle;

        // Each section fetches its own data lazily, only when the
        // user actually navigates to it.
        if (section === 'overview' && OS.flushOverviewLive) OS.flushOverviewLive();
        if (section === 'qr') window.refreshQR();
        if (section === 'diagnostics') window.runDoctor();
        if (section === 'logs') window.loadLogs();
        if (section === 'events') window.loadEvents();
        if (section === 'activity' && window.loadActivityFeed) window.loadActivityFeed();
        if (section === 'config') window.loadConfig();
        if (section === 'about') OS.loadVersionInfo();
        if (section === 'clients') OS.refreshClients();
        if (section === 'traffic') OS.refreshTraffic();
        if (section === 'policy') { OS.loadDomainPolicy(); OS.loadAppBlock(); }
        if (section === 'captive' && window.loadCaptive) window.loadCaptive();
        if (section === 'span' && window.loadSpan) window.loadSpan();
        if (section === 'mail' && OS.loadMail) OS.loadMail();
        if (section === 'vpn' && OS.loadVpn) OS.loadVpn();
        if (section === 'audit' && OS.loadAudit) OS.loadAudit();
        if (section === 'users' && OS.initUsersPage) OS.initUsersPage();

        if (window.innerWidth <= 900) closeSidebar();

        var content = OS.$('content');
        if (content) content.scrollTop = 0;
    };
})(window.OS);
