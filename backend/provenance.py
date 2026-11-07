"""Where a photo or video came from: a camera, Snapchat, a screenshot, another app.

Only evidence inside the file (or its name) is used, never a guess from its size alone:

- Snapchat writes a small record into EXIF UserComment (base64 protobuf) with the app version,
  phone model and iOS version at the moment the snap was saved, e.g.
  ``Snapchat/14.13.0.53 (iPhone17,3; iOS 26.5; gzip)``.
- iOS screenshots say ``Screenshot`` in UserComment; Instagram sets Software=Instagram; TikTok
  leaves its name in the video metadata.
- Camera photos and videos name their maker and model.
- Videos exported by an iPhone app (handler "Core Media Video", no Apple camera keys) and images
  without any camera data were saved from an app, but no app name survives: "Saved from an app".

Snapchat records carry no date, but their app version and iOS version can be placed in time with
the user's own camera photos (see estimate_snapchat_dates).
"""

import base64
import calendar
import itertools
import re
from pathlib import Path

CAMERA = "camera"
APP_SOURCES = ("snapchat", "instagram", "tiktok", "whatsapp", "telegram", "screenshot", "app_export")
SOURCES = (CAMERA, *APP_SOURCES, "unknown")
LABELS = {
    "camera": "Camera",
    "snapchat": "Snapchat",
    "instagram": "Instagram",
    "tiktok": "TikTok",
    "whatsapp": "WhatsApp",
    "telegram": "Telegram",
    "screenshot": "Screenshot",
    "app_export": "Saved from an app",
    "unknown": "Unknown",
}

PHOTO_TYPES = {"jpg", "jpeg", "png", "heic", "heif", "webp", "tif", "tiff", "avif", "gif", "bmp"}
MOVIE_TYPES = {"mp4", "mov", "m4v", "3gp", "3g2"}
_MAC_EPOCH = 2082844800  # seconds from 1904-01-01 (QuickTime) to 1970-01-01

# Apple's model codes (what Snapchat records) and the names cameras write in EXIF.
APPLE_MODELS = {
    "iPhone12,1": "iPhone 11", "iPhone12,3": "iPhone 11 Pro", "iPhone12,5": "iPhone 11 Pro Max",
    "iPhone12,8": "iPhone SE (2nd generation)", "iPhone13,1": "iPhone 12 mini", "iPhone13,2": "iPhone 12",
    "iPhone13,3": "iPhone 12 Pro", "iPhone13,4": "iPhone 12 Pro Max", "iPhone14,4": "iPhone 13 mini",
    "iPhone14,5": "iPhone 13", "iPhone14,2": "iPhone 13 Pro", "iPhone14,3": "iPhone 13 Pro Max",
    "iPhone14,6": "iPhone SE (3rd generation)", "iPhone14,7": "iPhone 14", "iPhone14,8": "iPhone 14 Plus",
    "iPhone15,2": "iPhone 14 Pro", "iPhone15,3": "iPhone 14 Pro Max", "iPhone15,4": "iPhone 15",
    "iPhone15,5": "iPhone 15 Plus", "iPhone16,1": "iPhone 15 Pro", "iPhone16,2": "iPhone 15 Pro Max",
    "iPhone17,1": "iPhone 16 Pro", "iPhone17,2": "iPhone 16 Pro Max", "iPhone17,3": "iPhone 16",
    "iPhone17,4": "iPhone 16 Plus", "iPhone17,5": "iPhone 16e", "iPhone18,1": "iPhone 17 Pro",
    "iPhone18,2": "iPhone 17 Pro Max", "iPhone18,3": "iPhone 17", "iPhone18,4": "iPhone Air",
}  # fmt: skip

SNAP_RECORD = re.compile(rb"Snapchat/(\d+(?:\.\d+)+) \(([^;()]+);\s*(iOS|Android)\s*([\d.]+)")
OS_VERSION = re.compile(r"\d+(?:\.\d+){0,3}")

