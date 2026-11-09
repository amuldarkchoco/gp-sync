"""Running anywhere, not only on Umbrel: host name, default folders, excluded folders,
an optional password and the upload folder found among the media folders."""

import base64
import json
import os
import urllib.error
import urllib.request

import sync


def get(server, path, auth=None):
    headers = {"Authorization": "Basic " + base64.b64encode(auth.encode()).decode()} if auth else {}
    try:
        with urllib.request.urlopen(urllib.request.Request(server + path, headers=headers)) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def test_status_says_what_the_machine_is_called(media):
    assert json.loads(sync.status_body())["host"] == sync.HOST_NAME == "this server"


def test_excluded_folders_are_not_backed_up(media, monkeypatch):
    for d in ("@eaDir", "encoded-video", "#recycle"):
        (media / "Photos" / d).mkdir(exist_ok=True)
        (media / "Photos" / d / "x.jpg").write_bytes(b"x" * 10)
    (media / "Photos" / "keep.jpg").write_bytes(b"k" * 10)
    names = {os.path.basename(p) for p, *_ in sync.scan()}
    assert "keep.jpg" in names and "x.jpg" not in names
    monkeypatch.setattr(sync, "EXCLUDE", ("keep.*",))
    names = {os.path.basename(p) for p, *_ in sync.scan()}
    assert "keep.jpg" not in names and "x.jpg" in names


def test_any_folder_names_are_backed_up(media, monkeypatch):
    """An Immich library or any other folder: with no Photos/Videos folder, everything counts."""
    tops = ["Immich", "Phone"]
    assert set(sync.folder_map(tops=tops).values()) == {"test@example.com"}
    monkeypatch.setattr(sync, "DEFAULT_FOLDERS", ("Phone",))
    m = sync.folder_map(tops=tops)
    assert m["Phone"] == "test@example.com" and m["Immich"] == ""


def test_password_protects_everything(server, media, monkeypatch):
    monkeypatch.setattr(sync, "PASSWORD", "s3cret")
    assert get(server, "/api/status")[0] == 401
    assert get(server, "/api/status", "any:wrong")[0] == 401
    code, body = get(server, "/api/status", "me:s3cret")  # scripts: curl -u any:PASSWORD
    assert code == 200 and json.loads(body)["auth"] is True


def test_sign_in_page_and_cookie(server, media, monkeypatch):
    import http.client
    import urllib.parse

    monkeypatch.setattr(sync, "PASSWORD", "s3cret")
    monkeypatch.setattr(sync, "WRONG_PASSWORD_DELAY", 0)
    host = urllib.parse.urlsplit(server).netloc

    def call(method, path, body=None, cookie=None):
        c = http.client.HTTPConnection(host)
        headers = {"Content-Type": "application/x-www-form-urlencoded"} if body else {}
        if cookie:
            headers["Cookie"] = cookie
        c.request(method, path, body, headers)
        r = c.getresponse()
        r.read()
        return r.status, r.getheader("Location"), r.getheader("Set-Cookie")

    assert call("GET", "/")[:2] == (303, "login")  # pages go to the sign-in page
    assert call("GET", "/login")[0] == 200
    assert call("POST", "/login", "password=nope")[1] == "login?e=1"
    code, where, cookie = call("POST", "/login", "password=s3cret")
    assert (code, where) == (303, "./") and "HttpOnly" in cookie
    jar = cookie.split(";")[0]
    assert call("GET", "/api/status", cookie=jar)[0] == 200
    assert call("GET", "/", cookie=jar)[0] == 200
    assert "Max-Age=0" in call("POST", "/logout", cookie=jar)[2]
    monkeypatch.setattr(sync, "PASSWORD", "changed")  # a new password ends old sign-ins
    assert call("GET", "/api/status", cookie=jar)[0] == 401


def test_no_password_by_default(server, media):
    assert get(server, "/api/status")[0] == 200


def test_upload_folder_is_found_among_media_folders(media, monkeypatch, tmp_path):
    inside = media / "Photos" / "Uploads"
    inside.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(sync, "UPLOAD_DIR", inside)
    assert sync.upload_folder_name() == "Photos/Uploads"
    elsewhere = tmp_path / "Uploads"
    elsewhere.mkdir()
    monkeypatch.setattr(sync, "UPLOAD_DIR", elsewhere)
    assert sync.upload_folder_name() == ""  # not inside a backed-up folder
    assert sync.upload_info()["synced"] is False
