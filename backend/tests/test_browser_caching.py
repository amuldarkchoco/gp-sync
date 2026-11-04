"""Cache in the app (no Redis needed), answers the browser can keep,
versioned thumbnails and a smaller live status."""

import json
import urllib.error
import urllib.request

import cache
import sync


def get(server, path, headers=None):
    req = urllib.request.Request(server + path, headers=headers or {})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def test_unchanged_answers_are_not_sent_again(server, media):
    code, headers, body = get(server, "/api/totals")
    assert code == 200 and body and headers["ETag"]
    code, headers2, body2 = get(server, "/api/totals", {"If-None-Match": headers["ETag"]})
    assert code == 304 and body2 == b"" and headers2["ETag"] == headers["ETag"]


def test_versioned_thumbnails_are_kept_for_good(server, media):
    from PIL import Image

    Image.new("RGB", (400, 300), (0, 90, 200)).save(media / "Photos" / "keep.jpg")
    _, plain, _ = get(server, "/api/thumb?path=Photos/keep.jpg")
    _, versioned, _ = get(server, "/api/thumb?path=Photos/keep.jpg&v=123")
    assert "immutable" not in plain["Cache-Control"]
    assert "immutable" in versioned["Cache-Control"]


def test_thumbnails_stay_out_of_memory_without_redis(server, media):
    from PIL import Image

    cache.clear()
    Image.new("RGB", (400, 300), (0, 90, 200)).save(media / "Photos" / "mem.jpg")
    assert get(server, "/api/thumb?path=Photos/mem.jpg")[0] == 200
    assert cache.get("thumb:Photos/mem.jpg") is None  # the file on disk is the cache


def test_file_list_has_file_time(media):
    sync.scan()
    sync.q(
        "INSERT INTO files (path,size,mtime,status,updated) VALUES (?,?,?,?,?)",
        (str(media / "Photos" / "b.HEIC"), 200, 1700000000.5, "uploaded", 1),
    )
    item = sync.list_files()["items"][0]
    assert item["mtime"] == 1700000000


def test_live_status_is_small(media):
    for _ in range(90):
        sync.net["up"].append(123456.789123)
        sync.res["cpu"].append(3.14159265)
    for i in range(100):
        sync.log_lines.append((i, "info", "line", None))
    s = json.loads(sync.status_body())
    assert all(isinstance(v, int) for v in s["net"]["up"])
    assert all(len(str(v)) <= 5 for v in s["resources"]["cpu"])
    assert len(s["log"]) == 12 and len(s["failed"]) <= 9
