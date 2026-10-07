#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
#
# Licensed under the Apache License, Version 2.0

"""Domain classification, policy matching and noise filtering for OSHotspot.

This module is the single source of truth for deciding what a DNS domain
"is" (noise / messaging / social / entertainment / browsing / unknown) and
whether it matches an admin-defined policy pattern (forbidden or watched).

Design goals
------------
* **Pure stdlib module** -- this module itself has no pip dependency
  (only ``os``, ``re``, ``sqlite3``, ``time``); the project's two pip
  deps (``pygtail``, ``tenacity``) live in tailer/db/notify instead.
* **Editable at runtime** -- patterns live in SQLite tables that the
  dashboard can edit; no code change required to extend the noise list or
  the policy lists.
* **Stateless matching** -- every public matcher is a pure function of
  ``(domain, patterns)`` so it can be unit-tested and reused both by the
  collector (tailer.py) and by the web server (handler.py).
* **Wildcard semantics** -- a pattern may be either:
    - an exact domain   ("example.com")
    - a wildcard suffix ("*.example.com")  -> matches "example.com" and
      any sub-domain ("www.example.com", "a.b.example.com").
  The wildcard form is the more common one in practice.

Schema (created by events.db.init_db alongside the existing tables)
-------------------------------------------------------------------
::

    noise_patterns     (pattern TEXT PRIMARY KEY, label TEXT, added_date TEXT)
    forbidden_domains  (pattern TEXT PRIMARY KEY, label TEXT, added_date TEXT)
    watched_domains    (pattern TEXT PRIMARY KEY, label TEXT, added_date TEXT)

If a table is missing or the DB is unavailable, every function here
degrades gracefully to a safe default (treat as non-matching).
"""

import os
import re
import sqlite3
import time

# A wildcard pattern looks like "*.example.com" -- the leading "*." is
# stripped and the rest is treated as a suffix.  Anything else is an
# exact match (after lower-casing + trailing-dot strip).
WILDCARD_RE = re.compile(r"^\*\.")

