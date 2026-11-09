"""Work for different accounts runs side by side: one account's slow work never holds up another's."""

import threading
import time

import sync


def test_a_busy_account_does_not_hold_up_another():
    release = threading.Event()
    done = []

    def step(key):
        if key == "slow" and not release.is_set():
            release.wait(5)  # a long library read or download
        done.append(key)
        return False

    lanes = sync.Lanes("test", step, idle=0)
    lanes.wake(["slow", "fast"])
    deadline = time.time() + 2
    while "fast" not in done and time.time() < deadline:
        time.sleep(0.01)
    assert "fast" in done and "slow" not in done
    release.set()


def test_refresh_requests_are_taken_once_per_account():
    sync._refresh_requests.extend(["a@x.com", "b@x.com", "a@x.com"])
    assert sync._take_refresh("a@x.com")
    assert not sync._take_refresh("a@x.com")
    assert list(sync._refresh_requests) == ["b@x.com"]
    sync._refresh_requests.clear()


def test_steps_only_touch_their_own_account(media):
    sync.q("DELETE FROM reclaim")
    sync.q(
        "INSERT INTO reclaim (account, media_key, dedup_key, name, size, quota, state, updated) "
        "VALUES ('other@x.com', 'K', 'D', 'n.jpg', 1, 1, 'queued', 0)"
    )
    called = []
    assert not sync.reclaim_step(lambda a: called.append(a), account="test@example.com")
    assert called == []  # the other account's item is left to its own lane
    sync.q("DELETE FROM reclaim")


def test_downloads_reserve_disk_space(monkeypatch):
    import collections

    gb = 1024**3
    Usage = collections.namedtuple("Usage", "total used free")
    monkeypatch.setattr(sync.shutil, "disk_usage", lambda p: Usage(10 * gb, 0, 3 * gb))
    with sync._disk_space(1 * gb):  # one download under way
        try:
            with sync._disk_space(2 * gb):  # a second at the same time doesn't fit any more
                raise AssertionError("should not fit")
        except RuntimeError as e:
            assert "disk space" in str(e)
        with sync._disk_space(int(0.5 * gb)):
            pass
    assert sync._disk_reserved[0] == 0


def test_status_lists_background_work_per_account():
    sync.reclaim_state.clear()
    sync.copy_state.clear()
    sync._refreshing.add("c@x.com")
    sync.reclaim_state["a@x.com"]["current"] = {"key": "K", "step": "deleting", "done": 0, "total": 9, "name": "a.jpg"}
    sync.copy_state[("a@x.com", "b@x.com")]["current"] = {"key": "K2", "step": "uploading", "done": 3, "total": 9,
                                                         "name": "b.mp4"}  # fmt: skip
    jobs = sync.background_jobs()
    assert {"kind": "library", "account": "c@x.com"} in jobs
    assert {"kind": "storage", "account": "a@x.com", "name": "a.jpg", "step": "deleting", "done": 0, "total": 9} in jobs
    assert any(j["kind"] == "copy" and j["to"] == "b@x.com" and j["done"] == 3 for j in jobs)
    sync._refreshing.clear()
    sync.reclaim_state.clear()
    sync.copy_state.clear()
