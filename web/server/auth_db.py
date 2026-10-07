#!/usr/bin/env python3
#
# OSHotspot
# Copyright 2026 OLOJEDE Samuel
# Licensed under the Apache License, Version 2.0

"""SQLite-backed authentication, session management, and notification
storage for the OSHotspot dashboard.

Tables are created lazily on first access so the dashboard keeps working
even if this module is imported before the DB directory exists.  All
password hashing uses hashlib.pbkdf2_hmac (stdlib) with a per-user
random salt -- never plaintext, never md5/sha1 alone."""

import hashlib
import json
import os
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone

from . import settings

_DB_PATH = None  # resolved lazily
_initialized = False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _now_ts():
    return time.time()


def _hash_password(password, salt=None):
    """Hash a password with PBKDF2-HMAC-SHA256.  Returns (hex_hash, hex_salt)."""
    if salt is None:
        salt = secrets.token_hex(16)
    elif isinstance(salt, str):
        pass  # already hex string
    raw_hash = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), 100000
    )
    return raw_hash.hex(), salt


def _db_path():
    global _DB_PATH
    if _DB_PATH is None:
        _DB_PATH = os.environ.get("OSHOTSPOT_AUTH_DB", settings.AUTH_DB)
    return _DB_PATH


def _connect():
    """Open a connection to auth.db, creating the file and tables if needed."""
    global _initialized
    path = _db_path()
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=3000")
    if not _initialized:
        _init_tables(conn)
        _initialized = True
    return conn