# Default noise patterns seeded into the noise_patterns table on first
# init.  These are the categories of background / system / OS telemetry
# traffic that flood the dnsmasq log without carrying useful information
# about what a user is *doing*.  Admins can edit the table later.
DEFAULT_NOISE_PATTERNS = [
    # --- connectivity checks ---
    ("captive.apple.com",                "Apple connectivity check"),
    ("*.captive.apple.com",              "Apple connectivity check"),
    ("connectivitycheck.gstatic.com",    "Google connectivity check"),
    ("connectivitycheck.android.com",    "Android connectivity check"),
    ("connectivitycheck.gstatic.com",    "Google connectivity check"),
    ("clients3.google.com",              "Google connectivity check"),
    ("clients4.google.com",              "Google connectivity check"),
    ("www.google.com/generate_204",      "Google connectivity check"),
    ("msftconnecttest.com",              "Microsoft connectivity check"),
    ("*.msftconnecttest.com",            "Microsoft connectivity check"),
    ("msftncsi.com",                     "Microsoft NCSI"),
    ("*.msftncsi.com",                   "Microsoft NCSI"),
    ("dns.msftncsi.com",                 "Microsoft NCSI"),
    ("www.msftconnecttest.com",          "Microsoft connectivity check"),
    ("network-test.debian.org",          "Debian connectivity check"),
    ("captiveportal.kuketz.de",          "Captive portal check"),

    # --- Apple push / telemetry ---
    ("*.push.apple.com",                 "Apple push notifications"),
    ("*.icloud.com",                     "Apple iCloud keep-alive"),
    ("*.icloud-content.com",             "Apple iCloud content"),
    ("gsp-ssl.ls.apple.com",             "Apple location services"),
    ("*.ls.apple.com",                   "Apple location services"),
    ("gs-loc.apple.com",                 "Apple location services"),
    ("time.apple.com",                   "Apple NTP"),
    ("time-ios.apple.com",               "Apple NTP (iOS)"),
    ("*.mzstatic.com",                   "Apple CDN metadata"),

    # --- Google / Android push / telemetry ---
    ("*.google-analytics.com",           "Google Analytics"),
    ("*.googletagmanager.com",           "Google Tag Manager"),
    ("*.doubleclick.net",                "Google ads"),
    ("*.googlesyndication.com",          "Google ads"),
    ("*.googleapis.com",                 "Google API"),
    ("android.clients.google.com",       "Android push"),
    ("*.gcm.googleapis.com",             "Google Cloud Messaging"),
    ("*.fcm.googleapis.com",             "Firebase Cloud Messaging"),
    ("mtalk.google.com",                 "Android push (mtalk)"),
    ("alt*-mtalk.google.com",            "Android push (mtalk)"),
    ("time.google.com",                  "Google NTP"),
    ("time1.google.com",                 "Google NTP"),
    ("*.gvt1.com",                       "Google update"),
    ("*.gvt2.com",                       "Google update"),
    ("*.gvt3.com",                       "Google update"),
    ("update.googleapis.com",            "Google update"),

    # --- Microsoft telemetry ---
    ("*.telemetry.microsoft.com",        "Microsoft telemetry"),
    ("*.vortex.data.microsoft.com",      "Microsoft telemetry"),
    ("*.settings.data.microsoft.com",    "Microsoft settings sync"),
    ("*.events.data.microsoft.com",      "Microsoft events"),
    ("*.login.microsoftonline.com",      "Microsoft login keep-alive"),
    ("*.windowsupdate.com",              "Windows update"),
    ("*.wns.windows.com",                "Windows push notifications"),
    ("*.notify.windows.com",             "Windows push notifications"),

    # --- Mozilla ---
    ("*.telemetry.mozilla.org",          "Mozilla telemetry"),
    ("detectportal.firefox.com",         "Firefox captive portal"),
    ("*.services.mozilla.com",           "Mozilla services"),
    ("content-signature-2.cdn.mozilla.net", "Mozilla signature"),

    # --- carrier / mobile ---
    ("*.carrier.com",                    "Carrier provisioning"),
    ("epdg.epc.mnc260.mcc310.pub.3gppnetwork.org", "Carrier ePDG"),
    ("*.3gppnetwork.org",                "3GPP network"),

    # --- common time sync ---
    ("pool.ntp.org",                     "NTP pool"),
    ("*.pool.ntp.org",                   "NTP pool"),
    ("time.windows.com",                 "Windows NTP"),
    ("time.nist.gov",                    "NIST NTP"),

    # --- generic local / metadata ---
    ("localhost",                        "Localhost"),
    ("*.local",                          "mDNS / Bonjour local"),
    ("*.localdomain",                    "Local domain"),
    ("metadata.google.internal",         "Cloud metadata endpoint"),
    ("169.254.169.254",                  "Cloud metadata IP"),

    # --- DNS-over-HTTPS bootstrap (often automatic) ---
    ("*.dns.cloudflare.com",             "Cloudflare DoH"),
    ("*.dns.google",                     "Google DoH"),
    ("*.mozilla.cloudflare-dns.com",     "Mozilla DoH"),

    # --- Samsung / other OEMs ---
    ("*.samsungacr.com",                 "Samsung telemetry"),
    ("*.samsungqbe.com",                 "Samsung telemetry"),
    ("*.ospserver.net",                  "Samsung push"),
]

