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

    window.toggleSidebar = function () {
        var sb = OS.$('sidebar');
        if (sb.classList.contains('open')) closeSidebar();
        else sb.classList.add('open');
    };

    window.navigate = function (section) {
        if (!OS.SECTIONS[section]) section = 'overview';

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
        if (section === 'qr') window.refreshQR();
        if (section === 'diagnostics') window.runDoctor();
        if (section === 'logs') window.loadLogs();
        if (section === 'config') window.loadConfig();
        if (section === 'about') OS.loadVersionInfo();
        if (section === 'clients') OS.refreshClients();
        if (section === 'traffic') OS.refreshTraffic();

        if (window.innerWidth <= 900) closeSidebar();

        var content = OS.$('content');
        if (content) content.scrollTop = 0;
    };
})(window.OS);