def _init_tables(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS admin_users (
            id                    INTEGER PRIMARY KEY AUTOINCREMENT,
            username              TEXT UNIQUE NOT NULL,
            password_hash         TEXT NOT NULL,
            password_salt         TEXT NOT NULL,
            role                  TEXT NOT NULL DEFAULT 'admin',
            created_at            TEXT NOT NULL,
            created_by            INTEGER REFERENCES admin_users(id),
            failed_login_attempts INTEGER NOT NULL DEFAULT 0,
            locked_until          TEXT,
            can_view_audit        INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token      TEXT PRIMARY KEY,
            user_id    INTEGER NOT NULL REFERENCES admin_users(id),
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS notifications (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            type             TEXT NOT NULL,
            message          TEXT NOT NULL,
            severity         TEXT NOT NULL DEFAULT 'info',
            created_at       TEXT NOT NULL,
            read             INTEGER NOT NULL DEFAULT 0,
            related_event_id INTEGER
        );

        CREATE TABLE IF NOT EXISTS audit_log (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp  TEXT NOT NULL,
            username   TEXT NOT NULL,
            role       TEXT NOT NULL,
            action     TEXT NOT NULL,
            detail     TEXT DEFAULT '',
            source_ip  TEXT DEFAULT '',
            success    INTEGER NOT NULL DEFAULT 1
        );
    """)
    # Indexes for audit_log (separate statements — executescript batches)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(username)")
    # Migrate: add can_view_audit column if missing (existing DBs)
    try:
        conn.execute(
            "ALTER TABLE admin_users ADD COLUMN can_view_audit INTEGER NOT NULL DEFAULT 0"
        )
    except sqlite3.OperationalError:
        pass  # column already exists
    conn.commit()


# ---------------------------------------------------------------------------
# User management
# ---------------------------------------------------------------------------

def needs_setup():
    """Return True if no superadmin exists yet (first-run)."""
    conn = _connect()
    try:
        row = conn.execute("SELECT COUNT(*) AS c FROM admin_users").fetchone()
        return row["c"] == 0
    finally:
        conn.close()


def get_user(username):
    """Return a user row dict or None."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM admin_users WHERE username = ?", (username,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_user_by_id(user_id):
    """Return a user row dict or None."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM admin_users WHERE id = ?", (user_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def create_user(username, password, role="admin", created_by=None):
    """Create a new user.  Returns the new user's id, or raises on
    duplicate username.  Password is hashed before storage."""
    if not username or not username.strip():
        raise ValueError("Username is required")
    if len(password) < settings.PASSWORD_MIN_LENGTH:
        raise ValueError(
            f"Password must be at least {settings.PASSWORD_MIN_LENGTH} characters"
        )
    if role not in ("superadmin", "admin"):
        raise ValueError("Invalid role")
    pw_hash, salt = _hash_password(password)
    conn = _connect()
    try:
        cur = conn.execute(
            "INSERT INTO admin_users "
            "(username, password_hash, password_salt, role, created_at, created_by) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (username.strip(), pw_hash, salt, role, _now_iso(), created_by),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Per-IP brute-force throttle (in-memory, never disclosed to the client).
# ---------------------------------------------------------------------------

IP_LOGIN_ATTEMPTS = {}
_IP_LOGIN_LOCK = threading.Lock()


def is_loopback(ip):
    """True when the address is the hotspot host itself (loopback only)."""
    return ip in settings.IP_LOCKOUT_EXEMPT or ip == "::1"


def _ip_lockout_for(failures):
    lockout_secs = 0
    for threshold, duration in settings.IP_LOCKOUT_TIERS:
        if failures >= threshold:
            lockout_secs = duration
    return lockout_secs


def check_ip_lockout(ip):
    """Return True if the client IP is currently throttled."""
    if not ip or is_loopback(ip):
        return False
    now = time.time()
    with _IP_LOGIN_LOCK:
        entry = IP_LOGIN_ATTEMPTS.get(ip)
        if not entry:
            return False
        if now - entry.get("last_ts", 0) > settings.IP_ATTEMPT_TTL:
            del IP_LOGIN_ATTEMPTS[ip]
            return False
        return now < entry.get("locked_until", 0)


def record_ip_failure(ip):
    """Count one failed login from this IP and apply a lockout tier if reached."""
    if not ip or is_loopback(ip):
        return
    now = time.time()
    with _IP_LOGIN_LOCK:
        for stale_ip in [k for k, v in IP_LOGIN_ATTEMPTS.items()
                         if now - v.get("last_ts", 0) > settings.IP_ATTEMPT_TTL]:
            del IP_LOGIN_ATTEMPTS[stale_ip]
        entry = IP_LOGIN_ATTEMPTS.get(ip, {"failures": 0, "locked_until": 0.0, "last_ts": now})
        entry["failures"] += 1
        entry["last_ts"] = now
        lockout_secs = _ip_lockout_for(entry["failures"])
        if lockout_secs > 0:
            entry["locked_until"] = now + lockout_secs
            if entry.get("notified_failures") != entry["failures"]:
                entry["notified_failures"] = entry["failures"]
                try:
                    from events import alert as email_alert
                    email_alert.alert(
                        "Brute-force lockout: client IP {} banned for {}s after {} failed login attempts".format(
                            ip, lockout_secs, entry["failures"]
                        ),
                        level="ALERT",
                        extra={
                            "attacker_ip": ip,
                            "client_ip": ip,
                            "failure_count": entry["failures"],
                            "lockout_duration": "{}s".format(lockout_secs),
                            "service_name": "Admin Dashboard",
                            "category": "admin_lockout",
                        },
                        category="admin_lockout",
                    )
                except Exception:
                    pass
        IP_LOGIN_ATTEMPTS[ip] = entry


def reset_ip_failures(ip):
    """Clear the failure counter for an IP after a successful login."""
    if not ip or is_loopback(ip):
        return
    with _IP_LOGIN_LOCK:
        IP_LOGIN_ATTEMPTS.pop(ip, None)


def verify_password(username, password, client_ip=None):
    """Verify credentials.  Returns a user dict on success, or a dict
    with an 'error' key on failure.

    Possible error values:
      - 'invalid'      wrong username or password (generic to avoid enumeration)
      - 'locked'       account is temporarily locked (includes 'retry_after' key)

    When client_ip is provided, it is throttled on failure.  A blocked IP is
    NEVER disclosed: it silently receives the same generic 'invalid' error.
    """
    if client_ip and is_loopback(client_ip):
        client_ip = None
    if client_ip and check_ip_lockout(client_ip):
        time.sleep(settings.LOGIN_FAIL_DELAY)
        return {"error": "invalid"}
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM admin_users WHERE username = ?", (username,)
        ).fetchone()
        if not row:
            if client_ip:
                record_ip_failure(client_ip)
            time.sleep(settings.LOGIN_FAIL_DELAY)
            return {"error": "invalid"}

        user = dict(row)

        # Check lockout
        if user.get("locked_until"):
            locked_until = datetime.fromisoformat(user["locked_until"])
            if datetime.now(timezone.utc) < locked_until:
                retry = int((locked_until - datetime.now(timezone.utc)).total_seconds())
                return {"error": "locked", "retry_after": max(retry, 1)}
            # Lockout expired -- clear it
            conn.execute(
                "UPDATE admin_users SET locked_until = NULL, "
                "failed_login_attempts = 0 WHERE id = ?",
                (user["id"],),
            )
            conn.commit()
            user["locked_until"] = None
            user["failed_login_attempts"] = 0

        # Verify password
        computed_hash, _ = _hash_password(password, user["password_salt"])
        if not secrets.compare_digest(computed_hash, user["password_hash"]):
            if client_ip:
                record_ip_failure(client_ip)
            time.sleep(settings.LOGIN_FAIL_DELAY)
            _record_failed_login(conn, user)
            return {"error": "invalid"}

        # Success -- reset failed attempts
        conn.execute(
            "UPDATE admin_users SET failed_login_attempts = 0, "
            "locked_until = NULL WHERE id = ?",
            (user["id"],),
        )
        conn.commit()
        if client_ip:
            reset_ip_failures(client_ip)
        user["failed_login_attempts"] = 0
        user["locked_until"] = None
        return user
    finally:
        conn.close()


def _record_failed_login(conn, user):
    """Increment failed attempts and lock if a tier threshold is reached.
    Lockout duration escalates with the number of failures.
    Caller must commit."""
    attempts = user["failed_login_attempts"] + 1
    lockout_secs = 0
    for threshold, duration in settings.LOCKOUT_TIERS:
        if attempts >= threshold:
            lockout_secs = duration
    locked_until = None
    if lockout_secs > 0:
        locked_until = (
            datetime.now(timezone.utc) + timedelta(seconds=lockout_secs)
        ).isoformat()
        try:
            from events import alert as email_alert
            email_alert.alert(
                "Brute-force lockout: admin user '{}' locked for {}s after {} failed attempts".format(
                    user.get("username", "admin"), lockout_secs, attempts
                ),
                level="ALERT",
                extra={
                    "user_target": user.get("username", "admin"),
                    "failure_count": attempts,
                    "lockout_duration": "{}s".format(lockout_secs),
                    "service_name": "Admin Dashboard",
                    "category": "admin_lockout",
                },
                category="admin_lockout",
            )
        except Exception:
            pass
    conn.execute(
        "UPDATE admin_users SET failed_login_attempts = ?, locked_until = ? "
        "WHERE id = ?",
        (attempts, locked_until, user["id"]),
    )
    conn.commit()


def list_users():
    """Return all users as a list of dicts (password_hash/salt excluded)."""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT id, username, role, created_at, created_by, "
            "failed_login_attempts, locked_until, can_view_audit "
            "FROM admin_users ORDER BY id"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def delete_user(user_id):
    """Delete a user.  Prevents deleting the last superadmin.
    Returns (True, None) on success or (False, error_message) on failure."""
    conn = _connect()
    try:
        user = conn.execute(
            "SELECT * FROM admin_users WHERE id = ?", (user_id,)
        ).fetchone()
        if not user:
            return False, "User not found"
        user = dict(user)

        if user["role"] == "superadmin":
            count = conn.execute(
                "SELECT COUNT(*) AS c FROM admin_users WHERE role = 'superadmin'"
            ).fetchone()["c"]
            if count <= 1:
                return False, "Cannot delete the last superadmin account"

        conn.execute("DELETE FROM admin_users WHERE id = ?", (user_id,))
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        conn.commit()
        return True, None
    finally:
        conn.close()


def reset_user_password(user_id, new_password=None):
    """Reset a user's password.  If new_password is None, generates a
    random one.  Returns (user_dict, new_password) or (None, error_msg)."""
    if new_password is None:
        new_password = secrets.token_urlsafe(12)
    if len(new_password) < settings.PASSWORD_MIN_LENGTH:
        return None, (
            f"Password must be at least {settings.PASSWORD_MIN_LENGTH} characters"
        )
    conn = _connect()
    try:
        user = conn.execute(
            "SELECT * FROM admin_users WHERE id = ?", (user_id,)
        ).fetchone()
        if not user:
            return None, "User not found"
        pw_hash, salt = _hash_password(new_password)
        conn.execute(
            "UPDATE admin_users SET password_hash = ?, password_salt = ?, "
            "failed_login_attempts = 0, locked_until = NULL WHERE id = ?",
            (pw_hash, salt, user_id),
        )
        conn.commit()
        return dict(user), new_password
    finally:
        conn.close()


def set_user_role(user_id, role):
    """Change a user's role.  Returns (True, None) or (False, error)."""
    if role not in ("superadmin", "admin"):
        return False, "Invalid role"
    conn = _connect()
    try:
        user = conn.execute(
            "SELECT * FROM admin_users WHERE id = ?", (user_id,)
        ).fetchone()
        if not user:
            return False, "User not found"
        conn.execute(
            "UPDATE admin_users SET role = ? WHERE id = ?", (role, user_id)
        )
        conn.commit()
        return True, None
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Session management
# ---------------------------------------------------------------------------

def create_session(user_id):
    """Create a new session for the given user.  Returns the session token."""
    token = secrets.token_hex(32)
    now = datetime.now(timezone.utc)
    expires = now + timedelta(seconds=settings.SESSION_EXPIRY)
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at, expires_at) "
            "VALUES (?, ?, ?, ?)",
            (token, user_id, now.isoformat(), expires.isoformat()),
        )
        conn.commit()
        return token
    finally:
        conn.close()


def get_session(session_token):
    """Return session dict if valid and not expired, else None."""
    if not session_token:
        return None
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM sessions WHERE token = ?", (session_token,)
        ).fetchone()
        if not row:
            return None
        session = dict(row)
        if datetime.now(timezone.utc) > datetime.fromisoformat(session["expires_at"]):
            conn.execute("DELETE FROM sessions WHERE token = ?", (session_token,))
            conn.commit()
            return None
        return session
    finally:
        conn.close()