# Names apps give the files they save. Dates in names are local time (year, month, day[, h, m, s]).
_D = r"(?P<y>(?:19|20)\d\d)-?(?P<mo>[01]\d)-?(?P<d>[0-3]\d)"
_T = r"(?:[_ -]?(?:at )?(?P<h>[0-2]\d)[.:-]?(?P<mi>[0-5]\d)[.:-]?(?P<s>[0-5]\d))?"
NAME_RULES = (
    ("snapchat", re.compile(r"^snapchat-\d+", re.I), False),
    ("whatsapp", re.compile(rf"^(?:IMG|VID|AUD|PTT|STK)-{_D}-WA\d+", re.I), True),
    ("whatsapp", re.compile(r"^WhatsApp (?:Image|Video) (?P<y>\d{4})-(?P<mo>\d\d)-(?P<d>\d\d) at "
                            r"(?P<h>\d{1,2})\.(?P<mi>\d\d)\.(?P<s>\d\d)", re.I), True),
    ("telegram", re.compile(rf"^(?:photo|video)_{_D}_(?P<h>\d\d)-(?P<mi>\d\d)-(?P<s>\d\d)", re.I), True),
    ("telegram", re.compile(r"telegram", re.I), False),
    ("screenshot", re.compile(rf"^Screenshot[ _-]{_D}{_T}", re.I), True),
    ("screenshot", re.compile(r"^(?:Screenshot|Screen Shot)\b", re.I), False),
    ("camera", re.compile(rf"^(?:PXL|IMG|VID|MVIMG)_{_D}_(?P<h>\d\d)(?P<mi>\d\d)(?P<s>\d\d)", re.I), True),
    ("camera", re.compile(rf"^{_D}_(?P<h>\d\d)(?P<mi>\d\d)(?P<s>\d\d)(?:\D|$)"), True),
)  # fmt: skip


def name_hint(name):
    """(source, date parts or None) suggested by a file name, or (None, None)."""
    stem = Path(str(name)).name
    for source, rule, dated in NAME_RULES:
        m = rule.search(stem)
        if not m:
            continue
        parts = None
        if dated:
            g = m.groupdict()
            parts = tuple(int(g.get(k) or 0) for k in ("y", "mo", "d", "h", "mi", "s"))
            if not _valid_parts(parts):
                parts = None
        return source, parts
    return None, None


def _valid_parts(p):
    y, mo, d, h, mi, s = p
    if not (1990 <= y <= 2100 and 1 <= mo <= 12 and h < 24 and mi < 60 and s < 60):
        return False
    return 1 <= d <= calendar.monthrange(y, mo)[1]


def name_date(name, tz_offset_min=0):
    """Unix time from a dated file name (its local time in the viewer's time zone), or None."""
    _, parts = name_hint(name)
    if not parts:
        return None
    return float(calendar.timegm((*parts, 0, 0, 0)) - tz_offset_min * 60)


def snapchat_record(comment):
    """(app version, device code, OS name, OS version) from a UserComment value, or None."""
    if comment is None:
        return None
    raw = _user_comment(comment).encode("utf-8", "ignore")  # without the character-set header
    found = SNAP_RECORD.search(raw)
    if not found:
        text = re.sub(rb"[^A-Za-z0-9+/=_-]", b"", raw)
        if len(text) >= 16:
            try:
                found = SNAP_RECORD.search(base64.b64decode(text + b"=" * (-len(text) % 4), altchars=b"-_"))
            except (ValueError, TypeError):
                found = None
    if not found:
        return None
    ver, device, os_name, os_ver = (x.decode("ascii", "ignore").strip() for x in found.groups())
    return ver, device, os_name, os_ver


