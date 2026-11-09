"""Sources: where each photo and video came from, the estimated date of Snapchat saves, and what
is done in Google (album, archive, caption) for items saved from apps."""

import base64
import hashlib
import io
import json
import struct
import urllib.request

import pytest
from gpmc.db import Storage
from helpers import post
from test_dates import ACC, DAY, GpmcLike, jpeg, library_item, put, upload
from test_dates import dates as dates  # the fixture

import provenance
import sync

SNAP = b"Snapchat/14.13.0.53 (iPhone17,3; iOS 26.5; gzip)"


# ---- fixtures built in the test


def exif_jpeg(color=(10, 20, 30), fmt="JPEG", **tags):
    """A small picture with EXIF: make, model, software, comment (UserComment bytes), date."""
    from PIL import Image

    im = Image.new("RGB", (8, 8), color)
    exif = Image.Exif()
    for key, tag in (("make", 0x010F), ("model", 0x0110), ("software", 0x0131)):
        if key in tags:
            exif[tag] = tags[key]
    inner = exif.get_ifd(0x8769)
    if "comment" in tags:
        inner[0x9286] = tags["comment"]
    if "date" in tags:
        inner[0x9003] = tags["date"]
    buf = io.BytesIO()
    im.save(buf, fmt, exif=exif.tobytes())
    return buf.getvalue()


def snap_comment(record=SNAP):
    """Snapchat's UserComment: an ASCII header, then a base64 protobuf holding the record."""
    proto = b"\x0a" + bytes([len(record)]) + record + b"\x10\x01"
    return b"ASCII\0\0\0" + base64.b64encode(proto)


def atom(kind, body):
    return struct.pack(">I", 8 + len(body)) + kind + body


def mp4(handler="Core Media Video", keys=None, extra=b"", created=3_800_000_000):
    """ftyp + moov: a movie header, one track with a handler name, and Apple metadata keys."""
    mvhd = atom(b"mvhd", b"\0\0\0\0" + struct.pack(">II", created, created) + b"\0" * 92)
    hdlr = atom(b"hdlr", b"\0" * 4 + b"\0" * 4 + b"vide" + b"\0" * 12 + handler.encode() + b"\0")
    trak = atom(b"trak", atom(b"mdia", hdlr))
    meta = b""
    if keys:
        names = b"".join(struct.pack(">I", 8 + len(k)) + b"mdta" + k.encode() for k in keys)
        key_atom = atom(b"keys", b"\0" * 4 + struct.pack(">I", len(keys)) + names)
        items = b"".join(
            atom(struct.pack(">I", i), atom(b"data", b"\0\0\0\1\0\0\0\0" + v.encode()))
            for i, v in enumerate(keys.values(), 1)
        )
        meta = atom(b"meta", atom(b"hdlr", b"\0" * 8 + b"mdta" + b"\0" * 13) + key_atom + atom(b"ilst", items))
    moov = atom(b"moov", mvhd + trak + meta + extra)
    return atom(b"ftyp", b"isom\0\0\0\0isom") + moov


# ---- detection


def test_detects_every_marker(tmp_path):
    k = "com.apple.quicktime."
    apple = {f"{k}make": "Apple", f"{k}model": "iPhone 16", f"{k}software": "27.0",
             f"{k}creationdate": "2026-07-14T10:00:00+0530"}  # fmt: skip
    camera = exif_jpeg(make="Apple", model="iPhone 16", software="27.0", date="2026:07:14 10:00:00")
    tiktok = mp4(extra=atom(b"udta", b"\0\0\0\x0e\xa9cmt TikTok"), handler="VideoHandler")
    cases = {
        "snap.jpg": (exif_jpeg(comment=snap_comment()), "snapchat", "marker"),
        "shot.png": (exif_jpeg(fmt="PNG", comment=b"ASCII\0\0\0Screenshot"), "screenshot", "marker"),
        "insta.jpg": (exif_jpeg(software="Instagram"), "instagram", "marker"),
        "cam.jpg": (camera, "camera", "marker"),
        "plain.jpg": (exif_jpeg(), "app_export", "likely"),
        "export.mp4": (mp4(), "app_export", "likely"),
        "camclip.mov": (mp4(keys=apple), "camera", "marker"),
        "tiktok.mp4": (tiktok, "tiktok", "marker"),
        "IMG-20240504-WA0001.jpg": (exif_jpeg(), "whatsapp", "name"),
        "Snapchat-123456.jpg": (exif_jpeg(), "snapchat", "name"),
        "broken.jpg": (b"not a picture", "unknown", ""),
    }
    for name, (data, source, confidence) in cases.items():
        (tmp_path / name).write_bytes(data)
        info = provenance.detect(tmp_path / name)
        assert (info["source"], info["confidence"]) == (source, confidence), (name, info)
        assert info["reasons"], name
    snap = provenance.detect(tmp_path / "snap.jpg")
    assert (snap["app_version"], snap["device"], snap["os_version"]) == ("14.13.0.53", "iPhone17,3", "26.5")
    cam = provenance.detect(tmp_path / "cam.jpg")
    assert (cam["device"], cam["os_version"]) == ("iPhone 16", "27.0") and cam["taken"]
    clip = provenance.detect(tmp_path / "camclip.mov")
    assert clip["os_version"] == "27.0" and clip["taken"] == 1_784_003_400  # 04:30 UTC


