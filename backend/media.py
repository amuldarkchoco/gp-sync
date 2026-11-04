"""File hashing and thumbnails. No app state here, so it is easy to test."""

import hashlib
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
        tmp = target.with_suffix(".tmp")
        im.save(tmp, "WEBP", quality=quality, method=4)
        tmp.replace(target)
    return target


def save_bytes(data, target):
    """Store thumbnail bytes from Google (JPEG) as our cached WebP."""
    import io

    from PIL import Image

    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(io.BytesIO(data)) as im:
        im.thumbnail((THUMB_SIZE, THUMB_SIZE))
        tmp = target.with_suffix(".tmp")
        im.convert("RGB").save(tmp, "WEBP", quality=72, method=4)
        tmp.replace(target)
    return target
