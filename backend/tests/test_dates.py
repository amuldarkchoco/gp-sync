"""Dates: files without their own capture date get the right one in Google Photos, go into an album
of their own, and ones uploaded with a wrong date can be uploaded again with the right one."""

import hashlib
import inspect
import io
import json
import os
import sqlite3
import struct
import urllib.request
from pathlib import Path

import pytest
from gpmc.db import Storage
from gpmc.models import MediaItem
from helpers import post

import media
import sync

ACC = "test@example.com"
DAY = 86400


def jpeg(date=None, color=(200, 30, 30)):
    """A small JPEG, with DateTimeOriginal when `date` is given."""
    from PIL import Image

    im = Image.new("RGB", (8, 8), color)
    exif = Image.Exif()
    if date:
        exif.get_ifd(0x8769)[0x9003] = date
    buf = io.BytesIO()
    im.save(buf, "JPEG", exif=exif.tobytes())
    return buf.getvalue()


def movie(created):
    """A minimal MP4: ftyp + moov with a version-0 movie header (QuickTime seconds since 1904)."""

    def atom(kind, body):
        return struct.pack(">I", 8 + len(body)) + kind + body

    mvhd = atom(b"mvhd", b"\0\0\0\0" + struct.pack(">II", created, created) + b"\0" * 92)
    return atom(b"ftyp", b"isom\0\0\0\0isom") + atom(b"moov", mvhd)


def put(name, data, mtime):
    p = sync.MEDIA / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    os.utime(p, (mtime, mtime))
    return p


# ---- what is inside a file


def test_has_date_reads_photos_and_videos(tmp_path):
    cases = {
        "dated.jpg": (jpeg("2024:05:01 10:00:00"), True),
        "snap.jpg": (jpeg(), False),
        "zero.jpg": (jpeg("0000:00:00 00:00:00"), False),
        "clip.mp4": (movie(3_800_000_000), True),
        "nodate.mov": (movie(0), False),
        "broken.jpg": (b"not a picture", None),
        "film.mkv": (b"whatever", None),
    }
    for name, (data, want) in cases.items():
        (tmp_path / name).write_bytes(data)
        assert media.has_date(tmp_path / name) is want, name


# ---- uploads send the best date


class FakeApi:
    def __init__(self, google=()):
        self.google = set(google)  # SHA-1s Google has
        self.sent = []  # upload_timestamp of each commit
        self.albums = {}  # album key -> (name, [media keys])
        self.calls = []

    def find_remote_media_by_hash(self, digest):
        return "OLD" if digest in self.google else None

    def commit_upload(self, upload_response_decoded, file_name, sha1_hash, quality="original",
                      make=None, model=None, upload_timestamp=None):  # fmt: skip
        self.sent.append(upload_timestamp)
        self.google.add(sha1_hash)
        return f"KEY{len(self.sent)}"

    def create_album(self, album_name, media_keys):
        key = f"ALB{len(self.albums)}"
        self.albums[key] = (album_name, list(media_keys))
        return key

    def add_media_to_album(self, album_media_key, media_keys):
        self.albums[album_media_key][1].extend(media_keys)

    def set_favorite(self, dedup, on):
        self.calls.append(("favorite", dedup, on))

    def set_archived(self, dedups, on):
        self.calls.append(("archived", dedups, on))

    def set_item_caption(self, dedup_key="", caption=""):
        self.calls.append(("caption", dedup_key, caption))


class GpmcLike:
    """Behaves like gpmc.Client._upload_file: skips files Google has, else commits with the file's mtime."""

    def __init__(self, google=()):
        self.api = FakeApi(google)

    def _upload_file(self, file_path, hash_value, progress, force_upload, use_quota, saver, progress_callback=None):
        if self.api.find_remote_media_by_hash(hash_value):
            progress_callback({"phase": "skipped"})
            return {str(file_path): "OLD"}
        progress_callback({"phase": "uploading", "bytes_completed": 1})
        key = self.api.commit_upload(
            upload_response_decoded={}, file_name=Path(file_path).name, sha1_hash=hash_value,
            upload_timestamp=int(Path(file_path).stat().st_mtime),
        )  # fmt: skip
        return {str(file_path): key}


@pytest.fixture
def dates(media, tmp_path, monkeypatch):
    sync.sq("DELETE FROM media_dates")
    sync.sq("DELETE FROM undated_album")
    sync.q("DELETE FROM albums")
    sync.q("DELETE FROM copies")
    sync._dates_checked.clear()
    monkeypatch.setattr(sync, "GPMC_HOME", tmp_path / "gpmc")
    monkeypatch.setitem(sync.dates_state, "current", None)
    monkeypatch.setitem(sync.state, "phase", "idle")  # date checks only run while idle
    for p in list(sync.MEDIA.rglob("*")):
        if p.is_file():
            p.unlink()
    return sync.MEDIA


