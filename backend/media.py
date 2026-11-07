"""File hashing and thumbnails. No app state here, so it is easy to test."""

import hashlib
import os
import threading
from pathlib import Path

THUMB_SIZE = 320
_thumb_slots = threading.BoundedSemaphore(2)  # thumbnails are CPU heavy; two at a time
_heif_ready = False


def sha1_file(path, on_progress=None, chunk=1024 * 1024):
    """SHA-1 of a file (what Google Photos uses to recognise duplicates), as bytes."""
    h = hashlib.sha1()
    done = 0
    with open(path, "rb") as f:
        while block := f.read(chunk):
            h.update(block)
            done += len(block)
            if on_progress:
                on_progress(done)
    return h.digest()


def release_memory():
    """Give memory freed by image decoding back to the system (glibc keeps it otherwise)."""
    global _libc
    if _libc is False:
        return
    try:
        if _libc is None:
            import ctypes

            _libc = ctypes.CDLL("libc.so.6")
        _libc.malloc_trim(0)
    except (OSError, AttributeError):
        _libc = False  # not glibc (e.g. musl or macOS): nothing to do


_libc = None


def _enable_heif():
    global _heif_ready
    if not _heif_ready:
        from pillow_heif import register_heif_opener

        register_heif_opener()
        _heif_ready = True


def _save_webp(im, target, quality):
    """Write atomically. Each writer has its own temp file: the background thumbnailer and a
    dashboard request can make the same picture at once without corrupting the cached one."""
    tmp = target.with_name(f".{target.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        im.save(tmp, "WEBP", quality=quality, method=4)
        tmp.replace(target)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def thumb_path(cache_dir, path, mtime):
    key = hashlib.sha1(f"{path}\0{mtime}".encode()).hexdigest()
    return Path(cache_dir) / key[:2] / f"{key}.webp"


def make_thumbnail(source, target, size=THUMB_SIZE, quality=72):
    """Write a WebP thumbnail (or, with a bigger size, a preview) of an image file. Returns the target path."""
    from PIL import Image, ImageOps

    _enable_heif()
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    with _thumb_slots, Image.open(source) as im:
        im.draft("RGB", (size * 2, size * 2))  # fast JPEG decode at reduced size
        im = ImageOps.exif_transpose(im)
        im.thumbnail((size, size))
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGB")
        _save_webp(im, target, quality)
    return target


def save_bytes(data, target):
    """Store thumbnail bytes from Google (JPEG) as our cached WebP."""
    import io

    from PIL import Image

    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(io.BytesIO(data)) as im:
        im.thumbnail((THUMB_SIZE, THUMB_SIZE))
        _save_webp(im.convert("RGB"), target, 72)
    return target


# ---- is a capture date stored inside the file?

PHOTO_DATE_TAGS = (0x9003, 0x9004)  # DateTimeOriginal, DateTimeDigitized (in the Exif block)
XMP_DATE_KEYS = (b"DateTimeOriginal", b"DateCreated", b"CreateDate")
MOVIE_EXTS = {"mp4", "mov", "m4v", "3gp", "3g2"}
_MAC_EPOCH = 2082844800  # seconds from 1904-01-01 (QuickTime) to 1970-01-01
_YEAR_1971 = 365 * 86400


def _real_date(value):
    text = str(value or "").strip().strip("\x00")
    return bool(text) and not text.startswith(("0000", "    "))


def _photo_has_date(path):
    from PIL import Image

    _enable_heif()
    with Image.open(path) as im:  # reads the header only
        exif = im.getexif()
        inner = exif.get_ifd(0x8769)
        if any(_real_date(inner.get(t)) for t in PHOTO_DATE_TAGS) or _real_date(exif.get(0x0132)):
            return True
        xmp = im.info.get("xmp") or im.info.get("XML:com.adobe.xmp") or b""
        if isinstance(xmp, str):
            xmp = xmp.encode()
        return any(k in xmp for k in XMP_DATE_KEYS)


def _atoms(f, start, end):
    """(type, body start, body end) of each atom between start and end of an MP4/QuickTime file."""
    pos = start
    while pos + 8 <= end:
        f.seek(pos)
        head = f.read(8)
        if len(head) < 8:
            return
        size, kind = int.from_bytes(head[:4], "big"), head[4:8]
        body = pos + 8
        if size == 1:  # 64-bit size follows
            size = int.from_bytes(f.read(8), "big")
            body += 8
        elif size == 0:  # runs to the end of the file
            size = end - pos
        if size < 8:
            return
        yield kind, body, min(pos + size, end)
        pos += size


def _movie_has_date(path):
    with open(path, "rb") as f:
        f.seek(0, 2)
        end = f.tell()
        for kind, body, stop in _atoms(f, 0, end):
            if kind != b"moov":
                continue
            for inner, ibody, _ in _atoms(f, body, stop):
                if inner == b"mvhd":
                    f.seek(ibody)
                    version = f.read(4)[0]
                    raw = f.read(8 if version == 1 else 4)
                    if int.from_bytes(raw, "big") - _MAC_EPOCH > _YEAR_1971:
                        return True
            # Apple keeps the camera's own date in metadata too, even when the header has none.
            f.seek(body)
            return b"com.apple.quicktime.creationdate" in f.read(min(stop - body, 16 * 1024 * 1024))
    return False


def has_date(path):
    """True if the file keeps its own capture date (Google Photos uses that), False if it has none
    (Google then uses the date sent with the upload), None if this file type can't be checked."""
    name = str(path).lower()
    kind = name.rsplit(".", 1)[-1] if "." in name else ""
    try:
        if kind in MOVIE_EXTS:
            return _movie_has_date(path)
        if kind in {"jpg", "jpeg", "png", "heic", "heif", "webp", "tif", "tiff", "avif", "gif", "bmp"}:
            return _photo_has_date(path)
    except Exception:
        return None  # damaged, or a format Pillow can't read
    return None
