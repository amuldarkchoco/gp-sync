"""Tests for folders, accounts and other features: folders, accounts, schedule, speed limit, albums, alerts,
thumbnails, file search, duplicates, health and the installable app."""

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from helpers import FAKE_AUTH, FakeClient, post, time_at

import sync

OTHER_AUTH = FAKE_AUTH.replace("test%40example.com", "family%40example.com")


def names(todo):
    return sorted(Path(t[0]).name for t in todo)


# --- wave 1: folders and accounts


def test_default_folders_are_photos_and_videos(media):
    (sync.MEDIA / "Downloads").mkdir(exist_ok=True)
    (sync.MEDIA / "Downloads" / "movie.mp4").write_bytes(b"m" * 50)
    fmap = sync.folder_map()
    assert fmap["Photos"] == fmap["Videos"] == "test@example.com"
    assert fmap["Downloads"] == ""
    assert "movie.mp4" not in names(sync.scan())
    assert sync.state["folders"]["Downloads"]["files"] == 1  # counted, not backed up


def test_choose_folders(media):
    (sync.MEDIA / "Downloads").mkdir(exist_ok=True)
    (sync.MEDIA / "Downloads" / "movie.mp4").write_bytes(b"m" * 50)
    sync.update_settings({"folders": {"Downloads": "test@example.com", "Photos": "", "Videos": ""}})
    assert names(sync.scan()) == ["movie.mp4"]
    sync.update_settings({"folders": {"Downloads": "nobody@example.com"}})  # unknown account: skipped
    assert names(sync.scan()) == []


def test_second_account_gets_its_own_folder(media):
    sync.save_account(OTHER_AUTH)
    assert [a for a, _ in sync.accounts()] == ["test@example.com", "family@example.com"]
    sync.update_settings({"folders": {"Photos": "test@example.com", "Videos": "family@example.com"}})
    by_account = {Path(p).name: acc for p, _, _, acc in sync.scan()}
    assert by_account == {"a.jpg": "test@example.com", "b.HEIC": "test@example.com", "c.mp4": "family@example.com"}


def test_moving_a_folder_to_another_account_uploads_again(media):
    sync.save_account(OTHER_AUTH)
    todo = sync.scan()
    sync.upload_all(
        FakeClient({"a.jpg": "uploading", "b.HEIC": "uploading", "c.mp4": "uploading"}), todo, "test@example.com"
    )
    assert sync.scan() == []
    sync.update_settings({"folders": {"Photos": "test@example.com", "Videos": "family@example.com"}})
    assert [(Path(p).name, a) for p, _, _, a in sync.scan()] == [("c.mp4", "family@example.com")]


def test_replacing_a_login_keeps_account_order(media):
    sync.save_account(OTHER_AUTH)
    sync.save_account(FAKE_AUTH.replace("Token=x", "Token=y"))
    assert sync.accounts()[0][0] == "test@example.com"
    assert sync.remove_account("family@example.com")
    assert [a for a, _ in sync.accounts()] == ["test@example.com"]


def test_legacy_login_becomes_first_account(media):
    for f in sync.ACCOUNTS_DIR.glob("*.auth"):
        f.unlink()
    sync.LEGACY_AUTH_FILE.write_text(FAKE_AUTH)
    sync.q("INSERT OR REPLACE INTO files (path,size,mtime,status) VALUES ('/x/old.jpg',1,1,'uploaded')")
    sync.migrate_accounts()
    assert [a for a, _ in sync.accounts()] == ["test@example.com"]
    assert sync.q("SELECT account FROM files WHERE path='/x/old.jpg'") == [("test@example.com",)]
    sync.LEGACY_AUTH_FILE.unlink()


def test_accounts_api(server, media):
    code, body = post(server + "/api/auth", b"auth=" + urllib.request.quote(OTHER_AUTH).encode())
    assert code == 200 and json.loads(body)["email"] == "family@example.com"
    with urllib.request.urlopen(server + "/api/status") as r:
        assert json.load(r)["accounts"] == ["test@example.com", "family@example.com"]
    post(server + "/api/accounts/remove", json.dumps({"email": "family@example.com"}).encode())
    assert [a for a, _ in sync.accounts()] == ["test@example.com"]


