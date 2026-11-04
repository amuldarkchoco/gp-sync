"""Cache (Redis or memory), lighter idle work, scan-now while paused,
HEAD requests, thumbnails made ahead of time and the installable app."""

import json
import urllib.error
import urllib.request

import pytest
from helpers import post

import cache
import sync


def get(server, path, method="GET"):
    req = urllib.request.Request(server + path, method=method)
    with urllib.request.urlopen(req) as r:
        return r.status, dict(r.headers), r.read()


# --- cache


def test_memory_cache_and_generation():
    cache.clear()
    calls = []

    def make():
        calls.append(1)
        return b"answer"

    assert cache.remember("k", 60, make) == b"answer"
    assert cache.remember("k", 60, make) == b"answer"
    assert len(calls) == 1  # second answer came from the cache
    cache.bump()
    cache.remember("k", 60, make)
    assert len(calls) == 2  # data changed: made again


def test_database_writes_make_cached_answers_stale(media):
    gen = cache.generation()
    sync.q("SELECT COUNT(*) FROM files")
    assert cache.generation() == gen  # reads keep the cache
    sync.q("UPDATE files SET attempts=0 WHERE 0")
    assert cache.generation() > gen


def test_unreachable_redis_falls_back_to_memory(monkeypatch):
    monkeypatch.setattr(cache, "URL", "redis://127.0.0.1:1/0")  # nothing listens on port 1
    monkeypatch.setattr(cache, "_client", None)
    monkeypatch.setattr(cache, "_down_until", 0.0)
    cache.set("x", b"1", 60)
    assert cache.get("x") == b"1"
    assert cache.info()["backend"] == "memory (Redis unreachable)"


def test_memory_cache_stays_bounded(monkeypatch):
    cache.clear()
    monkeypatch.setattr(cache, "MEMORY_LIMIT", 1000)
    for i in range(50):
        cache.set(f"k{i}", b"x" * 100, 60)
    assert cache._mem_bytes <= 1000
    assert cache.get("k49") == b"x" * 100 and cache.get("k0") is None


def test_files_answer_is_cached_until_data_changes(server, media):
    sync.scan()
    sync.q("INSERT INTO files (path,size,mtime,status,updated) VALUES (?,?,?,?,?)", ("/x/a.jpg", 1, 1, "uploaded", 1))
    first = json.loads(get(server, "/api/files")[2])["total"]
    sync.q("INSERT INTO files (path,size,mtime,status,updated) VALUES (?,?,?,?,?)", ("/x/b.jpg", 1, 1, "uploaded", 2))
    assert json.loads(get(server, "/api/files")[2])["total"] == first + 1


def test_health_reports_the_cache(server, media):
    h = json.loads(get(server, "/api/health")[2])
    assert h["cache"]["backend"].startswith("memory")
    assert {"hits", "misses", "hit_rate", "keys"} <= h["cache"].keys()


# --- status shared by every dashboard


def test_status_body_is_shared_and_refreshes_on_change(media):
    a = sync.status_body()
    assert sync.status_body() is a  # same answer within a second
    sync.notify_change()
    assert sync.status_body() is not a


# --- scan now while paused or without an account


def test_scan_while_paused_counts_and_records_time(media):
    sync.PAUSE_FILE.touch()
    try:
        sync.state["last_scan"] = 0
        sync.run_round()
        assert sync.state["phase"] == "paused"
        assert sync.state["last_scan"] > 0
        assert sync.state["library"]["files"] == 3
    finally:
        sync.PAUSE_FILE.unlink(missing_ok=True)


def test_scan_without_account_is_setup(media):
    for f in sync.ACCOUNTS_DIR.glob("*.auth"):
        f.unlink()
    sync.state["last_scan"] = 0
    sync.run_round()
    assert sync.state["phase"] == "setup" and sync.state["last_scan"] > 0


# --- lighter when nobody is watching


def test_sampling_slows_down_when_unwatched(monkeypatch):
    monkeypatch.setitem(sync.viewers, "streams", 0)
    monkeypatch.setitem(sync.viewers, "last_request", 0.0)
    monkeypatch.setitem(sync.state, "phase", "idle")
    assert not sync.watched() and sync.sample_step() == sync.IDLE_STEP
    sync.saw_viewer()
    assert sync.watched() and sync.sample_step() == 1
    monkeypatch.setitem(sync.viewers, "last_request", 0.0)
    monkeypatch.setitem(sync.state, "phase", "uploading")
    assert sync.sample_step() == 1


def test_memory_leaves_out_file_cache(monkeypatch, tmp_path):
    (tmp_path / "memory.current").write_text("1000000\n")
    (tmp_path / "memory.max").write_text("max\n")
    (tmp_path / "memory.stat").write_text("anon 500000\ninactive_file 400000\nactive_file 100000\n")
    monkeypatch.setattr(sync, "CGROUP", tmp_path)
    used, _ = sync.read_memory()
    assert used == 600000


# --- thumbnails ahead of time


def test_thumbnails_are_made_ahead_of_time(media, monkeypatch):
    from PIL import Image

    Image.new("RGB", (800, 600), (10, 120, 200)).save(media / "Photos" / "pic.jpg")
    path = str(media / "Photos" / "pic.jpg")
    st = (media / "Photos" / "pic.jpg").stat()
    sync.q(
        "INSERT INTO files (path,size,mtime,status,updated) VALUES (?,?,?,?,?)",
        (path, st.st_size, st.st_mtime, "uploaded", 1),
    )
    sync._thumbs_checked.clear()
    monkeypatch.setitem(sync.state, "phase", "idle")
    assert sync.thumb_some() == 1
    assert sync.media.thumb_path(sync.THUMBS, path, st.st_mtime).exists()
    assert sync.thumb_some() == 0  # nothing left


def test_missing_thumbnail_is_remembered(server, media, monkeypatch):
    cache.clear()
    calls = []
    real = sync.thumbnail
    monkeypatch.setattr(sync, "thumbnail", lambda n: calls.append(n) or real(n))
    for _ in range(2):
        with pytest.raises(urllib.error.HTTPError) as e:
            get(server, "/api/thumb?path=Videos/c.mp4")
        assert e.value.code == 404
    assert len(calls) == 1  # the second 404 came from the cache


# --- web server


def test_head_requests_for_dashboard_files(server):
    code, headers, body = get(server, "/manifest.webmanifest", "HEAD")
    assert code == 200 and body == b""
    assert headers["Content-Type"] == "application/manifest+json"


def test_manifest_is_installable(server):
    m = json.loads(get(server, "/manifest.webmanifest")[2])
    assert m["name"] == "GP Sync" and m["display"] == "standalone"
    purposes = {(i["sizes"], i.get("purpose", "any")) for i in m["icons"]}
    assert {("192x192", "any"), ("512x512", "any"), ("512x512", "maskable")} <= purposes
    html = get(server, "/")[2].decode()
    assert 'crossorigin="use-credentials"' in html  # Umbrel's proxy needs the login cookie


def test_pause_then_scan_keeps_paused(server, media):
    post(server + "/api/pause")
    try:
        assert sync.PAUSE_FILE.exists()
        post(server + "/api/sync")
        sync.run_round()
        assert json.loads(get(server, "/api/status")[2])["phase"] == "paused"
    finally:
        sync.PAUSE_FILE.unlink(missing_ok=True)
