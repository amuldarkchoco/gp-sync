"""Freeing Google storage: download, prove it's the original, wait for the user, upload, check."""

import hashlib
import json
import urllib.error
import urllib.request

import pytest
from gpmc.db import Storage
from gpmc.models import MediaItem

import sync

ACC = "test@example.com"
DATA = b"original photo bytes" * 1000


def b64(data):
    return sync._b64_hash(hashlib.sha1(data).digest())


def item(key, data=DATA, quota=None, **kw):
    return MediaItem(
        media_key=key, file_name=f"{key}.jpg", dedup_key=b64(data), is_canonical=True, type=1,
        caption=kw.pop("caption", None),
        collection_id="", size_bytes=len(data), quota_charged_bytes=len(data) if quota is None else quota,
        origin=kw.pop("origin", "self"), content_version=1, utc_timestamp=1_700_000_000_000,
        server_creation_timestamp=0, **kw,
    )  # fmt: skip


class FakeResponse:
    def __init__(self, data):
        self.data = data

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def raise_for_status(self):
        pass

    def iter_content(self, n):
        yield self.data


class FakeApi:
    bearer_token = "token"
    user_agent = "test"

    def __init__(self, google):
        self.google = google  # dedup keys still in Google
        self.calls = []

    def get_download_urls(self, key):
        return {"1": {"5": {"2": {"6": f"https://video-downloads.googleusercontent.com/{key}"}}}}

    def find_remote_media_by_hash(self, digest):
        return "OLD" if sync._b64_hash(digest) in self.google else None

    def set_favorite(self, dedup, on):
        self.calls.append(("favorite", dedup, on))

    def set_archived(self, dedups, on):
        self.calls.append(("archived", dedups, on))

    def set_item_caption(self, dedup_key="", caption=""):
        self.calls.append(("caption", dedup_key, caption))


class FakeClient:
    def __init__(self, db, google, new_quota=0):
        self.api = FakeApi(google)
        self.db = db
        self.new_quota = new_quota
        self.uploads = []

    def _upload_file(self, path, digest, bar, force_upload, use_quota, saver, progress_callback=None):
        self.uploads.append((path.read_bytes(), use_quota, saver, path.stat().st_mtime))
        progress_callback({"phase": "uploading", "bytes_completed": 10})
        return {str(path): "NEW"}

    def update_cache(self, show_progress=True):
        with Storage(self.db) as st:
            st.update([item("NEW", quota=self.new_quota)])


@pytest.fixture
def library(tmp_path, monkeypatch, media):
    monkeypatch.setattr(sync, "GPMC_HOME", tmp_path / "gpmc")
    monkeypatch.setattr(sync, "RECLAIM_DIR", tmp_path / "reclaim")
    monkeypatch.setitem(sync.reclaim_state, "current", None)
    sync.q("DELETE FROM reclaim")
    db = sync._library_db(ACC)
    db.parent.mkdir(parents=True)
    with Storage(db) as st:
        st.update(
            [
                item("BIG", is_favorite=True, caption="Goa"),
                item("SMALL", data=b"small"),
                item("FREE", data=b"free", quota=0),
                item("PARTNER", data=b"partner", origin="partner"),
                item("TRASHED", data=b"trash", trash_timestamp=5),
            ]
        )
    monkeypatch.setattr("requests.get", lambda url, **kw: FakeResponse(DATA if "BIG" in url else b"tampered"))
    return db


def test_report_lists_what_counts_biggest_first(library):
    sync.q("INSERT INTO files (path, status, account, sha1) VALUES ('x', 'uploaded', ?, ?)",
           (ACC, hashlib.sha1(b"free").hexdigest()))  # fmt: skip
    r = sync.storage_report(ACC)
    assert [i["key"] for i in r["items"]] == ["BIG", "SMALL"]  # not free, partner or trashed ones
    assert r["counted"] == 2 and r["counted_bytes"] == len(DATA) + 5 and r["total"] == 3
    assert r["ours"] == {"seen": 1, "counted": 0}  # GP Sync's own upload doesn't count
    assert r["items"][0]["taken"] == 1_700_000_000


def test_whole_round_trip(library):
    google = {b64(DATA)}
    client = FakeClient(library, google)
    sync.reclaim_queue(ACC, ["BIG"])
    assert sync.reclaim_step(lambda a: client)
    row = sync.q("SELECT state, local FROM reclaim WHERE media_key='BIG'")[0]
    assert row[0] == "downloaded" and sync.Path(row[1]).read_bytes() == DATA

    # Still in Google: nothing is uploaded.
    sync.reclaim_step(lambda a: client)
    assert client.uploads == []

    google.clear()  # the user deleted it in Google Photos
    sync.reclaim_step(lambda a: client)
    assert client.uploads == [(DATA, False, False, 1_700_000_000)]  # free upload, original date
    assert ("favorite", b64(DATA), True) in client.api.calls and ("caption", b64(DATA), "Goa") in client.api.calls
    assert sync.q("SELECT state FROM reclaim WHERE media_key='BIG'")[0][0] == "checking"

    sync.reclaim_step(lambda a: client)
    assert sync.q("SELECT state, local FROM reclaim WHERE media_key='BIG'")[0] == ("done", "")
    assert not (sync.RECLAIM_DIR / ACC / "BIG").exists()
    assert sync.storage_report(ACC)["freed"] == {"count": 1, "bytes": len(DATA)}


def test_refuses_a_download_that_is_not_the_original(library):
    sync.reclaim_queue(ACC, ["SMALL"])  # the fake serves other bytes for it
    sync.reclaim_step(lambda a: FakeClient(library, set()))
    state, error, local = sync.q("SELECT state, error, local FROM reclaim WHERE media_key='SMALL'")[0]
    assert state == "failed" and "not exactly" in error and not local
    assert not list((sync.RECLAIM_DIR / ACC / "SMALL").glob("*.jpg"))


def test_stops_when_google_counts_the_new_upload(library):
    client = FakeClient(library, set(), new_quota=123)
    sync.reclaim_queue(ACC, ["BIG"])
    for _ in range(3):
        sync.reclaim_step(lambda a: client)
    assert sync.q("SELECT state FROM reclaim WHERE media_key='BIG'")[0][0] == "counts"
    assert sync.reclaim_blocked(ACC) and sync.storage_report(ACC)["blocked"]
    assert (sync.RECLAIM_DIR / ACC / "BIG").exists()  # the downloaded copy is kept


def test_cancel_removes_the_downloaded_copy(library):
    sync.reclaim_queue(ACC, ["BIG"])
    sync.reclaim_step(lambda a: FakeClient(library, {b64(DATA)}))
    assert sync.reclaim_cancel(ACC, ["BIG"]) == {"cancelled": 1}
    assert not (sync.RECLAIM_DIR / ACC / "BIG").exists()


def test_storage_api(library, server):
    with urllib.request.urlopen(f"{server}/api/storage?account={ACC}") as r:
        assert [i["key"] for i in json.load(r)["items"]] == ["BIG", "SMALL"]
    req = urllib.request.Request(
        f"{server}/api/storage/download", json.dumps({"account": "nobody", "keys": []}).encode()
    )
    with pytest.raises(urllib.error.HTTPError):
        urllib.request.urlopen(req)