def test_account_file_named_differently(server, media):
    # A login file whose name is not the email inside it: Health still loads and Remove deletes it.
    odd = sync.ACCOUNTS_DIR / "renamed.auth"
    odd.write_text(OTHER_AUTH)
    with urllib.request.urlopen(server + "/api/health") as r:
        accs = {a["email"]: a for a in json.load(r)["accounts"]}
    assert accs["family@example.com"]["login_saved"] > 0
    code, body = post(server + "/api/accounts/remove", json.dumps({"email": "family@example.com"}).encode())
    assert code == 200 and json.loads(body)["ok"] is True and not odd.exists()
    assert [a for a, _ in sync.accounts()] == ["test@example.com"]


# --- wave 1: schedule and speed limit


def at_local_hour(hour, tz=0):
    return 1_800_000_000 // 86400 * 86400 + hour * 3600 - tz * 60 + 60


@pytest.mark.parametrize(
    ("start", "end", "hour", "allowed"),
    [(1, 7, 3, True), (1, 7, 7, False), (1, 7, 0, False), (22, 6, 23, True), (22, 6, 5, True), (22, 6, 12, False)],
)
def test_schedule_window(start, end, hour, allowed):
    st = sync._merge(sync.DEFAULT_SETTINGS, {"schedule": {"enabled": True, "start": start, "end": end}})
    st["tz_offset_min"] = 330
    assert sync.upload_allowed(st, at_local_hour(hour, 330)) is allowed


def test_schedule_off_always_allows():
    st = sync.get_settings()
    assert sync.upload_allowed(st, at_local_hour(13))


def test_next_window_opens_at_start_hour():
    st = sync._merge(sync.DEFAULT_SETTINGS, {"schedule": {"enabled": True, "start": 1, "end": 7}})
    t = sync.next_window(st, at_local_hour(12))
    assert sync.local_hour(st, t) == 1 and t > at_local_hour(12)


def test_upload_stops_outside_window(media, monkeypatch):
    sync.update_settings({"schedule": {"enabled": True, "start": 1, "end": 2}})
    monkeypatch.setattr(sync, "upload_allowed", lambda st=None, now=None: False)
    sync.upload_all(FakeClient({}), sync.scan(), "test@example.com")
    assert sync.q("SELECT COUNT(*) FROM files")[0][0] == 0


