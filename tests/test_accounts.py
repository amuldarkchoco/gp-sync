"""Several Google accounts: a folder can be backed up to up to five accounts at once."""

import json

import pytest
from helpers import FakeClient

import sync

SECOND = "androidId=abc&app=com.google.android.apps.photos&Email=two%40example.com&lang=en_US&Token=y"


def auth_for(n):
    return f"androidId=abc&app=com.google.android.apps.photos&Email=a{n}%40example.com&lang=en_US&Token=z"


@pytest.fixture
def two(media):
    sync.q("DELETE FROM copies")
    sync.save_account(SECOND)
    yield ["test@example.com", "two@example.com"]
    sync.q("DELETE FROM copies")


def test_folder_to_several_accounts(two):
    sync.update_settings({"folders": {"Photos": two, "Videos": ["test@example.com"]}})
    assert sync.folder_targets()["Photos"] == two
    assert sync.folder_map()["Photos"] == "test@example.com"  # the first is the main account
    todo = sync.scan()
    main = [t for t in todo if len(t) == 4]
    copies = [t for t in todo if len(t) == 5]
    assert {t[3] for t in main} == {"test@example.com"} and len(main) == 3
    assert {t[3] for t in copies} == {"two@example.com"} and len(copies) == 2  # the two photos only
    assert main == todo[: len(main)]  # main backups go first


def test_copies_are_recorded_per_account(two):
    sync.update_settings({"folders": {"Photos": two}})
    todo = sync.scan()
    ok = FakeClient({"a.jpg": "uploading", "b.HEIC": "skipped"})
    sync.upload_all(ok, [t for t in todo if t[3] == "test@example.com"], "test@example.com")
    sync.upload_all(ok, [t for t in todo if t[3] == "two@example.com"], "two@example.com")
    assert (
        sync.q("SELECT COUNT(*) FROM copies WHERE account='two@example.com' AND status IN ('uploaded','exists')")[0][0]
        == 2
    )
    assert sync.scan() == []  # everything is in both accounts
    f = sync.state["folders"]["Photos"]
    assert f["accounts"] == two and f["copies"]["two@example.com"] == 2
    s = json.loads(sync.status_body())
    assert s["copies"]["two@example.com"]["done"] == 2 and s["max_accounts"] == 5


def test_failed_copy_is_retried_alone(two):
    sync.update_settings({"folders": {"Photos": two}})
    todo = sync.scan()
    sync.upload_all(FakeClient({"a.jpg": "uploading", "b.HEIC": "uploading"}), [t for t in todo if len(t) == 4])
    sync.upload_all(FakeClient({"a.jpg": KeyError("bad"), "b.HEIC": "uploading"}), [t for t in todo if len(t) == 5])
    again = sync.scan()
    assert [(t[0].rsplit("/", 1)[-1], t[3]) for t in again] == [("a.jpg", "two@example.com")]


def test_old_single_account_settings_still_work(two):
    sync.meta_set("settings", json.dumps({**sync.get_settings(), "folders": {"Photos": "two@example.com"}}))
    assert sync.folder_targets()["Photos"] == ["two@example.com"]


def test_at_most_five_accounts(media):
    for f in sync.ACCOUNTS_DIR.glob("*.auth"):
        f.unlink()
    sync.meta_set("account_order", "[]")
    for n in range(5):
        assert sync.save_account(auth_for(n))
    with pytest.raises(ValueError, match="Up to 5"):
        sync.save_account(auth_for(9))
    assert sync.save_account(auth_for(0))  # replacing a login is always fine
    sync.update_settings({"folders": {"Photos": [f"a{n}@example.com" for n in range(5)] + ["extra@example.com"]}})
    assert len(sync.get_settings()["folders"]["Photos"]) == 5
