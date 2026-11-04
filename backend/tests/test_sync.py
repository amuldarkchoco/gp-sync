import inspect
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

import pytest
import requests
from helpers import FAKE_AUTH, FakeClient, post, time_at

import sync

# --- gpmc contract: sync.py relies on these internals, so updates must keep them.


def test_gpmc_upload_file_signature():
    from gpmc import Client

    params = inspect.signature(Client._upload_file).parameters
    for name in ("file_path", "hash_value", "progress", "force_upload", "use_quota", "saver", "progress_callback"):
        assert name in params, f"gpmc Client._upload_file lost parameter {name!r}"


def test_gpmc_reports_skipped_phase():
    from gpmc import Client

    src = inspect.getsource(Client._upload_file)
    assert 'report("skipped"' in src, "gpmc no longer reports files already in Google Photos"
    assert "find_remote_media_by_hash" in src


def test_gpmc_client_accepts_our_arguments():
    from gpmc import Client

    params = inspect.signature(Client.__init__).parameters
    assert "auth_data" in params and "log_level" in params


def test_rich_progress_can_be_disabled():
    from rich.progress import Progress

    with Progress(disable=True) as bar:
        bar.add_task("x")


# --- error handling


def http_error(code):
    response = requests.Response()
    response.status_code = code
    return requests.HTTPError(response=response)


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (http_error(401), "login"),
        (http_error(403), "login"),
        (http_error(429), "busy"),
        (http_error(503), "busy"),
        (requests.ConnectionError("x"), "connection"),
        (requests.Timeout("x"), "connection"),
        (ValueError("Error=BadAuthentication"), "login"),
        (http_error(400), ""),
        (KeyError("client_sig"), ""),
    ],
)
def test_outage_kind(error, expected):
    result = sync.outage_kind(error)
    assert (expected in result) if expected else result == ""


# --- scanning and uploading


def test_scan_finds_only_media(media):
    todo = sync.scan()
    names = sorted(Path(p).name for p, *_ in todo)
    assert names == ["a.jpg", "b.HEIC", "c.mp4"]
    assert sync.state["library"]["files"] == 3
    assert sync.state["library"]["bytes"] == 600


def test_upload_records_results_and_retries(media):
    todo = sync.scan()
    client = FakeClient({"a.jpg": "uploading", "b.HEIC": "skipped", "c.mp4": KeyError("bad file")})
    sync.upload_all(client, todo)
    status = dict((Path(p).name, s) for p, s in sync.q("SELECT path,status FROM files"))
    assert status == {"a.jpg": "uploaded", "b.HEIC": "exists", "c.mp4": "failed"}

    # Next scan only retries the failed file.
    assert [Path(p).name for p, *_ in sync.scan()] == ["c.mp4"]
    assert sync.state["library"]["synced_files"] == 2


def test_outage_does_not_use_up_retries(media):
    todo = sync.scan()
    client = FakeClient({"a.jpg": requests.ConnectionError("offline"), "b.HEIC": "uploading", "c.mp4": "uploading"})
    sync.upload_all(client, todo)
    assert sync.q("SELECT COUNT(*) FROM files WHERE status='failed'")[0][0] == 0
    assert "connection" in sync.state["error"]


def test_gives_up_after_max_attempts(media):
    for _ in range(sync.MAX_ATTEMPTS):
        todo = [t for t in sync.scan() if Path(t[0]).name == "a.jpg"]
        sync.upload_all(FakeClient({"a.jpg": KeyError("bad")}), todo)
    assert "a.jpg" not in [Path(p).name for p, *_ in sync.scan()]


# --- web page and API


def test_page_and_status(server):
    with urllib.request.urlopen(server + "/") as r:
        html = r.read().decode()
    assert "GP Sync" in html and "api/status" in html
    with urllib.request.urlopen(server + "/icon.svg") as r:
        assert r.headers["Content-Type"] == "image/svg+xml" and b"<svg" in r.read()
    with urllib.request.urlopen(server + "/api/status") as r:
        data = json.load(r)
    for key in ("phase", "library", "counts", "net", "failed", "log", "current", "account"):
        assert key in data