def test_speed_limit_sleeps(monkeypatch):
    slept = []
    clock = iter([100.0, 100.5])
    monkeypatch.setattr(sync.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(sync.time, "sleep", slept.append)
    t = sync.Throttle(8)  # 8 Mbps = 1 MB/s
    t(0)
    t(1_000_000)  # 1 MB after 0.5 s: half a second ahead
    assert slept == [pytest.approx(0.5)]
    sync.Throttle(0)(10**9)  # no limit: never sleeps
    assert len(slept) == 1


# --- settings


def test_settings_validation_and_secrets(media):
    with pytest.raises(ValueError):
        sync.update_settings({"notify": {"ntfy_url": "ntfy.sh/topic"}})
    sync.update_settings({"notify": {"ntfy_url": "https://ntfy.sh/t", "ntfy_token": "secret"}, "albums": "bogus"})
    sync.update_settings({"notify": {"ntfy_token": ""}, "speed_limit_mbps": "12.5"})  # empty keeps the secret
    st = sync.get_settings()
    assert st["notify"]["ntfy_token"] == "secret" and st["albums"] == "off" and st["speed_limit_mbps"] == 12.5
    pub = sync.public_settings()
    assert pub["notify"]["ntfy_token"] == "" and pub["notify"]["ntfy_token_set"] is True
    assert sync.DEFAULT_SETTINGS["notify"]["ntfy_token"] == ""  # defaults untouched


def test_settings_api(server, media):
    code, body = post(server + "/api/settings", json.dumps({"schedule": {"enabled": True, "start": 25}}).encode())
    assert code == 200 and json.loads(body)["settings"]["schedule"]["start"] == 1
    assert post(server + "/api/settings", b"{not json")[0] == 400
    with urllib.request.urlopen(server + "/api/settings") as r:
        assert json.load(r)["schedule"]["enabled"] is True


# --- wave 2: albums, file search, thumbnails


@pytest.mark.parametrize(
    ("name", "mode", "album"),
    [
        ("Photos/iPhone/13/x.jpg", "top", "iPhone"),
        ("Photos/iPhone/13/x.jpg", "parent", "13"),
        ("Photos/x.jpg", "top", "Photos"),
        ("Photos/Goa Trip/x.jpg", "parent", "Goa Trip"),
        ("Photos/Goa Trip/x.jpg", "off", None),
    ],
)
def test_album_name(name, mode, album):
    assert sync.album_name(str(sync.MEDIA / name), mode) == album


class FakeApi:
    def __init__(self, fail_add=False):
        self.calls, self.fail_add = [], fail_add

    def create_album(self, album_name, media_keys):
        self.calls.append(("create", album_name, list(media_keys)))
        return f"album-{album_name}"

    def add_media_to_album(self, album_media_key, media_keys):
        if self.fail_add:
            raise RuntimeError("album was deleted")
        self.calls.append(("add", album_media_key, list(media_keys)))


def test_albums_are_created_once_then_reused(media):
    client = FakeClient({"a.jpg": "uploading", "b.HEIC": "uploading", "c.mp4": "uploading"})
    client.api = FakeApi()
    sync.update_settings({"albums": "top"})
    sync.upload_all(client, sync.scan())
    assert ("create", "trip", ["media-key"]) in client.api.calls
    sync.flush_albums(client, "test@example.com", {"trip": ["k2"]})
    assert client.api.calls[-1] == ("add", "album-trip", ["k2"])
    client.api.fail_add = True  # deleted in Google Photos: a new album is made
    sync.flush_albums(client, "test@example.com", {"trip": ["k3"]})
    assert client.api.calls[-1] == ("create", "trip", ["k3"])


def test_file_search(server, media):
    sync.upload_all(FakeClient({"a.jpg": "uploading", "b.HEIC": "skipped", "c.mp4": KeyError("bad")}), sync.scan())
    res = sync.list_files(query="trip")
    assert [i["name"] for i in res["items"]] == ["Photos/trip/a.jpg"]
    assert res["items"][0]["google_url"] == "https://photos.google.com/photo/media-key"
    assert [i["name"] for i in sync.list_files(status="failed")["items"]] == ["Videos/c.mp4"]
    assert sync.list_files(folder="Photos")["total"] == 2
    assert [i["size"] for i in sync.list_files(sort="size")["items"]] == [300, 200, 100]
    with urllib.request.urlopen(server + "/api/files?q=HEIC&limit=abc") as r:
        assert json.load(r)["items"][0]["status"] == "exists"


def test_thumbnails(server, media):
    from PIL import Image

    Image.new("RGB", (1200, 800), "orange").save(sync.MEDIA / "Photos" / "big.jpg", quality=90)
    with urllib.request.urlopen(server + "/api/thumb?path=Photos/big.jpg") as r:
        assert r.headers["Content-Type"] == "image/webp"
        thumb = Image.open(__import__("io").BytesIO(r.read()))
        assert max(thumb.size) == 320
    for bad in ("../../etc/passwd", "Photos/missing.jpg", "Photos/trip/../../../x.jpg"):
        assert post(server + "/api/thumb?path=" + bad)[0] in (404, 501)  # POST not allowed
        try:
            urllib.request.urlopen(server + "/api/thumb?path=" + urllib.request.quote(bad))
            raise AssertionError("should be 404")
        except urllib.error.HTTPError as e:
            assert e.code == 404


def test_video_thumbnail_comes_from_google(media, monkeypatch):
    import io

    from gpmc.api import Api
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (640, 360), "blue").save(buf, "JPEG")
    monkeypatch.setattr(Api, "get_thumbnail", lambda self, key, width=None: buf.getvalue())
    sync.upload_all(FakeClient({"a.jpg": "uploading", "b.HEIC": "uploading", "c.mp4": "uploading"}), sync.scan())
    target = sync.thumbnail("Videos/c.mp4")
    assert target and target.suffix == ".webp"


# --- wave 3: alerts, weekly summary, health


@pytest.fixture
def ntfy_server():
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    got = []

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"])).decode()
            got.append(
                {"path": self.path, "title": self.headers["Title"], "auth": self.headers["Authorization"], "body": body}
            )
            self.send_response(200)
            self.end_headers()

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/backups", got
    srv.shutdown()


def test_ntfy_alert(ntfy_server):
    import notify

    url, got = ntfy_server
    res = notify.send_now({"ntfy_url": url, "ntfy_token": "tk"}, "Hello", "World", "tada")
    assert res == {"ntfy": "ok"}
    assert got == [{"path": "/backups", "title": "Hello", "auth": "Bearer tk", "body": "World"}]