# Domain root -> category mapping for the meaningful (non-noise) buckets.
# These are heuristic, ordered by specificity (longest match first).  An
# entry like "facebook.com" matches "facebook.com" itself AND any
# "*.facebook.com" sub-domain (since the matcher strips the leftmost
# label and tries again).  This list is *not* editable in SQLite on
# purpose -- it reflects well-known service categories; the noise list
# and the policy lists are the editable ones.
CATEGORY_RULES = [
    # --- messaging / VoIP ---
    ("messaging", [
        "whatsapp.com", "whatsapp.net",
        "messenger.com", "messenger.net",
        "telegram.org", "t.me",
        "signal.org", "signalcdn.net",
        "discord.com", "discordapp.com", "discordapp.net",
        "slack.com", "slackb.com",
        "skype.com", "skype.net",
        "zoom.us", "zoomgov.com",
        "hangouts.google.com", "talkgadget.google.com",
        "chat.google.com",
        "facetime.apple.com", "imessage.com",
        "viber.com",
        "snapchat.com", "snapchatads.com",
    ]),
    # --- social networks ---
    ("social", [
        "facebook.com", "fbcdn.net",
        "instagram.com", "cdninstagram.com",
        "twitter.com", "twimg.com", "x.com",
        "tiktok.com", "tiktokcdn.com", "musical.ly",
        "linkedin.com", "licdn.com",
        "pinterest.com", "pinimg.com",
        "reddit.com", "redditmedia.com", "redd.it",
        "tumblr.com",
        "vk.com", "userapi.com",
        "weibo.com", "sinaimg.cn",
    ]),
    # --- entertainment / streaming ---
    ("entertainment", [
        "youtube.com", "googlevideo.com", "ytimg.com", "youtu.be",
        "ggpht.com", "youtubei.googleapis.com",
        "netflix.com", "nflxvideo.net", "nflximg.net", "nflxext.com",
        "spotify.com", "scdn.co", "spotifycdn.com",
        "deezer.com", "dzcdn.net",
        "twitch.tv", "ttvnw.net", "jtvnw.net",
        "disneyplus.com", "disney-plus.net",
        "hulu.com", "hulustream.com",
        "hbo.com", "hbomax.com",
        "primevideo.com", "amazonvideo.com",
        "dailymotion.com", "dmcdn.net",
        "soundcloud.com", "sndcdn.com",
        "vimeo.com", "vimeocdn.com",
        "bilibili.com", "bilivideo.com", "bilivideo.cn",
        "ted.com",
    ]),
    # --- browsing / search / CDN / generic ---
    ("browsing", [
        "google.com", "googleusercontent.com", "gstatic.com",
        "bing.com", "bing.net",
        "duckduckgo.com",
        "yahoo.com", "yimg.com",
        "baidu.com", "bdstatic.com", "bdimg.com",
        "yandex.com", "yandex.ru", "yastatic.net",
        "wikipedia.org", "wikimedia.org", "wikimediafoundation.org",
        "amazon.com", "amazonaws.com", "cloudfront.net",
        "github.com", "githubusercontent.com", "githubassets.com",
        "cloudflare.com", "cloudflareinsights.com", "cdnjs.cloudflare.com",
        "akamai.net", "akamaized.net",
        "fastly.net", "fastly-edge.com",
        "bootstrapcdn.com", "jsdelivr.net", "unpkg.com",
        "w3.org",
    ]),
]


# ---------------------------------------------------------------------------
# Pattern normalisation + matching helpers
# ---------------------------------------------------------------------------

def normalize_domain(domain):
    """Lower-case, strip trailing dot, strip surrounding whitespace.

    Returns "" for falsy input."""
    if not domain:
        return ""
    d = str(domain).strip().lower()
    while d.endswith("."):
        d = d[:-1]
    return d


def normalize_pattern(pattern):
    """Normalise a pattern for storage: lower-case, strip whitespace and
    trailing dot, but keep the leading ``*.`` if present."""
    if not pattern:
        return ""
    p = str(pattern).strip().lower()
    p = p.lstrip(".")
    while p.endswith(".") and not p.endswith("*."):
        p = p[:-1].strip()
    return p


def match_pattern(domain, pattern):
    """Return True if *domain* matches *pattern*.

    Pattern semantics:
      * ``*.example.com``  -> matches "example.com" and any "*.example.com"
      * ``example.com``    -> exact match only
    Both arguments are normalised first (lower-cased, trailing dot
    stripped).  Comparison is case-insensitive."""
    domain = normalize_domain(domain)
    pattern = normalize_pattern(pattern)
    if not domain or not pattern:
        return False
    if pattern.startswith("*."):
        suffix = pattern[2:]
        if not suffix:
            return False
        # "*.example.com" matches "example.com" and "anything.example.com"
        return domain == suffix or domain.endswith("." + suffix)
    return domain == pattern


