"""Phone uploads, upload times, insights, metrics, app log and the Vite dashboard."""

import json
import os
import sqlite3
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from helpers import FakeClient, post

import sync


@pytest.fixture
def uploads(media):
    sync.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    return sync.UPLOAD_DIR


def send(server, name, data, mtime_ms=None):
    q = urllib.parse.urlencode({"name": name, **({"mtime": mtime_ms} if mtime_ms else {})})
    code, body = post(f"{server}/api/upload?{q}", data)
    return code, json.loads(body or b"{}")


# --- uploads from phones


def test_upload_lands_in_month_folder(server, uploads, monkeypatch):
    monkeypatch.setattr(sync, "_owned", lambda p: None)
    when = 1_760_000_000_000  # 2025-10-09 UTC, in milliseconds like File.lastModified
    code, r = send(server, "IMG_1.jpg", b"photo-bytes", when)
    assert code == 200 and r["saved"] == "Photos/Uploads/2025/10/IMG_1.jpg"
    saved = sync.MEDIA / r["saved"]
    assert saved.read_bytes() == b"photo-bytes"
    assert int(saved.stat().st_mtime) == when // 1000  # keeps the photo's own date
    assert not list(saved.parent.glob(".*.part"))  # no temp files left behind

    # Same file again: recognised, not stored twice. Same name, other content: kept apart.
    code, r = send(server, "IMG_1.jpg", b"photo-bytes", when)
    assert r["duplicate"] == "Photos/Uploads/2025/10/IMG_1.jpg"
    code, r = send(server, "IMG_1.jpg", b"other-bytes", when)
    assert r["saved"] == "Photos/Uploads/2025/10/IMG_1 (1).jpg"


def test_upload_found_by_fingerprint_anywhere(server, uploads):
    import hashlib

    (sync.MEDIA / "Photos/old.jpg").write_bytes(b"same")  # still on this server
    sync.q(
        "INSERT INTO files (path,size,mtime,status,attempts,updated,sha1) VALUES (?,?,?,?,0,0,?)",
        (str(sync.MEDIA / "Photos/old.jpg"), 4, 0, "uploaded", hashlib.sha1(b"same").hexdigest()),
    )
    code, r = send(server, "copy.jpg", b"same")
    assert code == 200 and r["duplicate"] == "Photos/old.jpg"
    assert not list(uploads.rglob("copy.jpg"))


def test_upload_is_safe(server, uploads):
    assert send(server, "notes.txt", b"x")[0] == 400  # only photos and videos
    assert send(server, "empty.jpg", b"")[0] == 400
    code, r = send(server, "../../../escape.jpg", b"x")  # folder parts are dropped
    assert code == 200 and Path(r["saved"]).name == "escape.jpg"
    assert (sync.MEDIA / r["saved"]).resolve().is_relative_to(uploads.resolve())


def test_upload_needs_the_folder(server, media, monkeypatch, tmp_path):
    monkeypatch.setattr(sync, "UPLOAD_DIR", tmp_path / "missing")
    assert send(server, "a.jpg", b"x")[0] == 503
    with urllib.request.urlopen(server + "/api/upload") as r:
        assert json.load(r)["ready"] is False


def test_uploaded_file_is_backed_up(server, uploads, monkeypatch):
    monkeypatch.setattr(sync, "_owned", lambda p: None)
    code, r = send(server, "phone.jpg", b"from-phone", 1_700_000_000_000)
    assert code == 200
    assert any(sync.rel(p) == r["saved"] for p, *_ in sync.scan())


def test_share_without_service_worker_opens_upload_page(server):
    req = urllib.request.Request(server + "/share", data=b"--x--", method="POST")

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a):
            return None

    with pytest.raises(urllib.error.HTTPError) as e:
        urllib.request.build_opener(NoRedirect).open(req)
    assert e.value.code == 303 and e.value.headers["Location"].endswith("#/upload")


# --- upload times and insights


def test_upload_times_are_recorded(media, clean_stats):
    sync.sq("DELETE FROM uploads")
    todo = sync.scan()
    sync.upload_all(FakeClient({"a.jpg": "uploading", "b.HEIC": "skipped", "c.mp4": KeyError("x")}), todo)
    rows = dict(sync.sq("SELECT name, result FROM uploads"))
    assert rows == {"Photos/trip/a.jpg": "uploaded", "Photos/b.HEIC": "exists", "Videos/c.mp4": "failed"}
    t = sync.totals()
    assert "photo_ms" in t and "video_ms" in t


def test_insights(media, clean_stats):
    sync.sq("DELETE FROM uploads")
    sync.scan()
    sync.save_upload("Photos/x.jpg", "photo", 4_000_000, 2000, "uploaded", "a")
    sync.save_upload("Photos/y.jpg", "photo", 2_000_000, 1000, "uploaded", "a")
    sync.save_upload("Videos/z.mp4", "video", 90_000_000, 60_000, "uploaded", "a")
    sync.add_stats(photos=2, photo_bytes=6_000_000, photo_ms=3000, videos=1, video_bytes=90_000_000, video_ms=60_000)
    i = sync.insights(0)
    assert i["upload_ms"] == 63_000
    assert i["photo"]["avg_ms"] == 1500 and i["video"]["avg_ms"] == 60_000
    assert i["photo"]["avg_bytes"] == 150  # library average: a.jpg 100 + b.HEIC 200
    assert i["video"]["avg_uploaded_bytes"] == 90_000_000
    assert sum(i["by_hour"]) == 3 and sum(i["by_weekday"]) == 3
    assert i["largest"][0]["name"] == "Videos/z.mp4"
    assert {t["ext"] for t in i["types"]} == {"jpg", "heic", "mp4"}