def test_telegram_alert(monkeypatch):
    import notify

    seen = []

    class Resp:
        def close(self):
            pass

    monkeypatch.setattr(notify.urllib.request, "urlopen", lambda req, timeout: seen.append(req) or Resp())
    res = notify.send_now({"telegram_token": "123:abc", "telegram_chat": "42"}, "T", "M")
    assert res == {"telegram": "ok"}
    assert seen[0].full_url == "https://api.telegram.org/bot123:abc/sendMessage"
    assert json.loads(seen[0].data) == {"chat_id": "42", "text": "T\nM"}
    assert notify.send_now({}, "T", "M") == {}


def test_alert_events(media, monkeypatch):
    sent = []
    monkeypatch.setattr(sync.notify, "send", lambda cfg, title, message, tags="", on_done=None: sent.append(title))
    sync.update_settings({"notify": {"ntfy_url": "https://ntfy.sh/x", "round_min": 2, "on_gave_up": True}})
    for _ in range(sync.MAX_ATTEMPTS):
        todo = [t for t in sync.scan() if Path(t[0]).name == "c.mp4"]
        sync.upload_all(FakeClient({"c.mp4": KeyError("bad")}), todo)
    assert sent.count("GP Sync: gave up on a file") == 1
    sync.upload_all(FakeClient({"a.jpg": "uploading", "b.HEIC": "uploading"}), sync.scan())
    assert sent[-1] == "GP Sync: backup done"
    sync.update_settings({"notify": {"on_round": False}})
    sent.clear()
    sync.q("DELETE FROM files")
    sync.upload_all(FakeClient({"a.jpg": "uploading", "b.HEIC": "uploading", "c.mp4": "uploading"}), sync.scan())
    assert sent == []


def test_login_rejected_alert_once(media, monkeypatch):
    import requests

    sent = []
    monkeypatch.setattr(sync.notify, "send", lambda cfg, title, message, tags="", on_done=None: sent.append(title))
    resp = requests.Response()
    resp.status_code = 403
    for _ in range(3):
        err = requests.HTTPError(response=resp)
        sync.upload_all(FakeClient({"a.jpg": err, "b.HEIC": err, "c.mp4": err}), sync.scan()[:1])
    assert sent == ["GP Sync: login rejected"]
    assert "rejected the login" in sync.state["error"]  # Uptime Kuma watches for this text


def test_weekly_summary_schedule(media, monkeypatch, clean_stats):
    sent = []
    monkeypatch.setattr(sync.notify, "send", lambda cfg, title, message, tags="", on_done=None: sent.append(message))
    sync.q("DELETE FROM meta WHERE k='weekly_sent'")
    sync.update_settings({"tz_offset_min": 330, "notify": {"ntfy_url": "https://ntfy.sh/x"}})
    monday_0830 = time_at("2026-11-02 08:30") - 330 * 60  # 08:30 in India
    sync.add_stats(monday_0830 - 2 * 86400, photos=5, photo_bytes=2048)  # Saturday
    assert sync.weekly_summary(now=monday_0830) is None  # before 09:00
    msg = sync.weekly_summary(now=monday_0830 + 3600)
    assert "5 photos" in msg and sent == [msg]
    assert sync.weekly_summary(now=monday_0830 + 7200) is None  # only once a week
    assert sync.weekly_summary(now=monday_0830 + 7 * 86400 + 3600) is not None  # next Monday


def test_health(server, media, monkeypatch):
    from gpmc.api import Api

    with urllib.request.urlopen(server + "/api/health") as r:
        h = json.load(r)
    assert h["version"] and h["stats_engine"].startswith("Turso") and h["disk_data"]["free"] > 0
    assert h["accounts"][0]["email"] == "test@example.com"
    monkeypatch.setattr(Api, "bearer_token", property(lambda self: "token"))
    code, body = post(server + "/api/health/check-login")
    assert code == 200 and json.loads(body) == {"test@example.com": "ok"}


# --- wave 4: duplicates and the installable app


