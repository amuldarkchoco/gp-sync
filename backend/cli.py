"""gpsync: GP Sync from the command line.

Talks to the running app over its REST API (the same one the dashboard uses), so it is safe to run
while the app works. Inside the container it finds the app on its own:

    docker exec <container> gpsync status
    docker exec <container> gpsync diagnostics > gp-sync-diagnostics.json

Elsewhere, point it at the app with --url (and --password if the app has one).
"""

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


class Api:
    def __init__(self, url, password):
        self.url = url.rstrip("/")
        self.password = password

    def call(self, path, body=None):
        req = urllib.request.Request(
            self.url + path,
            json.dumps(body).encode() if body is not None else None,
            {"Content-Type": "application/json"} if body is not None else {},
        )
        if self.password:
            token = base64.b64encode(f"gpsync:{self.password}".encode()).decode()
            req.add_header("Authorization", "Basic " + token)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            sys.exit(f"gpsync: {path}: HTTP {e.code} {detail}")
        except urllib.error.URLError as e:
            sys.exit(f"gpsync: can't reach GP Sync at {self.url}: {e.reason}")


def when(t):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(t)) if t else "-"


def out(data, as_json):
    if as_json:
        print(json.dumps(data, indent=1))
        return True
    return False


def cmd_status(api, a):
    s = api.call("/api/status")
    if out(s, a.json):
        return
    c = s.get("counts", {})
    print(f"GP Sync {s.get('version', '?')}: {s.get('phase', '?')}{' (paused)' if s.get('paused') else ''}")
    print(f"Files: {c.get('uploaded', 0)} uploaded, {c.get('exists', 0)} already in Google, "
          f"{c.get('pending', 0)} waiting, {c.get('failed', 0)} failed")  # fmt: skip
    for acc in s.get("accounts", []):
        print(f"Account: {acc}{'  LOGIN REJECTED' if acc in s.get('login_failed', []) else ''}")
    for j in s.get("jobs", []):
        print(f"Running: {j['kind']} {j.get('account', '')} {j.get('step', '')} {j.get('name', '')}")
    if s.get("error"):
        print(f"Error: {s['error']}")


def cmd_diagnostics(api, a):
    data = api.call(f"/api/diagnostics?hours={a.hours}")
    text = json.dumps(data, indent=1)
    if a.output:
        with open(a.output, "w") as f:
            f.write(text)
        print(f"Saved {a.output} ({len(text) // 1024} KB, last {a.hours} h)", file=sys.stderr)
    else:
        print(text)


def cmd_logs(api, a):
    q = urllib.parse.urlencode({"level": a.level, "q": a.search, "limit": a.limit})
    items = api.call(f"/api/logs?{q}")["items"]
    if out(items, a.json):
        return
    for i in reversed(items):
        print(f"{when(i['time'])} {i['level'].upper():7} {i['text']}")


def cmd_activity(api, a):
    q = urllib.parse.urlencode({"kind": a.kind, "q": a.search, "limit": a.limit})
    items = api.call(f"/api/activity?{q}")["items"]
    if out(items, a.json):
        return
    for i in reversed(items):
        print(f"{when(i['time'])} {i['kind']:10} {i['text']}")


def cmd_check_login(api, a):
    r = api.call("/api/health/check-login", {})
    if out(r, a.json):
        return
    for acc, res in r.items():
        print(f"{acc}: {'ok' if res == 'ok' else res}")


def cmd_refresh(api, a):
    api.call("/api/storage/refresh", {"account": a.account})
    print(f"Reading the Google library of {a.account}…", file=sys.stderr)
    while True:
        time.sleep(3)
        r = api.call(f"/api/storage?account={urllib.parse.quote(a.account)}")
        if not r.get("refreshing"):
            break
    print(f"Done: {r.get('total')} items, {r.get('counted')} count against storage."
          + (f" Error: {r['error']}" if r.get("error") else ""))  # fmt: skip


