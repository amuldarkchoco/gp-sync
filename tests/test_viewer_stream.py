"""Viewer (previews, original files), file details, single retry,
resumable uploads into named folders and the live event stream."""

import json
import socket
import urllib.error
import urllib.parse
import urllib.request

import pytest
from helpers import post

import sync


@pytest.fixture
def uploads(media, monkeypatch):
    monkeypatch.setattr(sync, "_owned", lambda p: None)
    sync.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    return sync.UPLOAD_DIR


def get(server, path, headers=None):
    req = urllib.request.Request(server + path, headers=headers or {})
    with urllib.request.urlopen(req) as r:
        return r.status, dict(r.headers), r.read()


# --- viewer


def test_preview_of_a_photo(server, media):
    from PIL import Image

    Image.new("RGB", (3000, 2000), (200, 30, 30)).save(media / "Photos" / "big.jpg")
    code, headers, body = get(server, "/api/preview?path=Photos/big.jpg")
    assert code == 200 and headers["Content-Type"] == "image/webp"
    import io

    with Image.open(io.BytesIO(body)) as im:
        assert max(im.size) == sync.PREVIEW_SIZE


def test_original_file_with_ranges(server, media):
    code, headers, body = get(server, "/api/media?path=Videos/c.mp4")
    assert code == 200 and body == b"z" * 300 and headers["Accept-Ranges"] == "bytes"
    assert headers["Content-Type"] == "video/mp4"
    code, headers, body = get(server, "/api/media?path=Videos/c.mp4", {"Range": "bytes=10-19"})
    assert code == 206 and len(body) == 10 and headers["Content-Range"] == "bytes 10-19/300"
    code, headers, body = get(server, "/api/media?path=Videos/c.mp4", {"Range": "bytes=-5"})
    assert code == 206 and len(body) == 5
    code, headers, _ = get(server, "/api/media?path=Photos/b.HEIC&download=1")
    assert "attachment" in headers["Content-Disposition"]
    with pytest.raises(urllib.error.HTTPError) as e:
        get(server, "/api/media?path=Videos/c.mp4", {"Range": "bytes=900-"})
    assert e.value.code == 416
    for bad in ("../state.db", "Photos/notes.txt", "Photos/../../data/state.db"):
        with pytest.raises(urllib.error.HTTPError) as e:
            get(server, "/api/media?path=" + urllib.parse.quote(bad))
        assert e.value.code == 404


def test_file_details_and_single_retry(server, media):
    from helpers import FakeClient

    todo = sync.scan()
    sync.upload_all(FakeClient({"a.jpg": "uploading", "b.HEIC": "skipped", "c.mp4": KeyError("broken")}), todo)
    _, _, body = get(server, "/api/file?path=Videos/c.mp4")
    f = json.loads(body)
    assert f["status"] == "failed" and "broken" in f["error"] and f["attempts"] == 1
    assert f["kind"] == "video" and f["playable"] and f["history"]
    _, _, body = get(server, "/api/file?path=Photos/trip/a.jpg")
    assert json.loads(body)["google_url"].startswith("https://photos.google.com/photo/")

    _, body = post(server + "/api/retry", json.dumps({"path": "Videos/c.mp4"}).encode())
    assert json.loads(body)["ok"] is True
    assert sync.q("SELECT attempts FROM files WHERE path=?", (str(sync.MEDIA / "Videos/c.mp4"),))[0][0] == 0
    _, body = post(server + "/api/retry", json.dumps({"path": "Photos/trip/a.jpg"}).encode())
    assert json.loads(body)["ok"] is False  # not failed: nothing to do


# --- resumable uploads


def piece(server, uid, name, offset, total, data, folder=""):
    q = urllib.parse.urlencode(
        {"id": uid, "name": name, "offset": offset, "total": total, "mtime": 1_700_000_000_000, "folder": folder}
    )
    code, body = post(f"{server}/api/upload?{q}", data)
    return code, json.loads(body or b"{}")


def test_upload_in_pieces_and_resume(server, uploads):
    data = bytes(range(256)) * 40  # 10 KB
    uid = "test-upload-0001"
    assert piece(server, uid, "VID_1.mp4", 0, len(data), data[:4000]) == (200, {"ok": True, "offset": 4000})
    # The connection dropped: the phone asks how much arrived and continues from there.
    _, _, body = get(server, f"/api/upload?id={uid}")
    assert json.loads(body)["offset"] == 4000
    code, r = piece(server, uid, "VID_1.mp4", 2000, len(data), data[2000:6000])  # wrong offset
    assert code == 409 and r["offset"] == 4000
    code, r = piece(server, uid, "VID_1.mp4", 4000, len(data), data[4000:], folder="Goa Trip")
    assert code == 200 and r["saved"] == "Photos/Uploads/Goa Trip/VID_1.mp4"
    assert (sync.MEDIA / r["saved"]).read_bytes() == data
    assert not list((uploads / sync.CHUNKS).glob("*.part"))
    _, _, body = get(server, "/api/upload")
    assert "Goa Trip" in json.loads(body)["folders"]


def test_piece_checks(server, uploads):
    assert piece(server, "bad id!", "a.jpg", 0, 5, b"x")[0] == 400
    assert piece(server, "upload-id-002", "a.txt", 0, 5, b"x")[0] == 400
    assert piece(server, "upload-id-003", "a.jpg", 0, 3, b"xxxxx")[0] == 400  # longer than the file
    code, r = piece(server, "upload-id-004", "a.jpg", 0, 5, b"hello", folder="../../evil")
    assert code == 200 and r["saved"] == "Photos/Uploads/evil/a.jpg"


def test_stale_pieces_are_cleaned(uploads):
    d = uploads / sync.CHUNKS
    d.mkdir(exist_ok=True)
    old = d / "old-upload-1.part"
    old.write_bytes(b"x")
    import os

    os.utime(old, (0, 0))
    sync.clean_chunks()
    assert not old.exists()


# --- live updates


def test_live_stream_sends_status(server):
    host, port = server.removeprefix("http://").split(":")
    with socket.create_connection((host, int(port)), timeout=5) as s:
        s.sendall(b"GET /api/stream HTTP/1.1\r\nHost: x\r\n\r\n")
        buf = b""
        while b"\n\n" not in buf.split(b"\r\n\r\n", 1)[-1]:
            buf += s.recv(65536)
    head, body = buf.split(b"\r\n\r\n", 1)
    assert b"text/event-stream" in head
    event = json.loads(body.split(b"\n\n")[0].removeprefix(b"data: "))
    assert "phase" in event and "pending" in event
