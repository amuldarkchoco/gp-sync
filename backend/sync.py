"""Copy every photo and video in the mounted media folders to Google Photos.

Files are never changed: folders should be mounted read-only. A web dashboard shows
progress, history and network use, and is where Google accounts are connected.
Works on Umbrel and on any Docker host: Linux, Windows, macOS, NAS (see README.md).
"""

import base64
import collections
import contextlib
import fnmatch
import hashlib
import hmac
import http.cookies
import json
import os
import re
import shutil
import socket
import sqlite3
import sys
import threading
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cache
import media
import notify

HERE = Path(__file__).resolve().parent
# VERSION sits next to sync.py in the image, one level up (repo root) when run from backend/.
_VERSION_FILE = next((p for p in (HERE / "VERSION", HERE.parent / "VERSION") if p.exists()), None)
VERSION = _VERSION_FILE.read_text().strip() if _VERSION_FILE else "dev"
DATA = Path(os.environ.get("DATA_DIR", "/data"))
MEDIA = Path(os.environ.get("MEDIA_DIR", "/media"))
PORT = int(os.environ.get("PORT", "8527"))
HOST = os.environ.get("HOST", "0.0.0.0")
INTERVAL = int(os.environ.get("SCAN_INTERVAL_MINUTES", "5")) * 60
SETTLE = int(os.environ.get("SETTLE_SECONDS", "120"))  # skip files still being copied
MAX_ATTEMPTS = 5
MAX_ACCOUNTS = 5  # Google accounts one app can hold
NET_HISTORY = 90  # seconds of speed history kept for the graph
STARTED = time.time()

LEGACY_AUTH_FILE = DATA / "auth_data"  # single account (older installs)
ACCOUNTS_DIR = DATA / "accounts"
PAUSE_FILE = DATA / "paused"
DB_FILE = DATA / "state.db"
STATS_FILE = DATA / "stats.db"
THUMBS = DATA / "thumbs"
# Phones upload here (Umbrel: Photos/Uploads). The rest of the media stays read-only.
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", "/uploads"))
UPLOAD_OWNER = (int(os.environ.get("PUID", "1000")), int(os.environ.get("PGID", "1000")))
MAX_UPLOAD = 50 * 1024**3
upload_lock = threading.Lock()
# The dashboard built by Vite (web/ → static/ in the image; ../web/dist when run from backend/ in the repo).
STATIC_DIR = next(
    (d for d in (HERE / "static", HERE.parent / "web" / "dist") if (d / "index.html").exists()), HERE / "static"
)

PHOTO_EXTS = {
    "jpg", "jpeg", "png", "heic", "heif", "gif", "webp", "bmp", "tif", "tiff", "avif",
    "dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2", "srw", "pef",
}  # fmt: skip
VIDEO_EXTS = {"mp4", "mov", "m4v", "3gp", "3g2", "avi", "mkv", "webm", "mts", "m2ts", "wmv", "mpg", "mpeg"}
EXTS = PHOTO_EXTS | VIDEO_EXTS
THUMB_EXTS = {"jpg", "jpeg", "png", "heic", "heif", "gif", "webp", "bmp", "tif", "tiff", "avif"}
DONE = ("uploaded", "exists")
# Top-level folders backed up until folders are chosen in Settings (FOLDERS="Photos,Videos" by
# default; when none of them exist, every folder is backed up).
DEFAULT_FOLDERS = tuple(f.strip() for f in os.environ.get("FOLDERS", "Photos,Videos").split(",") if f.strip())
# Folder and file names never backed up (comma-separated patterns, * and ? allowed): NAS and
# system clutter, and Immich's transcoded videos. Hidden names (starting with ".") are skipped too.
DEFAULT_EXCLUDE = "@eaDir,#recycle,#snapshot,$RECYCLE.BIN,System Volume Information,lost+found,encoded-video"
EXCLUDE = tuple(p.strip() for p in os.environ.get("EXCLUDE", DEFAULT_EXCLUDE).split(",") if p.strip())
# What the dashboard calls the machine the files are on ("Umbrel" on Umbrel).
HOST_NAME = os.environ.get("HOST_NAME", "").strip() or "this server"
# Optional password for the dashboard and API (any user name). Umbrel has its own login.
PASSWORD = os.environ.get("PASSWORD", "")

log_lines = collections.deque(maxlen=300)  # (unix time, kind, text, file name or None)
state = {
    "phase": "starting",
    "done": 0,
    "total": 0,
    "last_scan": 0,
    "error": "",
    "current": None,  # {"name", "bytes_done", "bytes_total", "step", "kind", "account"}
    "library": {"files": 0, "bytes": 0, "synced_files": 0, "synced_bytes": 0, "types": {}},
    "folders": {},  # top folder -> {"files", "bytes", "synced_files", "synced_bytes"}
    "pending": [],  # names waiting to upload (first 500)
    "index": [],  # every media file from the last scan: (rel path, is video, size, added, backed up)
    "session": {"started": STARTED, "uploaded_files": 0, "uploaded_bytes": 0},
    "login_failed": set(),  # accounts Google rejected; cleared on success or a new login
    "next_window": 0,
}
net = {
    "up": collections.deque(maxlen=NET_HISTORY),
    "down": collections.deque(maxlen=NET_HISTORY),
    "sent": 0,
    "received": 0,
}
wake = threading.Event()
background_work = threading.Event()  # new uploads: make their thumbnails soon
changed = threading.Condition()  # wakes live dashboards (/api/stream) when something happens
stream_slots = threading.BoundedSemaphore(16)
db_lock = threading.Lock()


def log(msg, kind="info", name=None):
    """Print, keep in memory for the live view, and save to the activity history."""
    now = time.time()
    out = sys.stderr if kind in ("error", "failed") else sys.stdout
    print(time.strftime("%Y-%m-%d %H:%M:%S ") + msg, file=out, flush=True)
    log_lines.append((now, kind, msg, name))
    save_event(now, kind, msg, name)
    notify_change()


changes = [0]  # bumped on every notify_change, so cached status answers refresh at once


def notify_change():
    changes[0] += 1
    with changed:
        changed.notify_all()


def rel(path):
    return str(path).removeprefix(str(MEDIA) + "/")


def ext(name):
    return str(name).rsplit(".", 1)[-1].lower()


def top_folder(path):
    parts = rel(path).split("/")
    return parts[0] if len(parts) > 1 else ""


# ---------------------------------------------------------------- upload state (SQLite)


def db():
    conn = sqlite3.connect(DB_FILE, check_same_thread=False)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY, size INTEGER, mtime REAL, status TEXT,
            media_key TEXT, error TEXT, attempts INTEGER DEFAULT 0, updated REAL)"""
    )
    conn.execute("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)")
    cols = {r[1] for r in conn.execute("PRAGMA table_info(files)")}
    if "account" not in cols:  # older installs: add the account column
        conn.execute("ALTER TABLE files ADD COLUMN account TEXT")
    if "sha1" not in cols:  # older installs: add the sha1 column (duplicate finder)
        conn.execute("ALTER TABLE files ADD COLUMN sha1 TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS files_sha1 ON files(sha1)")
    conn.execute("CREATE INDEX IF NOT EXISTS files_updated ON files(updated)")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS albums (account TEXT, name TEXT, album_key TEXT, PRIMARY KEY (account, name))"
    )
    # Copies of a file in more Google accounts than the folder's first one (one row per account).
    conn.execute(
        """CREATE TABLE IF NOT EXISTS copies (
            path TEXT NOT NULL, account TEXT NOT NULL, size INTEGER, mtime REAL, status TEXT,
            media_key TEXT, error TEXT, attempts INTEGER DEFAULT 0, updated REAL,
            PRIMARY KEY (path, account))"""
    )
    # Items moved out of Google storage (see "free up Google storage").
    conn.execute(
        """CREATE TABLE IF NOT EXISTS reclaim (
            account TEXT NOT NULL, media_key TEXT NOT NULL, dedup_key TEXT, name TEXT, kind TEXT,
            size INTEGER, quota INTEGER, taken REAL, favorite INTEGER, archived INTEGER, caption TEXT,
            state TEXT, error TEXT, local TEXT, new_key TEXT, checks INTEGER DEFAULT 0, updated REAL,
            PRIMARY KEY (account, media_key))"""
    )
    # Items copied from one Google account to another (see "copy between Google accounts").
    conn.execute(
        """CREATE TABLE IF NOT EXISTS copyjobs (
            src TEXT NOT NULL, dst TEXT NOT NULL, media_key TEXT NOT NULL, dedup_key TEXT, name TEXT,
            kind TEXT, size INTEGER, taken REAL, favorite INTEGER, archived INTEGER, caption TEXT,
            state TEXT, error TEXT, new_key TEXT, checks INTEGER DEFAULT 0, updated REAL,
            PRIMARY KEY (src, dst, media_key))"""
    )
    conn.execute("CREATE INDEX IF NOT EXISTS copyjobs_state ON copyjobs(state, taken)")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.commit()
    return conn


CONN = db()


def q(sql, args=()):
    with db_lock:
        cur = CONN.execute(sql, args)
        rows = cur.fetchall()  # before commit, so RETURNING rows are not lost
        if CONN.in_transaction:
            CONN.commit()
            cache.bump()  # cached answers that read the data are now stale
        return rows


def meta_get(k):
    rows = q("SELECT v FROM meta WHERE k=?", (k,))
    return rows[0][0] if rows else None


def meta_set(k, v):
    q("INSERT OR REPLACE INTO meta VALUES (?,?)", (k, v))


# ---------------------------------------------------------------- settings

DEFAULT_SETTINGS = {
    "folders": None,  # {top folder: account email or ""}; None = Photos and Videos to the first account
    "schedule": {"enabled": False, "start": 1, "end": 7},  # local hours; may wrap past midnight
    "tz_offset_min": 0,  # viewer's time zone, saved from the dashboard
    "speed_limit_mbps": 0,  # 0 = no limit
    "albums": "off",  # off | top (first subfolder) | parent (folder the file is in)
    "notify": {
        "ntfy_url": "",
        "ntfy_token": "",
        "telegram_token": "",
        "telegram_chat": "",
        "on_login": True,
        "on_gave_up": True,
        "on_round": True,
        "round_min": 20,
        "weekly": True,
    },
    "hash_existing": True,  # duplicate finder: fingerprint already uploaded files when idle
}
SECRET_KEYS = ("ntfy_token", "telegram_token")


def _merge(base, extra):
    out = dict(base)
    for k, v in (extra or {}).items():
        if k in out and isinstance(out[k], dict) and isinstance(v, dict):
            out[k] = _merge(out[k], v)
        elif k in out:
            out[k] = v
    return out


def get_settings():
    try:
        saved = json.loads(meta_get("settings") or "{}")
    except ValueError:
        saved = {}
    return _merge(json.loads(json.dumps(DEFAULT_SETTINGS)), saved)  # deep copy: never change the defaults


def update_settings(changes):
    """Merge `changes` into the saved settings, after checking the values. Returns the new settings."""
    cur = get_settings()
    new = _merge(cur, changes)
    n, s = new["notify"], new["schedule"]
    for key in SECRET_KEYS:  # empty secret in a change means "keep the saved one"
        if not (changes.get("notify") or {}).get(key):
            n[key] = cur["notify"][key]
    s["start"], s["end"] = int(s["start"]) % 24, int(s["end"]) % 24
    s["enabled"] = bool(s["enabled"])
    new["tz_offset_min"] = max(-840, min(840, int(new["tz_offset_min"])))
    new["speed_limit_mbps"] = max(0.0, float(new["speed_limit_mbps"] or 0))
    if new["albums"] not in ("off", "top", "parent"):
        new["albums"] = "off"
    n["round_min"] = max(1, int(n["round_min"]))
    if new["folders"] is not None:
        # One account per folder, or a list (the first is the main one): up to MAX_ACCOUNTS.
        new["folders"] = {
            str(k): list(dict.fromkeys(a for a in _as_list(v) if a))[:MAX_ACCOUNTS]
            for k, v in dict(new["folders"]).items()
        }
    if n["ntfy_url"] and not n["ntfy_url"].startswith(("http://", "https://")):
        raise ValueError("The ntfy address must start with http:// or https://")
    meta_set("settings", json.dumps(new))
    return new


def public_settings():
    """Settings for the dashboard: secrets are never sent back, only whether they are set."""
    st = get_settings()
    for key in SECRET_KEYS:
        st["notify"][key + "_set"] = bool(st["notify"][key])
        st["notify"][key] = ""
    return st


# ---------------------------------------------------------------- Google accounts


def email_of(auth):
    params = urllib.parse.parse_qs(auth)
    return (params.get("Email") or params.get("email") or ["unknown"])[0]


def _account_file(email):
    safe = "".join(c for c in email if c.isalnum() or c in "@._-+")
    return ACCOUNTS_DIR / f"{safe}.auth"


def _account_paths():
    """{email: [auth files]} read from the files themselves: a file's name can differ from the
    email inside it (an older version, or a login whose email could not be read)."""
    found = {}
    for f in ACCOUNTS_DIR.glob("*.auth"):
        auth = f.read_text().strip()
        if auth:
            found.setdefault(email_of(auth), []).append(f)
    return found


def migrate_accounts():
    """Older installs: the single auth_data file becomes the first account."""
    ACCOUNTS_DIR.mkdir(parents=True, exist_ok=True)
    if LEGACY_AUTH_FILE.exists() and not any(ACCOUNTS_DIR.glob("*.auth")):
        auth = LEGACY_AUTH_FILE.read_text().strip()
        if auth:
            target = _account_file(email_of(auth))
            target.write_text(auth)
            target.chmod(0o600)
    first = accounts()
    if first and not _account_order():
        meta_set("account_order", json.dumps([e for e, _ in first]))
    if first:
        q("UPDATE files SET account=? WHERE account IS NULL", (first[0][0],))


def _account_order():
    try:
        return json.loads(meta_get("account_order") or "[]")
    except ValueError:
        return []


def accounts():
    """[(email, auth)] in the order they were added. The first one is the main account."""
    found = {}
    for f in ACCOUNTS_DIR.glob("*.auth"):
        auth = f.read_text().strip()
        if auth:
            found[email_of(auth)] = (auth, f.stat().st_mtime)
    order = _account_order()
    rank = {e: i for i, e in enumerate(order)}
    emails = sorted(found, key=lambda e: (rank.get(e, len(order)), found[e][1], e))
    return [(e, found[e][0]) for e in emails]


def parse_auth(auth):
    auth = (auth or "").strip()
    if "androidId=" not in auth:
        return None
    auth = auth[auth.index("androidId=") :].split()[0]
    return auth if "Email=" in auth else None


def save_account(auth):
    """Add or replace an account's login. Returns its email, or None if the text is not a login."""
    auth = parse_auth(auth)
    if not auth:
        return None
    email = email_of(auth)
    target = _account_file(email)
    existed = target.exists()
    if not existed and len(accounts()) >= MAX_ACCOUNTS:
        raise ValueError(f"Up to {MAX_ACCOUNTS} Google accounts can be connected. Remove one first.")
    ACCOUNTS_DIR.mkdir(parents=True, exist_ok=True)
    target.write_text(auth)
    target.chmod(0o600)
    order = _account_order()
    if email not in order:  # replacing a login keeps the account's place
        meta_set("account_order", json.dumps([*order, email]))
    state["login_failed"].discard(email)
    log(("Updated login for " if existed else "Connected Google account ") + email, "account")
    wake.set()
    return email


def remove_account(email):
    files = _account_paths().get(email) or [f for f in [_account_file(email)] if f.exists()]
    if files:
        for f in files:
            f.unlink(missing_ok=True)
        meta_set("account_order", json.dumps([e for e in _account_order() if e != email]))
        log(f"Removed Google account {email}", "account")
        return True
    return False


def _as_list(value):
    """A folder's accounts as saved: one email (older settings) or a list of emails."""
    if not value:
        return []
    return [str(v) for v in value] if isinstance(value, (list, tuple)) else [str(value)]


def folder_targets(st=None, tops=None):
    """Every account each top-level folder is backed up to; the first is its main account.

    An empty list means the folder is not backed up."""
    st = st or get_settings()
    accs = [a for a, _ in accounts()]
    tops = tops if tops is not None else list_top_folders()
    if st["folders"] is None:
        defaults = [t for t in tops if t in DEFAULT_FOLDERS] or tops
        return {t: (accs[:1] if t in defaults else []) for t in tops}
    out = {}
    for t in tops:
        chosen = [a for a in _as_list(st["folders"].get(t)) if a in accs]
        out[t] = list(dict.fromkeys(chosen))[:MAX_ACCOUNTS]
    return out


