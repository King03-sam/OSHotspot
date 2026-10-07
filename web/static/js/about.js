/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * about.js: About page with project info, tech stack, features, security.
 */

(function (OS) {
    'use strict';

    OS.renderAbout = function () {
        document.getElementById('content').insertAdjacentHTML('beforeend',
            '<section class="view" id="view-about">'
            + '<div class="card" style="max-width:640px;">'
            +     '<div class="card-body">'
            +         '<div class="about-block">'
            +             '<div class="about-logo" id="aboutLogoBox">'
            +                 '<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>'
            +             '</div>'
            +             '<div>'
            +                 '<h3 class="about-title">OSHotspot</h3>'
            +                 '<p class="about-tagline">WiFi Hotspot & Network Security Manager for Linux</p>'
            +                 '<p class="text-muted" style="line-height:1.5;margin-top:6px;">Share your computer\'s WiFi with any device. Monitor traffic, enforce policies, detect threats.</p>'
            +             '</div>'
            +         '</div>'

            +         '<div class="kv-list" style="margin-top:20px;">'
            +             '<div class="kv-row"><span class="kv-key">Author</span><span class="kv-val" id="aboutAuthor">OLOJEDE Samuel</span></div>'
            +             '<div class="kv-row"><span class="kv-key">License</span><span class="kv-val">Apache License 2.0</span></div>'
            +             '<div class="kv-row" id="aboutVersionRow"><span class="kv-key">Version</span><span class="kv-val mono" id="aboutVersion">...</span></div>'
            +         '</div>'

            +         '<hr style="border:none;border-top:1px solid var(--border-color);margin:24px 0">'

            +         '<div style="margin-bottom:20px;">'
            +             '<div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">Technology</div>'
            +             '<div style="font-size:13px;color:var(--text-secondary);line-height:1.8;">hostapd<span style="color:var(--text-muted);"> · </span>dnsmasq<span style="color:var(--text-muted);"> · </span>iptables/nftables<span style="color:var(--text-muted);"> · </span>iw<span style="color:var(--text-muted);"> · </span>qrencode<span style="color:var(--text-muted);"> · </span>C<span style="color:var(--text-muted);"> · </span>Python 3<span style="color:var(--text-muted);"> · </span>systemd</div>'
            +         '</div>'

            +         '<hr style="border:none;border-top:1px solid var(--border-color);margin:24px 0">'

            +         '<div style="margin-bottom:20px;">'
            +             '<div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">Features</div>'
            +             '<ul style="margin:0;padding-left:18px;color:var(--text-secondary);font-size:13px;line-height:2;">'
            +                 '<li>WiFi AP with NAT, DHCP & DNS (hostapd + dnsmasq)</li>'
            +                 '<li>DNS traffic intelligence & domain policy with alerts</li>'
            +                 '<li>SPAN port traffic analysis & anomaly detection</li>'
            +                 '<li>Captive portal with access codes, guest mode & rate limiting</li>'
            +                 '<li>Application category blocking (messaging, gaming)</li>'
            +                 '<li>Device inventory with unknown device alerts</li>'
            +                 '<li>Live bandwidth monitor with real-time chart</li>'
            +                 '<li>DoH / DoT / VPN protocol blocking</li>'
            +                 '<li>QR code, diagnostics, logs & systemd auto-start</li>'
            +                 '<li>Remote access via Tailscale VPN</li>'
            +                 '<li>… and more</li>'
            +             '</ul>'
            +         '</div>'

            +         '<hr style="border:none;border-top:1px solid var(--border-color);margin:24px 0">'

            +         '<div>'
            +             '<div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">Security</div>'
            +             '<ul style="margin:0;padding-left:18px;color:var(--text-secondary);font-size:13px;line-height:2;">'
            +                 '<li>Configurable bind address (localhost or all interfaces)</li>'
            +                 '<li>PBKDF2-HMAC-SHA256 password hashing</li>'
            +                 '<li>Session token + HttpOnly cookies, role-based access</li>'
            +                 '<li>Progressive brute-force lockout (5 failures = 1 min, up to 60 min; per-IP blocks never disclosed)</li>'
            +             '</ul>'
            +         '</div>'
            +     '</div>'
            + '</div>'
            + '</section>'
        );
        (function () {
            var el = OS.$('aboutVersion');
            if (!el) return;
            fetch('/api/version', { credentials: 'same-origin' })
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    if (data.version === 'unknown') {
                        OS.$('aboutVersionRow').style.display = 'none';
                    } else if (data.version) {
                        el.textContent = data.version;
                    }
                })
                .catch(function () {});
        })();
    };

    OS.updateAboutLogo = function (src) {
        var box = OS.$('aboutLogoBox');
        if (!box) return;
        if (src) {
            var url = (src.indexOf('data:') === 0) ? src : (src + (src.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now());
            box.innerHTML = '<img src="' + url + '" alt="Logo" style="max-width:36px;max-height:36px;object-fit:contain;" onerror="OS._aboutLogoFallback(this)">';
            box.style.background = 'none';
            box.style.border = 'none';
        } else {
            box.innerHTML = '<img src="/images/default-icon.svg" alt="Logo" style="max-width:36px;max-height:36px;object-fit:contain;" onerror="OS._aboutLogoFallback(this)">';
            box.style.background = 'none';
            box.style.border = 'none';
        }
    };

    OS._aboutLogoFallback = function (img) {
        var box = img && img.parentNode;
        if (!box) return;
        box.innerHTML = '<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>';
        box.style.background = '';
        box.style.border = '';
    };
})(window.OS);