def match_any(domain, patterns):
    """Return the first pattern in *patterns* that matches *domain*, or
    None.  *patterns* is an iterable of strings."""
    domain = normalize_domain(domain)
    for p in patterns:
        if match_pattern(domain, p):
            return p
    return None


# ---------------------------------------------------------------------------
# SQLite access for the three editable tables
# ---------------------------------------------------------------------------

def _open(path):
    """Open a short-lived connection with a sane busy_timeout.  Caller
    must close it.  Falls back to :memory: if *path* is None."""
    conn = sqlite3.connect(path or ":memory:", timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=5000")
    except Exception:
        pass
    return conn


def _now_iso():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _ensure_tables(conn):
    """Create the three editable tables if they don't exist.  Idempotent
    so it's safe to call from every entry point."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS noise_patterns (
            pattern     TEXT PRIMARY KEY,
            label       TEXT NOT NULL DEFAULT '',
            added_date  TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS forbidden_domains (
            pattern     TEXT PRIMARY KEY,
            label       TEXT NOT NULL DEFAULT '',
            added_date  TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS watched_domains (
            pattern     TEXT PRIMARY KEY,
            label       TEXT NOT NULL DEFAULT '',
            added_date  TEXT NOT NULL
        );
        """
    )
    conn.commit()


def _seed_defaults(conn, table, rows):
    """Insert default rows unless the table already has at least one
    row.  INSERT OR IGNORE keeps it idempotent across restarts."""
    cur = conn.execute("SELECT COUNT(*) AS n FROM " + table)
    n = cur.fetchone()["n"]
    if n > 0:
        return
    now = _now_iso()
    conn.executemany(
        "INSERT OR IGNORE INTO " + table + " (pattern, label, added_date) "
        "VALUES (?, ?, ?)",
        [(normalize_pattern(p), l, now) for p, l in rows],
    )
    conn.commit()


def list_patterns(db_path, table):
    """Return all rows from a policy table as a list of dicts, ordered
    by pattern.  Returns [] on any failure or unknown table."""
    if table not in ("noise_patterns", "forbidden_domains", "watched_domains"):
        return []
    try:
        conn = _open(db_path)
        try:
            _ensure_tables(conn)
            rows = conn.execute(
                "SELECT pattern, label, added_date FROM " + table + " "
                "ORDER BY pattern"
            ).fetchall()
        finally:
            conn.close()
        return [dict(r) for r in rows]
    except Exception:
        return []


def add_pattern(db_path, table, pattern, label=""):
    """Insert one pattern (idempotent on PRIMARY KEY).  Returns True if
    the pattern was newly inserted, False if it already existed or on
    failure / invalid input."""
    if table not in ("noise_patterns", "forbidden_domains", "watched_domains"):
        return False
    p = normalize_pattern(pattern)
    if not p:
        return False
    try:
        conn = _open(db_path)
        try:
            _ensure_tables(conn)
            cur = conn.execute(
                "INSERT OR IGNORE INTO " + table + " "
                "(pattern, label, added_date) VALUES (?, ?, ?)",
                (p, str(label or ""), _now_iso()),
            )
            conn.commit()
            added = cur.rowcount > 0
        finally:
            conn.close()
        return added
    except Exception:
        return False


def remove_pattern(db_path, table, pattern):
    """Delete one pattern by its exact (normalised) form.  Returns True
    if a row was deleted, False otherwise (including on failure)."""
    if table not in ("noise_patterns", "forbidden_domains", "watched_domains"):
        return False
    p = normalize_pattern(pattern)
    if not p:
        return False
    try:
        conn = _open(db_path)
        try:
            _ensure_tables(conn)
            cur = conn.execute(
                "DELETE FROM " + table + " WHERE pattern = ?", (p,)
            )
            conn.commit()
            deleted = cur.rowcount > 0
        finally:
            conn.close()
        return deleted
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Caching policy loader -- avoids re-reading the SQLite tables on every
# DNS query.  Cache TTL is short (a few seconds) so dashboard edits show
# up quickly without restarting the collector.
# ---------------------------------------------------------------------------