def test_snapchat_record_plain_or_encoded():
    assert provenance.snapchat_record(snap_comment()) == ("14.13.0.53", "iPhone17,3", "iOS", "26.5")
    assert provenance.snapchat_record(b"ASCII\0\0\0" + SNAP) == ("14.13.0.53", "iPhone17,3", "iOS", "26.5")
    assert provenance.snapchat_record(b"ASCII\0\0\0hello world, nothing here") is None
    assert provenance.snapchat_record(None) is None


@pytest.mark.parametrize(
    ("name", "want"),
    [
        ("IMG-20240504-WA0001.jpg", (2024, 5, 4, 0, 0, 0)),
        ("Screenshot_20240504-103015.png", (2024, 5, 4, 10, 30, 15)),
        ("PXL_20240504_103015123.jpg", (2024, 5, 4, 10, 30, 15)),
        ("VID_20240504_103015.mp4", (2024, 5, 4, 10, 30, 15)),
        ("WhatsApp Image 2024-05-04 at 9.05.01.jpeg", (2024, 5, 4, 9, 5, 1)),
        ("IMG-20240231-WA0001.jpg", None),  # no 31 February
        ("0f3a9c.jpg", None),
    ],
)
def test_dates_in_file_names(name, want):
    import calendar

    got = provenance.name_date(name, tz_offset_min=330)
    if want is None:
        assert got is None
    else:
        assert got == calendar.timegm((*want, 0, 0, 0)) - 330 * 60


# ---- placing Snapchat saves in time


def _library():
    """iPhone 16 camera photos: iOS 26.5 on days 0-60, 27.0 on days 61-140, 27.1 on days 141-200."""
    cam = []
    for os_ver, first, last in (("26.5", 0, 60), ("27.0", 61, 140), ("27.1", 141, 200)):
        cam += [("iPhone 16", os_ver, first * DAY), ("iPhone 16", os_ver, last * DAY)]
    return cam


def test_anchors_and_interpolation():
    snaps = [
        ("a1", "14.10.0.1", "iPhone17,3", "26.5", None),
        ("a2", "14.10.0.1", "iPhone17,3", "27.0", None),  # caught on both sides: an anchor
        ("b1", "14.21.0.9", "iPhone17,3", "27.0", None),
        ("b2", "14.21.0.9", "iPhone17,3", "27.1", None),  # the second anchor
        ("mid", "14.15.0.3", "iPhone17,3", "27.0", None),
    ]
    out = provenance.estimate_snapchat_dates(snaps, _library())
    assert out["a1"]["date"] == pytest.approx(60.5 * DAY)
    assert out["b1"]["date"] == pytest.approx(140.5 * DAY)
    step = 80 / 11  # 11 versions between the anchors over 80 days
    assert out["mid"]["date"] == pytest.approx((60.5 + 5 * step) * DAY)
    assert out["mid"]["lo"] < out["mid"]["date"] < out["mid"]["hi"]
    assert (out["mid"]["hi"] - out["mid"]["lo"]) / 2 < 6 * DAY  # about ± a few days, not months
    assert "between anchors 14.10" in out["mid"]["reason"]


def test_window_only_without_anchors_and_arrival_cap():
    out = provenance.estimate_snapchat_dates([("x", "14.15.0.3", "iPhone17,3", "27.0", None)], _library())
    assert out["x"]["date"] == pytest.approx(100.5 * DAY)
    assert out["x"]["lo"] == 61 * DAY and out["x"]["hi"] == 140 * DAY
    assert "within the time" in out["x"]["reason"]
    capped = provenance.estimate_snapchat_dates([("x", "14.15.0.3", "iPhone17,3", "27.0", 80 * DAY)], _library())
    assert capped["x"]["hi"] == 80 * DAY and capped["x"]["date"] <= 80 * DAY