def folder_map(st=None, tops=None):
    """The main account of each top-level folder. "" means it is not backed up."""
    return {t: (accs[0] if accs else "") for t, accs in folder_targets(st, tops).items()}


def skipped(name):
    """Hidden, or matches an EXCLUDE pattern."""
    return name.startswith(".") or any(fnmatch.fnmatch(name, p) for p in EXCLUDE)


def list_top_folders():
    try:
        return sorted(e.name for e in os.scandir(MEDIA) if e.is_dir() and not skipped(e.name))
    except OSError:
        return []


# ---------------------------------------------------------------- statistics (Turso)
# Daily statistics live in a Turso database (open-source, SQLite-compatible; turso.tech).
# Upload state stays in plain SQLite: Turso is still beta, and a statistics problem must
# never stop backups. If Turso can't be used, statistics fall back to SQLite.

STAT_COLUMNS = (
    "photos",
    "videos",
    "photo_bytes",
    "video_bytes",
    "existing",
    "failed",
    "net_sent",
    "net_received",
    "photo_ms",  # time spent uploading (added later; older rows have none)
    "video_ms",
)
HOURLY_SCHEMA = """CREATE TABLE IF NOT EXISTS hourly (
    hour INTEGER PRIMARY KEY,
    photos INTEGER NOT NULL DEFAULT 0, videos INTEGER NOT NULL DEFAULT 0,
    photo_bytes INTEGER NOT NULL DEFAULT 0, video_bytes INTEGER NOT NULL DEFAULT 0,
    existing INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
    net_sent INTEGER NOT NULL DEFAULT 0, net_received INTEGER NOT NULL DEFAULT 0,
    peak_up REAL NOT NULL DEFAULT 0, peak_down REAL NOT NULL DEFAULT 0)"""  # one row per hour (unix time // 3600)
STATS_SCHEMA = (
    HOURLY_SCHEMA,
    "CREATE TABLE IF NOT EXISTS events (time REAL NOT NULL, kind TEXT, text TEXT, name TEXT)",
    # One row per finished file: how long it took, for averages and insights.
    """CREATE TABLE IF NOT EXISTS uploads (time REAL NOT NULL, name TEXT, kind TEXT, bytes INTEGER,
       ms INTEGER, result TEXT, account TEXT)""",
    # Everything the app prints, so problems can be looked at later.
    "CREATE TABLE IF NOT EXISTS logs (time REAL NOT NULL, level TEXT, text TEXT)",
    # Per-minute averages of speed, CPU, memory and Google latency.
    """CREATE TABLE IF NOT EXISTS samples (minute INTEGER PRIMARY KEY, up REAL, down REAL, cpu REAL,
       mem INTEGER, latency REAL)""",
)
EVENT_DAYS = 90  # activity history kept this long
LOG_DAYS = 30
SAMPLE_DAYS = 14
stats_lock = threading.Lock()


def _dist_version(name):
    try:
        from importlib.metadata import version

        return version(name)
    except Exception:
        return ""