def upload(client, *paths):
    todo = [(str(p), p.stat().st_size, p.stat().st_mtime, ACC) for p in paths]
    sync.upload_all(client, todo, ACC)


def test_undated_upload_gets_the_earliest_identical_copy(dates):
    snap = jpeg()
    early = put("Photos/old/a.jpg", snap, 1_700_000_000)
    late = put("Photos/new/b.jpg", snap, 1_700_000_000 + 5 * DAY)
    sync.scan()  # the index lists both files
    client = GpmcLike()
    upload(client, late)
    assert client.api.sent == [1_700_000_000]  # not the later copy's time
    assert sync.sq("SELECT sent, inside FROM media_dates WHERE path=?", (str(late),)) == [(1_700_000_000, 0)]
    assert sync.sq("SELECT sha1 FROM media_dates WHERE path=?", (str(early),))[0][0] == hashlib.sha1(snap).hexdigest()


def test_dated_photo_keeps_gpmc_behaviour(dates):
    p = put("Photos/c.jpg", jpeg("2020:01:01 12:00:00"), 1_700_000_000)
    client = GpmcLike()
    upload(client, p)
    assert client.api.sent == [1_700_000_000]  # file time; Google uses the date inside anyway
    assert sync.sq("SELECT inside, sent FROM media_dates WHERE path=?", (str(p),)) == [(1, None)]
    assert "commit_upload" not in vars(client.api)  # gpmc's own method is back


def test_picked_date_wins(dates):
    p = put("Photos/d.jpg", jpeg(), 1_700_000_000)
    first = GpmcLike()
    upload(first, p)
    sync.dates_set("Photos/d.jpg", 1_600_000_000)
    assert sync.best_date(str(p), p.stat().st_size, p.stat().st_mtime, hashlib.sha1(p.read_bytes()).hexdigest()) == (
        1_600_000_000,
        "manual",
    )
    with pytest.raises(ValueError):
        sync.dates_set("Photos/d.jpg", sync.time.time() + 10 * DAY)
    with pytest.raises(ValueError):
        sync.dates_set("Photos/nope.jpg", 1_600_000_000)


# ---- album for files without a date


def test_album_waits_for_the_choice_then_adds_once(dates):
    put("Photos/e.jpg", jpeg(), 1_700_000_000)
    put("Photos/f.jpg", jpeg("2020:01:01 12:00:00", (0, 0, 200)), 1_700_000_000)
    sync.scan()
    client = GpmcLike()
    upload(client, sync.MEDIA / "Photos/e.jpg", sync.MEDIA / "Photos/f.jpg")
    assert not sync.undated_album_step(lambda a: client)  # not asked yet
    sync.update_settings({"undated": {"asked": True}})
    assert sync.undated_album_step(lambda a: client)
    assert list(client.api.albums.values()) == [("Date unknown", ["KEY1"])]  # only the undated one
    assert not sync.undated_album_step(lambda a: client)  # already there
    sync.update_settings({"undated": {"name": "  No   date  "}})
    assert sync.get_settings()["undated"]["name"] == "No date"
    assert sync.undated_album_step(lambda a: client)  # a new name: a new album
    assert ("No date", ["KEY1"]) in client.api.albums.values()
    sync.update_settings({"undated": {"album": False, "name": ""}})
    assert sync.get_settings()["undated"] == {"album": False, "name": "Date unknown", "asked": True}


# ---- fixing dates already in Google


def library_item(sha1hex, when, **kw):
    return MediaItem(
        media_key="OLD", file_name="x.jpg", dedup_key=sync._b64_hash(bytes.fromhex(sha1hex)), is_canonical=True,
        type=1, caption=kw.pop("caption", None), collection_id="", size_bytes=1, quota_charged_bytes=0,
        origin="self", content_version=1, utc_timestamp=when * 1000, server_creation_timestamp=0, **kw,
    )  # fmt: skip