def cmd_storage(api, a):
    r = api.call(f"/api/storage?account={urllib.parse.quote(a.account)}")
    if out(r, a.json):
        return
    k = r.get("kinds") or {}
    print(f"{a.account}: library read {when(r.get('refreshed'))}, {r.get('total')} items")
    print(f"Counting against storage: {r.get('counted')} items, {r.get('counted_bytes', 0) / 1e9:.2f} GB "
          f"({k.get('photo', {}).get('count', 0)} photos, {k.get('video', {}).get('count', 0)} videos)")  # fmt: skip
    print(f"Freed so far: {r['freed']['count']} items, {r['freed']['bytes'] / 1e9:.2f} GB")
    busy = [i for i in r.get("items", []) if i.get("state") not in ("", "done", None)]
    for i in busy[:50]:
        print(f"  {i['state']:10} {i['name']} {i.get('error', '')}")


def cmd_free(api, a):
    if not a.yes:
        sys.exit("gpsync: freeing deletes items in Google Photos before uploading them again. Add --yes to go ahead.")
    r = api.call("/api/storage/download", {"account": a.account, "kind": a.kind, "keep": a.keep})
    print(f"Queued {r.get('queued', 0)} item(s) in {a.account}. Follow with: gpsync storage {a.account}")


def cmd_downloads(api, a):
    r = api.call("/api/downloads")
    if out(r, a.json):
        return
    for acc, t in r.get("accounts", {}).items():
        print(f"{acc}: {t['photos']} photos, {t['videos']} videos, {t['bytes'] / 1e9:.2f} GB in {r.get('folder', '')}")


def main(argv=None):
    p = argparse.ArgumentParser(prog="gpsync", description="GP Sync from the command line.")
    p.add_argument("--url", default=os.environ.get("GPSYNC_URL", f"http://127.0.0.1:{os.environ.get('PORT', '8527')}"))
    p.add_argument("--password", default=os.environ.get("PASSWORD", ""), help="the app's password, if it has one")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add(name, fn, help_):
        s = sub.add_parser(name, help=help_)
        s.set_defaults(fn=fn)
        s.add_argument("--json", action="store_true", help="print JSON")
        return s

    add("status", cmd_status, "what the app is doing")
    s = add("diagnostics", cmd_diagnostics, "everything needed to look into a problem, as JSON")
    s.add_argument("--hours", type=int, default=24, help="how much log and activity (default 24)")
    s.add_argument("-o", "--output", help="save to this file instead of printing")
    s = add("logs", cmd_logs, "the app log")
    s.add_argument("--level", default="all", choices=["all", "error", "info"])
    s.add_argument("--search", default="")
    s.add_argument("--limit", type=int, default=200)
    s = add("activity", cmd_activity, "what was uploaded, fixed, freed or copied")
    s.add_argument("--kind", default="all", choices=["all", "uploaded", "google", "exists", "failed", "system"])
    s.add_argument("--search", default="")
    s.add_argument("--limit", type=int, default=100)
    add("check-login", cmd_check_login, "ask Google whether each saved login still works")
    s = add("refresh", cmd_refresh, "read an account's Google library again (changes nothing in Google)")
    s.add_argument("account")
    s = add("storage", cmd_storage, "what counts against an account's Google storage")
    s.add_argument("account")
    s = add("free", cmd_free, "free Google storage: download, delete in Google, upload again for free")
    s.add_argument("account")
    s.add_argument("--kind", default="all", choices=["all", "photo", "video"])
    s.add_argument("--keep", action="store_true", help="keep the downloaded copies (see Downloads)")
    s.add_argument("--yes", action="store_true", help="really do it")
    add("downloads", cmd_downloads, "copies kept on this server, per account")
    a = p.parse_args(argv)
    a.fn(Api(a.url, a.password), a)


if __name__ == "__main__":
    main()