def test_duplicate_finder(media):
    (sync.MEDIA / "Photos" / "copy.jpg").write_bytes(b"x" * 100)  # same bytes as trip/a.jpg
    sync.upload_all(
        FakeClient({"a.jpg": "uploading", "b.HEIC": "uploading", "c.mp4": "uploading", "copy.jpg": "skipped"}),
        sync.scan(),
    )
    d = sync.duplicates()
    assert d["wasted"] == 100
    assert sorted(d["groups"][0]["files"]) == ["Photos/copy.jpg", "Photos/trip/a.jpg"]


def test_hasher_fingerprints_old_uploads(media):
    path = str(sync.MEDIA / "Photos" / "trip" / "a.jpg")
    st = Path(path).stat()
    sync.q(
        "INSERT INTO files (path,size,mtime,status,account) VALUES (?,?,?,'uploaded','test@example.com')",
        (path, st.st_size, st.st_mtime),
    )
    sync.state["phase"] = "idle"
    assert sync.hash_some() == 1
    assert (
        sync.q("SELECT sha1 FROM files WHERE path=?", (path,))[0][0]
        == __import__("hashlib").sha1(b"x" * 100).hexdigest()
    )
    assert sync.hash_some() == 0


def test_installable_app(server):
    with urllib.request.urlopen(server + "/manifest.webmanifest") as r:
        m = json.load(r)
    assert m["display"] == "standalone"
    for icon in m["icons"]:
        with urllib.request.urlopen(server + "/" + icon["src"]) as r:
            assert r.status == 200
    with urllib.request.urlopen(server + "/sw.js") as r:
        assert "javascript" in r.headers["Content-Type"]
    with urllib.request.urlopen(server + "/apple-touch-icon.png") as r:
        assert r.headers["Content-Type"] == "image/png"


# --- 1.6: activity history, resources, latency


def test_activity_is_saved_and_filtered(media):
    sync.sq("DELETE FROM events")
    sync.upload_all(FakeClient({"a.jpg": "uploading", "b.HEIC": "skipped", "c.mp4": KeyError("bad")}), sync.scan())
    sync.log("Settings saved", "info")
    everything = sync.activity()["items"]
    assert [e["kind"] for e in everything][:1] == ["info"]  # newest first
    assert [e["name"] for e in sync.activity("uploaded")["items"]] == ["Photos/trip/a.jpg"]
    assert [e["name"] for e in sync.activity("exists")["items"]] == ["Photos/b.HEIC"]
    assert len(sync.activity("failed")["items"]) == 1
    assert sync.activity(query="b.HEIC")["items"][0]["kind"] == "exists"
    oldest = everything[-1]["time"]
    assert sync.activity(before=oldest)["items"] == []


def test_activity_api(server, media):
    sync.sq("DELETE FROM events")
    sync.log("Uploaded Photos/x.jpg", "uploaded", "Photos/x.jpg")
    with urllib.request.urlopen(server + "/api/activity?kind=uploaded&limit=5") as r:
        assert json.load(r)["items"][0]["name"] == "Photos/x.jpg"


def test_old_activity_is_pruned():
    sync.sq("DELETE FROM events")
    sync.save_event(sync.time.time() - (sync.EVENT_DAYS + 1) * 86400, "info", "ancient")
    sync.save_event(sync.time.time(), "info", "fresh")
    sync.init_events()
    assert [e["text"] for e in sync.activity()["items"]] == ["fresh"]


def test_resource_readers():
    assert sync.read_cpu_seconds() > 0
    used, limit = sync.read_memory()
    assert 0 < used <= limit
    rd, wr = sync.read_io()
    assert rd >= 0 and wr >= 0
    r = sync.resources_json()
    assert {"cpu", "mem", "mem_limit", "cores", "latency"} <= r.keys()


def test_latency_measurement():
    import socket

    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen()
    assert sync.measure_latency(("127.0.0.1", srv.getsockname()[1])) >= 0
    srv.close()
    assert sync.measure_latency(("127.0.0.1", 9), timeout=1) is None  # nothing listening


# --- folders and devices