def test_fix_round_trip(dates):
    snap = jpeg()
    sha1hex = hashlib.sha1(snap).hexdigest()
    early = put("Photos/a/early.jpg", snap, 1_700_000_000)
    late = put("Photos/b/late.jpg", snap, 1_700_000_000 + 3 * DAY)
    sync.scan()
    # Uploaded by an older version: Google got the later copy's time.
    sync.q("INSERT INTO files (path, size, mtime, status, media_key, account, sha1, updated) "
           "VALUES (?,?,?,'uploaded','OLD',?,?,?)",
           (str(late), len(snap), late.stat().st_mtime, ACC, sha1hex, 1))  # fmt: skip
    sync.q("INSERT INTO files (path, size, mtime, status, media_key, account, sha1, updated) "
           "VALUES (?,?,?,'exists','OLD',?,?,?)",
           (str(early), len(snap), early.stat().st_mtime, ACC, sha1hex, 1))  # fmt: skip
    sync.dates_some()
    db = sync._library_db(ACC)
    db.parent.mkdir(parents=True)
    with Storage(db) as st:
        st.update([library_item(sha1hex, 1_700_000_000 + 3 * DAY, is_favorite=True, caption="Shimla")])
    sync.meta_set(f"library_refreshed:{ACC}", "10")

    r = sync.dates_report(ACC)
    late_item = next(i for i in r["items"] if i["name"] == "Photos/b/late.jpg")
    assert late_item["wrong"] and late_item["best"] == 1_700_000_000 and late_item["source"] == "copy"
    assert r["wrong"] == 1 and len(r["items"]) == 1  # both copies are the same item in Google: listed once

    client = GpmcLike(google={bytes.fromhex(sha1hex)})
    assert sync.dates_fix(["Photos/b/late.jpg", "Photos/nope.jpg"]) == {"queued": 1}
    waiting = next(i for i in sync.dates_report(ACC)["items"] if i["name"] == "Photos/b/late.jpg")
    assert waiting["previous_google"] == 1_700_000_000 + 3 * DAY
    assert waiting["previous_google_source"] == "google"
    assert not sync.datefix_step(lambda a: client)  # still in Google
    assert client.api.sent == []

    client.api.google.clear()  # the user deleted it in Google Photos
    sync._dates_checked.clear()
    assert sync.datefix_step(lambda a: client)
    assert client.api.sent == [1_700_000_000]
    assert ("favorite", sync._b64_hash(bytes.fromhex(sha1hex)), True) in client.api.calls
    assert ("caption", sync._b64_hash(bytes.fromhex(sha1hex)), "Shimla") in client.api.calls
    assert sync.q("SELECT media_key, status FROM files WHERE path=?", (str(late),)) == [("KEY1", "uploaded")]
    assert sync.sq("SELECT fix, sent FROM media_dates WHERE path=?", (str(late),)) == [("done", 1_700_000_000)]
    fixed = next(i for i in sync.dates_report(ACC)["items"] if i["name"] == "Photos/b/late.jpg")
    assert not fixed["wrong"] and fixed["fix"] == "done"
    assert fixed["previous_google"] == 1_700_000_000 + 3 * DAY
    assert fixed["google"] == fixed["best"] == 1_700_000_000
    assert fixed["google_source"] == "sent"  # not yet verified by a later library refresh
    assert fixed["google_url"] == "https://photos.google.com/photo/KEY1"


def test_date_report_does_not_invent_google_date(dates):
    p = put("Photos/old.jpg", jpeg(), 1_700_000_000)
    sha1hex = hashlib.sha1(p.read_bytes()).hexdigest()
    sync.q(
        "INSERT INTO files (path, size, mtime, status, media_key, account, sha1, updated) "
        "VALUES (?,?,?,'uploaded','',?,?,100)",
        (str(p), p.stat().st_size, p.stat().st_mtime, ACC, sha1hex),
    )
    sync.date_facts(str(p), p.stat().st_size, p.stat().st_mtime)
    sync.meta_set(f"library_refreshed:{ACC}", "0")
    item = sync.dates_report(ACC)["items"][0]
    assert item["google"] is None and item["google_source"] == "unknown"
    assert item["best"] == 1_700_000_000 and not item["google_url"]

    db = sync._library_db(ACC)
    db.parent.mkdir(parents=True, exist_ok=True)
    with Storage(db) as st:
        st.update([library_item(sha1hex, 1_700_000_000 + DAY)])
    sync.meta_set(f"library_refreshed:{ACC}", "200")
    item = sync.dates_report(ACC)["items"][0]
    assert item["google"] == 1_700_000_000 + DAY and item["google_source"] == "google"
    assert item["best"] == 1_700_000_000 and item["wrong"]
    assert item["google_url"] == "https://photos.google.com/photo/OLD"