def test_auth_saved_privately(server):
    assert post(server + "/api/auth", b"auth=nonsense")[0] == 400
    code, _ = post(server + "/api/auth", b"auth=" + urllib.request.quote(" junk " + FAKE_AUTH).encode())
    assert code == 200
    saved = sync._account_file("test@example.com")
    assert saved.read_text() == FAKE_AUTH
    assert oct(os.stat(saved).st_mode & 0o777) == "0o600"
    with urllib.request.urlopen(server + "/api/status") as r:
        assert json.load(r)["account"] == "test@example.com"


def test_pause_toggles(server):
    sync.PAUSE_FILE.unlink(missing_ok=True)
    post(server + "/api/pause")
    assert sync.PAUSE_FILE.exists()
    post(server + "/api/pause")
    assert not sync.PAUSE_FILE.exists()


def test_network_counters():
    rx, tx = sync.read_net_counters()
    assert rx >= 0 and tx >= 0


# --- statistics


def test_stats_add_up_per_hour(clean_stats):
    t = 1_800_000_000  # a fixed moment
    sync.add_stats(t, photos=1, photo_bytes=100)
    sync.add_stats(t + 10, photos=2, photo_bytes=50, peak_up=10.0)
    sync.add_stats(t + 20, net_sent=7, peak_up=5.0)
    row = sync.sq("SELECT photos, photo_bytes, net_sent, peak_up FROM hourly")
    assert row == [(3, 150, 7, 10.0)]


def test_history_groups_days_in_viewer_time_zone(clean_stats):
    # 23:30 UTC belongs to the next day in India (UTC+5:30).
    t = time_at("2026-11-03 23:30")
    sync.add_stats(t, videos=1, video_bytes=10)
    utc = {d["day"]: d for d in sync.history(3650, 0)["data"]}
    india = {d["day"]: d for d in sync.history(3650, 330)["data"]}
    assert utc["2026-11-03"]["videos"] == 1
    assert india["2026-11-04"]["videos"] == 1


def test_history_window(clean_stats):
    sync.add_stats(sync.time.time() - 400 * 86400, photos=1)
    sync.add_stats(sync.time.time(), photos=1)
    assert len(sync.history(30, 0)["data"]) == 1
    assert sync.totals()["photos"] == 2


def test_backfill_from_existing_uploads(clean_stats, media):
    t = time_at("2026-10-01 12:00")
    for name, status in (("a.jpg", "uploaded"), ("c.mp4", "uploaded"), ("b.HEIC", "exists")):
        path = next(str(p) for p in sync.MEDIA.rglob(name))
        sync.q(
            "INSERT OR REPLACE INTO files (path,size,mtime,status,media_key,error,attempts,updated)"
            " VALUES (?,?,?,?,?,?,0,?)",
            (path, 5, 0, status, "k", "", t),
        )
    sync.backfill_stats()
    sync.backfill_stats()  # second run must not double count
    tot = sync.totals()
    assert (tot["photos"], tot["videos"], tot["existing"], tot["photo_bytes"]) == (1, 1, 1, 5)


def test_upload_records_daily_stats(clean_stats, media):
    todo = sync.scan()
    sync.upload_all(FakeClient({"a.jpg": "uploading", "b.HEIC": "skipped", "c.mp4": KeyError("x")}), todo)
    tot = sync.totals()
    assert (tot["photos"], tot["existing"], tot["failed"], tot["photo_bytes"]) == (1, 1, 1, 100)


def test_history_api(server, clean_stats):
    sync.add_stats(photos=4)
    with urllib.request.urlopen(server + "/api/history?days=7&tz=330") as r:
        data = json.load(r)
    assert data["days"] == 7 and data["tz_offset_min"] == 330
    assert data["data"][-1]["photos"] == 4
    with urllib.request.urlopen(server + "/api/history?days=abc&tz=99999") as r:
        assert json.load(r)["tz_offset_min"] == 840  # clamped, bad numbers fall back
    with urllib.request.urlopen(server + "/api/totals") as r:
        assert json.load(r)["photos"] == 4
