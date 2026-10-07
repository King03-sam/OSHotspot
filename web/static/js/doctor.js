/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * doctor.js — Diagnostics page: runs the health-check script and
 * renders each [OK]/[WARN]/[FAIL] result with a summary pill.
 */

(function (OS) {
    'use strict';

    OS.renderDoctor = function () {
        document.getElementById('content').insertAdjacentHTML('beforeend',
            '<section class="view" id="view-diagnostics">'
            + '<div class="card">'
            +     '<div class="card-header">'
            +         '<h2 class="card-title">System Diagnostics</h2>'
            +         '<div class="card-header-actions">'
            +             '<span class="summary-pill" id="doctorSummary"></span>'
            +             '<button class="btn btn-primary btn-sm doctor-run-btn" onclick="runDoctor()">'
            +                 '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>'
            +                 '<span>Run Again</span>'
            +             '</button>'
            +         '</div>'
            +     '</div>'
            +     '<div class="card-body no-pad">'
            +         '<div id="doctorResults" class="doctor-list">'
            +             '<div class="doctor-empty">Click "Run Again" to execute a fresh diagnostic check.</div>'
            +         '</div>'
            +     '</div>'
            + '</div>'
            + '</section>'
        );
    };

    window.runDoctor = function () {
        var results = OS.$('doctorResults');
        var summary = OS.$('doctorSummary');
        if (!results) return;

        results.innerHTML = '<div class="doctor-empty">Running diagnostics…</div>';
        if (summary) {
            summary.textContent = 'running';
            summary.className = 'summary-pill';
        }

        OS.api('/api/doctor').then(function (checks) {
            if (!checks.length) {
                results.innerHTML = '<div class="doctor-empty">No results returned.</div>';
                return;
            }

            var counts = { ok: 0, warn: 0, fail: 0 };
            var html = '';
            for (var i = 0; i < checks.length; i++) {
                var c = checks[i];
                counts[c.status] = (counts[c.status] || 0) + 1;
                html += '<div class="doctor-check doctor-check-' + OS.esc(c.status) + '">'
                    + '<div class="doctor-icon ' + OS.esc(c.status) + '">' + statusIcon(c.status) + '</div>'
                    + '<div class="doctor-msg">' + OS.esc(c.message) + '</div>'
                    + '</div>';
            }
            results.innerHTML = html;

            if (summary) {
                var parts = [];
                if (counts.ok) parts.push(counts.ok + ' ok');
                if (counts.warn) parts.push(counts.warn + ' warn');
                if (counts.fail) parts.push(counts.fail + ' fail');
                summary.textContent = parts.join(' · ');
                summary.className = 'summary-pill';
                if (counts.fail) summary.classList.add('has-fail');
                else if (counts.warn) summary.classList.add('has-warn');
                else summary.classList.add('all-ok');
            }
        }).catch(function () {
            results.innerHTML = '<div class="doctor-empty" style="color:var(--red)">Failed to run diagnostics.</div>';
            if (summary) {
                summary.textContent = 'error';
                summary.className = 'summary-pill has-fail';
            }
        });
    };

    function statusIcon(status) {
        if (status === 'ok') {
            return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
        }
        if (status === 'fail') {
            return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
        }
        return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>';
    }
})(window.OS);