def test_versions_stay_in_order_and_unknown_phones_use_any_iphone():
    snaps = [
        ("old", "14.12.0.1", "iPhone99,9", "27.0", None),  # unmapped model: windows of all iPhones
        ("new", "14.11.0.1", "iPhone99,9", "26.5", None),
        ("newer", "14.13.0.1", "iPhone99,9", "26.5", None),
    ]
    out = provenance.estimate_snapchat_dates(snaps, _library())
    # 14.12 is later than 14.13's iOS window allows: bounds are squeezed so later versions are never older.
    assert out["new"]["date"] <= out["old"]["date"]
    assert set(out) == {"old", "new", "newer"}
    assert provenance.estimate_snapchat_dates(snaps, []) == {}  # no camera photos: nothing to go on


def test_version_steps_cross_majors():
    steps = provenance._version_steps([(13, 93), (13, 95), (14, 10), (14, 12)])
    assert steps == {(13, 93): 0, (13, 95): 2, (14, 10): 3, (14, 12): 5}


# ---- in GP Sync


@pytest.fixture
def src(dates):
    sync.sq("DELETE FROM provenance")
    sync.sources_state.update(error="", needs_library=False)
    return dates


def _uploaded(name, data, mtime=1_790_000_000, client=None):
    p = put(name, data, mtime)
    sync.scan()
    client = client or GpmcLike()
    upload(client, p)
    sync.state["phase"] = "idle"  # the upload is over; labels are made while idle
    return p, client


def test_labels_files_while_idle_and_keeps_decisions(src):
    put("Photos/snap.jpg", exif_jpeg(comment=snap_comment()), 1_790_000_000)
    put("Photos/cam.jpg", exif_jpeg(make="Apple", model="iPhone 16", software="26.5", date="2026:05:01 10:00:00"),
        1_790_000_000)  # fmt: skip
    sync.scan()
    sync.dates_some()
    rows = dict(sync.sq("SELECT path, source FROM provenance"))
    assert rows == {str(sync.MEDIA / "Photos/snap.jpg"): "snapchat", str(sync.MEDIA / "Photos/cam.jpg"): "camera"}
    # Only one camera photo on 26.5: the snap is placed on that day (and before it reached the server).
    est = sync.estimated_date(str(sync.MEDIA / "Photos/snap.jpg"))
    assert est == pytest.approx(sync.provenance._exif_date("2026:05:01 10:00:00"), abs=DAY)

    assert sync.sources_decide(["Photos/snap.jpg"], "instagram") == {"updated": 1}
    assert sync.estimated_date(str(sync.MEDIA / "Photos/snap.jpg")) is None  # no longer Snapchat
    put("Photos/snap.jpg", exif_jpeg((1, 2, 3), comment=snap_comment()), 1_790_000_100)  # changed
    sync.scan()
    sync.dates_some()
    assert sync.sq("SELECT source, decision FROM provenance WHERE path=?", (str(sync.MEDIA / "Photos/snap.jpg"),)) == [
        ("snapchat", "instagram")
    ]
    with pytest.raises(ValueError):
        sync.sources_decide(["Photos/snap.jpg"], "myspace")
    assert sync.sources_decide(["Photos/snap.jpg"], "auto") == {"updated": 1}
    assert sync.sources_report("snapchat")["items"][0]["decided"] is False


def test_names_and_estimates_feed_the_upload_date(src):
    wa = put("Photos/IMG-20240504-WA0001.jpg", jpeg(), 1_790_000_000)
    sha = hashlib.sha1(wa.read_bytes()).hexdigest()
    when, where = sync.best_date(str(wa), wa.stat().st_size, wa.stat().st_mtime, sha)
    assert where == "filename" and sync.time.gmtime(when)[:3] == (2024, 5, 4)

    put("Photos/cam.jpg", exif_jpeg(make="Apple", model="iPhone 16", software="26.5", date="2026:05:01 10:00:00"),
        1_790_000_000)  # fmt: skip
    sync.scan()
    sync.dates_some()
    client = GpmcLike()
    snap = put("Photos/snap.jpg", exif_jpeg(comment=snap_comment()), 1_790_000_000)
    sync.scan()
    upload(client, snap)  # labelled and estimated right before the upload
    assert client.api.sent == [pytest.approx(sync.provenance._exif_date("2026:05:01 10:00:00"), abs=DAY)]
    sync.update_settings({"sources": {"estimate_dates": False}})
    assert sync.best_date(str(snap), snap.stat().st_size, snap.stat().st_mtime, None)[1] != "estimated"


