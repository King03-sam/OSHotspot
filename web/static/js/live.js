/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * live.js -- the unified SSE (Server-Sent Events) client for the whole
 * dashboard.  Loaded once per browser tab, opens a single
 * EventSource('/api/live-stream') connection, and dispatches
 * incoming messages by `type` to whichever page section has registered
 * a listener for that type.
 *
 * Pages that don't need real-time updates (Configuration, Diagnostics,
 * About, Domain Policy list view) never register a listener and are
 * completely unaffected.
 *
 * The native EventSource API gives us automatic reconnection for free:
 * if the connection drops, the browser waits a few seconds and tries
 * again.  We don't need any custom retry logic.
 *
 * Usage from any module:
 *
 *     OS.live.on('dns_event', function (msg) { ... });
 *     OS.live.on('alert',      function (msg) { ... });
 *     OS.live.on('client_change', function (msg) { ... });
 *     OS.live.on('traffic_sample', function (msg) { ... });
 *     OS.live.on('policy_change',  function (msg) { ... });
 *     OS.live.on('notification',   function (msg) { ... });
 *
 * The handler receives the parsed JSON message object.
 *
 * SSE message format (sent by web/server/live_stream.py):
 *
 *     {"type": "dns_event",      ...}   -- new or updated DNS session
 *     {"type": "alert",          ...}   -- high-priority forbidden / watched / flood
 *     {"type": "client_change",  ...}   -- unknown_device / marked_known / connect / disconnect
 *     {"type": "traffic_sample", ...}   -- bandwidth sample (optional)
 *     {"type": "policy_change",  ...}   -- admin edited a domain policy list
 *     {"type": "notification",   ...}   -- persistent anomaly notification (bell badge)
 *     {"type": "hello",          ...}   -- connection established
 */

(function (OS) {
    'use strict';

    var listeners = {};          // type -> [handler, ...]
    var es = null;               // the EventSource
    var started = false;
    var connected = false;
    var lastMessageAt = 0;
    var lastPayloadAt = 0;
    var errorCount = 0;
    var STALE_MS = 15000;
    var RECONNECT_ERRORS = 5;

    function dispatch(text) {
        var msg;
        try { msg = JSON.parse(text); } catch (e) { return; }
        msg = OS.normalizeLiveMessage ? OS.normalizeLiveMessage(msg) : msg;
        if (!msg || !msg.type) return;
        lastMessageAt = Date.now();
        if (msg.type !== 'hello') {
            lastPayloadAt = lastMessageAt;
            errorCount = 0;
        }
        var handlers = listeners[msg.type];
        if (!handlers) return;
        for (var i = 0; i < handlers.length; i++) {
            try { handlers[i](msg); } catch (e) { /* swallow */ }
        }
    }

    var reconnectTimer = null;
    var reconnectDelay = 2000;

    function _cleanupES() {
        if (es) {
            try {
                es.onopen = null;
                es.onmessage = null;
                es.onerror = null;
                es.close();
            } catch (_) {}
            es = null;
        }
    }

    function _reconnect() {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        _cleanupES();
        connected = false;
        _connect();
    }

    function _scheduleReconnect() {
        if (reconnectTimer) return;
        _cleanupES();
        connected = false;
        reconnectTimer = setTimeout(function () {
            reconnectTimer = null;
            reconnectDelay = Math.min(reconnectDelay * 2, 15000);
            _connect();
        }, reconnectDelay);
    }

    function start() {
        if (started) return;
        started = true;
        // Defer the actual connect until the dashboard is initialized.
        // app.js sets OS.state in init(); we may run before that.
        setTimeout(_connect, 0);

        setInterval(function () {
            if (!started || document.hidden) return;
            var activeView = OS.$('view-activity');
            var eventsView = OS.$('view-events');
            var pageActive = (activeView && activeView.classList.contains('active'))
                || (eventsView && eventsView.classList.contains('active'));
            if (!pageActive) return;
            if (!lastPayloadAt || Date.now() - lastPayloadAt < STALE_MS) return;
            dispatch(JSON.stringify({type: '_sse_stale', ts: Date.now()}));
        }, 5000);
    }

    function _connect() {
        if (!OS.state) {
            // State not ready yet -- retry shortly.
            setTimeout(_connect, 500);
            return;
        }
        try {
            _cleanupES();
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            var url = '/api/live-stream';
            es = new EventSource(url);

            es.onopen = function () {
                connected = true;
                errorCount = 0;
                reconnectDelay = 2000;
                if (window.console) console.log('[OSHotspot] SSE connected');
            };

            // The server sends every event with no event name (just
            // `data: ...\n\n`), so onmessage catches them all.
            es.onmessage = function (ev) {
                dispatch(ev.data);
            };

            es.onerror = function () {
                connected = false;
                errorCount += 1;
                if (window.console) console.log('[OSHotspot] SSE reconnecting\u2026');
                // After several failed reconnects, force a fresh
                // EventSource so a poisoned Last-Event-ID cannot stick.
                if (errorCount >= RECONNECT_ERRORS) {
                    errorCount = 0;
                    _scheduleReconnect();
                }
            };
        } catch (e) {
            connected = false;
            // EventSource not supported (very old browser) -- fall
            // back to polling.  Don't crash the dashboard.
            if (window.console) console.warn('[OSHotspot] SSE unsupported, falling back to polling', e);
        }
    }

    function stop() {
        started = false;
        connected = false;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        _cleanupES();
    }

    function on(type, handler) {
        if (!type || typeof handler !== 'function') return;
        if (!listeners[type]) listeners[type] = [];
        listeners[type].push(handler);
    }

    function off(type, handler) {
        if (!listeners[type]) return;
        var idx = listeners[type].indexOf(handler);
        if (idx >= 0) listeners[type].splice(idx, 1);
    }

    // When the browser tab becomes visible again after being hidden
    // (e.g. user switched away and came back), dispatch a synthetic
    // event so page modules can re-fetch missed data from the DB.
    // Mobile browsers kill SSE connections in the background; this
    // triggers a catch-up when the user returns.
    var _wasHidden = false;
    document.addEventListener('visibilitychange', function () {
        if (!started) return;
        if (document.hidden) {
            _wasHidden = true;
        } else if (_wasHidden) {
            _wasHidden = false;
            dispatch(JSON.stringify({type: '_visibility_restored', ts: Date.now()}));
        }
    });

    OS.live = {
        start: start,
        stop: stop,
        on: on,
        off: off,
        get connected() { return connected; },
        get lastMessageAt() { return lastMessageAt; },
        get lastPayloadAt() { return lastPayloadAt; },
        // Exposed for tests; not meant to be called by app code.
        _dispatch: dispatch
    };
})(window.OS);
