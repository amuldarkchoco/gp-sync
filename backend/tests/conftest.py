import os
import sys
import tempfile
from pathlib import Path

# sync.py opens its database at import time, so point it at temp folders first.
_tmp = Path(tempfile.mkdtemp(prefix="gphotos-sync-test-"))
(_tmp / "data").mkdir()
(_tmp / "media").mkdir()
os.environ["DATA_DIR"] = str(_tmp / "data")
os.environ["MEDIA_DIR"] = str(_tmp / "media")
os.environ["SETTLE_SECONDS"] = "0"
os.environ["UPLOAD_DIR"] = str(_tmp / "media" / "Photos" / "Uploads")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


import threading  # noqa: E402
from http.server import ThreadingHTTPServer  # noqa: E402

import pytest  # noqa: E402
from helpers import FAKE_AUTH  # noqa: E402

import sync  # noqa: E402


@pytest.fixture
def media():
    sync.q("DELETE FROM files")
    sync.q("DELETE FROM meta WHERE k='settings'")
    sync.PAUSE_FILE.unlink(missing_ok=True)
    for f in sync.ACCOUNTS_DIR.glob("*.auth"):
        f.unlink()
    sync.save_account(FAKE_AUTH)
    root = sync.MEDIA
    for p in root.rglob("*"):
        if p.is_file():
            p.unlink()
    (root / "Photos" / "trip").mkdir(parents=True, exist_ok=True)
    (root / "Videos").mkdir(exist_ok=True)
    (root / "Photos" / "trip" / "a.jpg").write_bytes(b"x" * 100)
    (root / "Photos" / "b.HEIC").write_bytes(b"y" * 200)
    (root / "Videos" / "c.mp4").write_bytes(b"z" * 300)
    (root / "Photos" / ".DS_Store").write_bytes(b"junk")
    (root / "Photos" / "notes.txt").write_bytes(b"text")
    (root / "Photos" / "empty.jpg").write_bytes(b"")
    return root


@pytest.fixture
def server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), sync.Handler)
    # A short poll interval: shutdown() otherwise waits up to 0.5 s after every test.
    threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()
    srv.server_close()


@pytest.fixture
def clean_stats():
    sync.sq("DELETE FROM hourly")
    sync.q("DELETE FROM meta WHERE k='stats_backfilled'")
