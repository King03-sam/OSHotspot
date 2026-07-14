/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * theme.js — dark/light mode, persisted to localStorage and seeded
 * from the OS-level color scheme preference on first visit.
 */

(function (OS) {
    'use strict';

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('oshotspot-theme', theme);
    }

    OS.initTheme = function () {
        var saved = localStorage.getItem('oshotspot-theme');
        var preferred = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)
            ? 'light' : 'dark';
        applyTheme(saved || preferred);
    };

    window.toggleTheme = function () {
        var current = document.documentElement.getAttribute('data-theme');
        applyTheme(current === 'dark' ? 'light' : 'dark');
        // The sparkline reads CSS variables for its colors, so it
        // needs a manual redraw after a theme switch.
        OS.drawTrafficSpark();
    };
})(window.OS);
