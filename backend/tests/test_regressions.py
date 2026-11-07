"""Regression tests for bugs found in a code review."""

import hashlib
import io
import json
import threading
import urllib.parse
import urllib.request

import pytest
from helpers import FAKE_AUTH, post

import media
import sync

OTHER_AUTH = FAKE_AUTH.replace("test%40example.com", "family%40example.com")


@pytest.fixture
def uploads(media, monkeypatch):
    sync.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(sync, "_owned", lambda p: None)
    return sync.UPLOAD_DIR


# --- upload hours in time zones that are not whole hours from UTC


@pytest.mark.parametrize("tz", [330, 345, -210])
def test_next_window_opens_on_the_local_hour(tz):
    st = sync._merge(sync.DEFAULT_SETTINGS, {"schedule": {"enabled": True, "start": 1, "end": 7}})
    st["tz_offset_min"] = tz
    noon = 1_800_000_000 // 86400 * 86400 + 12 * 3600 - tz * 60 + 60  # 12:01 local
    t = sync.next_window(st, noon)
    assert sync.local_hour(st, t) == 1
    assert (t + tz * 60) % 3600 == 0  # exactly 01:00 local, not up to 45 minutes later
    assert sync.upload_allowed(st, t) and not sync.upload_allowed(st, t - 1)


# --- resumable phone uploads


def test_last_piece_cannot_switch_to_another_file_type(uploads):
    first = sync.receive_chunk(io.BytesIO(b"abcd"), 4, "upload-id-1", 0, 8, "photo.jpg")
    assert first == (200, {"ok": True, "offset": 4})
    code, result = sync.receive_chunk(io.BytesIO(b"efgh"), 4, "upload-id-1", 4, 8, "page.html")
    assert code == 400 and "photos and videos" in result["error"]
    assert not list(uploads.rglob("page.html"))
    code, result = sync.receive_chunk(io.BytesIO(b"efgh"), 4, "upload-id-1", 4, 8, "photo.jpg")
    assert code == 200 and result["saved"].endswith("photo.jpg")


def test_upload_is_kept_when_the_known_copy_was_deleted(server, uploads):
    gone = sync.MEDIA / "Photos" / "deleted.jpg"
    sync.q(
        "INSERT INTO files (path,size,mtime,status,attempts,updated,sha1) VALUES (?,?,?,'uploaded',0,0,?)",
        (str(gone), 4, 0, hashlib.sha1(b"same").hexdigest()),
    )
    code, body = post(f"{server}/api/upload?{urllib.parse.urlencode({'name': 'again.jpg'})}", b"same")
    result = json.loads(body)
    assert code == 200 and "duplicate" not in result and result["saved"].endswith("again.jpg")


# --- logins


def test_new_login_replaces_one_saved_under_another_file_name(media):
    odd = sync.ACCOUNTS_DIR / "renamed.auth"
    odd.write_text(OTHER_AUTH.replace("Token=x", "Token=old"))
    assert sync.save_account(OTHER_AUTH.replace("Token=x", "Token=new")) == "family@example.com"
    assert not odd.exists()
    assert dict(sync.accounts())["family@example.com"].endswith("Token=new")


def test_removed_account_has_no_login_warning(media):
    sync.save_account(OTHER_AUTH)
    sync.state["login_failed"].add("family@example.com")
    assert sync.remove_account("family@example.com")
    assert "family@example.com" not in sync.state["login_failed"]


# --- searches treat % and _ literally


def test_file_search_and_folder_filter_are_literal(media):
    for name in ("Photos/My_Trip/a.jpg", "Photos/MyXTrip/b.jpg", "Photos/100%/c.jpg", "Photos/1000/d.jpg"):
        sync.q(
            "INSERT INTO files (path,size,mtime,status,updated) VALUES (?,1,1,'uploaded',1)", (str(sync.MEDIA / name),)
        )
    assert [i["name"] for i in sync.list_files(folder="Photos/My_Trip")["items"]] == ["Photos/My_Trip/a.jpg"]
    assert [i["name"] for i in sync.list_files(query="100%")["items"]] == ["Photos/100%/c.jpg"]


def test_bad_paging_time_is_ignored(server):
    sync.sq("DELETE FROM events")
    sync.log("Something happened", "info")
    with urllib.request.urlopen(f"{server}/api/activity?before=soon") as r:
        assert r.status == 200 and json.load(r)["items"][0]["text"] == "Something happened"
    with urllib.request.urlopen(f"{server}/api/logs?before=soon") as r:
        assert r.status == 200 and isinstance(json.load(r)["items"], list)


# --- malformed requests get an answer instead of a dropped connection


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/api/settings", b"[]"),
        ("/api/settings", b'{"notify": "x"}'),
        ("/api/accounts/remove", b"[]"),
        ("/api/retry", b"{bad"),
    ],
)
def test_malformed_requests_get_400(server, media, path, body):
    assert post(server + path, body)[0] == 400


# --- thumbnails made by two threads at once


def test_concurrent_thumbnails_stay_valid(tmp_path):
    from PIL import Image

    source = tmp_path / "photo.jpg"
    Image.new("RGB", (900, 600), (20, 120, 220)).save(source, "JPEG")
    target = tmp_path / "thumbs" / "photo.webp"
    errors = []

    def make():
        try:
            media.make_thumbnail(source, target)
        except Exception as e:  # pragma: no cover - reported below
            errors.append(e)

    threads = [threading.Thread(target=make) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors
    with Image.open(target) as im:
        im.verify()
    assert not list(target.parent.glob("*.tmp"))
