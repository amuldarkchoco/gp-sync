# Prompts for AI assistants

Copy a prompt into Claude Code, Codex or a similar coding assistant that can run commands on
your computer. Each one says exactly what to do and what not to touch.

- [Get the Google login line from an Android phone](#get-the-google-login-line)
- [Run GP Sync on a laptop (Windows, macOS or Linux)](#run-gp-sync-on-a-laptop)
- [Run GP Sync on a server or NAS](#run-gp-sync-on-a-server-or-nas)
- [Install GP Sync on Umbrel](#install-gp-sync-on-umbrel)
- [Collect diagnostics for a problem](#collect-diagnostics-for-a-problem)

> [!CAUTION]
> The login line gives full access to that Google account's photos. Only paste it into GP Sync.
> The prompt below tells the assistant not to save it or send it anywhere else.

## Get the Google login line

Needs: an Android phone with **GmsCore** (microG) and **Google Photos ReVanced** installed, USB
debugging on (**Settings → About phone → tap Build number 7 times**, then **Developer options →
USB debugging**), and a USB cable.

```text
Help me get the Google Photos login text for GP Sync from my Android phone.

My phone is connected to this computer by USB, with USB debugging turned on (Settings > Developer
options). It has GmsCore (microG) and Google Photos ReVanced installed.

1. Make sure adb works (install Android platform-tools for this operating system if it is
   missing) and run "adb devices". If the phone shows as "unauthorized", tell me to accept the
   prompt on the phone, then check again.
2. Check both apps are installed: adb shell pm list packages | grep -i -E "revanced|microg|gms"
   (on Windows use findstr /i instead of grep). If one is missing, tell me which and stop.
3. Clear the log with "adb logcat -c", then watch it: adb logcat | grep "auth%2Fphotos.native"
4. Tell me to open Google Photos ReVanced and sign in with the Google account I want to add. If
   that account is already in GmsCore, tell me to remove it there first, then sign in again.
5. From the first matching line, take everything from "androidId=" to the end of the line,
   exactly as it is, and show it to me in one code block.

This text is a login to my Google account: don't save it to a file, don't put it in any command
history you control, and don't send it anywhere else.
```

Paste the line in GP Sync: **Settings → Google accounts → Add an account → Connect**. The same
prompt is in the app, with a **Copy prompt** button.

## Run GP Sync on a laptop

```text
Set up GP Sync (https://github.com/kshanxs/gp-sync) on this computer with Docker.

1. Check Docker is installed and running ("docker version"). If it isn't, tell me how to install
   Docker Desktop for this operating system and stop.
2. Ask me which folders hold my photos and videos. Don't guess, and never mount my home folder
   as a whole.
3. Make a folder for the app's data (for example ~/gp-sync-data or C:\gp-sync-data).
4. Write a docker-compose.yml in a new folder gp-sync with:
   - image kshanxs/gp-sync:latest, restart unless-stopped, port 8527:8527
   - environment: TZ set to this computer's time zone, HOST_NAME set to this computer's name,
     PASSWORD set to a random 20-character password (show it to me once)
   - volumes: the data folder at /data, and each photo folder read-only at /media/<short name>:ro
5. Run "docker compose up -d" and wait until http://localhost:8527 answers.
6. Tell me to open http://localhost:8527, sign in with the password, and connect a Google account
   in Settings > Google accounts.

Don't change anything inside my photo folders. They must be mounted read-only (:ro).
```

## Run GP Sync on a server or NAS

```text
Set up GP Sync (https://github.com/kshanxs/gp-sync) on this Linux server or NAS with Docker
Compose.

1. Check Docker and the compose plugin work ("docker compose version"). Install them with the
   distribution's packages if they are missing, and tell me what you installed.
2. Ask me for the photo and video folders to back up. Don't guess, and never mount / or a
   whole disk.
3. Create /opt/gp-sync with a data folder, and a docker-compose.yml:
   - image kshanxs/gp-sync:latest, restart unless-stopped, port 8527:8527
   - environment: TZ (this server's time zone), HOST_NAME (this server's name), PASSWORD (a
     random 20-character password; show it to me once)
   - volumes: ./data:/data, each photo folder read-only as /media/<short name>:ro, and if I want
     uploads from my phone, a writable folder inside one of those photo folders as /uploads
   - for an Immich library, mount ${UPLOAD_LOCATION}/library read-only, never its thumbs or
     encoded-video folders
4. Run "docker compose up -d", check "docker compose logs --tail 50" shows "watching /media", and
   tell me the address to open (http://<this server's IP>:8527).
5. If the server is reachable from the internet, tell me to keep it behind a VPN such as
   Tailscale instead of opening the port.

Don't change anything inside my photo folders. They must be mounted read-only (:ro).
```

## Install GP Sync on Umbrel

```text
Help me install GP Sync on my Umbrel.

1. Tell me to open the Umbrel App Store, then ⋯ > Community App Stores, add
   https://github.com/kshanxs/kshanxs-umbrel-store and open "kshanx's App".
2. Tell me to install GP Sync there and open it.
3. Then help me connect a Google account: use the "Get the Google login line" prompt from
   https://github.com/kshanxs/gp-sync/blob/main/docs/PROMPTS.md, and tell me to paste the line in
   GP Sync under Settings > Google accounts > Connect.
4. Tell me to pick which folders go to which account in Settings > Folders. On Umbrel, the
   photos the Umbrel phone apps save are under Photos.
```

## Collect diagnostics for a problem

The dashboard has a **Diagnostics (JSON)** button on the **Health** page. From a terminal on
the machine that runs GP Sync:

```text
GP Sync has a problem. Collect its diagnostics so I can share them.

1. Find the container: docker ps --format '{{.Names}} {{.Image}}' | grep gp-sync
   (on Umbrel it is called kshan-gphotos-sync_web_1; docker needs sudo there).
2. Run: docker exec <container> gpsync diagnostics --hours 48 > gp-sync-diagnostics.json
3. Also show me: docker exec <container> gpsync status
   and the last errors: docker exec <container> gpsync logs --level error --limit 50
4. Tell me where the JSON file is. It has no Google logins in it, but it does have file names
   and account email addresses, so I can decide who to share it with.
```