def test_nothing_in_google_until_asked_then_album_caption_archive(src):
    snap, client = _uploaded("Photos/snap.jpg", exif_jpeg(comment=snap_comment()))
    sync.dates_some()
    step = lambda: sync.sources_step(lambda a: client)  # noqa: E731
    assert not step()  # not asked yet
    assert client.api.albums == {} and client.api.calls == []

    sync.update_settings({"sources": {"asked": True}})
    assert step()
    assert list(client.api.albums.values()) == [("Snapchat", ["KEY1"])]
    assert sync.sources_state["needs_library"]  # captions wait for the library list
    assert not [c for c in client.api.calls if c[0] == "caption"]

    sha = hashlib.sha1(snap.read_bytes()).hexdigest()
    dedup = sync._b64_hash(bytes.fromhex(sha))
    db = sync._library_db(ACC)
    db.parent.mkdir(parents=True, exist_ok=True)
    with Storage(db) as st:
        st.update([library_item(sha, 1_790_000_000)])
    assert step()
    assert client.api.calls == [("caption", dedup, "Saved from Snapchat")]
    assert not step()  # all done: nothing again

    sync.update_settings({"sources": {"snapchat": {"archive": True}}})
    assert step()
    assert client.api.calls[-1] == ("archived", [dedup], True)
    sync.update_settings({"sources": {"snapchat": {"archive": False, "caption": False}}})
    with Storage(db) as st:  # Google now shows our caption
        st.update([library_item(sha, 1_790_000_000, caption="Saved from Snapchat")])
    assert step()
    assert ("archived", [dedup], False) in client.api.calls
    assert client.api.calls[-1] == ("caption", dedup, "")  # ours, so it is taken away
    report = sync.sources_report("snapchat")["items"][0]
    assert report["album"] == "Snapchat" and not report["archived"] and not report["captioned"]


def test_own_caption_is_never_replaced(src):
    snap, client = _uploaded("Photos/snap.jpg", exif_jpeg(comment=snap_comment()))
    sync.dates_some()
    sha = hashlib.sha1(snap.read_bytes()).hexdigest()
    db = sync._library_db(ACC)
    db.parent.mkdir(parents=True, exist_ok=True)
    with Storage(db) as st:
        st.update([library_item(sha, 1_790_000_000, caption="Manali trip")])
    sync.update_settings({"sources": {"asked": True}})
    sync.sources_step(lambda a: client)
    assert not [c for c in client.api.calls if c[0] == "caption"]
    assert sync.sq("SELECT captioned FROM provenance") == [("-",)]


def test_app_album_replaces_the_date_unknown_album(src):
    _, client = _uploaded("Photos/snap.jpg", exif_jpeg(comment=snap_comment()))
    sync.dates_some()
    sync.update_settings({"undated": {"asked": True}})
    assert sync.own_album_paths() == set()  # sources not chosen yet: Date unknown still gets it
    sync.update_settings({"sources": {"asked": True}})
    assert sync.own_album_paths() == {str(sync.MEDIA / "Photos/snap.jpg")}
    assert not sync.undated_album_step(lambda a: client)


def test_accepting_estimates_queues_fix_dates(src):
    put("Photos/cam.jpg", exif_jpeg(make="Apple", model="iPhone 16", software="26.5", date="2026:05:01 10:00:00"),
        1_790_000_000)  # fmt: skip
    sync.update_settings({"sources": {"estimate_dates": False}})  # uploaded with the file time
    snap, _client = _uploaded("Photos/snap.jpg", exif_jpeg(comment=snap_comment()))
    sync.dates_some()
    assert sync.sources_accept_dates(["Photos/snap.jpg", "Photos/cam.jpg", "../etc/passwd"]) == {
        "accepted": 1,
        "queued": 1,
    }
    manual = sync.sq("SELECT manual FROM media_dates WHERE path=?", (str(snap),))[0][0]
    assert manual == sync.estimated_date(str(snap))


def test_settings_are_checked(src):
    s = sync.update_settings({"sources": {"snapchat": {"album_name": "  My   snaps ", "archive": 1}}})["sources"]
    assert s["snapchat"] == {"album": True, "album_name": "My snaps", "caption": True, "archive": True}
    s = sync.update_settings({"sources": {"snapchat": {"album_name": ""}}})["sources"]
    assert s["snapchat"]["album_name"] == "Snapchat"
    with pytest.raises(ValueError):
        sync.update_settings({"sources": {"snapchat": "on"}})
    with pytest.raises(ValueError):
        sync.update_settings({"sources": []})


