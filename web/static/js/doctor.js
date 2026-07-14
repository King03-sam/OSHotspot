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
                html += '<div class="doctor-check">'
                    + '<div class="doctor-dot ' + OS.esc(c.status) + '"></div>'
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
})(window.OS);