def test_new_statistics_columns_are_added_to_old_databases(tmp_path):
    conn = sqlite3.connect(tmp_path / "old.db")
    old = sync.HOURLY_SCHEMA  # 1.6 schema had no *_ms columns
    conn.execute(old)
    conn.execute("INSERT INTO hourly (hour, photos) VALUES (1, 5)")
    conn.commit()
    sync._create_stats_tables(conn)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(hourly)")}
    assert {"photo_ms", "video_ms"} <= cols
    assert conn.execute("SELECT photos, photo_ms FROM hourly").fetchall() == [(5, 0)]
    sync._create_stats_tables(conn)  # running again changes nothing


# --- metrics and app log


def test_metrics_history():
    sync.sq("DELETE FROM samples")
    now = int(time.time() // 60)
    for m in range(10):
        sync.save_minute(now - m, 1000.0 * m, 50.0, 5.0, 10_000_000, 30.0)
    out = sync.metrics(1)
    assert out["step_min"] == 1 and len(out["points"]) == 10
    assert out["points"][-1]["latency"] == 30.0


def test_app_log_is_saved(server):
    sync.sq("DELETE FROM logs")
    import io

    tee = sync.LogTee(io.StringIO(), "error")
    tee.write("2026-11-04 10:00:00 Something broke\nsecond line")
    tee.write(" continues\n")
    sync.flush_logs()
    texts = [x["text"] for x in sync.app_logs("error")["items"]]
    assert texts == ["second line continues", "Something broke"]  # newest first, time prefix removed
    with urllib.request.urlopen(server + "/api/logs?level=error&q=broke") as r:
        assert [x["text"] for x in json.load(r)["items"]] == ["Something broke"]


def test_library_warnings_are_one_line_each():
    import io
    import logging

    sync.sq("DELETE FROM logs")
    tee = sync.LogTee(io.StringIO(), "error")
    handler = logging.StreamHandler(tee)
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    logger = logging.getLogger("urllib3.test")
    logger.addHandler(handler)
    try:
        logger.warning("Retrying (Retry(total=5)) after connection broken by " + "x" * 200)
    finally:
        logger.removeHandler(handler)
    sync.flush_logs()
    items = sync.app_logs("error")["items"]
    assert len(items) == 1 and items[0]["level"] == "warning" and items[0]["text"].endswith("x" * 200)


def test_about(server):
    with urllib.request.urlopen(server + "/api/about") as r:
        a = json.load(r)
    assert a["version"] == sync.VERSION and a["packages"]["gpmc"] and a["packages"]["pyturso"]


def test_api_endpoints_answer(server, media):
    for path in ("insights?tz=60", "metrics?hours=24", "logs", "about", "upload", "health", "status"):
        with urllib.request.urlopen(f"{server}/api/{path}") as r:
            assert r.status == 200 and json.load(r) is not None
    with pytest.raises(urllib.error.HTTPError) as e:
        urllib.request.urlopen(server + "/api/nope")
    assert e.value.code == 404


# --- the built dashboard


def test_dashboard_is_built_and_served(server):
    assert (sync.STATIC_DIR / "index.html").exists(), "run `npx vp build` in web/ first"
    with urllib.request.urlopen(server + "/") as r:
        html = r.read().decode()
        assert r.headers["Content-Type"].startswith("text/html")
    asset = next(p for p in (sync.STATIC_DIR / "assets").iterdir() if p.suffix == ".js")
    with urllib.request.urlopen(f"{server}/assets/{asset.name}") as r:
        assert "immutable" in r.headers["Cache-Control"]
        assert r.headers["Content-Type"].startswith("text/javascript")
    assert asset.name in html


@pytest.mark.parametrize("path", ["/../sync.py", "/%2e%2e/sync.py", "/..%2fsync.py", "/assets/../../VERSION"])
def test_static_files_stay_inside_the_dashboard(server, path):
    with pytest.raises(urllib.error.HTTPError) as e:
        urllib.request.urlopen(server + path)
    assert e.value.code == 404


def test_manifest_can_receive_shared_photos(server):
    with urllib.request.urlopen(server + "/manifest.webmanifest") as r:
        m = json.load(r)
    assert m["share_target"]["params"]["files"][0]["name"] == "media"
    assert os.path.exists(sync.STATIC_DIR / "sw.js")


def test_old_activity_is_relabelled():
    sync.sq("DELETE FROM events")
    for text, kind in (
        ("Fixed the date of a.jpg: 2026-10-28 15:49 UTC", "uploaded"),
        ("Freed 3 MB of Google storage: b.jpg", "uploaded"),
        ("Uploaded c.jpg (1 MB in 2s)", "uploaded"),
        ("Deleted b.jpg in Google Photos to upload it again for free", "info"),
    ):
        sync.save_event(time.time(), kind, text)
    sync.init_events()
    assert [k for (k,) in sync.sq("SELECT kind FROM events ORDER BY rowid")] == [
        "fixed",
        "freed",
        "uploaded",
        "deleted",
    ]
