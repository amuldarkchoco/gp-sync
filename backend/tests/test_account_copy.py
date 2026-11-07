"""Copying one Google account to another: only what the other lacks, original files, nothing deleted."""

import json
import urllib.error
import urllib.request

import pytest
import requests
from gpmc.db import Storage
from test_free_storage import DATA, FakeClient, FakeResponse, b64, item

import sync

SRC, DST = "test@example.com", "second@example.com"
SECOND_AUTH = "androidId=def&app=com.google.android.apps.photos&Email=second%40example.com&lang=en_US&Token=y"


class SkippingClient(FakeClient):
    """The other account already has the file: Google skips the upload."""

    def _upload_file(self, path, digest, bar, force_upload, use_quota, saver, progress_callback=None):
        progress_callback({"phase": "skipped"})
        return {str(path): "OLD"}


@pytest.fixture
def libs(tmp_path, monkeypatch, media):
    sync.save_account(SECOND_AUTH)
    monkeypatch.setattr(sync, "GPMC_HOME", tmp_path / "gpmc")
    monkeypatch.setattr(sync, "COPY_DIR", tmp_path / "copy")
    monkeypatch.setitem(sync.copy_state, "current", None)
    monkeypatch.setitem(sync.copy_state, "error", "")
    sync.q("DELETE FROM copyjobs")
    sync.meta_set("copy_paused", "0")
    dbs = {}
    for acc, items in (
        (SRC, [
            item("NEW", is_favorite=True, caption="Goa"),  # 2023
            item("NEW-AGAIN"),  # the same file a second time
            item("SHARED", data=b"both"),
            item("OLD", data=b"old photo", utc_timestamp=1_500_000_000_000),  # 2017
            item("CLIP", data=b"clip", type=2),
            item("PARTNER", data=b"partner", origin="partner"),
        ]),
        (DST, [item("THERE", data=b"both")]),
    ):  # fmt: skip
        db = sync._library_db(acc)
        db.parent.mkdir(parents=True)
        with Storage(db) as st:
            st.update(items)
        dbs[acc] = db
    monkeypatch.setattr("requests.get", lambda url, **kw: FakeResponse(DATA if "NEW" in url else b"tampered"))
    return dbs


def clients(libs, dst_cls=FakeClient, quota=0):
    made = {SRC: FakeClient(libs[SRC], set()), DST: dst_cls(libs[DST], set(), new_quota=quota)}
    return made, made.get


def test_report_counts_what_is_missing(libs):
    r = sync.copy_report(SRC, DST)
    assert r["src_total"] == 5 and r["in_dst"] == 1  # the partner's item isn't ours to copy
    assert r["todo"]["photo"]["count"] == 2 and r["todo"]["video"]["count"] == 1
    dups = r["duplicates"]
    assert dups["count"] == 2 and {d["key"] for d in dups["items"]} >= {"SHARED"}
    assert any("twice" in d["error"] for d in dups["items"])
    assert r["years"] == {2017: 1, 2023: 2}


def test_filters_and_copy(libs):
    assert sync.copy_start(SRC, DST, ["photo"], 2020, None) == {"queued": 1}  # only NEW
    assert sync.copy_start(SRC, DST, ["photo"], 2020, None) == {"queued": 0}  # not twice
    made, get = clients(libs)
    assert sync.copy_step(get)
    dst = made[DST]
    assert [(data, quota) for data, quota, *_ in dst.uploads] == [(DATA, False)]  # free upload
    assert ("favorite", b64(DATA), True) in dst.api.calls and ("caption", b64(DATA), "Goa") in dst.api.calls
    assert sync.q("SELECT state, new_key FROM copyjobs WHERE media_key='NEW'")[0] == ("copied", "NEW")
    assert not (sync.COPY_DIR / "NEW").exists()  # the temporary file is gone
    assert made[SRC].uploads == []  # nothing changes in the account copied from

    assert not sync.copy_step(get)  # list done: the copies are checked
    assert sync.q("SELECT state FROM copyjobs WHERE media_key='NEW'")[0][0] == "done"
    r = sync.copy_report(SRC, DST)
    assert r["jobs"]["verified"] == 1 and r["todo"]["photo"]["count"] == 1


def test_already_there_is_skipped(libs):
    sync.copy_start(SRC, DST, ["photo"], 2020, None)
    _, get = clients(libs, SkippingClient)
    sync.copy_step(get)
    assert sync.q("SELECT state FROM copyjobs WHERE src=?", (SRC,)) == [("exists",)]
    dups = sync.copy_report(SRC, DST)["duplicates"]
    assert dups["count"] == 3  # in the other account, twice in this one, and found while uploading


def test_pauses_when_copies_count(libs):
    sync.copy_start(SRC, DST, ["photo"], 2020, None)
    _, get = clients(libs, quota=99)
    sync.copy_step(get)
    sync.copy_step(get)
    assert sync.q("SELECT state FROM copyjobs WHERE media_key='NEW'")[0][0] == "counts"
    assert sync.copy_report(SRC, DST)["paused"]
    with pytest.raises(ValueError, match="counted"):
        sync.copy_start(SRC, DST, keys=["CLIP"])
    assert sync.meta_get("copy_paused") == "1"