def _user_comment(value):
    """EXIF UserComment as text (its 8-byte character-set header removed)."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip("\x00 ")
    head, body = value[:8], value[8:]
    if head.startswith(b"UNICODE"):
        for enc in ("utf-16-be", "utf-16-le"):
            try:
                return body.decode(enc).strip("\x00 ")
            except UnicodeDecodeError:
                continue
    if head.startswith((b"ASCII", b"JIS", b"\x00\x00\x00\x00\x00\x00\x00\x00")):
        return body.decode("utf-8", "ignore").strip("\x00 ")
    return value.decode("utf-8", "ignore").strip("\x00 ")


def _exif_date(text):
    m = re.match(r"(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)", str(text or ""))
    if not m:
        return None
    parts = tuple(int(x) for x in m.groups())
    return float(calendar.timegm((*parts, 0, 0, 0))) if _valid_parts(parts) else None


def _photo_facts(path):
    from PIL import Image

    from media import _enable_heif

    _enable_heif()
    with Image.open(path) as im:
        exif = im.getexif()
        inner = exif.get_ifd(0x8769)
        xmp = im.info.get("xmp") or im.info.get("XML:com.adobe.xmp") or b""
        if isinstance(xmp, str):
            xmp = xmp.encode("utf-8", "ignore")
        comment = inner.get(0x9286)
        return {
            "make": str(exif.get(0x010F) or "").strip("\x00 "),
            "model": str(exif.get(0x0110) or "").strip("\x00 "),
            "software": str(exif.get(0x0131) or "").strip("\x00 "),
            "comment": comment,
            "comment_text": _user_comment(comment),
            "taken": _exif_date(inner.get(0x9003) or inner.get(0x9004)),
            "xmp": xmp,
            "format": im.format or "",
        }


def _atoms(f, start, end):
    from media import _atoms as atoms

    return atoms(f, start, end)


def _movie_facts(path, limit=16 * 1024 * 1024):
    """Apple/Android metadata keys, handler names and the movie header date of an MP4/MOV."""
    out = {"keys": {}, "handlers": [], "created": None, "blob": b"", "xmp": b""}
    with open(path, "rb") as f:
        f.seek(0, 2)
        end = f.tell()
        for kind, body, stop in _atoms(f, 0, end):
            if kind == b"moov" and not out["blob"]:
                f.seek(body)
                out["blob"] = f.read(min(stop - body, limit))
                _read_moov(out["blob"], out)
            elif kind == b"uuid" and stop - body <= 1024 * 1024:  # XMP box (TikTok, editors)
                f.seek(body)
                out["xmp"] += f.read(stop - body)
    return out


def _read_moov(blob, out):
    import io

    f = io.BytesIO(blob)
    end = len(blob)

    def walk(start, stop, depth):
        for kind, body, sub_end in _atoms(f, start, stop):
            if kind == b"mvhd":
                f.seek(body)
                version = f.read(4)[:1]
                raw = f.read(8 if version == b"\x01" else 4)
                secs = int.from_bytes(raw, "big") - _MAC_EPOCH if raw else 0
                if secs > 365 * 86400:
                    out["created"] = float(secs)
            elif kind == b"hdlr":
                f.seek(body + 24)
                name = f.read(max(0, sub_end - body - 24))
                out["handlers"].append(name.strip(b"\x00").lstrip(b"\x0b").decode("utf-8", "ignore").strip())
            elif kind == b"meta":
                f.seek(body)
                skip = 0 if f.read(8)[4:8] == b"hdlr" else 4  # QuickTime meta has no version field
                _read_keys(f, body + skip, sub_end, out["keys"])
            elif kind in (b"trak", b"mdia", b"udta") and depth < 4:
                walk(body, sub_end, depth + 1)

    walk(0, end, 0)


def _read_keys(f, start, stop, keys):
    names = []
    items = {}
    for kind, body, sub_end in _atoms(f, start, stop):
        if kind == b"keys":
            f.seek(body + 8)
            pos = body + 8
            while pos + 8 <= sub_end:
                f.seek(pos)
                size = int.from_bytes(f.read(4), "big")
                if size < 8:
                    break
                f.read(4)  # namespace, e.g. mdta
                names.append(f.read(size - 8).decode("utf-8", "ignore"))
                pos += size
        elif kind == b"ilst":
            for item, ibody, iend in _atoms(f, body, sub_end):
                index = int.from_bytes(item, "big")
                for dkind, dbody, dend in _atoms(f, ibody, iend):
                    if dkind == b"data":
                        f.seek(dbody + 8)
                        items[index] = f.read(max(0, dend - dbody - 8))
    for index, value in items.items():
        if 0 < index <= len(names):
            keys[names[index - 1]] = value.decode("utf-8", "ignore").strip("\x00 ")


def _iso_date(text):
    m = re.match(r"(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-]\d\d:?\d\d)?", str(text or ""))
    if not m:
        return None
    parts = tuple(int(x) for x in m.groups()[:6])
    if not _valid_parts(parts):
        return None
    t = calendar.timegm((*parts, 0, 0, 0))
    zone = m[7]
    if zone and zone != "Z":
        sign = -1 if zone[0] == "-" else 1
        zone = zone[1:].replace(":", "")
        t -= sign * (int(zone[:2]) * 3600 + int(zone[2:]) * 60)
    return float(t)


def _os_of(make, software):
    return software if make.lower() == "apple" and OS_VERSION.fullmatch(software or "") else ""


def detect(path):
    """Where a file came from. Never raises: unreadable files are "unknown".

    Returns {source, app, device, app_version, os_version, taken, confidence, reasons}."""
    name = Path(str(path)).name
    kind = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    out = {"source": "unknown", "app": "", "device": "", "app_version": "", "os_version": "", "taken": None,
           "confidence": "", "reasons": []}  # fmt: skip
    hint, _ = name_hint(name)

    def found(source, confidence, reason, **extra):
        out.update({"source": source, "confidence": confidence, "app": LABELS.get(source, ""), **extra})
        out["reasons"].append(reason)
        return out

    try:
        if kind in MOVIE_TYPES:
            return _detect_movie(path, out, hint, found)
        if kind in PHOTO_TYPES:
            return _detect_photo(path, out, hint, found)
    except Exception as e:  # damaged, or a format Pillow can't read
        out["reasons"].append(f"Could not read the file ({type(e).__name__})")
        if hint and hint != CAMERA:
            return found(hint, "name", f"File name looks like {LABELS[hint]}")
        return out
    if hint and hint != CAMERA:
        return found(hint, "name", f"File name looks like {LABELS[hint]}")
    return out


def _detect_photo(path, out, hint, found):
    facts = _photo_facts(path)
    make, model, software = facts["make"], facts["model"], facts["software"]
    out["taken"] = facts["taken"]
    snap = snapchat_record(facts["comment"])
    if snap:
        ver, device, os_name, os_ver = snap
        return found(
            "snapchat", "marker", f"Snapchat {ver} record ({APPLE_MODELS.get(device, device)}, {os_name} {os_ver})",
            app_version=ver, device=device, os_version=os_ver,
        )  # fmt: skip
    if hint == "snapchat":
        return found("snapchat", "name", "File name starts with Snapchat-")
    comment = facts["comment_text"]
    if comment.lower() == "screenshot" or b">Screenshot<" in facts["xmp"]:
        return found("screenshot", "marker", "Marked as a screenshot by the phone", device=model)
    if hint == "screenshot":
        return found("screenshot", "name", "File name says Screenshot", device=model)
    if software.lower() == "instagram":
        return found("instagram", "marker", "Saved by Instagram (Software tag)")
    if hint in ("whatsapp", "telegram"):
        return found(hint, "name", f"File name looks like {LABELS[hint]}")
    if make or model:
        device = model if model.lower().startswith(make.lower()) or not make else f"{make} {model}".strip()
        if make.lower() == "apple":
            device = model
        return found(CAMERA, "marker", f"Taken with {device or make}", device=device,
                     os_version=_os_of(make, software))  # fmt: skip
    if software:
        return found("app_export", "likely", f"Saved by {software}, no camera data", app=software)
    return found("app_export", "likely", "No camera data inside: saved from an app or the web")


def _detect_movie(path, out, hint, found):
    facts = _movie_facts(path)
    keys = facts["keys"]
    make = keys.get("com.apple.quicktime.make", "")
    model = keys.get("com.apple.quicktime.model", "")
    software = keys.get("com.apple.quicktime.software", "")
    taken = _iso_date(keys.get("com.apple.quicktime.creationdate"))
    out["taken"] = taken or facts["created"]
    meta = facts["blob"] + facts["xmp"]
    if b"TikTok" in meta or b"tiktok.com" in meta:
        return found("tiktok", "marker", "TikTok left its name in the video")
    if b"Snapchat" in meta or hint == "snapchat":
        return found("snapchat", "marker" if hint != "snapchat" else "name", "Snapchat named in the video")
    if hint in ("whatsapp", "telegram", "screenshot"):
        return found(hint, "name", f"File name looks like {LABELS[hint]}")
    if make or model:
        device = model if make.lower() == "apple" else f"{make} {model}".strip()
        return found(CAMERA, "marker", f"Recorded with {device}", device=device, os_version=_os_of(make, software))
    if "com.android.version" in keys:
        return found(CAMERA, "likely", f"Recorded on an Android phone (Android {keys['com.android.version']})",
                     device="Android phone")  # fmt: skip
    if any(h == "Core Media Video" for h in facts["handlers"]):
        return found("app_export", "likely", "Exported by an iPhone app (no camera data)")
    if hint == CAMERA:
        return found(CAMERA, "name", "Camera-style file name")
    return found("app_export", "likely", "No camera data inside: saved from an app or the web")


# ---- placing Snapchat saves in time


def version_key(version):
    """(major, minor) of an app version such as 14.13.0.53."""
    parts = [int(p) for p in str(version).split(".")[:2] if p.isdigit()]
    return tuple(parts + [0] * (2 - len(parts)))


def _version_steps(keys):
    """Sequential index for each (major, minor): numbers inside a major count weeks; a new major
    follows straight after the last version seen of the one before (13.95 -> 14.10 is one step)."""
    index, offset = {}, 0
    by_major = {}
    for major, minor in sorted(keys):
        by_major.setdefault(major, []).append(minor)
    for major in sorted(by_major):
        minors = by_major[major]
        for minor in minors:
            index[(major, minor)] = offset + (minor - minors[0])
        offset += minors[-1] - minors[0] + 1
    return index


def os_windows(camera_items):
    """{(device name, OS version): (first, last)} and {OS version: (first, last)} from dated
    camera items given as (device name, OS version, unix time)."""
    by_device, by_os = {}, {}
    for device, os_ver, taken in camera_items:
        if not os_ver or not taken:
            continue
        for table, key in ((by_device, (device, os_ver)), (by_os, os_ver)):
            lo, hi = table.get(key, (taken, taken))
            table[key] = (min(lo, taken), max(hi, taken))
    return by_device, by_os


DAY = 86400


def estimate_snapchat_dates(snaps, camera_items):
    """Estimated save date of each Snapchat item.

    snaps: [(path, app version, device code, OS version, arrived unix time or None)]
    camera_items: [(device name, OS version, unix time)] from dated camera photos and videos.
    Returns {path: {"date", "lo", "hi", "reason"}} for items that could be placed.

    Each phone is placed on its own: a second phone may keep an old Snapchat for months."""
    by_device, by_os = os_windows(camera_items)
    out = {}
    for device in {s[2] for s in snaps}:
        out.update(_estimate_device([s for s in snaps if s[2] == device], by_device, by_os))
    return out


def _estimate_device(snaps, by_device, by_os):
    names = {s[1]: version_key(s[1]) for s in snaps}

    def window(device_code, os_ver):
        name = APPLE_MODELS.get(device_code, device_code)
        return by_device.get((name, os_ver)) or by_os.get(os_ver)

    bounds, seen_os = {}, {}
    for _path, ver, device, os_ver, _arrived in snaps:
        key = names[ver]
        seen_os.setdefault(key, set()).add(os_ver)
        w = window(device, os_ver)
        if not w:
            continue
        lo, hi = bounds.get(key, (w[0], w[1]))
        bounds[key] = (max(lo, w[0]), min(hi, w[1]))
    if not bounds:
        return {}
    keys = sorted(bounds)
    lows = {k: bounds[k][0] for k in keys}
    highs = {k: bounds[k][1] for k in keys}
    for a, b in itertools.pairwise(keys):  # a later version can't be older
        lows[b] = max(lows[b], lows[a])
    for later, earlier in itertools.pairwise(reversed(keys)):  # an earlier one can't be newer
        highs[earlier] = min(highs[earlier], highs[later])
    steps = _version_steps(keys)
    # Versions caught on both sides of an iOS update (or squeezed to one moment) are anchors.
    anchors = {}
    for k in keys:
        if lows[k] >= highs[k] or (len(seen_os[k]) > 1 and highs[k] - lows[k] <= 2 * DAY):
            anchors[k] = ((lows[k] + highs[k]) / 2, max(abs(lows[k] - highs[k]) / 2, DAY / 2))
    per_version = {}
    anchor_keys = sorted(anchors)
    for k in keys:
        if k in anchors:
            date, spread = anchors[k]
            per_version[k] = (date, date - spread, date + spread, "caught on both sides of an iOS update")
        else:
            before = [a for a in anchor_keys if a < k]
            after = [a for a in anchor_keys if a > k]
            lo, hi = lows[k], highs[k]
            if before and after:
                a, b = before[-1], after[0]
                (da, sa), (db, sb) = anchors[a], anchors[b]
                step = (db - da) / max(1, steps[b] - steps[a])
                date = da + step * (steps[k] - steps[a])
                spread = max(step / 2 + max(sa, sb), DAY)
                reason = f"between anchors {_v(a)} ({_day(da)}) and {_v(b)} ({_day(db)})"
            else:
                date, spread = (lo + hi) / 2, max((hi - lo) / 2, DAY)
                reason = "within the time its iOS version was in use"
            date = min(max(date, lo), hi)
            # The window never leaves the time this version's iOS was in use.
            per_version[k] = (date, max(lo, date - spread), min(hi, date + spread), reason)
    out = {}
    for path, ver, _device, os_ver, arrived in snaps:
        k = names[ver]
        if k not in per_version:
            continue
        date, lo, hi, reason = per_version[k]
        if arrived and hi > arrived:  # it was on the phone before it reached the server
            hi = arrived
            lo = min(lo, hi)
            date = min(date, hi)
        out[path] = {
            "date": date,
            "lo": lo,
            "hi": hi,
            "reason": f"Snapchat {_v(k)} on iOS {os_ver}: {reason}",
        }
    return out


def _v(key):
    return f"{key[0]}.{key[1]}"


def _day(t):
    import time

    return time.strftime("%-d %b %Y", time.gmtime(t))
