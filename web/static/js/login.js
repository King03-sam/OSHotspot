/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * login.js -- login page and first-run setup page.  Replaces the
 * entire document body with a themed form when the user is not
 * authenticated or when no admin account exists yet.
 */

(function (OS) {
    'use strict';

    var loginHTML =
        '<div class="auth-page">'
        + '<div class="auth-card">'
        +     '<div class="auth-header">'
        +         '<div class="auth-logo">'
        +             '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">'
        +                 '<path d="M5 12.55a11 11 0 0 1 14.08 0"/>'
        +                 '<path d="M1.42 9a16 16 0 0 1 21.16 0"/>'
        +                 '<path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>'
        +                 '<line x1="12" y1="20" x2="12.01" y2="20"/>'
        +             '</svg>'
        +         '</div>'
        +         '<h2 class="auth-title">OSHotspot</h2>'
        +         '<p class="auth-subtitle" id="authSubtitle">Sign in to the dashboard</p>'
        +     '</div>'
        +     '<div class="auth-error" id="authError" style="display:none;"></div>'
        +     '<form id="authForm" autocomplete="on">'
        +         '<div class="auth-field">'
        +             '<label class="auth-label" for="authUsername">Username</label>'
        +             '<input class="auth-input" type="text" id="authUsername" name="username" autocomplete="username" required autofocus>'
        +         '</div>'
        +         '<div class="auth-field">'
        +             '<label class="auth-label" for="authPassword">Password</label>'
        +             '<input class="auth-input" type="password" id="authPassword" name="password" autocomplete="current-password" required>'
        +         '</div>'
        +         '<button class="btn btn-primary auth-submit" type="submit" id="authSubmitBtn">Sign In</button>'
        +     '</form>'
        + '</div>'
        + '</div>';

    function showError(msg) {
        var el = document.getElementById('authError');
        if (el) {
            el.textContent = msg;
            el.style.display = 'block';
        }
    }

    function hideError() {
        var el = document.getElementById('authError');
        if (el) el.style.display = 'none';
    }

    function setLoading(loading) {
        var btn = document.getElementById('authSubmitBtn');
        if (btn) {
            btn.disabled = loading;
            btn.textContent = loading ? 'Please wait\u2026' : (OS.state._isSetup ? 'Create Account' : 'Sign In');
        }
    }

    function handleLockout(data) {
        var retry = data.retry_after || 60;
        var mins = Math.ceil(retry / 60);
        showError('Account temporarily locked. Try again in ' + mins + ' minute' + (mins !== 1 ? 's' : '') + '.');
        setLoading(false);
        // Start countdown
        var btn = document.getElementById('authSubmitBtn');
        if (btn) btn.disabled = true;
        var interval = setInterval(function () {
            retry--;
            if (retry <= 0) {
                clearInterval(interval);
                hideError();
                setLoading(false);
                if (btn) btn.disabled = false;
                return;
            }
            mins = Math.ceil(retry / 60);
            showError('Account temporarily locked. Try again in ' + mins + ' minute' + (mins !== 1 ? 's' : '') + '.');
        }, 1000);
    }

    function submitForm(e) {
        e.preventDefault();
        hideError();
        var username = document.getElementById('authUsername').value.trim();
        var password = document.getElementById('authPassword').value;
        if (!username || !password) {
            showError('Username and password are required.');
            return;
        }
        setLoading(true);
        var url = OS.state._isSetup ? '/api/auth/setup' : '/api/auth/login';

        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username, password: password })
        }).then(function (r) {
            if (r.status === 302 || r.redirected) {
                // Success -- server set cookie and redirected
                window.location.href = '/';
                return;
            }
            return r.json().then(function (data) {
                if (r.ok) {
                    window.location.href = '/';
                } else if (data.error === 'locked') {
                    handleLockout(data);
                } else {
                    showError(data.error || 'Invalid credentials.');
                    setLoading(false);
                }
            });
        }).catch(function () {
            showError('Connection error. Please try again.');
            setLoading(false);
        });
    }

    /**
     * Called by app.js when the user is not authenticated.
     * Replaces the document body with the login or setup form.
     * @param {boolean} isSetup - true if first-run setup is needed
     */
    OS.showLogin = function (isSetup) {
        if (OS.state._loginShown) return;
        OS.state._loginShown = true;
        if (OS.stopPolling) OS.stopPolling();
        if (OS.live && OS.live.stop) OS.live.stop();
        OS.state._isSetup = isSetup;
        document.body.innerHTML = loginHTML;

        // Apply theme
        var saved = localStorage.getItem('oshotspot-theme');
        var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        var theme = saved || (prefersDark ? 'dark' : 'light');
        document.documentElement.setAttribute('data-theme', theme);

        // Fetch custom branding (logo & login background color)
        fetch('/api/auth/status').then(function (r) { return r.json(); }).then(function (data) {
            if (!data) return;
            if (data.admin_login_bg_color) {
                document.body.style.backgroundColor = data.admin_login_bg_color;
            }
            if (data.admin_logo_url) {
                var logoEl = document.querySelector('.auth-logo');
                if (logoEl) {
                    logoEl.innerHTML = '<img src="' + data.admin_logo_url + '" alt="Logo" style="max-width:80px;max-height:80px;object-fit:contain;display:block;margin:0 auto;">';
                    logoEl.style.background = 'none';
                    logoEl.style.border = 'none';
                }
                var fav = document.getElementById('favicon');
                if (fav) {
                    fav.href = data.admin_logo_url + '?t=' + Date.now();
                    fav.type = ((data.admin_logo_url.indexOf('data:image/svg') === 0) || /\.svg(\?|$)/i.test(data.admin_logo_url)) ? 'image/svg+xml' : 'image/png';
                }
            }
        }).catch(function () {});

        if (isSetup) {
            var sub = document.getElementById('authSubtitle');
            if (sub) sub.textContent = 'Create your Super Admin account to get started';
            var title = document.querySelector('.auth-title');
            if (title) title.textContent = 'First-Time Setup';
        }

        var form = document.getElementById('authForm');
        if (form) form.addEventListener('submit', submitForm);
    };
})(window.OS);
