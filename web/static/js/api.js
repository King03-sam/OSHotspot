/*
 * OSHotspot Dashboard
 * Copyright 2026 OLOJEDE Samuel
 * Licensed under the Apache License, Version 2.0
 *
 * api.js — single entry point for talking to the backend. Every call
 * appends the session token and normalizes the response into either
 * parsed JSON or plain text, rejecting with the parsed error body
 * when the server responds with a non-2xx status.
 */

(function (OS) {
    'use strict';

    OS.api = function (path, method, body) {
        var sep = path.indexOf('?') >= 0 ? '&' : '?';
        var url = path + sep + 'token=' + encodeURIComponent(OS.state.token);
        var opts = { method: method || 'GET', headers: {} };
        if (body) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        return fetch(url, opts).then(function (r) {
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
})(window.OS);
