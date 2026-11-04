"""Shared test helpers."""

import urllib.error
import urllib.request
from pathlib import Path

import sync

FAKE_AUTH = "androidId=abc&app=com.google.android.apps.photos&Email=test%40example.com&lang=en_US&Token=x"


class FakeClient:
    """Stands in for gpmc.Client: uploads, finds existing, or fails per file name."""

    def __init__(self, outcomes):
        self.outcomes = outcomes

    def _upload_file(self, file_path, hash_value, progress, force_upload, use_quota, saver, progress_callback):
        outcome = self.outcomes[Path(file_path).name]
        if isinstance(outcome, Exception):
            raise outcome
        progress_callback({"phase": outcome, "bytes_completed": 1, "bytes_total": 1})
        return {str(file_path): "media-key"}


def post(url, body=b""):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=body, method="POST")) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def time_at(text):
    import calendar

    return calendar.timegm(sync.time.strptime(text, "%Y-%m-%d %H:%M"))


def test_statistics_use_turso():
    assert sync.STATS_ENGINE.startswith("Turso"), sync.STATS_ENGINE


def test_add_stats_never_raises(clean_stats, monkeypatch):
    def broken(*a, **k):
        raise RuntimeError("database is broken")

    monkeypatch.setattr(sync, "sq", broken)
    sync.add_stats(photos=1)  # must not raise


def test_migrates_stats_from_state_db(clean_stats):
    with sync.db_lock:
        sync.CONN.execute(sync.HOURLY_SCHEMA)
        sync.CONN.execute("INSERT INTO hourly (hour, photos, net_sent) VALUES (500000, 7, 99)")
        sync.CONN.commit()
    sync.migrate_stats()
    assert sync.sq("SELECT photos, net_sent FROM hourly WHERE hour=500000") == [(7, 99)]
    assert not sync.q("SELECT 1 FROM sqlite_master WHERE name='hourly'")
    sync.migrate_stats()  # nothing left to move: no error


def test_falls_back_to_sqlite_without_turso(monkeypatch):
    import sys

    monkeypatch.setitem(sys.modules, "turso", None)  # makes "import turso" fail
    conn, engine = sync.open_stats()
    assert engine.startswith("SQLite")
    assert conn.execute("SELECT COUNT(*) FROM hourly").fetchone()[0] >= 0
    conn.close()