def test_wrong_download_fails_and_outage_waits(libs, monkeypatch):
    sync.copy_start(SRC, DST, ["photo"], None, 2018)  # OLD: served tampered
    _, get = clients(libs)
    sync.copy_step(get)
    state, error = sync.q("SELECT state, error FROM copyjobs WHERE media_key='OLD'")[0]
    assert state == "failed" and "not exactly" in error
    assert sync.copy_retry(SRC, DST) == {"queued": 1}

    def offline(url, **kw):
        raise requests.ConnectionError("offline")

    monkeypatch.setattr("requests.get", offline)
    assert not sync.copy_step(get)
    assert sync.q("SELECT state FROM copyjobs WHERE media_key='OLD'")[0][0] == "queued"
    assert "No connection" in sync.copy_report(SRC, DST)["error"]
    assert sync.copy_stop(SRC, DST) == {"removed": 1}


def test_copy_api(libs, server):
    with urllib.request.urlopen(f"{server}/api/copy?src={SRC}&dst={DST}") as r:
        assert json.load(r)["in_dst"] == 1
    bad = urllib.request.Request(f"{server}/api/copy/start", json.dumps({"src": SRC, "dst": SRC}).encode())
    with pytest.raises(urllib.error.HTTPError):
        urllib.request.urlopen(bad)


def test_copied_items_are_not_duplicates(libs):
    sync.copy_start(SRC, DST, ["photo"], 2020, None)
    _, get = clients(libs)
    sync.copy_step(get)
    # The other account now has the copy (as after reading its library again).
    with Storage(libs[DST]) as st:
        st.update([item("COPY-OF-NEW")])
    r = sync.copy_report(SRC, DST)
    assert r["duplicates"]["count"] == 2  # SHARED and NEW-AGAIN, not the copy we made
    assert r["jobs"]["copied"] == 1


def test_removed_account_pauses_instead_of_failing(libs):
    sync.copy_start(SRC, DST, ["photo", "video"])
    sync.remove_account(DST)
    _, get = clients(libs)
    assert not sync.copy_step(get)
    r = sync.q("SELECT state FROM copyjobs WHERE src=?", (SRC,))
    assert {s for (s,) in r} == {"queued"}
    assert sync.meta_get("copy_paused") == "1" and "no longer connected" in sync.copy_state["error"]


def test_failed_check_does_not_fail_the_copy(libs, monkeypatch):
    sync.copy_start(SRC, DST, ["photo"], 2020, None)
    monkeypatch.setattr(sync, "COPY_CHECK_EVERY", 1)
    made, get = clients(libs)

    def broken(show_progress=True):
        raise RuntimeError("database is locked")

    made[DST].update_cache = broken
    sync.copy_step(get)
    assert sync.q("SELECT state FROM copyjobs WHERE media_key='NEW'")[0][0] == "copied"


def test_year_filter_keeps_the_other_copy(libs):
    # NEW and NEW-AGAIN are the same file; only one is ever queued, whatever the filter.
    assert sync.copy_start(SRC, DST, ["photo"], 2020, None)["queued"] == 1
    assert sync.copy_start(SRC, DST, ["photo"], 2020, None)["queued"] == 0


def test_selecting_items_filters_and_preserves_duplicate_safety(libs):
    page = sync.copy_candidates(SRC, DST, limit=1)
    assert page["total"] == 3 and len(page["items"]) == 1
    assert sync.copy_candidates(SRC, DST, query="clip")["items"][0]["key"] == "CLIP"
    assert sync.copy_start(SRC, DST, keys=[]) == {"queued": 0}
    assert sync.copy_start(SRC, DST, keys=["CLIP", "SHARED", "PARTNER", "no-such-key"]) == {"queued": 1}
    assert sync.q("SELECT media_key FROM copyjobs WHERE src=? AND dst=?", (SRC, DST)) == [("CLIP",)]
    assert sync.copy_start(SRC, DST, keys=["CLIP"]) == {"queued": 0}
    with pytest.raises(ValueError):
        sync.copy_start(SRC, DST, keys="CLIP")


def test_start_does_not_override_manual_pause(libs):
    sync.meta_set("copy_paused", "1")
    assert sync.copy_start(SRC, DST, keys=["CLIP"]) == {"queued": 1}
    assert sync.meta_get("copy_paused") == "1"


def test_copy_requires_both_read_libraries(libs, tmp_path, monkeypatch):
    monkeypatch.setattr(sync, "GPMC_HOME", tmp_path / "empty")
    with pytest.raises(ValueError, match="library"):
        sync.copy_start(SRC, DST, keys=["CLIP"])
    with pytest.raises(ValueError, match="libraries"):
        sync.copy_candidates(SRC, DST)


def test_copy_candidates_api(libs, server):
    with urllib.request.urlopen(f"{server}/api/copy/items?src={SRC}&dst={DST}&q=clip") as r:
        result = json.load(r)
        assert result["total"] == 1 and result["items"][0]["key"] == "CLIP"
    body = json.dumps({"src": SRC, "dst": DST, "keys": [], "kinds": ["photo", "video"]}).encode()
    with urllib.request.urlopen(urllib.request.Request(f"{server}/api/copy/start", body)) as r:
        assert json.load(r)["queued"] == 0