def open_stats():
    """Open the statistics database: Turso if possible, otherwise SQLite. Returns (connection, engine name)."""
    try:
        import turso  # optional at runtime, so a broken install can't stop the app

        conn = turso.connect(str(STATS_FILE))
        _create_stats_tables(conn)
        return conn, f"Turso {_dist_version('pyturso')}".strip()
    except Exception as e:
        print(f"Turso unavailable, using SQLite for statistics: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        conn = sqlite3.connect(STATS_FILE, check_same_thread=False)
        _create_stats_tables(conn)
        return conn, f"SQLite {sqlite3.sqlite_version} (Turso unavailable)"


def _create_stats_tables(conn):
    for sql in STATS_SCHEMA:
        conn.execute(sql)
    have = {row[1] for row in conn.execute("PRAGMA table_info(hourly)").fetchall()}
    for col in STAT_COLUMNS:
        if col not in have:  # columns added by newer versions
            conn.execute(f"ALTER TABLE hourly ADD COLUMN {col} INTEGER NOT NULL DEFAULT 0")
    conn.commit()


STATS, STATS_ENGINE = open_stats()


def sq(sql, args=()):
    """Run one statement on the statistics database."""
    with stats_lock:
        cur = STATS.execute(sql, args)
        rows = cur.fetchall()
        STATS.commit()
        if sql.lstrip()[:6].upper() != "SELECT":
            cache.bump()
        return rows


def init_events():
    """Indexes, and drop history older than it is kept."""
    now = time.time()
    for table, days in (("events", EVENT_DAYS), ("logs", LOG_DAYS), ("uploads", None)):
        sq(f"CREATE INDEX IF NOT EXISTS {table}_time ON {table}(time)")
        if days:
            sq(f"DELETE FROM {table} WHERE time < ?", (now - days * 86400,))
    sq("DELETE FROM samples WHERE minute < ?", (int(now // 60) - SAMPLE_DAYS * 1440,))
    with contextlib.suppress(OSError):
        clean_chunks()


def save_event(when, kind, text, name=None):
    """Store one activity entry. Never raises."""
    try:
        sq("INSERT INTO events (time, kind, text, name) VALUES (?,?,?,?)", (when, kind, text, name))
    except Exception as e:
        print(f"Could not save activity: {type(e).__name__}: {e}", file=sys.stderr, flush=True)


EVENT_KINDS = {
    "uploaded": ("uploaded",),
    "exists": ("exists",),
    "failed": ("failed", "error"),
    "system": ("scan", "info", "pause", "resume", "account", "album", "received"),
}


def activity(kind="all", query="", before=None, limit=100):
    """Saved activity, newest first. `kind` is all, uploaded, exists, failed or system."""
    where, args = [], []
    if kind in EVENT_KINDS:
        where.append(f"kind IN ({', '.join('?' * len(EVENT_KINDS[kind]))})")
        args += EVENT_KINDS[kind]
    if query:
        where.append("text LIKE ?")
        args.append(f"%{query}%")
    if before:
        where.append("time < ?")
        args.append(float(before))
    sql_where = ("WHERE " + " AND ".join(where)) if where else ""
    rows = sq(f"SELECT time, kind, text, name FROM events {sql_where} ORDER BY time DESC LIMIT ?", (*args, int(limit)))
    return {"items": [{"time": t, "kind": k, "text": x, "name": n} for t, k, x, n in rows]}


def save_upload(name, kind, size, ms, result, account):
    """Store how long one file took. Never raises."""
    try:
        sq(
            "INSERT INTO uploads (time, name, kind, bytes, ms, result, account) VALUES (?,?,?,?,?,?,?)",
            (time.time(), name, kind, int(size), int(ms), result, account),
        )
    except Exception as e:
        print(f"Could not save upload time: {type(e).__name__}: {e}", file=sys.stderr, flush=True)


def _per(total, count):
    return total / count if count else 0


def insights(tz_offset_min=0):
    """Averages and patterns: upload time, file sizes, busiest hours and days, file types."""
    t = totals()
    lib = state["library"]
    offset = int(tz_offset_min) * 60
    kinds = {}
    for kind, n, size, ms, slow in sq(
        """SELECT kind, COUNT(*), COALESCE(SUM(bytes), 0), COALESCE(SUM(ms), 0), COALESCE(MAX(ms), 0)
           FROM uploads WHERE result='uploaded' GROUP BY kind"""
    ):
        kinds[kind] = {"files": n, "bytes": size, "ms": ms, "max_ms": slow}
    hours = [0] * 24
    for h, n in sq(
        "SELECT CAST((time + ?) / 3600 AS INTEGER) % 24 AS h, COUNT(*) FROM uploads WHERE result='uploaded' GROUP BY h",
        (offset,),
    ):
        hours[int(h)] = n
    weekdays = [0] * 7  # Monday first
    for d, n in sq(
        """SELECT (CAST((time + ?) / 86400 AS INTEGER) + 3) % 7 AS d, COUNT(*)
           FROM uploads WHERE result='uploaded' GROUP BY d""",
        (offset,),
    ):
        weekdays[int(d)] = n

    def rows(sql):
        return [{"time": tm, "name": n, "kind": k, "bytes": b, "ms": ms} for tm, n, k, b, ms in sq(sql)]

    total_ms = t["photo_ms"] + t["video_ms"]
    uploaded = t["photos"] + t["videos"]
    timed = sum(k["files"] for k in kinds.values())
    timed_bytes = sum(k["bytes"] for k in kinds.values())
    timed_ms = sum(k["ms"] for k in kinds.values())
    return {
        "upload_ms": total_ms,
        "uploaded": uploaded,
        "timed_files": timed,  # files with a recorded upload time
        "avg_ms": _per(timed_ms, timed),
        "avg_speed": _per(timed_bytes, timed_ms / 1000),  # bytes per second while uploading
        "photo": {
            "avg_ms": _per(kinds.get("photo", {}).get("ms", 0), kinds.get("photo", {}).get("files", 0)),
            "max_ms": kinds.get("photo", {}).get("max_ms", 0),
            "avg_bytes": _per(lib.get("photo_bytes", 0), lib.get("photos", 0)),
            "avg_uploaded_bytes": _per(t["photo_bytes"], t["photos"]),
            "files": lib.get("photos", 0),
            "bytes": lib.get("photo_bytes", 0),
        },
        "video": {
            "avg_ms": _per(kinds.get("video", {}).get("ms", 0), kinds.get("video", {}).get("files", 0)),
            "max_ms": kinds.get("video", {}).get("max_ms", 0),
            "avg_bytes": _per(lib.get("video_bytes", 0), lib.get("videos", 0)),
            "avg_uploaded_bytes": _per(t["video_bytes"], t["videos"]),
            "files": lib.get("videos", 0),
            "bytes": lib.get("video_bytes", 0),
        },
        "types": sorted(
            ({"ext": e, "files": n, "bytes": b} for e, (n, b) in lib.get("types", {}).items()),
            key=lambda x: -x["bytes"],
        ),
        "by_hour": hours,
        "by_weekday": weekdays,
        "largest": rows(
            "SELECT time, name, kind, bytes, ms FROM uploads WHERE result='uploaded' ORDER BY bytes DESC LIMIT 5"
        ),
        "slowest": rows(
            "SELECT time, name, kind, bytes, ms FROM uploads WHERE result='uploaded' ORDER BY ms DESC LIMIT 5"
        ),
        "tz_offset_min": int(tz_offset_min),
    }


# ---------------------------------------------------------------- app log (everything printed)


class LogTee:
    """Copies printed lines to the logs table, a few at a time from a background thread."""

    def __init__(self, stream, level):
        self.stream, self.level = stream, level
        self.buf = ""

    def write(self, text):
        self.stream.write(text)
        self.buf += text
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            line = LOG_STAMP.sub("", line, count=1)  # the time is stored separately
            if line.strip():
                pending_logs.append((time.time(), self.level, line[:2000]))
        return len(text)

    def flush(self):
        self.stream.flush()

    def __getattr__(self, name):
        return getattr(self.stream, name)


pending_logs = collections.deque(maxlen=5000)
LOG_STAMP = re.compile(r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d ")


def flush_logs():
    rows = []
    while pending_logs:
        rows.append(pending_logs.popleft())
    if not rows:
        return
    try:
        with stats_lock:
            for row in rows:
                STATS.execute("INSERT INTO logs (time, level, text) VALUES (?,?,?)", row)
            STATS.commit()
    except Exception as e:
        sys.__stdout__.write(f"Could not save the log: {type(e).__name__}: {e}\n")  # not to the log: no loop


def log_writer():
    while True:
        time.sleep(2)
        flush_logs()


def app_logs(level="all", query="", before=None, limit=200):
    where, args = [], []
    if level in ("info", "error"):
        where.append("level = ?")
        args.append(level)
    if query:
        where.append("text LIKE ?")
        args.append(f"%{query}%")
    if before:
        where.append("time < ?")
        args.append(float(before))
    sql_where = ("WHERE " + " AND ".join(where)) if where else ""
    rows = sq(f"SELECT time, level, text FROM logs {sql_where} ORDER BY time DESC LIMIT ?", (*args, int(limit)))
    return {"items": [{"time": t, "level": lv, "text": x} for t, lv, x in rows]}


# ---------------------------------------------------------------- per-minute metrics


def save_minute(minute, up, down, cpu, mem, ms):
    try:
        sq(
            "INSERT OR REPLACE INTO samples (minute, up, down, cpu, mem, latency) VALUES (?,?,?,?,?,?)",
            (int(minute), up, down, cpu, int(mem), ms),
        )
    except Exception as e:
        print(f"Could not save metrics: {type(e).__name__}: {e}", file=sys.stderr, flush=True)


def minute_sampler():
    """Every minute: store averages from the live samplers. Once a day: drop old history."""
    last_prune = time.time()
    while True:
        time.sleep(60 - time.time() % 60 + 0.5)
        now = time.time()

        def avg(d, n=60):
            vals = list(d)[-n:]
            return sum(vals) / len(vals) if vals else 0

        recent = [ms for t, ms in latency if ms is not None and now - t < 90]
        save_minute(
            now // 60 - 1,
            avg(net["up"]),
            avg(net["down"]),
            avg(res["cpu"]),
            avg(res["mem"]),
            sum(recent) / len(recent) if recent else None,
        )
        if now - last_prune > 86400:
            init_events()
            last_prune = now


def metrics(hours=24):
    """Per-minute history grouped so about 240 points come back."""
    hours = max(1, min(int(hours), SAMPLE_DAYS * 24))
    step = max(1, hours * 60 // 240)  # minutes per point
    first = int(time.time() // 60) - hours * 60
    rows = sq(
        """SELECT minute / ? * ? AS m, AVG(up), MAX(up), AVG(down), MAX(down), AVG(cpu), AVG(mem), AVG(latency)
           FROM samples WHERE minute >= ? GROUP BY m ORDER BY m""",
        (step, step, first),
    )
    keys = ("up", "up_max", "down", "down_max", "cpu", "mem", "latency")
    return {
        "hours": hours,
        "step_min": step,
        "points": [{"time": m * 60, **dict(zip(keys, vals, strict=True))} for m, *vals in rows],
    }


def migrate_stats():
    """Move statistics kept in state.db by version 1.0.3 into the Turso database."""
    with db_lock:
        has_old = CONN.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hourly'").fetchone()
        rows = CONN.execute("SELECT * FROM hourly").fetchall() if has_old else []
    if not has_old:
        return
    cols = ", ".join(("hour", *STAT_COLUMNS, "peak_up", "peak_down"))
    with stats_lock:
        for row in rows:
            STATS.execute(f"INSERT OR REPLACE INTO hourly ({cols}) VALUES ({', '.join('?' * len(row))})", row)
        STATS.commit()
    with db_lock:
        CONN.execute("DROP TABLE hourly")
        CONN.commit()


def add_stats(when=None, peak_up=0.0, peak_down=0.0, **counts):
    """Add counts to the hour containing `when` (default now) and raise its peak speeds.

    Never raises: statistics must not interrupt uploads."""
    try:
        _add_stats(when, peak_up, peak_down, **counts)
    except Exception as e:
        print(f"Could not save statistics: {type(e).__name__}: {e}", file=sys.stderr, flush=True)


def _add_stats(when, peak_up, peak_down, **counts):
    hour = int((when or time.time()) // 3600)
    cols = [c for c in counts if c in STAT_COLUMNS]
    sq(
        f"""INSERT INTO hourly (hour, {", ".join([*cols, "peak_up", "peak_down"])})
            VALUES (?{", ?" * (len(cols) + 2)})
            ON CONFLICT(hour) DO UPDATE SET {"".join(f"{c}={c}+excluded.{c}, " for c in cols)}
            peak_up=MAX(peak_up, excluded.peak_up), peak_down=MAX(peak_down, excluded.peak_down)""",
        (hour, *(int(counts[c]) for c in cols), peak_up, peak_down),
    )


def backfill_stats():
    """Once: build daily history from uploads made before statistics existed."""
    if meta_get("stats_backfilled"):
        return
    rows = q("SELECT path, size, status, updated FROM files WHERE status IN ('uploaded','exists') AND updated")
    for path, size, status, updated in rows:
        if status == "exists":
            add_stats(updated, existing=1)
        elif ext(path) in VIDEO_EXTS:
            add_stats(updated, videos=1, video_bytes=size)
        else:
            add_stats(updated, photos=1, photo_bytes=size)
    meta_set("stats_backfilled", "1")


def history(days=365, tz_offset_min=0):
    """Daily totals for the last `days` days, in the viewer's time zone (offset east of UTC, minutes)."""
    offset = int(tz_offset_min) * 60
    today = int((time.time() + offset) // 86400)
    first = today - int(days) + 1
    sums = ", ".join(f"SUM({c})" for c in STAT_COLUMNS)
    rows = sq(
        f"""SELECT (hour * 3600 + ?) / 86400 AS d, {sums}, MAX(peak_up), MAX(peak_down)
            FROM hourly WHERE hour * 3600 + ? >= ? * 86400 GROUP BY d ORDER BY d""",
        (offset, offset, first),
    )
    out = []
    for d, *vals in rows:
        day = time.strftime("%Y-%m-%d", time.gmtime(d * 86400))
        out.append({"day": day, **dict(zip((*STAT_COLUMNS, "peak_up", "peak_down"), vals, strict=True))})
    return {
        "days": int(days),
        "tz_offset_min": int(tz_offset_min),
        "first": time.strftime("%Y-%m-%d", time.gmtime(first * 86400)),
        "today": time.strftime("%Y-%m-%d", time.gmtime(today * 86400)),
        "data": out,
    }


def totals():
    sums = ", ".join(f"COALESCE(SUM({c}), 0)" for c in STAT_COLUMNS)
    row = sq(f"SELECT {sums}, COALESCE(MAX(peak_up), 0), COALESCE(MIN(hour), 0) FROM hourly")[0]
    return {**dict(zip((*STAT_COLUMNS, "peak_up"), row[:-1], strict=True)), "since": row[-1] * 3600}


# ---------------------------------------------------------------- network speed


def read_net_counters():
    """Total bytes received and sent on this container's network (all but loopback)."""
    rx = tx = 0
    try:
        with open("/proc/net/dev") as f:
            for line in f.readlines()[2:]:
                name, data = line.split(":", 1)
                if name.strip() == "lo":
                    continue
                fields = data.split()
                rx += int(fields[0])
                tx += int(fields[8])
    except OSError:
        pass
    return rx, tx


# Nobody is watching and nothing is uploading: sample less often to save CPU.
IDLE_STEP = 5
viewers = {"streams": 0, "last_request": 0.0}
watched_event = threading.Event()  # set when a dashboard shows up, so samplers speed up at once


def watched():
    """True while a dashboard is open (a live stream or a request in the last 20 s)."""
    return viewers["streams"] > 0 or time.time() - viewers["last_request"] < 20


def saw_viewer():
    was = watched()
    viewers["last_request"] = time.time()
    if not was:
        watched_event.set()


def sample_step():
    return 1 if watched() or state["phase"] in ("uploading", "scanning") else IDLE_STEP


def pause_for(seconds):
    """Sleep, but wake early when a dashboard opens."""
    if watched_event.wait(seconds):
        watched_event.clear()


def _repeat(d, value, n):
    for _ in range(n):
        d.append(value)


def sampler():
    """Network speed, CPU, memory and disk: every second while watched or busy, else every 5 s.

    Slow samples are repeated so each chart point still stands for one second."""
    prev_rx, prev_tx = read_net_counters()
    prev_cpu, prev_io = read_cpu_seconds(), read_io()
    prev_t = last_flush = time.time()
    pending = {"net_sent": 0, "net_received": 0, "peak_up": 0.0, "peak_down": 0.0}
    while True:
        pause_for(sample_step())
        rx, tx = read_net_counters()
        cpu, io = read_cpu_seconds(), read_io()
        now = time.time()
        dt = max(now - prev_t, 0.001)
        n = max(1, min(round(dt), NET_HISTORY))
        got, sent = max(rx - prev_rx, 0), max(tx - prev_tx, 0)
        _repeat(net["down"], got / dt, n)
        _repeat(net["up"], sent / dt, n)
        net["received"] += got
        net["sent"] += sent
        pending["net_received"] += got
        pending["net_sent"] += sent
        pending["peak_up"] = max(pending["peak_up"], sent / dt)
        pending["peak_down"] = max(pending["peak_down"], got / dt)
        used, limit = read_memory()
        _repeat(res["cpu"], max(cpu - prev_cpu, 0) / dt * 100, n)
        _repeat(res["mem"], used, n)
        _repeat(res["read"], max(io[0] - prev_io[0], 0) / dt, n)
        _repeat(res["write"], max(io[1] - prev_io[1], 0) / dt, n)
        res["mem_limit"] = limit
        prev_rx, prev_tx, prev_cpu, prev_io, prev_t = rx, tx, cpu, io, now
        # Write once a minute, and when the hour changes so traffic lands in the right hour.
        if now - last_flush >= 60 or int(now // 3600) != int(last_flush // 3600):
            add_stats(last_flush if int(now // 3600) != int(last_flush // 3600) else now, **pending)
            pending = dict.fromkeys(pending, 0)
            last_flush = now


# ---------------------------------------------------------------- resources and Google latency

res = {
    "cpu": collections.deque(maxlen=NET_HISTORY),  # percent of one core
    "mem": collections.deque(maxlen=NET_HISTORY),  # bytes
    "read": collections.deque(maxlen=NET_HISTORY),  # disk bytes per second
    "write": collections.deque(maxlen=NET_HISTORY),
    "mem_limit": 0,
    "cores": os.cpu_count() or 1,
}
latency = collections.deque(maxlen=120)  # (unix time, milliseconds or None) every 30 s
LATENCY_HOST = ("photos.googleapis.com", 443)
CGROUP = Path("/sys/fs/cgroup")


def _read(path):
    try:
        return Path(path).read_text()
    except OSError:
        return ""


def read_cpu_seconds():
    """CPU time used by this container (cgroup v2), or by this process."""
    for line in _read(CGROUP / "cpu.stat").splitlines():
        if line.startswith("usage_usec "):
            return int(line.split()[1]) / 1e6
    fields = _read("/proc/self/stat").rsplit(")", 1)[-1].split()
    return (int(fields[11]) + int(fields[12])) / os.sysconf("SC_CLK_TCK") if len(fields) > 12 else 0.0


def read_memory():
    """(bytes used, limit in bytes) for this container, or for this process and the machine."""
    used = _read(CGROUP / "memory.current").strip()
    limit = _read(CGROUP / "memory.max").strip()
    if used.isdigit():
        # Like `docker stats`: leave out file cache the kernel can drop at any time.
        for line in _read(CGROUP / "memory.stat").splitlines():
            if line.startswith("inactive_file "):
                used = str(max(0, int(used) - int(line.split()[1])))
                break
    total = 0
    for line in _read("/proc/meminfo").splitlines():
        if line.startswith("MemTotal:"):
            total = int(line.split()[1]) * 1024
    if not used.isdigit():
        for line in _read("/proc/self/status").splitlines():
            if line.startswith("VmRSS:"):
                used = str(int(line.split()[1]) * 1024)
    return int(used or 0), int(limit) if limit.isdigit() else total


def read_io():
    """Total bytes read and written to disk by this container (or process)."""
    rd = wr = 0
    stat = _read(CGROUP / "io.stat")
    if stat:
        for line in stat.splitlines():
            for part in line.split()[1:]:
                k, _, v = part.partition("=")
                if k == "rbytes":
                    rd += int(v)
                elif k == "wbytes":
                    wr += int(v)
        return rd, wr
    for line in _read("/proc/self/io").splitlines():
        k, _, v = line.partition(":")
        if k == "read_bytes":
            rd = int(v)
        elif k == "write_bytes":
            wr = int(v)
    return rd, wr


def measure_latency(host=LATENCY_HOST, timeout=5):
    """Milliseconds to open a connection to Google Photos (DNS + TCP), or None if it fails."""
    start = time.perf_counter()
    try:
        with socket.create_connection(host, timeout=timeout):
            return (time.perf_counter() - start) * 1000
    except OSError:
        return None


def latency_sampler():
    """Every 30 s while a dashboard is open or uploads run, every 5 min otherwise."""
    while True:
        latency.append((time.time(), measure_latency()))
        busy = watched() or state["phase"] == "uploading"
        deadline = time.time() + (30 if busy else 300)
        while time.time() < deadline:
            pause_for(max(1, deadline - time.time()))
            if watched() and deadline - time.time() > 30:
                break  # a dashboard just opened: measure now


def resources_json():
    def last(d):
        return d[-1] if d else 0

    ok = [ms for _, ms in latency if ms is not None]
    return {
        # Rounded: the live view sends this every couple of seconds, so it should be small.
        "cpu": [round(v, 1) for v in res["cpu"]],
        "mem": [int(v) for v in res["mem"]],
        "read": [int(v) for v in res["read"]],
        "write": [int(v) for v in res["write"]],
        "cpu_now": round(last(res["cpu"]), 1),
        "mem_now": int(last(res["mem"])),
        "read_now": int(last(res["read"])),
        "write_now": int(last(res["write"])),
        "mem_limit": res["mem_limit"],
        "cores": res["cores"],
        "latency": [{"time": int(t), "ms": None if ms is None else round(ms, 1)} for t, ms in latency],
        "latency_now": latency[-1][1] if latency else None,
        "latency_avg": sum(ok) / len(ok) if ok else None,
    }


# ---------------------------------------------------------------- schedule and speed limit


def local_hour(st, now=None):
    return int(((now or time.time()) + st["tz_offset_min"] * 60) // 3600) % 24


def upload_allowed(st=None, now=None):
    """True when the schedule lets uploads run now."""
    st = st or get_settings()
    s = st["schedule"]
    if not s["enabled"] or s["start"] == s["end"]:
        return True
    h = local_hour(st, now)
    return s["start"] <= h < s["end"] if s["start"] < s["end"] else (h >= s["start"] or h < s["end"])


def next_window(st=None, now=None):
    """Unix time when the upload window next opens (now if it is open)."""
    st = st or get_settings()
    now = now or time.time()
    if upload_allowed(st, now):
        return now
    t = (int(now) // 3600 + 1) * 3600
    for _ in range(25):
        if upload_allowed(st, t):
            return t
        t += 3600
    return now


class Throttle:
    """Sleeps inside gpmc's progress callback so the upload stays under the speed limit."""

    def __init__(self, mbps):
        self.rate = mbps * 1e6 / 8 if mbps else 0  # bytes per second
        self.start = None

    def __call__(self, bytes_done):
        if not self.rate:
            return
        if self.start is None:
            self.start = time.monotonic()
            return
        ahead = bytes_done / self.rate - (time.monotonic() - self.start)
        if ahead > 0:
            time.sleep(min(ahead, 2.0))


# ---------------------------------------------------------------- sync


def scan(st=None):
    """Count the library and return files that are new, changed or need another account.

    Returns [(path, size, mtime, account)] for files that finished copying."""
    st = st or get_settings()
    now = time.time()
    tmap = folder_targets(st)
    fmap = {t: (a[0] if a else "") for t, a in tmap.items()}
    known = {
        p: (s, m, status, a, acc)
        for p, s, m, status, a, acc in q("SELECT path,size,mtime,status,attempts,account FROM files")
    }
    known_copies = {
        (p, acc): (s, m, status, a)
        for p, acc, s, m, status, a in q("SELECT path,account,size,mtime,status,attempts FROM copies")
    }
    todo = []
    index = []
    copies_todo = []  # the same files for a folder's other accounts, after the main backup
    lib = {
        "files": 0,
        "bytes": 0,
        "synced_files": 0,
        "synced_bytes": 0,
        "photos": 0,
        "photo_bytes": 0,
        "videos": 0,
        "video_bytes": 0,
        "types": {},  # extension -> [files, bytes]
    }
    folders = {
        t: {
            "files": 0,
            "bytes": 0,
            "synced_files": 0,
            "synced_bytes": 0,
            "account": a,
            "accounts": tmap[t],
            "copies": dict.fromkeys(tmap[t][1:], 0),  # extra account -> files copied there
        }
        for t, a in fmap.items()
    }
    for top, account in fmap.items():
        for root, dirs, names in os.walk(MEDIA / top):
            dirs[:] = sorted(d for d in dirs if not skipped(d))
            for name in sorted(names):
                if ext(name) not in EXTS or skipped(name):
                    continue
                path = os.path.join(root, name)
                try:
                    fst = os.stat(path)
                except OSError:
                    continue
                if fst.st_size == 0:
                    continue
                f = folders[top]
                f["files"] += 1
                f["bytes"] += fst.st_size
                row = known.get(path)
                index.append(
                    (
                        rel(path),
                        ext(name) in VIDEO_EXTS,
                        fst.st_size,
                        added_time(fst),
                        bool(account)
                        and bool(row)
                        and row[0] == fst.st_size
                        and row[1] == fst.st_mtime
                        and row[2] in DONE
                        and row[4] in (account, None),
                    )
                )
                if not account:
                    continue  # folder not backed up
                lib["files"] += 1
                lib["bytes"] += fst.st_size
                e = ext(name)
                kind = "video" if e in VIDEO_EXTS else "photo"
                lib[kind + "s"] += 1
                lib[kind + "_bytes"] += fst.st_size
                t = lib["types"].setdefault(e, [0, 0])
                t[0] += 1
                t[1] += fst.st_size
                settled = now - fst.st_mtime >= SETTLE
                for extra in tmap[top][1:]:
                    c = known_copies.get((path, extra))
                    if c and c[0] == fst.st_size and c[1] == fst.st_mtime:
                        if c[2] in DONE:
                            f["copies"][extra] += 1
                            continue
                        if c[3] >= MAX_ATTEMPTS:
                            continue
                    elif c:  # file changed: copy it again
                        q("UPDATE copies SET attempts=0 WHERE path=? AND account=?", (path, extra))
                    if settled:
                        copies_todo.append((path, fst.st_size, fst.st_mtime, extra, True))
                if row and row[0] == fst.st_size and row[1] == fst.st_mtime and row[4] in (account, None):
                    if row[2] in DONE:
                        for d in (lib, f):
                            d["synced_files"] += 1
                            d["synced_bytes"] += fst.st_size
                        continue
                    if row[3] >= MAX_ATTEMPTS:
                        continue
                elif row:  # file changed, or its folder moved to another account: start over
                    q("UPDATE files SET attempts=0 WHERE path=?", (path,))
                if now - fst.st_mtime < SETTLE:
                    continue
                todo.append((path, fst.st_size, fst.st_mtime, account))
    state["library"] = lib
    state["folders"] = folders
    state["index"] = index
    state["pending"] = [rel(p) for p, *_ in todo[:500]]
    state["copies_pending"] = len(copies_todo)
    return todo + copies_todo


def added_time(fst):
    """When a file arrived on this machine. mtime is often the photo's own date (kept by
    copy tools), so use the inode change time when it is later."""
    return max(fst.st_mtime, fst.st_ctime)


def clean_folder(path):
    """A folder path from the dashboard ("Photos/iPhone"), or None when it isn't safe."""
    parts = [p for p in str(path or "").replace("\\", "/").split("/") if p]
    if any(p in (".", "..") or skipped(p) for p in parts):
        return None
    return "/".join(parts)


def _device_name(folder):
    """Folders for the same phone get numbered when it pairs again ("I2220 (2)")."""
    return re.sub(r" \(\d+\)$", "", folder)


def _blank():
    return {"photos": 0, "videos": 0, "photo_bytes": 0, "video_bytes": 0, "synced": 0, "new": 0, "last_added": 0}


def folder_report(path="", group="folders", days=30, tz_offset_min=0, now=None):
    """Counts for any folder: totals, files added per day, and the same per subfolder.

    group="devices" lists the folders one level inside each backed-up top folder (where
    phone backup apps put one folder per device), merged by device name."""
    now = now or time.time()
    shift = tz_offset_min * 60
    today = int((now + shift) // 86400)
    first = today - days + 1
    index = state["index"]
    total = _blank()
    daily = {}  # day number -> [photos, videos]
    groups = {}
    if group == "devices":
        backed = {t for t, a in folder_targets().items() if a}
        uploads = upload_folder_name()

        def key_of(name):
            parts = name.split("/")
            if len(parts) < 3 or parts[0] not in backed:
                return None
            folder = f"{parts[0]}/{parts[1]}"
            return (_device_name(parts[1]), folder)
    else:
        prefix = path + "/" if path else ""
        depth = len(prefix.split("/")) - 1 if prefix else 0

        def key_of(name):
            if not name.startswith(prefix):
                return None
            parts = name.split("/")
            sub = parts[depth] if len(parts) > depth + 1 else ""
            return (sub, prefix + sub if sub else path)

    for name, video, size, added, synced in index:
        k = key_of(name)
        if k is None:
            continue
        label, folder = k
        g = groups.get(label)
        if g is None:
            g = groups[label] = {**_blank(), "folders": set(), "sub": False, "daily": {}}
        g["folders"].add(folder)
        if label and name.count("/") > folder.count("/") + 1:
            g["sub"] = True  # has folders inside: the dashboard can open it
        for d in (total, g):
            d["videos" if video else "photos"] += 1
            d["video_bytes" if video else "photo_bytes"] += size
            d["synced"] += synced
            d["last_added"] = max(d["last_added"], added)
        day = int((added + shift) // 86400)
        if day >= first:
            total["new"] += 1
            g["new"] += 1
            daily.setdefault(day, [0, 0])[video] += 1
            g["daily"][day] = g["daily"].get(day, 0) + 1

    def day_str(n):
        return time.strftime("%Y-%m-%d", time.gmtime(n * 86400))

    def week(d):
        return sum(c for day, c in d.items() if day > today - 7)

    children = []
    for label, g in groups.items():
        files = g["photos"] + g["videos"]
        children.append(
            {
                "name": label,
                "folders": sorted(g["folders"]),
                "has_sub": g["sub"],
                "files": files,
                "photos": g["photos"],
                "videos": g["videos"],
                "bytes": g["photo_bytes"] + g["video_bytes"],
                "synced": g["synced"],
                "new": g["new"],
                "new_week": week(g["daily"]),
                "last_added": g["last_added"],
                "series": [g["daily"].get(n, 0) for n in range(first, today + 1)],
                "uploads": group == "devices" and uploads in g["folders"],
            }
        )
    children.sort(key=lambda c: (c["name"] == "", -c["files"], c["name"].lower()))
    return {
        "ready": bool(state["last_scan"]),
        "path": path if group == "folders" else "",
        "group": group,
        "days": days,
        "today": day_str(today),
        "total": {
            **{k: total[k] for k in ("photos", "videos", "photo_bytes", "video_bytes", "synced", "new")},
            "files": total["photos"] + total["videos"],
            "bytes": total["photo_bytes"] + total["video_bytes"],
            "new_week": sum(p + v for day, (p, v) in daily.items() if day > today - 7),
            "new_day": sum(p + v for day, (p, v) in daily.items() if day == today),
            "last_added": total["last_added"],
        },
        "daily": [
            {"day": day_str(n), "photos": daily.get(n, [0, 0])[0], "videos": daily.get(n, [0, 0])[1]}
            for n in range(first, today + 1)
        ],
        "children": children,
    }


def outage_kind(e):
    """Return a message if the error is about the login, network or Google, not the file."""
    import requests

    if isinstance(e, requests.HTTPError) and e.response is not None:
        code = e.response.status_code
        if code in (401, 403):
            return "Google rejected the login. Paste a fresh androidId= line."
        if code == 429 or code >= 500:
            return f"Google is busy or down (HTTP {code}). Will retry next scan."
    if isinstance(e, (requests.ConnectionError, requests.Timeout)):
        return "No connection to Google. Will retry next scan."
    if any(s in str(e) for s in ("BadAuthentication", "NeedsBrowser")):
        return "Google rejected the login. Paste a fresh androidId= line."
    return ""


def album_name(path, mode):
    """Album for a file: "top" = first folder below the top-level folder, "parent" = the file's own folder."""
    parts = rel(path).split("/")[:-1]
    if mode == "off" or not parts:
        return None
    if mode == "top":
        return parts[1] if len(parts) > 1 else parts[0]
    return parts[-1]


def flush_albums(client, account, queued):
    """Add uploaded media to their albums, creating albums the first time."""
    for name, keys in list(queued.items()):
        if not keys:
            continue
        row = q("SELECT album_key FROM albums WHERE account=? AND name=?", (account, name))
        try:
            try:
                if not row:
                    raise LookupError
                client.api.add_media_to_album(album_media_key=row[0][0], media_keys=keys)
            except Exception:  # no album yet, or it was deleted in Google Photos: make a new one
                key = client.api.create_album(album_name=name, media_keys=keys)
                q("INSERT OR REPLACE INTO albums VALUES (?,?,?)", (account, name, key))
            log(f"Added {len(keys)} item(s) to album {name}", "album")
        except Exception as e:
            log(f"Could not update album {name}: {type(e).__name__}: {e}", "error")
        queued[name] = []


def alert(title, message, tags="", event=None):
    cfg = get_settings()["notify"]
    if event and not cfg.get(event, True):
        return
    notify.send(cfg, title, message, tags, on_done=lambda r: _alert_result(title, r))


def _alert_result(title, result):
    bad = {k: v for k, v in result.items() if v != "ok"}
    if bad:
        log(f"Alert '{title}' failed: {bad}", "error")


def upload_all(client, todo, account="", st=None):
    """Upload files for one account. Stops early for pause, schedule or outages."""
    from rich.progress import Progress

    st = st or get_settings()
    if not account and todo and len(todo[0]) > 3:
        account = todo[0][3]  # every item in one call belongs to the same account
    state.update(phase="uploading", done=0, total=len(todo))
    queued = collections.defaultdict(list)
    round_files = round_bytes = 0
    try:
        for path, size, mtime, *rest in todo:
            copy = len(rest) > 1 and rest[1]  # another account's copy, not the folder's main backup
            if PAUSE_FILE.exists():
                log("Paused", "pause")
                return
            if not upload_allowed(st):
                log("Upload window closed; continuing when it opens", "pause")
                return
            name = rel(path)
            cur = {
                "name": name,
                "bytes_done": 0,
                "bytes_total": size,
                "step": "hashing",
                "kind": "video" if ext(name) in VIDEO_EXTS else "photo",
                "account": account,
            }
            state["current"] = cur
            phases = []
            throttle = Throttle(st["speed_limit_mbps"])
            started = time.monotonic()

            def progress(ev, cur=cur, phases=phases, throttle=throttle):
                phase = ev.get("phase")
                phases.append(phase)
                cur["step"] = phase
                if phase == "uploading":
                    cur["bytes_done"] = ev.get("bytes_completed") or 0
                    throttle(cur["bytes_done"])

            try:
                digest = media.sha1_file(path, on_progress=lambda n, cur=cur: cur.update(bytes_done=n))
                cur.update(step="checking", bytes_done=0)
                # Single-file upload raises on failure; the batch upload() only logs errors.
                # gpmc is pinned in pyproject.toml, so this internal method stays stable.
                with Progress(disable=True) as bar:
                    result = client._upload_file(
                        Path(path), digest, bar, force_upload=False, use_quota=False, saver=False,
                        progress_callback=progress,
                    )  # fmt: skip
                key = next(iter(result.values()), "")
                if not key:
                    raise RuntimeError("Google returned no media key")
                status = "exists" if "skipped" in phases else "uploaded"
                if copy:
                    q(
                        """INSERT OR REPLACE INTO copies
                           (path, account, size, mtime, status, media_key, error, attempts, updated)
                           VALUES (?,?,?,?,?,?,'',0,?)""",
                        (path, account, size, mtime, status, key, time.time()),
                    )
                else:
                    q(
                        """INSERT OR REPLACE INTO files
                           (path, size, mtime, status, media_key, error, attempts, updated, account, sha1)
                           VALUES (?,?,?,?,?,'',0,?,?,?)""",
                        (path, size, mtime, status, key, time.time(), account, digest.hex()),
                    )
                    state["library"]["synced_files"] += 1
                    state["library"]["synced_bytes"] += size
                state["login_failed"].discard(account)
                if (album := album_name(path, st["albums"])) is not None:
                    queued[album].append(key)
                    if len(queued[album]) >= 100:
                        flush_albums(client, account, queued)
                ms = int((time.monotonic() - started) * 1000)
                save_upload(name, cur["kind"], size, ms, status, account)
                if status == "uploaded":
                    state["session"]["uploaded_files"] += 1
                    state["session"]["uploaded_bytes"] += size
                    round_files += 1
                    round_bytes += size
                    if cur["kind"] == "video":
                        add_stats(videos=1, video_bytes=size, video_ms=ms)
                    else:
                        add_stats(photos=1, photo_bytes=size, photo_ms=ms)
                    to = f" to {account}" if copy else ""
                    log(f"Uploaded {name}{to} ({fmt_bytes(size)} in {fmt_secs(ms / 1000)})", "uploaded", name)
                else:
                    add_stats(existing=1)
                    log(f"Already in Google Photos{f' ({account})' if copy else ''}: {name}", "exists", name)
            except Exception as e:
                err = f"{type(e).__name__}: {e}"[:500]
                problem = outage_kind(e)
                if problem:
                    # Not this file's fault: stop the round and try again later without
                    # using up the file's retries.
                    state["error"] = problem if not account else f"{account}: {problem}"
                    log(f"Stopped this round: {state['error']}", "error")
                    if "login" in problem and account not in state["login_failed"]:
                        state["login_failed"].add(account)
                        alert("GP Sync: login rejected", f"{account}: {problem}", "warning", "on_login")
                    return
                attempts = (
                    q(
                        """INSERT INTO copies (path,account,size,mtime,status,error,attempts,updated)
                       VALUES (?,?,?,?,'failed',?,1,?)
                       ON CONFLICT(path, account) DO UPDATE SET size=excluded.size, mtime=excluded.mtime,
                       status='failed', error=excluded.error, attempts=copies.attempts+1, updated=excluded.updated
                       RETURNING attempts""",
                        (path, account, size, mtime, err, time.time()),
                    )[0][0]
                    if copy
                    else q(
                        """INSERT INTO files (path,size,mtime,status,error,attempts,updated,account)
                       VALUES (?,?,?,'failed',?,1,?,?)
                       ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime, status='failed',
                       error=excluded.error, attempts=files.attempts+1, updated=excluded.updated,
                       account=excluded.account
                       RETURNING attempts""",
                        (path, size, mtime, err, time.time(), account),
                    )[0][0]
                )
                add_stats(failed=1)
                save_upload(name, cur["kind"], size, int((time.monotonic() - started) * 1000), "failed", account)
                log(f"Failed {name}{f' ({account})' if copy else ''}: {err}", "failed", name)
                if attempts >= MAX_ATTEMPTS:
                    alert("GP Sync: gave up on a file", f"{name}\n{err}", "x", "on_gave_up")
            finally:
                state["current"] = None
            state["done"] += 1
    finally:
        flush_albums(client, account, queued)
        if round_files and round_files >= st["notify"]["round_min"]:
            alert(
                "GP Sync: backup done",
                f"Uploaded {round_files} file(s), {fmt_bytes(round_bytes)}" + (f" to {account}" if account else ""),
                "white_check_mark",
                "on_round",
            )


def fmt_secs(secs):
    secs = round(secs)
    if secs < 60:
        return f"{max(secs, 1)} s"
    if secs < 3600:
        return f"{secs // 60} min {secs % 60} s"
    return f"{secs // 3600} h {secs % 3600 // 60} min"


def fmt_bytes(n):
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n} B"


def run_round():
    """One scan and, if allowed, uploads for every account."""
    from gpmc import Client  # imported here so the web page starts even if gpmc is broken

    st = get_settings()
    accs = dict(accounts())
    state["phase"] = "scanning"
    notify_change()
    todo = scan(st)
    state["last_scan"] = time.time()
    if not accs or PAUSE_FILE.exists():
        # Counted the library, but nothing is uploaded until an account is connected or uploads resume.
        state.update(phase="setup" if not accs else "paused")
        if not accs:
            state["error"] = ""
        notify_change()
        return
    if todo and not upload_allowed(st):
        state["phase"] = "scheduled"
        state["next_window"] = next_window(st)
        return
    if todo:
        log(f"Found {len(todo)} new file(s)", "scan")
        state["error"] = ""
        by_account = collections.defaultdict(list)
        for item in todo:
            by_account[item[3]].append(item)
        for account, items in by_account.items():
            if account in accs:
                upload_all(Client(auth_data=accs[account], log_level="WARNING"), items, account, st)
            if PAUSE_FILE.exists() or not upload_allowed(st):
                break
    state["phase"] = "paused" if PAUSE_FILE.exists() else "scheduled" if not upload_allowed(st) else "idle"
    if todo:
        background_work.set()
        media.release_memory()
    notify_change()


def weekly_summary(force=False, now=None):
    """Every Monday from 09:00 (viewer's time zone): last week's totals to the alert channels."""
    st = get_settings()
    if not (force or st["notify"]["weekly"]) or not notify.channels(st["notify"]):
        return None
    now = now or time.time()
    offset = st["tz_offset_min"] * 60
    local_day = int((now + offset) // 86400)
    monday = local_day - (local_day + 3) % 7  # 1970-01-01 was a Thursday
    due = monday * 86400 - offset + 9 * 3600
    if not force and (now < due or float(meta_get("weekly_sent") or 0) >= due):
        return None
    days = {d["day"]: d for d in history(8, st["tz_offset_min"])["data"]}
    week = [days.get(time.strftime("%Y-%m-%d", time.gmtime((monday - i) * 86400)), {}) for i in range(1, 8)]
    s = {c: sum(d.get(c, 0) for d in week) for c in STAT_COLUMNS}
    message = (
        f"Last week: {s['photos']} photos and {s['videos']} videos backed up "
        f"({fmt_bytes(s['photo_bytes'] + s['video_bytes'])}).\n"
        f"Network: {fmt_bytes(s['net_sent'])} sent, {fmt_bytes(s['net_received'])} received.\n"
        f"Library: {state['library']['synced_files']} of {state['library']['files']} files backed up."
    )
    meta_set("weekly_sent", str(now))
    alert("GP Sync: weekly summary", message, "bar_chart")
    return message


def worker():
    while True:
        try:
            run_round()
            weekly_summary()
        except Exception as e:
            state.update(phase="error", error=f"{type(e).__name__}: {e}")
            traceback.print_exc()
            log("Error: " + traceback.format_exc().strip().splitlines()[-1], "error")
        wait = INTERVAL
        if state["phase"] == "scheduled" and state["next_window"]:
            wait = max(30, min(INTERVAL, state["next_window"] - time.time() + 5))
        wake.wait(wait)
        wake.clear()


# ---------------------------------------------------------------- duplicates, thumbnails, health


IDLE_PHASES = ("idle", "setup", "scheduled", "paused")


def hash_some(limit=20):
    """Fingerprint up to `limit` uploaded files that have no SHA-1 yet. Returns how many were done."""
    rows = q(
        "SELECT path, size, mtime FROM files WHERE sha1 IS NULL AND status IN ('uploaded','exists') LIMIT ?",
        (limit,),
    )
    for path, size, mtime in rows:
        if state["phase"] not in IDLE_PHASES:
            break
        try:
            fst = os.stat(path)
            # Changed files get a fresh fingerprint when they are uploaded again.
            changed = fst.st_size != size or fst.st_mtime != mtime
            digest = "" if changed else media.sha1_file(path).hex()
        except OSError:
            digest = ""  # gone: mark so we don't retry forever
        q("UPDATE files SET sha1=? WHERE path=? AND sha1 IS NULL", (digest, path))
    return len(rows)


_thumbs_checked = set()  # files whose thumbnail exists (or can't be made), this run


def thumb_some(limit=12):
    """Make missing photo thumbnails ahead of time, so the Library scrolls without waiting.

    Returns how many were made."""
    made = 0
    for (path,) in q("SELECT path FROM files WHERE status IN ('uploaded','exists') ORDER BY updated DESC"):
        if path in _thumbs_checked or ext(path) not in THUMB_EXTS:
            continue
        if made >= limit or state["phase"] not in IDLE_PHASES:
            break
        name = rel(path)
        try:
            p = safe_media_path(name)
            if p and not media.thumb_path(THUMBS, str(p), p.stat().st_mtime).exists():
                thumbnail(name)
                made += 1
        except Exception as e:
            print(f"Thumbnail failed for {name}: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        _thumbs_checked.add(path)
    if made:
        media.release_memory()
    return made


def hasher():
    """When idle: make missing thumbnails, and fingerprint older uploads that have none yet so the
    duplicate finder sees them. Runs at low priority and backs off when there is nothing to do."""
    with contextlib.suppress(OSError, AttributeError):
        os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), 10)  # this thread only
    while True:
        busy = state["phase"] not in IDLE_PHASES  # check again soon
        try:
            if not busy:
                busy = thumb_some() > 0
                if get_settings()["hash_existing"]:
                    busy = hash_some() > 0 or busy
        except Exception as e:
            print(f"Hasher: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        background_work.wait(20 if busy else 600)
        background_work.clear()


def duplicates(limit=200):
    rows = q(
        """SELECT sha1, COUNT(*), MAX(size), GROUP_CONCAT(path, char(10)) FROM files
           WHERE sha1 IS NOT NULL AND sha1 != '' GROUP BY sha1 HAVING COUNT(*) > 1
           ORDER BY MAX(size) * (COUNT(*) - 1) DESC LIMIT ?""",
        (limit,),
    )
    groups = [
        {"sha1": h, "count": n, "size": size, "wasted": size * (n - 1), "files": [rel(p) for p in paths.split("\n")]}
        for h, n, size, paths in rows
    ]
    hashed, total = q(
        "SELECT SUM(sha1 IS NOT NULL AND sha1 != ''), COUNT(*) FROM files WHERE status IN ('uploaded','exists')"
    )[0]
    return {"groups": groups, "wasted": sum(g["wasted"] for g in groups), "hashed": hashed or 0, "total": total}


def safe_media_path(name):
    """Resolve a dashboard file name to a real path inside the media folder, or None."""
    try:
        p = (MEDIA / name).resolve()
        root = MEDIA.resolve()
    except (OSError, ValueError):
        return None
    if root not in p.parents or not p.is_file() or ext(p.name) not in EXTS:
        return None
    return p


def thumbnail(name):
    """Path of a cached WebP thumbnail for a media file, made on first request."""
    p = safe_media_path(name)
    if not p:
        return None
    mtime = p.stat().st_mtime
    target = media.thumb_path(THUMBS, str(p), mtime)
    if target.exists():
        return target
    if ext(p.name) in THUMB_EXTS:
        return media.make_thumbnail(p, target)
    # Videos: ask Google for its thumbnail of the uploaded copy.
    row = q("SELECT media_key, account FROM files WHERE path=? AND media_key IS NOT NULL", (str(MEDIA / name),))
    accs = dict(accounts())
    if row and row[0][1] in accs:
        from gpmc.api import Api

        data = Api(accs[row[0][1]]).get_thumbnail(row[0][0], width=media.THUMB_SIZE)
        return media.save_bytes(data, target)
    return None


def google_thumb(name):
    """Thumbnail of an item that is only in Google (for the storage page)."""
    account, _, key = name.partition("\n")
    auth = dict(accounts()).get(account)
    if not auth or not re.fullmatch(r"[\w-]+", key):
        return None
    target = THUMBS / "google" / f"{hashlib.sha1(name.encode()).hexdigest()}.webp"
    if target.exists():
        return target
    from gpmc.api import Api

    return media.save_bytes(Api(auth).get_thumbnail(key, width=media.THUMB_SIZE), target)


PREVIEW_SIZE = 1600
MEDIA_TYPES = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp",
    "avif": "image/avif", "bmp": "image/bmp", "heic": "image/heic", "heif": "image/heif", "tif": "image/tiff",
    "tiff": "image/tiff", "mp4": "video/mp4", "m4v": "video/mp4", "mov": "video/quicktime", "webm": "video/webm",
    "mkv": "video/x-matroska", "3gp": "video/3gpp", "avi": "video/x-msvideo",
}  # fmt: skip


def preview(name):
    """A large WebP of a photo for the viewer (cached like thumbnails), or None."""
    p = safe_media_path(name)
    if not p or ext(p.name) not in THUMB_EXTS:
        return None
    target = media.thumb_path(THUMBS, str(p), f"{p.stat().st_mtime}-{PREVIEW_SIZE}")
    return target if target.exists() else media.make_thumbnail(p, target, PREVIEW_SIZE, 82)


def file_info(name):
    """Everything known about one file: on disk, in the upload state and in recent activity."""
    p = safe_media_path(name)
    full = str(MEDIA / name)
    row = q("SELECT size, status, media_key, account, updated, error, attempts, sha1 FROM files WHERE path=?", (full,))
    size, status, key, account, updated, error, attempts, sha1 = row[0] if row else (None,) * 8
    st = p.stat() if p else None
    timing = sq("SELECT time, ms, result FROM uploads WHERE name=? ORDER BY time DESC LIMIT 1", (name,))
    events = sq("SELECT time, kind, text FROM events WHERE name=? ORDER BY time DESC LIMIT 20", (name,))
    return {
        "name": name,
        "exists": bool(p),
        "kind": "video" if ext(name) in VIDEO_EXTS else "photo",
        "size": st.st_size if st else size,
        "modified": st.st_mtime if st else None,
        "status": status or ("waiting" if p else "missing"),
        "account": account or folder_map().get(top_folder(full), ""),
        "updated": updated,
        "error": error or "",
        "attempts": attempts or 0,
        "max_attempts": MAX_ATTEMPTS,
        "sha1": sha1 or "",
        "google_url": f"https://photos.google.com/photo/{key}" if key else "",
        "upload_ms": timing[0][1] if timing else None,
        "history": [{"time": t, "kind": k, "text": x} for t, k, x in events],
        "previewable": ext(name) in THUMB_EXTS,
        "playable": ext(name) in ("mp4", "m4v", "mov", "webm"),
    }


def retry_file(name):
    """Try one failed file again at the next scan."""
    n = q("UPDATE files SET attempts=0 WHERE path=? AND status='failed' RETURNING path", (str(MEDIA / name),))
    if n:
        log(f"Retrying {name}", "info", name)
        wake.set()
    return bool(n)


def list_files(query="", status="all", folder="", sort="new", limit=60, offset=0):
    where, args = [], []
    if query:
        where.append("path LIKE ?")
        args.append(f"%{query}%")
    if status in ("uploaded", "exists", "failed"):
        where.append("status=?")
        args.append(status)
    if folder:
        where.append("path LIKE ?")
        args.append(f"{MEDIA}/{folder}/%")
    order = {"new": "updated DESC", "old": "updated ASC", "name": "path ASC", "size": "size DESC"}.get(
        sort, "updated DESC"
    )
    sql_where = ("WHERE " + " AND ".join(where)) if where else ""
    total = q(f"SELECT COUNT(*) FROM files {sql_where}", args)[0][0]
    rows = q(
        f"""SELECT path, size, status, media_key, account, updated, error, attempts, mtime FROM files {sql_where}
            ORDER BY {order} LIMIT ? OFFSET ?""",
        (*args, int(limit), int(offset)),
    )
    items = [
        {
            "name": rel(p),
            "size": size,
            "status": s,
            "kind": "video" if ext(p) in VIDEO_EXTS else "photo",
            "account": acc,
            "updated": t,
            "error": err,
            "attempts": att,
            "google_url": f"https://photos.google.com/photo/{key}" if key else "",
            "mtime": int(mt or 0),
        }
        for p, size, s, key, acc, t, err, att, mt in rows
    ]
    return {"total": total, "items": items}


def check_logins():
    """Ask Google for a token with each saved login. Returns {email: "ok" or error}."""
    from gpmc.api import Api

    out = {}
    for email, auth in accounts():
        try:
            Api(auth).bearer_token  # noqa: B018 - property fetches a token
            out[email] = "ok"
            state["login_failed"].discard(email)
        except Exception as e:
            out[email] = f"{type(e).__name__}: {e}"[:300]
    return out


def _dir_size(root):
    return sum(f.stat().st_size for f in root.rglob("*.webp")) if root.exists() else 0


def health():
    def disk(path):
        try:
            u = shutil.disk_usage(path)
            return {"total": u.total, "used": u.used, "free": u.free}
        except OSError:
            return None

    def size(p):
        return sum(f.stat().st_size for f in Path(p).parent.glob(Path(p).name + "*") if f.is_file())

    last_ok = dict(q("SELECT account, MAX(updated) FROM files WHERE status IN ('uploaded','exists') GROUP BY account"))
    paths = _account_paths()
    accs = [
        {
            "email": email,
            "login_saved": max((f.stat().st_mtime for f in paths.get(email, [])), default=None),
            "last_success": last_ok.get(email),
            "login_rejected": email in state["login_failed"],
        }
        for email, _ in accounts()
    ]
    thumbs = int(cache.remember("thumbs-bytes", 600, lambda: str(_dir_size(THUMBS)).encode()))
    return {
        "version": VERSION,
        "gpmc": _dist_version("gpmc"),
        "python": sys.version.split()[0],
        "stats_engine": STATS_ENGINE,
        "uptime": time.time() - STARTED,
        "disk_data": disk(DATA),
        "disk_media": disk(MEDIA),
        "db_bytes": size(DB_FILE),
        "stats_bytes": size(STATS_FILE),
        "thumbs_bytes": thumbs,
        "cache": cache.info(),
        "accounts": accs,
        "phase": state["phase"],
        "error": state["error"],
        "last_scan": state["last_scan"],
        "checks": {
            "media_readable": os.access(MEDIA, os.R_OK) and bool(list_top_folders()),
            "upload_folder": upload_info()["ready"],
            "turso": STATS_ENGINE.startswith("Turso"),
            "errors_24h": sq("SELECT COUNT(*) FROM logs WHERE level='error' AND time > ?", (time.time() - 86400,))[0][
                0
            ],
        },
    }


def status_json():
    st = get_settings()
    counts = dict(q("SELECT status, COUNT(*) FROM files GROUP BY status"))
    gave_up = q("SELECT COUNT(*) FROM files WHERE status='failed' AND attempts>=?", (MAX_ATTEMPTS,))[0][0]
    failed = [
        {"name": rel(p), "error": e, "attempts": a, "time": t}
        for p, e, a, t in q(
            "SELECT path,error,attempts,updated FROM files WHERE status='failed' ORDER BY updated DESC LIMIT 9"
        )
    ]
    up, down = [int(v) for v in net["up"]], [int(v) for v in net["down"]]
    recent = up[-30:]
    accs = [a for a, _ in accounts()]
    return {
        "version": VERSION,
        "host": HOST_NAME,
        "auth": bool(PASSWORD),
        "phase": state["phase"],
        "error": state["error"],
        "done": state["done"],
        "total": state["total"],
        "last_scan": state["last_scan"],
        "interval": INTERVAL // 60,
        "paused": PAUSE_FILE.exists(),
        "stats_engine": STATS_ENGINE,
        "account": accs[0] if accs else "",
        "accounts": accs,
        "login_failed": sorted(state["login_failed"]),
        "schedule": {**st["schedule"], "allowed": upload_allowed(st), "next_window": next_window(st)},
        "speed_limit_mbps": st["speed_limit_mbps"],
        "current": state["current"],
        "library": state["library"],
        "folders": state["folders"],
        "session": state["session"],
        "max_accounts": MAX_ACCOUNTS,
        "copies": {
            acc: {"done": done or 0, "failed": failed or 0}
            for acc, done, failed in q(
                "SELECT account, SUM(status IN ('uploaded','exists')), SUM(status='failed') "
                "FROM copies GROUP BY account"
            )
        },
        "copies_pending": state.get("copies_pending", 0),
        "counts": {
            "uploaded": counts.get("uploaded", 0),
            "exists": counts.get("exists", 0),
            "failed": counts.get("failed", 0),
            "gave_up": gave_up,
        },
        "net": {
            "up": up,
            "down": down,
            "up_now": up[-1] if up else 0,
            "down_now": down[-1] if down else 0,
            "up_avg": sum(recent) / len(recent) if recent else 0,
            "sent": net["sent"],
            "received": net["received"],
        },
        "failed": failed,
        "pending": state["pending"][:8],
        "settle_seconds": SETTLE,
        "log": [{"time": t, "kind": k, "text": m, "name": n} for t, k, m, n in list(log_lines)[-12:]][::-1],
        "resources": resources_json(),
        "now": time.time(),
    }


_status_memo = {"at": 0.0, "key": None, "body": b""}


def status_body():
    """status_json() as bytes, shared by every open dashboard for up to a second."""
    key = (cache.generation(), changes[0])
    now = time.monotonic()
    m = _status_memo
    if m["body"] and m["key"] == key and now - m["at"] < 1:
        return m["body"]
    body = json.dumps(status_json()).encode()
    m.update(at=now, key=key, body=body)
    return body


# ---------------------------------------------------------------- free up Google storage
# Photos and videos that count against the Google storage quota (for example ones the phone's
# Google Photos app backed up) are downloaded and checked against Google's own fingerprint. The
# user then deletes them in Google Photos: GP Sync never deletes anything there. Once an item is
# gone, it is uploaded again the way all GP Sync uploads go, which doesn't count, and checked.

RECLAIM_DIR = DATA / "reclaim"
GPMC_HOME = Path.home() / ".gpmc"  # where gpmc keeps its copy of each account's library list
RECLAIM_KINDS = {1: "photo", 2: "video"}
reclaim_wake = threading.Event()
reclaim_state = {"refreshing": "", "error": "", "current": None}


def reclaim_blocked(account):
    """True after Google counted one of our re-uploads: then nothing more is moved."""
    return bool(q("SELECT 1 FROM reclaim WHERE account=? AND state='counts' LIMIT 1", (account,)))


def _b64_hash(digest):
    """Google's dedup key: the file's SHA-1 in URL-safe base64."""
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def _library_db(account):
    return GPMC_HOME / account / "storage.db"


def _library_rows(account, sql, args=()):
    path = _library_db(account)
    if not path.exists():
        return None
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10)
    try:
        return conn.execute(sql, args).fetchall()
    except sqlite3.OperationalError:
        return None
    finally:
        conn.close()


def _seconds(ts):
    ts = int(ts or 0)
    return ts / 1000 if ts > 10**11 else ts  # Google sends milliseconds


def storage_report(account, limit=500):
    """What counts against Google storage in an account, biggest first, with progress."""
    refreshed = meta_get(f"library_refreshed:{account}")
    out = {
        "account": account,
        "refreshed": float(refreshed) if refreshed else None,
        "refreshing": reclaim_state["refreshing"] == account,
        "error": reclaim_state["error"],
        "blocked": reclaim_blocked(account),
        "current": reclaim_state["current"],
        "free_space": shutil.disk_usage(DATA).free if DATA.exists() else 0,
    }
    rows = _library_rows(
        account,
        """SELECT media_key, dedup_key, file_name, type, size_bytes, quota_charged_bytes, utc_timestamp
           FROM remote_media WHERE origin = 'self' AND COALESCE(trash_timestamp, 0) = 0
           AND COALESCE(is_locked, 0) = 0""",
    )
    jobs = {
        r[0]: r
        for r in q(
            """SELECT media_key, dedup_key, name, kind, size, quota, taken, state, error, new_key, updated
               FROM reclaim WHERE account=?""",
            (account,),
        )
    }
    ours = {
        _b64_hash(bytes.fromhex(h)) for (h,) in q("SELECT sha1 FROM files WHERE sha1 != '' AND account=?", (account,))
    }
    items, counted, counted_bytes, total, ours_counted, ours_seen = [], 0, 0, 0, 0, 0
    for key, dedup, name, kind, size, quota, taken in rows or []:
        total += 1
        if dedup in ours:
            ours_seen += 1
            ours_counted += bool(quota)
        if quota:
            counted += 1
            counted_bytes += quota
            items.append((key, dedup, name, RECLAIM_KINDS.get(kind, "photo"), size, quota, _seconds(taken)))
    listed = {i[0] for i in items}
    for key, dedup, name, kind, size, quota, taken, *_ in jobs.values():
        if key not in listed:  # deleted in Google already, or done
            items.append((key, dedup, name, kind, size, quota, taken))
    finished = {k for k, j in jobs.items() if j[7] in ("done", "counted")}
    items.sort(key=lambda i: (i[0] in finished, -(i[5] or 0), i[2] or ""))  # to do first, biggest first

    def job(key):
        j = jobs.get(key)
        return {"state": j[7], "error": j[8] or "", "new_key": j[9] or "", "updated": j[10]} if j else {"state": ""}

    done = q("SELECT COUNT(*), SUM(quota) FROM reclaim WHERE account=? AND state='done'", (account,))[0]
    return {
        **out,
        "listed": rows is not None,
        "total": total,
        "counted": counted,
        "counted_bytes": counted_bytes,
        "ours": {"seen": ours_seen, "counted": ours_counted},
        "freed": {"count": done[0], "bytes": done[1] or 0},
        "items": [
            {
                "key": key,
                "name": name,
                "kind": kind,
                "size": size,
                "quota": quota,
                "taken": taken,
                "google_url": f"https://photos.google.com/photo/{key}",
                **job(key),
            }
            for key, _dedup, name, kind, size, quota, taken in items[:limit]
        ],
    }


def reclaim_queue(account, keys):
    """Ask for items to be downloaded (biggest first, one at a time)."""
    wanted = set(keys)
    rows = _library_rows(
        account,
        """SELECT media_key, dedup_key, file_name, type, size_bytes, quota_charged_bytes, utc_timestamp,
                  is_favorite, is_archived, caption FROM remote_media WHERE quota_charged_bytes > 0""",
    )
    n = 0
    for key, dedup, name, kind, size, quota, taken, fav, arch, cap in rows or []:
        if key not in wanted:
            continue
        q(
            """INSERT INTO reclaim (account, media_key, dedup_key, name, kind, size, quota, taken, favorite,
                                    archived, caption, state, updated)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,'queued',?)
               ON CONFLICT(account, media_key) DO UPDATE SET state='queued', error=''
               WHERE state IN ('failed', 'cancelled')""",
            (account, key, dedup, name, RECLAIM_KINDS.get(kind, "photo"), size, quota, _seconds(taken),
             int(bool(fav)), int(bool(arch)), cap or "", time.time()),
        )  # fmt: skip
        n += 1
    reclaim_wake.set()
    return {"queued": n}


def reclaim_cancel(account, keys):
    """Forget items that are waiting (their downloaded copy is removed). Never touches Google."""
    n = 0
    for key in keys:
        rows = q(
            """SELECT local FROM reclaim WHERE account=? AND media_key=?
               AND state IN ('queued', 'downloaded', 'in_google', 'failed')""",
            (account, key),
        )
        if not rows:
            continue
        if rows[0][0]:
            shutil.rmtree(Path(rows[0][0]).parent, ignore_errors=True)
        q("DELETE FROM reclaim WHERE account=? AND media_key=?", (account, key))
        n += 1
    return {"cancelled": n}


_clients = {}  # account -> (login, gpmc Client): one login per account, renewed by gpmc when due
_clients_lock = threading.Lock()


def _reclaim_client(account):
    from gpmc import Client

    auth = dict(accounts()).get(account)
    if not auth:
        raise RuntimeError(f"{account} is not connected")
    with _clients_lock:
        known = _clients.get(account)
        if not known or known[0] != auth:  # new, or the login was replaced
            known = _clients[account] = (auth, Client(auth_data=auth, log_level="WARNING"))
        return known[1]


def _download_urls(response):
    """Download links in a PhotosPrepareDownload answer, Google's original first."""
    found = []

    def walk(node, path):
        if isinstance(node, dict):
            for k, v in node.items():
                walk(v, (*path, str(k)))
        elif isinstance(node, list):
            for v in node:
                walk(v, path)
        elif isinstance(node, (str, bytes)):
            text = node.decode(errors="ignore") if isinstance(node, bytes) else node
            host = urllib.parse.urlparse(text).hostname or ""
            if text.startswith("https://") and (
                host.endswith(".googleusercontent.com") or host.endswith(".google.com")
            ):
                found.append((0 if path[-4:] == ("1", "5", "2", "6") else 1, text))

    walk(response, ())
    return [u for _, u in sorted(found, key=lambda x: x[0])][:3]


def _download(client, account, key, dedup, name, size, taken, folder=None, track=None):
    """Download one item and prove it is Google's original (same SHA-1). Returns the path.

    `track` is the dict whose "current" shows progress (Free storage or account copy)."""
    import requests

    track = reclaim_state if track is None else track
    if shutil.disk_usage(DATA).free < (size or 0) * 1.1 + 512 * 1024**2:
        raise RuntimeError("Not enough free disk space for this file")
    folder = folder or RECLAIM_DIR / account / key
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / (clean_name(name) or f"{key}.bin")
    tmp = target.with_suffix(target.suffix + ".part")
    headers = {"Authorization": f"Bearer {client.api.bearer_token}", "User-Agent": client.api.user_agent}
    urls = _download_urls(client.api.get_download_urls(key))
    if not urls:
        raise RuntimeError("Google gave no download link")
    for url in urls:
        digest = hashlib.sha1()
        done = 0
        with requests.get(url, headers=headers, stream=True, timeout=60) as r, open(tmp, "wb") as f:
            r.raise_for_status()
            for block in r.iter_content(1024 * 1024):
                f.write(block)
                digest.update(block)
                done += len(block)
                track["current"] = {"key": key, "step": "downloading", "done": done, "total": size}
        if _b64_hash(digest.digest()) == dedup:
            tmp.replace(target)
            if taken:
                os.utime(target, (taken, taken))  # the upload uses the file time as its date
            return target
    tmp.unlink(missing_ok=True)
    raise RuntimeError("The download is not exactly Google's original, so it was not used")


def _set_reclaim(account, key, state_, error="", **cols):
    sets = ", ".join(f"{c}=?" for c in cols)
    q(
        f"UPDATE reclaim SET state=?, error=?, updated=?{', ' + sets if sets else ''} WHERE account=? AND media_key=?",
        (state_, error, time.time(), *cols.values(), account, key),
    )
    notify_change()


def reclaim_step(make_client=None):
    """Do the next piece of work. Returns True if there was something to do."""
    make_client = make_client or _reclaim_client
    rows = q(
        """SELECT account, media_key, dedup_key, name, size, taken, state, local, favorite, archived, caption,
                  new_key, checks FROM reclaim WHERE state IN ('queued', 'downloaded', 'in_google', 'checking')
           ORDER BY state = 'queued', quota DESC"""
    )
    if not rows:
        return False
    did = False
    clients = {}
    now = time.time()

    def client_for(account):
        if account not in clients:
            clients[account] = make_client(account)
        return clients[account]

    for account, key, dedup, name, size, taken, st_, local, fav, arch, cap, new_key, checks in rows:
        try:
            if st_ == "queued":
                reclaim_state["current"] = {"key": key, "step": "downloading", "done": 0, "total": size}
                path = _download(client_for(account), account, key, dedup, name, size, taken)
                _set_reclaim(account, key, "downloaded", local=str(path))
                reclaim_state["error"] = ""
                log(f"Downloaded {name} from Google ({fmt_bytes(size)}): delete it in Google Photos to free it", "info")
                return True  # one download per step: the next one waits for the next call
            if st_ in ("downloaded", "in_google"):
                if reclaim_blocked(account) or now - _reclaim_checked.get(key, 0) < 100:
                    continue  # asked Google about it less than 2 minutes ago
                _reclaim_checked[key] = now
                client = client_for(account)
                if client.api.find_remote_media_by_hash(base64.urlsafe_b64decode(dedup + "=" * (-len(dedup) % 4))):
                    continue  # the user hasn't deleted it yet (or it's still in Google's Trash)
                did = True
                reclaim_state["current"] = {"key": key, "step": "uploading", "done": 0, "total": size}
                result = _reupload(client, Path(local), dedup, size, key)
                if result is None:
                    _set_reclaim(
                        account, key, "in_google", "Still in Google Photos: also delete it from Google's Trash"
                    )
                    continue
                _restore_details(client, dedup, fav, arch, cap)
                _set_reclaim(account, key, "checking", new_key=result, checks=0)
            elif st_ == "checking":
                if now - _reclaim_checked.get(key, 0) < 60:
                    continue  # Google needs a moment to list a new upload: check once a minute
                _reclaim_checked[key] = now
                client = client_for(account)
                client.update_cache(show_progress=False)
                meta_set(f"library_refreshed:{account}", str(time.time()))
                found = _library_rows(
                    account, "SELECT quota_charged_bytes FROM remote_media WHERE media_key=?", (new_key,)
                )
                if not found:
                    if (checks or 0) >= 10:
                        _set_reclaim(account, key, "failed", "Uploaded, but Google hasn't listed it yet. Check later")
                    else:
                        _set_reclaim(account, key, "checking", checks=(checks or 0) + 1)
                    continue
                if found[0][0]:
                    _set_reclaim(account, key, "counts", "Google counted this upload too, so nothing was freed")
                    log(f"Free upload didn't work for {account}: stopped freeing storage", "error")
                    alert("Freeing storage stopped", f"Google counted the new upload of {name} against storage.")
                    continue
                shutil.rmtree(Path(local).parent, ignore_errors=True)
                _set_reclaim(account, key, "done", local="")
                log(f"Freed {fmt_bytes(size)} of Google storage: {name}", "uploaded")
        except Exception as e:
            msg = f"{type(e).__name__}: {e}"[:300]
            print(f"Free storage: {name}: {msg}", file=sys.stderr, flush=True)
            if st_ == "queued":
                if outage := outage_kind(e):  # no internet or Google is down: try again later
                    reclaim_state["error"] = outage
                    return False
                _set_reclaim(account, key, "failed", msg)
                return True
            _set_reclaim(account, key, st_, msg)  # tried again in 2 minutes
        finally:
            reclaim_state["current"] = None
    return did


_reclaim_checked = {}  # media key -> when Google was last asked about it


def _reupload(client, path, dedup, size, key, track=None):
    """Upload the downloaded original the free way. Returns the new media key, or None if Google
    still has the old one (then nothing is uploaded)."""
    from rich.progress import Progress

    track = reclaim_state if track is None else track
    phases = []

    def progress(ev):
        phases.append(ev.get("phase"))
        if ev.get("phase") == "uploading":
            track["current"] = {
                "key": key,
                "step": "uploading",
                "done": ev.get("bytes_completed") or 0,
                "total": size,
            }

    digest = base64.urlsafe_b64decode(dedup + "=" * (-len(dedup) % 4))
    with Progress(disable=True) as bar:
        result = client._upload_file(
            path, digest, bar, force_upload=False, use_quota=False, saver=False, progress_callback=progress
        )
    if "skipped" in phases:
        return None
    return next(iter(result.values()), "") or None


def _restore_details(client, dedup, favorite, archived, caption):
    """Favourite, archived and caption come back (they belong to the file, not to an album)."""
    for step in (
        lambda: favorite and client.api.set_favorite(dedup, True),
        lambda: archived and client.api.set_archived([dedup], True),
        lambda: caption and client.api.set_item_caption(dedup_key=dedup, caption=caption),
    ):
        try:
            step()
        except Exception as e:
            print(f"Free storage: couldn't restore details: {type(e).__name__}: {e}", file=sys.stderr, flush=True)


def refresh_library(account, make_client=None):
    """Read the account's library list from Google (the first time can take a few minutes)."""
    reclaim_state.update(refreshing=account, error="")
    notify_change()
    try:
        (make_client or _reclaim_client)(account).update_cache(show_progress=False)
        meta_set(f"library_refreshed:{account}", str(time.time()))
    except Exception as e:
        reclaim_state["error"] = f"{type(e).__name__}: {e}"[:300]
    finally:
        reclaim_state["refreshing"] = ""
        notify_change()


_refresh_requests = collections.deque()


def reclaim_worker():
    """One item at a time. Items waiting for the user to delete them are checked every 2 minutes."""
    with contextlib.suppress(Exception):  # reset work cut short by a restart
        q("UPDATE reclaim SET state='queued' WHERE state='downloading'")
    while True:
        try:
            while _refresh_requests:
                refresh_library(_refresh_requests.popleft())
            busy = reclaim_step()
        except Exception as e:
            print(f"Free storage: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            busy = False
        reclaim_wake.wait(1 if busy else 120)
        reclaim_wake.clear()


# ---------------------------------------------------------------- copy between Google accounts
# Everything one connected account owns is copied to another, newest first, one item at a time:
# download the original (checked against Google's fingerprint), upload it to the other account
# the free way, bring back favourite, archive and caption. Nothing is deleted anywhere.

COPY_DIR = DATA / "copy"
COPY_CHECK_EVERY = 25  # after this many copies, check with Google that they don't count
copy_state = {"current": None, "error": ""}
copy_wake = threading.Event()
_OWNED = "origin = 'self' AND COALESCE(trash_timestamp, 0) = 0 AND COALESCE(is_locked, 0) = 0 AND is_canonical"


def _year(ts):
    return time.gmtime(ts).tm_year if ts else None


def copy_report(src, dst):
    """What account `src` has that `dst` doesn't, and how copying is going."""
    src_rows = _library_rows(
        src,
        f"""SELECT dedup_key, type, size_bytes, utc_timestamp, media_key, file_name FROM remote_media
            WHERE {_OWNED} ORDER BY utc_timestamp DESC""",
    )
    dst_keys = _library_rows(dst, "SELECT dedup_key FROM remote_media")
    have = {k for (k,) in dst_keys or []}
    jobs = dict(q("SELECT state, COUNT(*) FROM copyjobs WHERE src=? AND dst=? GROUP BY state", (src, dst)))
    handled = {k for (k,) in q("SELECT dedup_key FROM copyjobs WHERE src=? AND dst=?", (src, dst))}
    todo = {"photo": [0, 0], "video": [0, 0]}
    years = {}
    in_dst = 0
    dups = {}  # media key -> item: already in dst, or the same file twice in src. Never copied.
    seen = set()
    for dedup, kind, size, taken, key, name in src_rows or []:
        twice = dedup in seen
        seen.add(dedup)
        if dedup in handled and not twice:
            continue  # on the copy list (or copied: then the other account has it because of us)
        if dedup in have or twice:
            in_dst += not twice
            dups[key] = (key, name, RECLAIM_KINDS.get(kind, "photo"), size, _seconds(taken),
                         "Already in " + dst if not twice else "The same file twice in " + src)  # fmt: skip
            continue
        k = RECLAIM_KINDS.get(kind, "photo")
        todo[k][0] += 1
        todo[k][1] += size or 0
        y = _year(_seconds(taken))
        if y:
            years[y] = years.get(y, 0) + 1

    def refreshed(acc):
        v = meta_get(f"library_refreshed:{acc}")
        return float(v) if v else None

    done = q(
        "SELECT COUNT(*), SUM(size) FROM copyjobs WHERE src=? AND dst=? AND state IN ('copied', 'done')", (src, dst)
    )[0]
    queued = q("SELECT COUNT(*), SUM(size) FROM copyjobs WHERE src=? AND dst=? AND state='queued'", (src, dst))[0]
    recent = q(
        """SELECT media_key, name, kind, size, taken, state, error, updated FROM copyjobs
           WHERE src=? AND dst=? AND state != 'queued' ORDER BY updated DESC LIMIT 40""",
        (src, dst),
    )
    failed = q(
        """SELECT media_key, name, kind, size, taken, state, error, updated FROM copyjobs
           WHERE src=? AND dst=? AND state IN ('failed', 'counts') ORDER BY updated DESC LIMIT 100""",
        (src, dst),
    )
    for key, name, kind, size, taken in q(
        "SELECT media_key, name, kind, size, taken FROM copyjobs WHERE src=? AND dst=? AND state='exists'", (src, dst)
    ):  # Google said the other account had it when uploading
        dups.setdefault(key, (key, name, kind, size, taken, "Already in " + dst))
    dup_list = sorted(dups.values(), key=lambda d: -(d[4] or 0))

    def item(r):
        key, name, kind, size, taken, state_, error, updated = r
        return {"key": key, "name": name, "kind": kind, "size": size, "taken": taken, "state": state_,
                "error": error or "", "updated": updated}  # fmt: skip

    return {
        "src": src,
        "dst": dst,
        "listed": {"src": src_rows is not None, "dst": dst_keys is not None},
        "refreshed": {"src": refreshed(src), "dst": refreshed(dst)},
        "refreshing": reclaim_state["refreshing"] in (src, dst) or any(a in (src, dst) for a in _refresh_requests),
        "error": copy_state["error"] or reclaim_state["error"],
        "paused": meta_get("copy_paused") == "1",
        "current": copy_state["current"],
        "src_total": len(src_rows or []),
        "in_dst": in_dst,
        "duplicates": {
            "count": len(dup_list),
            "bytes": sum(d[3] or 0 for d in dup_list),
            "items": [
                {
                    "key": k,
                    "name": n,
                    "kind": kd,
                    "size": sz,
                    "taken": t,
                    "state": "exists",
                    "error": why,
                    "updated": 0,
                }
                for k, n, kd, sz, t, why in dup_list[:60]
            ],
        },
        "todo": {k: {"count": c, "bytes": b} for k, (c, b) in todo.items()},
        "years": dict(sorted(years.items())),
        "jobs": {
            "queued": jobs.get("queued", 0),
            "queued_bytes": queued[1] or 0,
            "copied": jobs.get("copied", 0) + jobs.get("done", 0),
            "copied_bytes": done[1] or 0,
            "verified": jobs.get("done", 0),
            "exists": jobs.get("exists", 0),
            "failed": jobs.get("failed", 0),
            "counts": jobs.get("counts", 0),
        },
        "recent": [item(r) for r in recent],
        "failed": [item(r) for r in failed],
        "free_space": shutil.disk_usage(DATA).free if DATA.exists() else 0,
    }


def copy_start(src, dst, kinds=("photo", "video"), from_year=None, to_year=None):
    """Queue everything `src` owns that `dst` doesn't have yet (with the chosen filters)."""
    src_rows = _library_rows(
        src,
        f"""SELECT media_key, dedup_key, file_name, type, size_bytes, utc_timestamp, is_favorite, is_archived,
                   caption FROM remote_media WHERE {_OWNED}""",
    )
    if src_rows is None:
        raise ValueError("Read the library of the account to copy from first")
    have = {k for (k,) in _library_rows(dst, "SELECT dedup_key FROM remote_media") or []}
    handled = {k for (k,) in q("SELECT dedup_key FROM copyjobs WHERE src=? AND dst=?", (src, dst))}
    now = time.time()
    batch = []
    for key, dedup, name, kind, size, taken, fav, arch, cap in src_rows:
        k = RECLAIM_KINDS.get(kind, "photo")
        t = _seconds(taken)
        y = _year(t)
        if dedup in have or dedup in handled or k not in kinds:
            continue  # duplicates (already there) are never copied
        if (from_year and (not y or y < from_year)) or (to_year and (not y or y > to_year)):
            continue
        handled.add(dedup)  # the same file twice: copy it once
        batch.append((src, dst, key, dedup, name, k, size, t, int(bool(fav)), int(bool(arch)), cap or "", now))
    with db_lock:
        CONN.executemany(
            """INSERT OR IGNORE INTO copyjobs (src, dst, media_key, dedup_key, name, kind, size, taken, favorite,
                                              archived, caption, state, updated)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,'queued',?)""",
            batch,
        )
        CONN.commit()
    cache.bump()
    meta_set("copy_paused", "0")
    copy_wake.set()
    if batch:
        log(f"Copying {len(batch)} items from {src} to {dst}", "account")
    return {"queued": len(batch)}


def copy_stop(src, dst):
    """Take the items that haven't started off the list (copies already made stay)."""
    n = q("DELETE FROM copyjobs WHERE src=? AND dst=? AND state='queued' RETURNING 1", (src, dst))
    return {"removed": len(n)}


def copy_retry(src, dst):
    n = q(
        "UPDATE copyjobs SET state='queued', error='' WHERE src=? AND dst=? AND state='failed' RETURNING 1", (src, dst)
    )
    copy_wake.set()
    return {"queued": len(n)}


def _set_copy(src, dst, key, state_, error="", **cols):
    sets = "".join(f", {c}=?" for c in cols)
    q(
        f"UPDATE copyjobs SET state=?, error=?, updated=?{sets} WHERE src=? AND dst=? AND media_key=?",
        (state_, error, time.time(), *cols.values(), src, dst, key),
    )
    notify_change()


def _verify_copies(dst_client, src, dst, force=False):
    """Check with Google that copies made so far don't count against storage. Pauses if they do."""
    rows = q(
        "SELECT media_key, new_key, name, checks FROM copyjobs WHERE src=? AND dst=? AND state='copied'", (src, dst)
    )
    if not rows or (len(rows) < COPY_CHECK_EVERY and not force):
        return False
    dst_client.update_cache(show_progress=False)
    meta_set(f"library_refreshed:{dst}", str(time.time()))
    for key, new_key, name, checks in rows:
        found = _library_rows(dst, "SELECT quota_charged_bytes FROM remote_media WHERE media_key=?", (new_key,))
        if found and found[0][0]:
            _set_copy(src, dst, key, "counts", "Google counted this copy against storage")
            meta_set("copy_paused", "1")
            log(f"Copy to {dst} paused: Google counted {name} against storage", "error")
            alert("Account copy paused", f"Google counted the copy of {name} against the storage of {dst}.")
            return True
        if found:
            _set_copy(src, dst, key, "done")
        elif (checks or 0) >= 10:
            _set_copy(src, dst, key, "done", "Copied, but Google hasn't listed it yet")
        else:
            q("UPDATE copyjobs SET checks=COALESCE(checks, 0)+1 WHERE src=? AND dst=? AND media_key=?", (src, dst, key))
    return True


def copy_step(make_client=None):
    """Copy the next item. Returns True if there was something to do."""
    make_client = make_client or _reclaim_client
    if meta_get("copy_paused") == "1":
        return False
    row = q(
        """SELECT src, dst, media_key, dedup_key, name, size, taken, favorite, archived, caption FROM copyjobs
           WHERE state='queued' ORDER BY taken DESC LIMIT 1"""
    )
    if not row:  # the list is done: check the last copies (once a minute until Google lists them)
        for s_, d in q("SELECT DISTINCT src, dst FROM copyjobs WHERE state='copied'"):
            _verify_copies(make_client(d), s_, d, force=True)
        return False
    src, dst, key, dedup, name, size, taken, fav, arch, cap = row[0]
    connected = dict(accounts())
    if src not in connected or dst not in connected:  # an account was removed: wait, don't fail it all
        copy_state["error"] = f"{src if src not in connected else dst} is no longer connected. Copying is paused."
        meta_set("copy_paused", "1")
        return False
    folder = COPY_DIR / key
    try:
        source, target = make_client(src), make_client(dst)
        copy_state["current"] = {"key": key, "step": "downloading", "done": 0, "total": size, "name": name}
        path = _download(source, src, key, dedup, name, size, taken, folder=folder, track=copy_state)
        new_key = _reupload(target, path, dedup, size, key, track=copy_state)
        if new_key is None:
            _set_copy(src, dst, key, "exists")
        else:
            _restore_details(target, dedup, fav, arch, cap)
            _set_copy(src, dst, key, "copied", new_key=new_key)
            try:  # the copy is made: a failed check is tried again later, it doesn't fail the copy
                _verify_copies(target, src, dst)
            except Exception as e:
                print(f"Account copy: check failed: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        copy_state["error"] = ""
    except Exception as e:
        msg = f"{type(e).__name__}: {e}"[:300]
        print(f"Account copy: {name}: {msg}", file=sys.stderr, flush=True)
        if outage := outage_kind(e):  # Google or the internet is down: keep it queued, try again later
            copy_state["error"] = outage
            return False
        _set_copy(src, dst, key, "failed", msg)
    finally:
        copy_state["current"] = None
        shutil.rmtree(folder, ignore_errors=True)
    return True


def copy_worker():
    while True:
        try:
            busy = copy_step()
        except Exception as e:
            print(f"Account copy: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            busy = False
        copy_wake.wait(0.5 if busy else 60)
        copy_wake.clear()


# ---------------------------------------------------------------- uploads from phones


def upload_folders():
    """Named folders inside the upload folder (not the year folders)."""
    try:
        return sorted(
            e.name
            for e in os.scandir(UPLOAD_DIR)
            if e.is_dir() and not e.name.startswith(".") and not re.fullmatch(r"\d{4}", e.name)
        )
    except OSError:
        return []


def upload_folder_name():
    """Where phone uploads show up among the backed-up folders (e.g. Photos/Uploads), or ""."""
    if str(UPLOAD_DIR).startswith(str(MEDIA) + os.sep):
        return rel(UPLOAD_DIR)
    # Mounted separately (as on Umbrel): find the same folder inside the media folders.
    with contextlib.suppress(OSError):
        for top in list_top_folders():
            candidate = MEDIA / top / UPLOAD_DIR.name
            if candidate.is_dir() and os.path.samefile(candidate, UPLOAD_DIR):
                return f"{top}/{UPLOAD_DIR.name}"
    return ""


def upload_info():
    ready = UPLOAD_DIR.is_dir() and os.access(UPLOAD_DIR, os.W_OK)
    free = shutil.disk_usage(UPLOAD_DIR).free if ready else 0
    shown = upload_folder_name()
    synced = bool(shown) and any(shown.split("/")[0] == top and acc for top, acc in folder_map().items())
    return {
        "ready": ready,
        "folder": shown,
        "free": free,
        "max_bytes": MAX_UPLOAD,
        "synced": synced,
        "folders": upload_folders() if ready else [],
        "chunk_bytes": 8 * 1024**2,
    }


def clean_name(name):
    name = str(name).replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(c for c in name if c.isprintable() and c not in '<>:"|?*').strip(" .")
    return name[-180:]


def _owned(path):
    with contextlib.suppress(OSError):  # not root, or a file system without owners
        os.chown(path, *UPLOAD_OWNER)


CHUNKS = ".chunks"  # unfinished resumable uploads (a dot folder, so never scanned)
UPLOAD_ID = re.compile(r"[A-Za-z0-9_-]{8,64}")


def _when(mtime_ms):
    try:
        when = float(mtime_ms) / 1000 if mtime_ms else time.time()
        time.gmtime(when)
        return when
    except (TypeError, ValueError, OverflowError, OSError):
        return time.time()


def _upload_folder(when, folder=""):
    """UPLOAD_DIR/<folder>/ if the user named one, else UPLOAD_DIR/<year>/<month>/."""
    folder = clean_name(folder)
    if folder:
        parts = [folder]
    else:
        local = time.gmtime(when + get_settings()["tz_offset_min"] * 60)
        parts = [time.strftime("%Y", local), time.strftime("%m", local)]
    d = UPLOAD_DIR
    for part in parts:
        d = d / part
        if not d.exists():
            d.mkdir(exist_ok=True)
            _owned(d)
    return d


def _copy(stream, f, length, digest=None):
    left = length
    while left:
        chunk = stream.read(min(left, 1024 * 1024))
        if not chunk:
            raise ConnectionError("upload cut off")
        if digest:
            digest.update(chunk)
        f.write(chunk)
        left -= len(chunk)


def _check_upload(name, total):
    if not name or ext(name) not in EXTS:
        return 400, {"ok": False, "error": "Only photos and videos can be uploaded"}
    if not 0 < total <= MAX_UPLOAD:
        return 400, {"ok": False, "error": "Empty or too large"}
    info = upload_info()
    if not info["ready"]:
        return 503, {"ok": False, "error": "The upload folder is not available"}
    if info["free"] < total + 512 * 1024**2:
        return 507, {"ok": False, "error": f"Not enough free space on {HOST_NAME}"}
    return None


def chunk_offset(upload_id):
    """Bytes already received for a resumable upload (0 if none)."""
    if not UPLOAD_ID.fullmatch(upload_id or ""):
        return 0
    part = UPLOAD_DIR / CHUNKS / f"{upload_id}.part"
    return part.stat().st_size if part.exists() else 0


def receive_chunk(stream, length, upload_id, offset, total, name, mtime_ms=None, folder=""):
    """One piece of a resumable upload. The last piece saves the file like receive_upload."""
    name = clean_name(name)
    if not UPLOAD_ID.fullmatch(upload_id or ""):
        return 400, {"ok": False, "error": "Bad upload id"}
    problem = _check_upload(name, total) if offset == 0 else None
    if problem:
        return problem
    if not 0 < length <= 64 * 1024**2 or offset + length > total or total > MAX_UPLOAD:
        return 400, {"ok": False, "error": "Bad piece"}
    chunks = UPLOAD_DIR / CHUNKS
    chunks.mkdir(exist_ok=True)
    part = chunks / f"{upload_id}.part"
    have = part.stat().st_size if part.exists() else 0
    if offset != have:  # resume from what actually arrived
        return 409, {"ok": False, "offset": have, "error": "Resume from offset"}
    with open(part, "ab") as f:
        try:
            _copy(stream, f, length)
        except BaseException:
            f.truncate(have)  # drop a half piece so the next try starts cleanly
            raise
    if have + length < total:
        return 200, {"ok": True, "offset": have + length}
    when = _when(mtime_ms)
    return _finish_upload(part, name, total, when, media.sha1_file(part).hex(), folder)


def clean_chunks(max_age=2 * 86400):
    d = UPLOAD_DIR / CHUNKS
    if d.is_dir():
        for f in d.glob("*.part"):
            if time.time() - f.stat().st_mtime > max_age:
                f.unlink(missing_ok=True)


def receive_upload(stream, length, name, mtime_ms=None, folder=""):
    """Save one file sent from a phone into UPLOAD_DIR/<year>/<month>/ (or a named folder).

    Returns (http code, result)."""
    name = clean_name(name)
    problem = _check_upload(name, length)
    if problem:
        return problem
    when = _when(mtime_ms)
    target_dir = _upload_folder(when, folder)
    tmp = target_dir / f".{name}.{os.getpid()}.{threading.get_ident()}.part"  # dot files are not scanned
    digest = hashlib.sha1()
    try:
        with open(tmp, "wb") as f:
            _copy(stream, f, length, digest)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return _finish_upload(tmp, name, length, when, digest.hexdigest(), folder)


def _finish_upload(tmp, name, length, when, sha1_hex, folder=""):
    """Move a fully received file into place, unless the same photo is already here."""
    try:
        target_dir = _upload_folder(when, folder)
        dup = q("SELECT path FROM files WHERE sha1=? LIMIT 1", (sha1_hex,))
        if dup:
            tmp.unlink()
            return 200, {"ok": True, "duplicate": rel(dup[0][0]), "name": name}
        stem, dot, suffix = name.rpartition(".")
        with upload_lock:  # two phones sending IMG_0001.jpg at once must not overwrite each other
            target, n = target_dir / name, 1
            while target.exists():
                if target.stat().st_size == length and media.sha1_file(target).hex() == sha1_hex:
                    tmp.unlink()
                    return 200, {"ok": True, "duplicate": rel(target), "name": name}
                target = target_dir / f"{stem} ({n}){dot}{suffix}"
                n += 1
            os.replace(tmp, target)
        _owned(target)
        os.utime(target, (when, when))
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    saved = rel(target)
    log(f"Received {saved} from a phone ({fmt_bytes(length)})", "received", saved)
    wake.set()
    return 200, {"ok": True, "saved": saved, "name": name}


def about():
    packages = ("gpmc", "pyturso", "pillow", "pillow-heif", "requests", "rich", "redis")
    return {
        "version": VERSION,
        "host": HOST_NAME,
        "commit": os.environ.get("BUILD_COMMIT", ""),
        "built": os.environ.get("BUILD_DATE", ""),
        "python": sys.version.split()[0],
        "sqlite": sqlite3.sqlite_version,
        "stats_engine": STATS_ENGINE,
        "packages": {n: _dist_version(n) for n in packages},
        "started": STARTED,
        "uptime": time.time() - STARTED,
        "media": str(MEDIA),
        "upload_dir": str(UPLOAD_DIR),
        "interval_min": INTERVAL // 60,
    }


# ---------------------------------------------------------------- web server

CONTENT_TYPES = {
    "html": "text/html; charset=utf-8",
    "js": "text/javascript; charset=utf-8",
    "css": "text/css; charset=utf-8",
    "svg": "image/svg+xml",
    "png": "image/png",
    "webp": "image/webp",
    "ico": "image/x-icon",
    "json": "application/json",
    "webmanifest": "application/manifest+json",
    "woff2": "font/woff2",
    "txt": "text/plain; charset=utf-8",
}


def static_file(path):
    """A file of the built dashboard, or None. Never leaves STATIC_DIR."""
    name = urllib.parse.unquote(path).lstrip("/") or "index.html"
    try:
        target = (STATIC_DIR / name).resolve()
        target.relative_to(STATIC_DIR.resolve())
    except (ValueError, OSError):
        return None
    return target if target.is_file() else None


SESSION_COOKIE = "gps_auth"


def session_token():
    """The sign-in cookie's value: changes when PASSWORD changes, so old sign-ins stop working."""
    return hmac.new(PASSWORD.encode(), b"gp-sync sign-in", "sha256").hexdigest()


def signed_in(headers):
    if not PASSWORD:
        return True
    cookie = http.cookies.SimpleCookie()
    with contextlib.suppress(http.cookies.CookieError):
        cookie.load(headers.get("Cookie", ""))
    if SESSION_COOKIE in cookie and hmac.compare_digest(
        cookie[SESSION_COOKIE].value.encode(), session_token().encode()
    ):
        return True
    kind, _, value = headers.get("Authorization", "").partition(" ")
    if kind.lower() == "basic":  # scripts: curl -u any:PASSWORD
        try:
            given = base64.b64decode(value).decode().partition(":")[2]
        except (ValueError, UnicodeDecodeError):
            return False
        return hmac.compare_digest(given.encode(), PASSWORD.encode())
    return False


# A self-contained page (no scripts or files), so it works before signing in and in installed apps.
LOGIN_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#08090c"><title>Sign in · GP Sync</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;
font:16px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","Google Sans Text",Roboto,system-ui,sans-serif;
color:#f5f5f7;
background:#08090c radial-gradient(48rem 34rem at 0% 0%,rgb(10 132 255/.18),transparent 62%)}
form{width:100%;max-width:340px;padding:28px;border:1px solid rgb(255 255 255/.09);border-radius:22px;
background:rgb(30 31 37/.62);-webkit-backdrop-filter:blur(24px);backdrop-filter:blur(24px);
box-shadow:inset 0 1px 0 rgb(255 255 255/.1),0 20px 50px -25px #000}
h1{margin:0 0 4px;font-size:22px}p{margin:0 0 20px;color:#8e8e93;font-size:14px}
input{width:100%;height:46px;padding:0 14px;border-radius:12px;border:1px solid rgb(255 255 255/.12);
background:rgb(255 255 255/.06);color:inherit;font-size:16px;outline:none}input:focus{border-color:#0a84ff}
button{margin-top:14px;width:100%;height:46px;border:0;border-radius:999px;color:#fff;font-size:16px;
font-weight:600;background:#0a84ff;cursor:pointer}button:active{transform:scale(.98)}
.e{min-height:20px;margin-top:10px;color:#ff6961;font-size:14px}
</style></head><body><form method="post" action="login">
<h1>GP Sync</h1><p>Enter the password to open the dashboard.</p>
<input type="password" name="password" autocomplete="current-password" placeholder="Password" required autofocus>
<button type="submit">Sign in</button><div class="e">{error}</div></form></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json", cache="no-cache"):
        data = body if isinstance(body, bytes) else body.encode()
        etag = ""
        if code == 200 and self.command == "GET":
            # The browser keeps the answer and asks "changed?"; unchanged answers cost 0 bytes.
            etag = '"' + hashlib.blake2b(data, digest_size=8).hexdigest() + '"'
            if etag in self.headers.get("If-None-Match", ""):
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Cache-Control", cache)
                self.end_headers()
                return
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache if code == 200 else "no-store")
        if etag:
            self.send_header("ETag", etag)
        self.end_headers()
        self.wfile.write(data)

    def json(self, obj, code=200):
        self.send(code, json.dumps(obj))

    def send_file(self, target, ctype, download=False):
        """Send an original file, with Range support so videos can be played and seeked."""
        size = target.stat().st_size
        start, end, code = 0, size - 1, 200
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", "").strip())
        if m and (m[1] or m[2]):
            if m[1]:
                start, end = int(m[1]), min(int(m[2]) if m[2] else size - 1, size - 1)
            else:
                start = max(0, size - int(m[2]))
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            code = 206
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "private, max-age=3600")
        if code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if download:
            quoted = urllib.parse.quote(target.name)
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quoted}")
        self.end_headers()
        left = end - start + 1
        try:
            with open(target, "rb") as f:
                f.seek(start)
                while left > 0 and (block := f.read(min(left, 1024 * 1024))):
                    self.wfile.write(block)
                    left -= len(block)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the viewer moved on

    def stream(self):
        """Server-sent events: live status, pushed when something happens (and at least every 2 s)."""
        if not stream_slots.acquire(blocking=False):
            self.send(503, "{}")
            return
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            self.close_connection = True
            viewers["streams"] += 1
            watched_event.set()
            while True:
                self.wfile.write(b"data: " + status_body() + b"\n\n")
                self.wfile.flush()
                with changed:
                    changed.wait(timeout=2)
                time.sleep(0.25)  # bursts of events become one update
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            viewers["streams"] = max(0, viewers["streams"] - 1)
            viewers["last_request"] = time.time()
            stream_slots.release()

    def cached(self, key, ttl, make):
        """Answer with JSON from the cache (made by make() when missing or stale)."""
        self.send(200, cache.remember(key, ttl, lambda: json.dumps(make()).encode()))

    def image(self, kind, name, make):
        """A thumbnail or preview: from the cache, else made (and cached) by make(name)."""
        key = f"{kind}:{name}"
        data = cache.get(key)
        if data is None:
            try:
                target = make(name)
            except Exception as e:
                print(f"{kind.title()} failed for {name}: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
                target = None
            data = target.read_bytes() if target else b""
            media.release_memory()
            # Missing ones (videos not uploaded yet) are asked for again after a while. Found ones
            # are files on disk the system already keeps in memory, so only Redis stores them.
            if not data or cache.remote():
                cache.set(key, data, 86400 if data else 300)
        if data:
            # ?v=<file time> addresses one version of the picture: phones may keep it for good.
            versioned = "v=" in self.path
            self.send(
                200,
                data,
                "image/webp",
                "private, max-age=31536000, immutable" if versioned else "private, max-age=86400",
            )
        else:
            self.send(404, "{}")

    def allowed(self):
        """With PASSWORD set, every request needs the sign-in cookie (or HTTP Basic, for scripts).

        Pages go to the sign-in page; API calls get 401 (without a browser password popup)."""
        if not PASSWORD or signed_in(self.headers):
            return True
        path = self.path.partition("?")[0]
        if self.command in ("GET", "HEAD") and path in ("/", "/index.html"):
            self.send_response(303)
            self.send_header("Location", "login")
        else:
            self.send_response(401)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.close_connection = True
        return False

    def sign_in_page(self, error=False):
        self.send(
            200,
            LOGIN_PAGE.replace("{error}", "Wrong password" if error else ""),
            "text/html; charset=utf-8",
            "no-store",
        )

    def sign_in(self, body):
        given = (urllib.parse.parse_qs(body).get("password") or [""])[0]
        self.send_response(303)
        if PASSWORD and hmac.compare_digest(given.encode(), PASSWORD.encode()):
            self.send_header(
                "Set-Cookie", f"{SESSION_COOKIE}={session_token()}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax"
            )
            self.send_header("Location", "./")
        else:
            time.sleep(1)  # slows down guessing
            self.send_header("Location", "login?e=1")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def sign_out(self):
        self.send_response(303)
        self.send_header("Set-Cookie", f"{SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax")
        self.send_header("Location", "login" if PASSWORD else "./")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        """Like GET for the dashboard files (some browsers and install checks use HEAD)."""
        if not self.allowed():
            return
        path = self.path.partition("?")[0]
        target = static_file(path) if not path.startswith("/api/") else None
        if not target:
            self.send_response(404 if not path.startswith("/api/") else 405)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(ext(target.name), "application/octet-stream"))
        self.send_header("Content-Length", str(target.stat().st_size))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable" if "/assets/" in path else "no-cache")
        self.end_headers()

    def do_GET(self):
        if self.path.partition("?")[0] == "/login":
            self.sign_in_page("e=1" in self.path)
            return
        if not self.allowed():
            return
        path, _, qs = self.path.partition("?")
        query = urllib.parse.parse_qs(qs)

        def arg(name, default, lo=None, hi=None):
            raw = query.get(name, [default])[0]
            if lo is None:
                return raw
            try:
                return max(lo, min(hi, int(raw)))
            except ValueError:
                return default

        if path.startswith("/api/"):
            saw_viewer()
        if path == "/api/status":
            self.send(200, status_body())
        elif path == "/api/history":
            days, tz = arg("days", 365, 1, 3660), arg("tz", 0, -840, 840)
            self.cached(f"history:{days}:{tz}", 60, lambda: history(days, tz))
        elif path == "/api/folders":
            folder = clean_folder(arg("path", ""))
            if folder is None:
                self.json({"error": "bad folder"}, 400)
                return
            group = "devices" if arg("group", "folders") == "devices" else "folders"
            days, tz = arg("days", 30, 1, 366), arg("tz", 0, -840, 840)
            key = f"folders:{group}:{folder}:{days}:{tz}:{state['last_scan']}"
            self.cached(key, 30, lambda: folder_report(folder, group, days, tz))
        elif path == "/api/storage":
            account = arg("account", "") or (accounts()[0][0] if accounts() else "")
            self.json(storage_report(account) if account else {"account": "", "listed": False, "items": []})
        elif path == "/api/copy":
            accs = [a for a, _ in accounts()]
            src = arg("src", "") or (accs[0] if accs else "")
            dst = arg("dst", "") or next((a for a in accs if a != src), "")
            if src in accs and dst in accs and src != dst:
                self.json(copy_report(src, dst))
            else:
                self.json({"src": src, "dst": dst, "accounts": accs, "ready": False})
        elif path == "/api/storage/thumb":
            account, key = arg("account", ""), arg("key", "")
            self.image("gthumb", f"{account}\n{key}", google_thumb)
        elif path == "/api/totals":
            self.cached("totals", 60, totals)
        elif path == "/api/settings":
            self.json(public_settings())
        elif path == "/api/files":
            args = (
                arg("q", ""),
                arg("status", "all"),
                arg("folder", ""),
                arg("sort", "new"),
                arg("limit", 60, 1, 500),
                arg("offset", 0, 0, 10**9),
            )
            self.cached("files:" + json.dumps(args), 60, lambda: list_files(*args))
        elif path == "/api/duplicates":
            self.cached("duplicates", 300, duplicates)
        elif path == "/api/activity":
            self.json(activity(arg("kind", "all"), arg("q", ""), arg("before", "") or None, arg("limit", 100, 1, 1000)))
        elif path == "/api/resources":
            self.json(resources_json())
        elif path == "/api/health":
            self.json(health())
        elif path == "/api/thumb":
            self.image("thumb", arg("path", ""), thumbnail)
        elif path == "/api/insights":
            tz = arg("tz", 0, -840, 840)
            self.cached(f"insights:{tz}", 60, lambda: insights(tz))
        elif path == "/api/metrics":
            hours = arg("hours", 24, 1, SAMPLE_DAYS * 24)
            self.cached(f"metrics:{hours}", 60, lambda: metrics(hours))
        elif path == "/api/logs":
            self.json(
                app_logs(arg("level", "all"), arg("q", ""), arg("before", "") or None, arg("limit", 200, 1, 2000))
            )
        elif path == "/api/about":
            self.json(about())
        elif path == "/api/upload":
            if query.get("id"):
                self.json({"offset": chunk_offset(arg("id", ""))})
            else:
                self.json(upload_info())
        elif path == "/api/file":
            self.json(file_info(arg("path", "")))
        elif path == "/api/preview":
            self.image("preview", arg("path", ""), preview)
        elif path == "/api/media":
            target = safe_media_path(arg("path", ""))
            if target:
                self.send_file(
                    target, MEDIA_TYPES.get(ext(target.name), "application/octet-stream"), arg("download", "")
                )
            else:
                self.send(404, "{}")
        elif path == "/api/stream":
            self.stream()
        elif path.startswith("/api/"):
            self.send(404, "{}")
        elif target := static_file(path):
            # Vite gives built assets hashed names, so they can be cached for good.
            cache = "public, max-age=31536000, immutable" if "/assets/" in path else "no-cache"
            self.send(200, target.read_bytes(), CONTENT_TYPES.get(ext(target.name), "application/octet-stream"), cache)
        else:
            self.send(404, "{}")

    def do_POST(self):
        path0 = self.path.partition("?")[0]
        if path0 in ("/login", "/logout"):
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(min(max(n, 0), 4096)).decode(errors="replace")
            self.sign_in(body) if path0 == "/login" else self.sign_out()
            return
        if not self.allowed():
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        path, _, qs = self.path.partition("?")
        if path == "/api/upload":  # streamed straight to disk, not read into memory
            query = urllib.parse.parse_qs(qs)

            def a(k, default=""):
                return query.get(k, [default])[0]

            try:
                if a("id"):
                    code, result = receive_chunk(
                        self.rfile, length, a("id"), int(a("offset", "0")), int(a("total", "0")),
                        a("name"), a("mtime", None), a("folder"),
                    )  # fmt: skip
                else:
                    code, result = receive_upload(self.rfile, length, a("name"), a("mtime", None), a("folder"))
            except Exception as e:
                code, result = 500, {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
            if code != 200:
                self.close_connection = True  # the rest of the body may be unread
            self.json(result, code)
            return
        if path == "/share":  # shared from a phone without the service worker: open the Upload page
            self.close_connection = True
            self.send_response(303)
            self.send_header("Location", "./#/upload")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if not 0 <= length <= 1024 * 1024:
            self.send(413, "{}")
            self.close_connection = True
            return
        body = self.rfile.read(length).decode(errors="replace")
        if path in ("/auth", "/api/auth"):
            try:
                email, error = save_account((urllib.parse.parse_qs(body).get("auth") or [""])[0]), ""
            except ValueError as e:
                email, error = None, str(e)
            if path == "/auth":  # plain form post
                self.send_response(303)
                self.send_header("Location", "./")
                self.end_headers()
            else:
                error = error or "That doesn't look like a login line (it starts with androidId=)"
                self.json({"ok": bool(email), "email": email, "error": "" if email else error}, 200 if email else 400)
        elif path == "/api/accounts/remove":
            email = (json.loads(body or "{}")).get("email", "")
            self.json({"ok": remove_account(email)})
        elif path == "/api/settings":
            try:
                new = update_settings(json.loads(body or "{}"))
            except (ValueError, TypeError) as e:
                self.json({"ok": False, "error": str(e)}, 400)
                return
            log("Settings saved", "info")
            wake.set()
            self.json({"ok": True, "settings": {**new, "notify": public_settings()["notify"]}})
        elif path == "/api/notify/test":
            cfg = get_settings()["notify"]
            if not notify.channels(cfg):
                self.json({"ok": False, "results": {}, "error": "No alert channel is set up"}, 400)
                return
            results = notify.send_now(cfg, "GP Sync", "Test alert: alerts are working.", "bell")
            self.json({"ok": all(v == "ok" for v in results.values()), "results": results})
        elif path == "/api/notify/weekly":
            msg = weekly_summary(force=True)
            self.json({"ok": bool(msg), "message": msg or "Set up an alert channel first"})
        elif path == "/api/health/check-login":
            self.json(check_logins())
        elif path == "/api/sync":
            wake.set()
            self.json({})
        elif path == "/api/pause":
            if PAUSE_FILE.exists():
                PAUSE_FILE.unlink()
                log("Resumed", "resume")
                wake.set()
            else:
                PAUSE_FILE.touch()
                if state["phase"] != "uploading":
                    state["phase"] = "paused"
            notify_change()
            self.json({})
        elif path.startswith("/api/copy/"):
            try:
                req = json.loads(body or "{}")
                src, dst = str(req.get("src", "")), str(req.get("dst", ""))
            except (ValueError, AttributeError):
                self.json({"error": "bad request"}, 400)
                return
            accs = dict(accounts())
            if path == "/api/copy/pause":
                meta_set("copy_paused", "1" if req.get("paused") else "0")
                copy_state["error"] = ""
                copy_wake.set()
                self.json({"ok": True})
            elif src not in accs or dst not in accs or src == dst:
                self.json({"error": "Pick two different connected accounts"}, 400)
            elif path == "/api/copy/refresh":
                _refresh_requests.extend([src, dst])
                reclaim_wake.set()
                self.json({"ok": True})
            elif path == "/api/copy/start":
                try:
                    kinds = [k for k in req.get("kinds") or ["photo", "video"] if k in ("photo", "video")]
                    years = [int(req[k]) if req.get(k) else None for k in ("from_year", "to_year")]
                    self.json(copy_start(src, dst, kinds, *years))
                except ValueError as e:
                    self.json({"error": str(e)}, 400)
            elif path == "/api/copy/stop":
                self.json(copy_stop(src, dst))
            elif path == "/api/copy/retry":
                self.json(copy_retry(src, dst))
            else:
                self.send(404, "{}")
        elif path.startswith("/api/storage/"):
            try:
                req = json.loads(body or "{}")
                account, keys = str(req.get("account", "")), [str(k) for k in req.get("keys") or []][:1000]
            except (ValueError, AttributeError):
                self.json({"error": "bad request"}, 400)
                return
            if account not in dict(accounts()):
                self.json({"error": "unknown account"}, 400)
            elif path == "/api/storage/refresh":
                _refresh_requests.append(account)
                reclaim_wake.set()
                self.json({"ok": True})
            elif path == "/api/storage/download":
                self.json(reclaim_queue(account, keys))
            elif path == "/api/storage/cancel":
                self.json(reclaim_cancel(account, keys))
            elif path == "/api/storage/check":
                if req.get("unblock"):  # the user read why it stopped and wants to go on
                    q("UPDATE reclaim SET state='counted' WHERE account=? AND state='counts'", (account,))
                reclaim_wake.set()
                self.json({"ok": True})
            else:
                self.send(404, "{}")
        elif path == "/api/retry":
            one = (json.loads(body or "{}") if body.strip().startswith("{") else {}).get("path")
            if one:
                self.json({"ok": retry_file(one)})
            else:
                q("UPDATE files SET attempts=0 WHERE status='failed'")
                q("UPDATE copies SET attempts=0 WHERE status='failed'")
                wake.set()
                self.json({})
        else:
            self.send(404, "{}")


def main():
    os.chdir(DATA)  # gpmc writes failed_skipped_files.log to the working folder
    sys.stdout = LogTee(sys.stdout, "info")
    sys.stderr = LogTee(sys.stderr, "error")
    threading.Thread(target=log_writer, daemon=True).start()
    migrate_accounts()
    migrate_stats()
    init_events()
    backfill_stats()
    log(f"GP Sync {VERSION}: watching {MEDIA} every {INTERVAL // 60} min", "scan")
    threading.Thread(target=sampler, daemon=True).start()
    threading.Thread(target=hasher, daemon=True).start()
    threading.Thread(target=latency_sampler, daemon=True).start()
    threading.Thread(target=minute_sampler, daemon=True).start()
    with contextlib.suppress(Exception):  # gpmc sets a signal handler on import: main thread only
        import gpmc.client  # noqa: F401
    threading.Thread(target=reclaim_worker, daemon=True).start()
    threading.Thread(target=copy_worker, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    worker()  # gpmc installs signal handlers, so it must run on the main thread


if __name__ == "__main__":
    main()