def test_old_date_database_migrates_without_losing_rows():
    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE media_dates (path TEXT PRIMARY KEY, size INTEGER, mtime REAL, sha1 TEXT, inside INTEGER, "
        "manual REAL, sent REAL, fix TEXT, error TEXT, favorite INTEGER, archived INTEGER, caption TEXT, updated REAL)"
    )
    conn.execute("INSERT INTO media_dates (path, fix) VALUES ('photo.jpg', 'done')")
    sync._create_stats_tables(conn)
    sync._create_stats_tables(conn)  # safe on the next startup
    assert conn.execute("SELECT fix, previous_google, previous_google_source FROM media_dates").fetchone() == (
        "done",
        None,
        None,
    )
    conn.close()


def test_an_earlier_date_in_google_is_kept(dates):
    """Files are copied here after they were taken: if Google already has an earlier date (from the
    phone's own backup), that one is better than our file times, unless the user picked a date."""
    snap = jpeg()
    sha1hex = hashlib.sha1(snap).hexdigest()
    p = put("Photos/phone.jpg", snap, 1_700_000_000)
    sync.q("INSERT INTO files (path, size, mtime, status, media_key, account, sha1, updated) "
           "VALUES (?,?,?,'exists','OLD',?,?,1)", (str(p), len(snap), p.stat().st_mtime, ACC, sha1hex))  # fmt: skip
    sync.date_facts(str(p), len(snap), p.stat().st_mtime)
    db = sync._library_db(ACC)
    db.parent.mkdir(parents=True)
    with Storage(db) as st:
        st.update([library_item(sha1hex, 1_700_000_000 - 60 * DAY)])
    sync.meta_set(f"library_refreshed:{ACC}", "10")
    item = sync.dates_report(ACC)["items"][0]
    assert not item["wrong"] and item["source"] == "google" and item["best"] == 1_700_000_000 - 60 * DAY
    sync.dates_set("Photos/phone.jpg", 1_650_000_000)
    item = sync.dates_report(ACC)["items"][0]
    assert item["wrong"] and item["source"] == "manual"


def test_fix_waits_while_google_still_has_it_in_trash(dates):
    snap = jpeg()
    p = put("Photos/t.jpg", snap, 1_700_000_000)
    sync.q("INSERT INTO files (path, size, mtime, status, media_key, account, sha1, updated) "
           "VALUES (?,?,?,'uploaded','OLD',?,?,1)",
           (str(p), len(snap), p.stat().st_mtime, ACC, hashlib.sha1(snap).hexdigest()))  # fmt: skip
    sync.date_facts(str(p), len(snap), p.stat().st_mtime)
    sync.dates_fix(["Photos/t.jpg"])

    class TrashClient(GpmcLike):
        def _upload_file(self, file_path, *a, progress_callback=None, **k):
            progress_callback({"phase": "skipped"})  # the hash lookup missed, the upload found it
            return {str(file_path): "OLD"}

    assert not sync.datefix_step(lambda a: TrashClient())
    assert sync.sq("SELECT fix FROM media_dates WHERE path=?", (str(p),)) == [("in_google",)]
    assert sync.dates_cancel(["Photos/t.jpg"]) == {"cancelled": 1}