def delete_session(session_token):
    """Delete a session (logout)."""
    conn = _connect()
    try:
        conn.execute("DELETE FROM sessions WHERE token = ?", (session_token,))
        conn.commit()
    finally:
        conn.close()


def cleanup_expired_sessions():
    """Remove all expired sessions."""
    conn = _connect()
    try:
        conn.execute(
            "DELETE FROM sessions WHERE expires_at < ?",
            (_now_iso(),),
        )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------

def create_notification(ntype, message, severity="info", related_event_id=None):
    """Insert a notification.  Returns the new notification id."""
    conn = _connect()
    try:
        cur = conn.execute(
            "INSERT INTO notifications "
            "(type, message, severity, created_at, related_event_id) "
            "VALUES (?, ?, ?, ?, ?)",
            (ntype, message, severity, _now_iso(), related_event_id),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def get_notifications(limit=50, unread_only=False):
    """Return notifications, newest first."""
    conn = _connect()
    try:
        sql = "SELECT * FROM notifications"
        if unread_only:
            sql += " WHERE read = 0"
        sql += " ORDER BY id DESC LIMIT ?"
        rows = conn.execute(sql, (limit,)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def count_unread_notifications():
    """Return count of unread notifications."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM notifications WHERE read = 0"
        ).fetchone()
        return row["c"]
    finally:
        conn.close()


def mark_notification_read(notification_id):
    """Mark a single notification as read."""
    conn = _connect()
    try:
        conn.execute(
            "UPDATE notifications SET read = 1 WHERE id = ?", (notification_id,)
        )
        conn.commit()
    finally:
        conn.close()


def mark_all_notifications_read():
    """Mark all notifications as read."""
    conn = _connect()
    try:
        conn.execute("UPDATE notifications SET read = 1 WHERE read = 0")
        conn.commit()
    finally:
        conn.close()


def delete_read_notifications():
    """Delete notifications that have already been read. Returns count."""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT id FROM notifications WHERE CAST(read AS INTEGER) = 1"
        ).fetchall()
        ids = [row["id"] for row in rows]
        if not ids:
            return 0
        placeholders = ",".join("?" for _ in ids)
        cur = conn.execute(
            "DELETE FROM notifications "
            "WHERE CAST(read AS INTEGER) = 1 AND id IN ({} )".format(placeholders),
            ids,
        )
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()


def cleanup_old_notifications(max_age_days=30, max_unread=500):
    """Prune stale read notifications and cap unread growth.

    Returns a dict with counts of deleted rows for observability.
    """
    conn = _connect()
    deleted_read = 0
    deleted_unread = 0
    try:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=max_age_days)).isoformat()
        cur = conn.execute(
            "DELETE FROM notifications "
            "WHERE CAST(read AS INTEGER) = 1 AND created_at < ?",
            (cutoff,),
        )
        deleted_read = cur.rowcount or 0

        unread = conn.execute(
            "SELECT COUNT(*) AS c FROM notifications WHERE CAST(read AS INTEGER) = 0"
        ).fetchone()["c"]
        if unread > max_unread:
            excess = unread - max_unread
            # Keep the newest unread rows; drop the oldest overflow.
            cur = conn.execute(
                "DELETE FROM notifications WHERE id IN ("
                "  SELECT id FROM notifications "
                "  WHERE CAST(read AS INTEGER) = 0 "
                "  ORDER BY id ASC LIMIT ?"
                ")",
                (excess,),
            )
            deleted_unread = cur.rowcount or 0

        conn.commit()
        return {"deleted_read": deleted_read, "deleted_unread": deleted_unread}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------

def audit_log(username, role, action, detail="", source_ip="", success=True):
    """Write an audit entry to the database."""
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO audit_log "
            "(timestamp, username, role, action, detail, source_ip, success) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                time.strftime("%Y-%m-%d %H:%M:%S"),
                username,
                role,
                action,
                detail,
                source_ip,
                int(success),
            ),
        )
        conn.commit()
    except Exception:
        pass
    finally:
        conn.close()


def get_audit_log(limit=50, offset=0, user=None, action=None,
                  date_from=None, date_to=None):
    """Query audit entries with optional filters.  Returns
    (entries_list, total_count)."""
    conn = _connect()
    try:
        where = []
        params = []
        if user:
            where.append("username LIKE ?")
            params.append("%" + user + "%")
        if action:
            where.append("action LIKE ?")
            params.append("%" + action + "%")
        if date_from:
            where.append("timestamp >= ?")
            params.append(date_from)
        if date_to:
            where.append("timestamp <= ?")
            params.append(date_to + " 23:59:59")

        where_sql = (" WHERE " + " AND ".join(where)) if where else ""

        count_row = conn.execute(
            "SELECT COUNT(*) AS c FROM audit_log" + where_sql, params
        ).fetchone()
        total = count_row["c"]

        rows = conn.execute(
            "SELECT * FROM audit_log" + where_sql +
            " ORDER BY id DESC LIMIT ? OFFSET ?",
            params + [limit, offset],
        ).fetchall()
        return [dict(r) for r in rows], total
    finally:
        conn.close()


def delete_audit_entries(entry_ids):
    """Delete audit entries by their IDs.  Returns count deleted."""
    if not entry_ids:
        return 0
    conn = _connect()
    try:
        placeholders = ",".join("?" for _ in entry_ids)
        cur = conn.execute(
            "DELETE FROM audit_log WHERE id IN ({})".format(placeholders),
            entry_ids,
        )
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()


def cleanup_old_audit():
    """Delete audit entries older than 90 days (rolling cleanup)."""
    conn = _connect()
    try:
        conn.execute(
            "DELETE FROM audit_log WHERE timestamp < datetime('now', '-90 days')"
        )
        conn.commit()
    finally:
        conn.close()


def set_can_view_audit(user_id, enabled):
    """Toggle the can_view_audit flag for a user.
    Returns (True, None) on success or (False, error) on failure."""
    conn = _connect()
    try:
        user = conn.execute(
            "SELECT * FROM admin_users WHERE id = ?", (user_id,)
        ).fetchone()
        if not user:
            return False, "User not found"
        conn.execute(
            "UPDATE admin_users SET can_view_audit = ? WHERE id = ?",
            (int(enabled), user_id),
        )
        conn.commit()
        return True, None
    finally:
        conn.close()