class PolicyCache:
    """In-memory cache of the three policy tables.

    The collector calls :py:meth:`get` on every DNS query; the dashboard
    calls :py:meth:`invalidate` after every edit.  The cache also
    auto-refreshes after *ttl* seconds so a manual edit of the DB
    (e.g. by a sysadmin running sqlite3 directly) is picked up."""

    def __init__(self, db_path, ttl=5.0):
        self.db_path = db_path
        self.ttl = ttl
        self._data = {"noise_patterns": [], "forbidden_domains": [],
                      "watched_domains": []}
        self._loaded_at = 0.0

    def _maybe_reload(self):
        now = time.time()
        if self._loaded_at and now - self._loaded_at < self.ttl:
            return
        try:
            for table in self._data:
                self._data[table] = list_patterns(self.db_path, table)
            self._loaded_at = now
        except Exception:
            # Keep the last good snapshot rather than nuking the cache.
            pass

    def invalidate(self):
        """Force the next :py:meth:`get` to reload from SQLite."""
        self._loaded_at = 0.0

    def get(self, table):
        self._maybe_reload()
        return self._data.get(table, [])

    def patterns(self, table):
        """Return just the pattern strings from one table."""
        return [row.get("pattern", "") for row in self.get(table) if row.get("pattern")]


# ---------------------------------------------------------------------------
# Public classifier -- the main entry point used by the collector
# ---------------------------------------------------------------------------

def classify_domain(domain, noise_patterns):
    """Decide the category of *domain* given a list of noise patterns.

    Returns a dict:
      ``{"category": "noise", "matched_pattern": "*.icloud.com"}``
      ``{"category": "messaging", "matched_pattern": None}``
      ``{"category": "unknown",   "matched_pattern": None}``

    The category is one of:
      ``noise`` / ``messaging`` / ``social`` / ``entertainment``
      / ``browsing`` / ``unknown``.

    *noise_patterns* is an iterable of pattern strings (typically loaded
    from the noise_patterns table).  An empty list still allows the
    heuristic CATEGORY_RULES to classify known services."""
    domain = normalize_domain(domain)
    if not domain:
        return {"category": "unknown", "matched_pattern": None}

    # 1) noise -- explicit admin-curated patterns win over heuristics.
    matched = match_any(domain, noise_patterns or [])
    if matched:
        return {"category": "noise", "matched_pattern": matched}

    # 2) heuristic categories -- strip the leftmost label and try again
    #    so that "www.google.com" matches the rule for "google.com".
    parts = domain.split(".")
    candidates = []
    for i in range(len(parts)):
        candidates.append(".".join(parts[i:]))
    for category, roots in CATEGORY_RULES:
        for root in roots:
            if root in candidates:
                return {"category": category, "matched_pattern": None}

    return {"category": "unknown", "matched_pattern": None}


def check_policy(domain, forbidden, watched):
    """Return ``{"forbidden": pattern_or_None, "watched": pattern_or_None}``.

    Both pattern lists are iterated; the first matching pattern wins
    (so order them most-specific-first if you care)."""
    return {
        "forbidden": match_any(domain, forbidden or []),
        "watched":   match_any(domain, watched or []),
    }


# ---------------------------------------------------------------------------
# Schema bootstrap -- called by events.db.init_db after the existing
# tables are created.  Safe to call repeatedly.
# ---------------------------------------------------------------------------

def init_policy_tables(db_path):
    """Create the three editable tables and seed the noise list with
    sensible defaults.  Returns True on success."""
    try:
        conn = _open(db_path)
        try:
            _ensure_tables(conn)
            _seed_defaults(conn, "noise_patterns", DEFAULT_NOISE_PATTERNS)
        finally:
            conn.close()
        return True
    except Exception:
        return False