def test_recheck_selected_and_all(dates, server, monkeypatch):
    other = "other@example.com"
    monkeypatch.setattr(sync, "accounts", lambda: [(ACC, "auth"), (other, "auth")])
    paths = [
        put("Photos/one.jpg", jpeg(color=(200, 30, 30)), 1_700_000_000),
        put("Photos/two.jpg", jpeg(color=(30, 200, 30)), 1_700_000_000),
        put("Photos/other.jpg", jpeg(color=(30, 30, 200)), 1_700_000_000),
    ]
    for p, account in zip(paths, (ACC, ACC, other), strict=True):
        digest = hashlib.sha1(p.read_bytes()).hexdigest()
        sync.q(
            "INSERT INTO files (path, size, mtime, status, media_key, account, sha1, updated) "
            "VALUES (?,?,?,'uploaded','OLD',?,?,1)",
            (str(p), p.stat().st_size, p.stat().st_mtime, account, digest),
        )
        sync.date_facts(str(p), p.stat().st_size, p.stat().st_mtime)
    sync.dates_fix([f"Photos/{p.name}" for p in paths])
    client = GpmcLike(google={hashlib.sha1(p.read_bytes()).digest() for p in paths})
    assert not sync.datefix_step(lambda _account: client)
    assert all(str(p) in sync._dates_checked for p in paths)
    sync.reclaim_wake.clear()

    # The selected file is checked again immediately; another account and invalid paths are ignored.
    client.api.google.remove(hashlib.sha1(paths[0].read_bytes()).digest())
    code, body = post(
        f"{server}/api/dates/recheck",
        json.dumps({"account": ACC, "paths": ["Photos/one.jpg", "Photos/other.jpg", "../other.jpg"]}).encode(),
    )
    assert code == 200 and json.loads(body) == {"queued": 1}
    assert sync.reclaim_wake.is_set()
    assert str(paths[0]) not in sync._dates_checked
    assert all(str(p) in sync._dates_checked for p in paths[1:])
    assert sync.datefix_step(lambda _account: client)
    assert len(client.api.sent) == 1
    assert sync.sq("SELECT fix FROM media_dates WHERE path=?", (str(paths[0]),)) == [("done",)]
    assert sync.sq("SELECT fix FROM media_dates WHERE path=?", (str(paths[1]),)) == [("waiting",)]

    # Rechecking all only affects waiting files owned by this account, and won't upload one Google still has.
    code, body = post(f"{server}/api/dates/recheck", json.dumps({"account": ACC, "all": True}).encode())
    assert code == 200 and json.loads(body) == {"queued": 1}
    assert str(paths[1]) not in sync._dates_checked and str(paths[2]) in sync._dates_checked
    assert not sync.datefix_step(lambda _account: client)
    assert len(client.api.sent) == 1
    code, _ = post(f"{server}/api/dates/recheck", json.dumps({"account": "unknown", "all": True}).encode())
    assert code == 400


def test_recheck_still_respects_google_trash(dates):
    p = put("Photos/trash.jpg", jpeg(), 1_700_000_000)
    digest = hashlib.sha1(p.read_bytes()).hexdigest()
    sync.q(
        "INSERT INTO files (path, size, mtime, status, media_key, account, sha1, updated) "
        "VALUES (?,?,?,'uploaded','OLD',?,?,1)",
        (str(p), p.stat().st_size, p.stat().st_mtime, ACC, digest),
    )
    sync.date_facts(str(p), p.stat().st_size, p.stat().st_mtime)
    sync.dates_fix(["Photos/trash.jpg"])

    class TrashClient(GpmcLike):
        def _upload_file(self, file_path, *a, progress_callback=None, **k):
            progress_callback({"phase": "skipped"})
            return {str(file_path): "OLD"}

    client = TrashClient()
    assert not sync.datefix_step(lambda _account: client)
    assert sync.sq("SELECT fix FROM media_dates WHERE path=?", (str(p),)) == [("in_google",)]
    assert sync.dates_recheck(ACC, ["Photos/trash.jpg"]) == {"queued": 1}
    assert not sync.datefix_step(lambda _account: client)
    assert sync.sq("SELECT fix FROM media_dates WHERE path=?", (str(p),)) == [("in_google",)]
    assert not client.api.sent


def test_library_filter_and_api(dates, server):
    p = put("Photos/u.jpg", jpeg(), 1_700_000_000)
    put("Photos/v.jpg", jpeg("2020:01:01 12:00:00"), 1_700_000_000)
    upload(GpmcLike(), p, sync.MEDIA / "Photos/v.jpg")
    with urllib.request.urlopen(f"{server}/api/files?status=undated") as r:
        items = json.load(r)["items"]
    assert [(i["name"], i["undated"]) for i in items] == [("Photos/u.jpg", True)]
    code, body = post(f"{server}/api/dates/set", json.dumps({"path": "Photos/v.jpg", "when": 1}).encode())
    assert code == 400 and b"without a date" in body
    code, _ = post(f"{server}/api/dates/set", json.dumps({"path": "Photos/u.jpg", "when": 1_600_000_000}).encode())
    assert code == 200
    with urllib.request.urlopen(f"{server}/api/dates?account={ACC}") as r:
        report = json.load(r)
    assert report["items"][0]["source"] == "manual" and report["items"][0]["wrong"]
    with urllib.request.urlopen(f"{server}/api/status") as r:
        status = json.load(r)
    assert status["dates"] == {"undated": 1, "waiting": 0} and status["undated_asked"] is False


def test_gpmc_still_sends_the_upload_time_by_keyword():
    """upload_date() replaces upload_timestamp in gpmc's commit_upload call: keep that call shape."""
    from gpmc import Client
    from gpmc.api import Api

    assert "upload_timestamp=" in inspect.getsource(Client._upload_file)
    assert "upload_timestamp" in inspect.signature(Api.commit_upload).parameters
    assert {"add_media_to_album", "create_album"} <= set(dir(Api))
