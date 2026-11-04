# GP Sync

Back up the photos and videos on your server to Google Photos, in original quality: any folder on
Linux, Windows, macOS, a NAS, an [Immich](https://immich.app) library, or Umbrel. One Docker image
(amd64 and arm64); see [Run it anywhere](#run-it-anywhere). On Umbrel, install it from the
community app store [kshanxs/kshanxs-umbrel-store](https://github.com/kshanxs/kshanxs-umbrel-store).

Uploads use [gpmc](https://github.com/xob0t/google_photos_mobile_client), which talks to Google
Photos like the Android app.

- Checks for new files every 5 minutes (or click **Scan now**).
- Waits until a file has stopped changing for 2 minutes, so half-copied files are not sent.
- Skips files that are already in Google Photos.
- Folders are mounted read-only: nothing on your server is changed or deleted. Deleting a file there does not delete it from Google Photos.
  The one writable folder is the upload folder (**Photos/Uploads** on Umbrel), where photos sent from your phone through the dashboard are saved.
- A failed file is retried on later scans, up to 5 times. **Retry failed** resets the count.

## Features

- **Folders and accounts:** connect up to 5 Google accounts and choose, per folder, which of them it
  goes to: one account, or several at once (the first is the main backup, the others get copies).
  Photos and Videos go to the first account by default (or every folder, if those don't exist).
- **Upload hours and speed limit:** only upload between set hours, and cap the upload speed so the
  rest of your internet stays fast.
- **Albums:** put new uploads in Google Photos albums named after their folder.
- **Files:** search and filter everything that was backed up, with thumbnails (iPhone HEIC too) and
  a link to each item in Google Photos. A duplicates tab lists identical files.
- **History:** a contribution graph (like GitHub's) of photos, videos, data uploaded or network
  traffic per day, with day details, streaks and 30-day charts.
- **Alerts:** ntfy or Telegram messages when Google rejects a login, a file fails 5 times or a
  backup finishes, plus a weekly summary every Monday.
- **Overview at a glance:** progress ring, live upload/download, today, streak, CPU and memory, health badges and recent activity.
- **Network:** speed gauges, live traffic, Google response time, data used per day.
- **Activity:** saved for 90 days in Turso, grouped by day, with filters, search and thumbnails.
- **Health:** version, uptime, CPU, memory and disk use of the app, free space, database sizes and a one-click check of every login.
- **Upload from your phone:** pick, drag or take photos and videos in the dashboard (or share them
  from the Android gallery to the installed app). They're saved in the upload folder
  (`<year>/<month>/`), files already there are recognised, and everything is then
  backed up to Google Photos like the rest.
- **Insights:** total time spent uploading, average time per photo and per video, average photo and
  video size, uploads by hour and weekday, file types, largest and slowest uploads.
- **App log:** everything the app prints is kept for 30 days in Turso, searchable, errors only, or
  saved as a text file (Health page).
- **About:** app, build and package versions, and credits for the technology used.
- **Install as an app:** add the dashboard to a phone's home screen.
- Sidebar on desktop, bottom tabs and a "More" menu on phones; dark and light themes.

## Statistics and REST API

Uploads and network traffic are logged per hour in a [Turso](https://turso.tech) database
(`/data/stats.db`), using Turso's open-source engine (`pyturso`). Tables: `hourly` (per-hour totals),
`events` (activity, 90 days), `uploads` (one row per file with its upload time), `samples`
(per-minute speed, CPU, memory and Google response time, 14 days) and `logs` (app log, 30 days). The file is
SQLite-compatible. Days are built in the viewer's time zone. The upload state itself
(`/data/state.db`) stays in plain SQLite, because Turso is still beta and a statistics problem must
never stop backups; if Turso can't be used, statistics fall back to SQLite automatically.

| Endpoint | Returns |
|---|---|
| `GET /api/status` | Live status, library progress, current file, speeds, failures, activity |
| `GET /api/history?days=365&tz=330` | Per-day totals; `tz` is minutes east of UTC (India = 330) |
| `GET /api/totals` | All-time totals and fastest upload |
| `GET /api/files?q=&status=all&folder=&sort=new&limit=60&offset=0` | Search backed-up files |
| `GET /api/duplicates` | Groups of identical files |
| `GET /api/health` | Version, storage, logins |
| `GET /api/activity?kind=all&q=&before=&limit=100` | Saved activity (all, uploaded, exists, failed, system) |
| `GET /api/resources` | CPU, memory, disk I/O and Google response time |
| `GET /api/settings` | Settings (secrets are never returned) |
| `GET /api/thumb?path=Photos/x.jpg` | WebP thumbnail |
| `GET /api/insights?tz=330` | Upload times, average sizes, busiest hours and weekdays, file types |
| `GET /api/metrics?hours=24` | Per-minute speed, CPU, memory and Google response time (up to 14 days) |
| `GET /api/logs?level=all&q=&before=&limit=200` | App log (`level` = all or error) |
| `GET /api/about` | App, build and package versions |
| `GET /api/upload` | Whether phone uploads are possible, and free space |
| `POST /api/upload?name=IMG_1.jpg&mtime=<ms>` | Upload one photo or video (raw file as the body) |

Each day has `photos`, `videos`, `photo_bytes`, `video_bytes`, `existing`, `failed`,
`net_sent`, `net_received`, `photo_ms`, `video_ms` (time spent uploading), `peak_up`, `peak_down`
(bytes per second).

## Connect your Google account (once)

1. On an Android phone, install [GmsCore](https://github.com/ReVanced/GmsCore/releases) and [Google Photos ReVanced](https://github.com/j-hc/revanced-magisk-module/releases).
2. Turn on USB debugging and connect the phone to a computer with `adb`.
3. Run `adb logcat | grep "auth%2Fphotos.native"` (Windows: `adb logcat | FINDSTR "auth%2Fphotos.native"`).
4. Open Google Photos ReVanced and sign in. If the account is already in GmsCore, remove it there first.
5. Copy the text from `androidId=` to the end of the line, paste it into the app and click **Save account**.

Treat that line like a password: it gives full access to the Google Photos library.

## Notes

- gpmc uses an unofficial API that Google could change or block.
- Everything the app needs is inside its Docker image; nothing is downloaded at start.

## Run it anywhere

GP Sync is a Docker image for Intel/AMD (amd64) and ARM (arm64): [`kshanxs/gp-sync`](https://hub.docker.com/r/kshanxs/gp-sync)
on Docker Hub (also `ghcr.io/kshanxs/gp-sync`). It runs on Linux servers, NAS boxes, Raspberry Pi, Windows and macOS with Docker Desktop, or Umbrel.
It backs up **whatever folders you mount under `/media`**, read-only: a phone backup folder, an
Immich library, a NAS share, anything. Each folder you mount shows up in **Settings → Folders**,
where you choose which Google account backs it up.

### Docker Compose (recommended)

```yaml
services:
  gp-sync:
    image: kshanxs/gp-sync:latest
    restart: unless-stopped
    ports: ["8527:8527"]
    environment:
      TZ: Asia/Kolkata                  # your time zone
      HOST_NAME: My NAS                 # what the dashboard calls this machine
      PASSWORD: change-me               # dashboard login (any user name); leave out on a trusted network
    volumes:
      - ./gp-sync-data:/data            # app data: accounts, state, statistics
      - /path/to/photos:/media/Photos:ro
      - /path/to/videos:/media/Videos:ro
      - /path/to/photos/Uploads:/uploads   # optional: where phone uploads are saved
```

Run `docker compose up -d`, open `http://<server>:8527` and connect your Google account.
Use a version tag (for example `:1.0.0`) instead of `latest` to update only when you choose.

### Windows (Docker Desktop)

Use Windows paths on the left side; Docker Desktop shares the drive:

```yaml
    volumes:
      - C:\gp-sync-data:/data
      - D:\Pictures:/media/Pictures:ro
      - C:\Users\you\OneDrive\Camera Roll:/media/Camera Roll:ro
```

Or in one line (PowerShell):

```powershell
docker run -d --name gp-sync --restart unless-stopped -p 8527:8527 -v C:\gp-sync-data:/data -v "D:\Pictures:/media/Pictures:ro" kshanxs/gp-sync:latest
```

### Immich

Mount Immich's originals, not its whole upload location (that also holds thumbnails):

```yaml
    volumes:
      - ${UPLOAD_LOCATION}/library:/media/Immich:ro   # with the storage template on
      - ${UPLOAD_LOCATION}/upload:/media/Immich uploads:ro   # originals without the template
```

Immich's `encoded-video` folder is skipped by default. If you do mount the whole upload location,
also skip its other folders: `EXCLUDE: "@eaDir,#recycle,encoded-video,thumbs,profile,backups"`.

### Settings (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `TZ` | `UTC` | Time zone for upload hours, history and the weekly summary |
| `HOST_NAME` | `this server` | What the dashboard calls the machine ("Folders on My NAS") |
| `PASSWORD` | none | Shows a sign-in page before the dashboard (remembered for a year; works in the installed app). Scripts use `curl -u any:PASSWORD` |
| `FOLDERS` | `Photos,Videos` | Folders under `/media` backed up until you choose in Settings; if none exist, all are |
| `EXCLUDE` | `@eaDir,#recycle,#snapshot,$RECYCLE.BIN,System Volume Information,lost+found,encoded-video` | Folder and file names never backed up (`*` and `?` allowed). Hidden names are always skipped |
| `SCAN_INTERVAL_MINUTES` | `5` | How often folders are checked |
| `SETTLE_SECONDS` | `120` | A file must be unchanged this long before it's sent (skips half-copied files) |
| `PUID` / `PGID` | `1000` | Owner of files saved from phone uploads |
| `REDIS_URL` | none | Use a Redis or Valkey server as the cache (normally the app's own memory is used) |

Folders:

| Path in the container | What |
|---|---|
| `/data` | App data (writable): Google logins, upload state, statistics, thumbnails |
| `/media/<name>` | Each folder to back up, read-only. The name is what the dashboard shows |
| `/uploads` | Optional, writable: phone uploads. Mount a folder that is also inside a backed-up folder so they get backed up too |

Without `PASSWORD`, the dashboard has no login: keep it on your home network or behind a VPN
such as Tailscale. The network speed on the page is this container's own traffic.

## Development

The sync engine and REST API are Python (`sync.py`). The dashboard is TypeScript in `web/`,
styled with Tailwind CSS v4, with Lucide icons and hand-drawn SVG charts, and built with
[Vite+](https://viteplus.dev) (`vp`: Vite, Rolldown, Oxlint, Oxfmt and Vitest in one tool). In `web/`:

```sh
npm ci                     # exact versions from package-lock.json
npx vp dev                 # dev server; API calls go to the app on port 8527 (or API_URL)
npx vp check               # format, lint and type check
npx vp test                # tests
npx vp build               # build into web/dist, which sync.py serves
```

The Docker image builds the dashboard in a Node stage and copies only the result into the Python image.

The Python side uses [uv](https://docs.astral.sh/uv/) and [ruff](https://docs.astral.sh/ruff/). In the repo root:

```sh
uv sync                    # install exact versions from uv.lock, plus ruff and pytest
uv run ruff check .        # lint
uv run ruff format .       # format
uv run pytest              # tests (build the dashboard first), including checks that gpmc still has what sync.py uses
```

## Releases

- `VERSION` is the app version. Raise it (and add a section to `CHANGELOG.md`) to release.
- `.github/workflows/release.yml` lints and tests every push (`vp check`, `vp test`, `vp build`,
  ruff, pytest). When `VERSION` has no git tag yet, it builds the image
  `kshanxs/gp-sync:<version>` on Docker Hub and `ghcr.io/kshanxs/gp-sync:<version>` (amd64 and arm64), tags the commit `v<version>` and makes a
  GitHub release with that version's `CHANGELOG.md` notes. The Umbrel store
  [kshanxs/kshanxs-umbrel-store](https://github.com/kshanxs/kshanxs-umbrel-store) checks for new
  images every hour and updates itself; Umbrel then shows **Update**.
- Every Monday it tries the newest gpmc and packages (`scripts/update_deps.py`); if every test
  passes, it releases the next patch version on its own. If anything fails, nothing is released.
- All code and packages ship inside the image, pinned by digest in the store's
  `docker-compose.yml`, so a restart always runs the same tested build. Umbrel updates copy only
  `docker-compose.yml`, `umbrel-app.yml` and `hooks/`.
- The Umbrel app id stays `kshan-gphotos-sync`, so installed copies keep updating.

## License and credits

GP Sync is made by [kshanxs](https://github.com/kshanxs) and released under the
[MIT license](LICENSE). It builds on open-source work by others, credited on the app's About page:
[gpmc](https://github.com/xob0t/google_photos_mobile_client) by xob0t (the Google Photos client),
Turso, SQLite, Redis (optional), Pillow, pillow-heif, Python, uv, Ruff, Vite+, TypeScript, Tailwind CSS and
Lucide, plus ReVanced and GmsCore for getting the sign-in.