def test_sources_api(src, server):
    _uploaded("Photos/snap.jpg", exif_jpeg(comment=snap_comment()))
    sync.dates_some()
    with urllib.request.urlopen(f"{server}/api/sources?source=snapchat") as r:
        body = json.loads(r.read())
    assert body["counts"]["snapchat"] == 1 and body["items"][0]["name"] == "Photos/snap.jpg"
    assert body["items"][0]["reasons"] and body["settings"]["asked"] is False

    decide = json.dumps({"paths": ["Photos/snap.jpg"], "source": "tiktok"}).encode()
    code, out = post(f"{server}/api/sources/decide", decide)
    assert code == 200 and json.loads(out) == {"updated": 1}
    for path, body in [
        ("/api/sources/decide", b"{not json"),
        ("/api/sources/decide", json.dumps({"paths": ["Photos/snap.jpg"], "source": "nope"}).encode()),
        ("/api/sources/settings", json.dumps({"settings": "x"}).encode()),
        ("/api/sources/settings", json.dumps({"settings": {"snapchat": 5}}).encode()),
        ("/api/sources/decide", b"[1, 2]"),
    ]:
        assert post(server + path, body)[0] == 400, (path, body)
    assert post(f"{server}/api/sources/nothing", b"{}")[0] == 404
    code, out = post(f"{server}/api/sources/settings", json.dumps({"settings": {"asked": True}}).encode())
    assert code == 200 and json.loads(out)["settings"]["asked"] is True
    code, out = post(f"{server}/api/sources/accept-dates", json.dumps({"paths": ["Photos/snap.jpg"]}).encode())
    assert code == 200 and json.loads(out) == {"accepted": 0, "queued": 0}  # labelled TikTok now


class PickyApi:
    """Like Google: a batch with one item it doesn't know fails as a whole (404)."""

    def __init__(self, known):
        self.known, self.albums = set(known), {}

    def _check(self, keys):
        if not set(keys) <= self.known:
            raise RuntimeError("404 Client Error: Not Found")

    def create_album(self, album_name, media_keys):
        self._check(media_keys)
        self.albums["ALB"] = (album_name, list(media_keys))
        return "ALB"

    def add_media_to_album(self, album_media_key, media_keys):
        self._check(media_keys)
        self.albums[album_media_key][1].extend(media_keys)


def test_one_missing_item_doesnt_block_the_album(src):
    class Client:
        api = PickyApi({"K0", "K1", "K2", "K4", "NEW3"})

    sync.q("DELETE FROM albums")
    sync._album_refused.clear()
    sync.meta_set(f"library_refreshed:{ACC}", "0")  # no library list read yet
    items = [(f"/media/p{i}.jpg", f"K{i}") for i in range(5)]
    added, left_out, ok = sync.album_add(Client(), ACC, "Snapchat", items)
    assert ok and sorted(added) == ["/media/p0.jpg", "/media/p1.jpg", "/media/p2.jpg", "/media/p4.jpg"]
    assert left_out == ["/media/p3.jpg"]
    assert sorted(Client.api.albums["ALB"][1]) == ["K0", "K1", "K2", "K4"]
    # Refused items wait instead of failing every round.
    assert sync.album_add(Client(), ACC, "Snapchat", [("/media/p3.jpg", "K3")]) == ([], [], True)

    # With the library read, a replaced item is found under its current key.
    sync._album_refused.clear()
    data = b"replaced photo"
    sha = hashlib.sha1(data).hexdigest()
    sync.q("INSERT OR REPLACE INTO files (path, status, account, sha1, media_key, updated) VALUES (?,?,?,?,?,?)",
           ("/media/p3.jpg", "uploaded", ACC, sha, "K3", 1))  # fmt: skip
    db = sync._library_db(ACC)
    db.parent.mkdir(parents=True, exist_ok=True)
    item = library_item(sha, 1_790_000_000)
    item.media_key = "NEW3"
    with Storage(db) as st:
        st.update([item])
    sync.meta_set(f"library_refreshed:{ACC}", "100")
    added, left_out, ok = sync.album_add(Client(), ACC, "Snapchat", [("/media/p3.jpg", "K3")])
    assert added == ["/media/p3.jpg"] and "NEW3" in Client.api.albums["ALB"][1]
    assert sync.q("SELECT media_key FROM files WHERE path='/media/p3.jpg'") == [("NEW3",)]
