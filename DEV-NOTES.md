# DEV-NOTES — Python Dependencies

This fork of OSHotspot is a **private development fork**. It deliberately
adds **two** small, well-maintained pip packages to fix real production
bugs that the stdlib-only design could not address cleanly.  The upstream
(public) repo remains stdlib-only; these notes explain what was added,
why, and how to keep the additions minimal.

> **Maintenance rule:** keep the dependency surface at exactly these two
> packages.  If a fix can be done with stdlib + the existing two deps, do
> that.  New pip packages need explicit justification.

## The two dependencies

| Package     | Version   | Where used                          | Why                                                   |
|-------------|-----------|-------------------------------------|-------------------------------------------------------|
| `pygtail`   | >= 0.4.0  | `events/tailer.py`                  | Rotation-safe log tailing (offset file + copytruncate) |
| `tenacity`  | >= 8.0.0  | `events/db.py`, `events/notify.py`, `events/live_bus.py` | Retry/backoff for SQLite write contention             |

Declared in `requirements.txt`.

## pygtail — why

**Problem:** the event collector tails `/var/log/oshotspot/dnsmasq.log`.
Every dnsmasq restart replaces/reopens that file without a
logrotate-style rename.  The old hand-rolled reader could not reliably
detect the new file, so after a restart the collector kept reading a
stale offset — events went silent (the exact reported bug).

**Fix:** `pygtail.Pygtail(..., copytruncate=True, save_on_end=True)`
tracks the file inode + byte offset in a state file.  When the inode
changes and no rotated copy can be found, `copytruncate=True` makes
pygtail reset to offset 0 and re-read the fresh file — exactly the
dnsmasq-restart case.  Re-reads are harmless: the events table has a
`source_hash` UNIQUE column, and `events/parser.py` computes a stable
hash per raw log line.

`copytruncate=False` would keep a stale offset and **silently read
nothing** after a replacement — do not switch it off.

## tenacity — why

**Problem:** the tailer (writer) and the web dashboard (readers) access
the SQLite DBs concurrently.  WAL + `busy_timeout` already prevent most
`database is locked` errors, but under load a write can still hit a
transient lock.

**Fix:** write operations in `events/db.py` (`insert_event`,
`update_session`, `mark_known`, `set_known_label`, `remove_known`),
`events/notify.py` (`_persist_notification`) and `events/live_bus.py`
(`publish`) are wrapped with `@retry` on `sqlite3.OperationalError`,
using exponential backoff (3–4 attempts).  Retry is deliberately scoped
to `OperationalError` — a transient lock.  Real bugs (`IntegrityError`,
`ProgrammingError`) are not retried and surface immediately.

Additional SQLite hardening applied in the same step:
- `PRAGMA synchronous=NORMAL` on every connection
  (`events/db.py`, `events/classify.py`, `events/notify.py`,
  `web/server/auth_db.py`).
- `PRAGMA journal_mode=WAL` added to `events/classify.py`.

## Not regressing the collector

Two subtleties matter when touching these paths:

1. `events/notify.py` creates its own `notifications` table (idempotent)
   because the collector may start before the web server has initialised
   auth.db.  `publish()` stays best-effort: a DB failure must never crash
   the collector — the SSE toast still fires via `live_bus.publish`.

2. `events/tailer.py` `run_once()` wraps each `handle_event()` call so a
   single bad event (e.g. a persistent DB lock after the retry budget)
   cannot abort the pygtail iteration.  pygtail only saves its offset at
   EOF, so an early abort would re-read the same lines on the next tick.

## Installing

`install.sh` installs the deps automatically from `requirements.txt`
(handles the PEP 668 `--break-system-packages` case on newer
Debian/Ubuntu).  For manual installs:

```bash
python3 -m pip install -r requirements.txt
```

Verify with:

```bash
python3 -c "import pygtail, tenacity"
```