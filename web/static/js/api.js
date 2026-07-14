/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * api.js — single entry point for talking to the backend. Every call
 * appends the session token and normalizes the response into either
 * parsed JSON or plain text, rejecting with the parsed error body
 * when the server responds with a non-2xx status.
 *
 * Includes a configurable fetch timeout so requests never hang forever
 * when the server is blocked running a shell script.
 */

(function (OS) {
    'use strict';

    var DEFAULT_TIMEOUT = 30000;   // 30 s for normal requests
    var ACTION_TIMEOUT  = 60000;   // 60 s for start/stop/restart
    var REPAIR_TIMEOUT  = 90000;   // 90 s for repair (worst case)

    /**
     * Wrap fetch() with a timeout so we never wait forever.
     * Returns a promise that rejects with a TimeoutError if the
     * server doesn't respond within `ms` milliseconds.
     */
    function fetchWithTimeout(url, opts, ms) {
        var controller = new AbortController();
        var id = setTimeout(function () { controller.abort(); }, ms);
        opts.signal = controller.signal;
        return fetch(url, opts).finally(function () { clearTimeout(id); });
    }

    /**
     * Public API helper.  `path` is the URL path (e.g. '/api/status'),
     * `method' defaults to GET, optional `body` is JSON-serialised.
     * `timeout` overrides the default if supplied.
     */
    OS.api = function (path, method, body, timeout) {
        var sep = path.indexOf('?') >= 0 ? '&' : '?';
        var url = path + sep + 'token=' + encodeURIComponent(OS.state.token);
        var opts = { method: method || 'GET', headers: {} };
        if (body) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        var ms = timeout || DEFAULT_TIMEOUT;
        return fetchWithTimeout(url, opts, ms).then(function (r) {
            var ct = r.headers.get('Content-Type') || '';
            if (ct.indexOf('application/json') >= 0) {
                return r.json().then(function (data) {
                    if (!r.ok) throw data;
                    return data;
                });
            }
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.text();
        });
    };

    /* Expose timeout constants so actions.js can pick the right one. */
    OS.TIMEOUT_ACTION = ACTION_TIMEOUT;
    OS.TIMEOUT_REPAIR = REPAIR_TIMEOUT;
})(window.OS);