def test_folder_report_counts_any_folder(media):
    (media / "Photos" / "trip" / "day2").mkdir(exist_ok=True)
    (media / "Photos" / "trip" / "day2" / "d.mov").write_bytes(b"v" * 50)
    sync.scan()
    sync.state["last_scan"] = time.time()
    top = sync.folder_report("", "folders", 7)
    names = {c["name"]: c for c in top["children"]}
    assert names["Photos"]["photos"] == 2 and names["Photos"]["videos"] == 1 and names["Photos"]["has_sub"]
    assert names["Videos"]["videos"] == 1
    assert top["total"]["files"] == 4 and top["total"]["new_day"] == 4

    photos = sync.folder_report("Photos", "folders", 7)
    kids = {c["name"]: c for c in photos["children"]}
    assert kids["trip"]["files"] == 2 and kids["trip"]["has_sub"]
    assert kids[""]["files"] == 1  # b.HEIC sits in Photos itself
    assert photos["daily"][-1] == {"day": photos["today"], "photos": 2, "videos": 1}
    assert sum(kids["trip"]["series"]) == 2

    deep = sync.folder_report("Photos/trip/day2", "folders", 7)
    assert deep["total"]["videos"] == 1 and deep["children"][0]["name"] == ""


def test_folder_report_groups_devices(media):
    for dev in ("Pixel", "Pixel (2)"):
        (media / "Photos" / dev / "0a").mkdir(parents=True, exist_ok=True)
        (media / "Photos" / dev / "0a" / f"{dev}.jpg").write_bytes(b"p" * 10)
    (media / "Documents" / "Phone").mkdir(parents=True, exist_ok=True)
    (media / "Documents" / "Phone" / "x.jpg").write_bytes(b"d" * 10)  # not a backed-up folder
    sync.scan()
    r = sync.folder_report("", "devices", 30)
    devices = {c["name"]: c for c in r["children"]}
    assert devices["Pixel"]["files"] == 2
    assert devices["Pixel"]["folders"] == ["Photos/Pixel", "Photos/Pixel (2)"]
    assert "Phone" not in devices


def test_folder_report_dates_files_by_arrival(media):
    old = time.time() - 40 * 86400
    os.utime(media / "Videos" / "c.mp4", (old, old))  # copied with its original date kept
    sync.scan()
    r = sync.folder_report("Videos", "folders", 30)
    assert r["total"]["new"] == 1  # it still arrived today


def test_folders_api_rejects_unsafe_paths(media, server):
    sync.scan()
    with urllib.request.urlopen(f"{server}/api/folders?path=Photos") as r:
        assert json.load(r)["total"]["files"] == 2
    with pytest.raises(urllib.error.HTTPError) as bad:
        urllib.request.urlopen(f"{server}/api/folders?path=../etc")
    assert bad.value.code == 400


def test_backup_app_buckets_are_hidden_and_files_listed(media):
    for b in ("0a", "1f", "b2", "ff"):
        (media / "Photos" / "iPhone" / b).mkdir(parents=True, exist_ok=True)
        (media / "Photos" / "iPhone" / b / f"{b}.jpg").write_bytes(b"p" * 10)
    sync.scan()
    sync.state["last_scan"] = time.time()
    r = sync.folder_report("Photos/iPhone", "folders", 30)
    assert r["buckets"] and r["children"] == [] and r["total"]["files"] == 4
    devices = sync.folder_report("", "devices", 30)["children"]
    assert len(next(d for d in devices if d["name"] == "iPhone")["recent"]) == 4

    # Nothing is uploaded yet: the files still show, as waiting (Library would be empty).
    f = sync.folder_files("Photos/iPhone")
    assert f["total"] == 4 and {i["state"] for i in f["items"]} == {"waiting"}
    sync.q("INSERT INTO files (path, size, mtime, status) VALUES (?, 10, 0, 'uploaded')",
           (str(media / "Photos/iPhone/0a/0a.jpg"),))  # fmt: skip
    sync.q("INSERT INTO files (path, size, mtime, status, error) VALUES (?, 10, 0, 'failed', 'bad file')",
           (str(media / "Photos/iPhone/ff/ff.jpg"),))  # fmt: skip
    f = sync.folder_files("Photos/iPhone")
    assert f["counts"] == {"all": 4, "backed_up": 1, "waiting": 2, "failed": 1, "photo": 4, "video": 0}
    assert [i["name"] for i in sync.folder_files("Photos/iPhone", status="failed")["items"]] == [
        "Photos/iPhone/ff/ff.jpg"
    ]
    assert sync.folder_files("Photos/iPhone", status="failed")["items"][0]["error"] == "bad file"
    assert sync.folder_files("Photos/iPhone", kind="video")["total"] == 0
    assert sync.folder_files("Photos/iPhone", limit=2, offset=3)["items"][0]["name"].endswith(".jpg")
