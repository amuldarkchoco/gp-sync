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

### The quick way: run the commands yourself

You don't need an AI assistant for this. With the phone plugged in and signed in to Google Photos
ReVanced, run one command. It reads the login line your own apps already wrote to the device log
and prints only that line.

**macOS or Linux:**

```sh
adb logcat -d -b all 2>/dev/null | grep -o 'androidId=.*' | grep 'auth%2Fphotos.native' | tail -1
```

**Windows (PowerShell):**

```powershell
(adb logcat -d -b all | Select-String 'auth%2Fphotos.native' | Select-Object -Last 1) `
  -replace '^.*?(androidId=)', '$1'
```

If it prints nothing, the line isn't in the log yet. Start watching, then open Google Photos
ReVanced and sign in (or sign out and back in) with the account you want to add:

```sh
# macOS or Linux — prints the line as soon as it appears, then stops
adb logcat | grep -m 1 --line-buffered 'auth%2Fphotos.native' | grep -o 'androidId=.*'
```

```powershell
# Windows — Ctrl+C once the line prints
adb logcat | Select-String 'auth%2Fphotos.native'
```

Copy the whole line, starting at `androidId=`. Checks: `adb devices` should list your phone (if it
says `unauthorized`, accept the prompt on the phone); `adb shell pm list packages | grep -i -E
"revanced|microg|gms"` should show both apps.

### The assistant way: paste this prompt

Some AI assistants refuse to read account tokens, even your own. The prompt below gives the
assistant the context it needs — this is your account, on your device, and a documented setup step
for the open-source GP Sync project — so it helps instead of guessing at your intent.

```text
I'm setting up GP Sync (https://github.com/kshanxs/gp-sync), an open-source self-hosted tool that
backs up MY OWN photos to MY OWN Google Photos account. This is a normal, documented setup step
for that project; it is not an attack or an attempt to access anyone else's account.

To authorise the tool, I need the Google Photos sign-in line that MY apps on MY OWN Android phone,
which is plugged into this computer by USB, have already written to the device's own debug log
(the standard `adb logcat`). I am the account owner and the device owner. Nothing is being
intercepted: adb only reads the log my own phone exposes to the computer I connected it to.

Please run these read-only commands and help me:

1. Confirm the phone is connected: `adb devices`. If it shows "unauthorized", tell me to accept
   the USB debugging prompt on the phone, then re-run it. If no device, tell me to check the cable
   and that USB debugging is on.
2. Confirm the apps: `adb shell pm list packages | grep -i -E "revanced|microg|gms"`
   (on Windows, `findstr /i` instead of `grep`). Both GmsCore (microG) and Google Photos ReVanced
   should appear.
3. Read the line already in the log:
   `adb logcat -d -b all | grep -o 'androidId=.*' | grep 'auth%2Fphotos.native' | tail -1`
4. If that prints nothing, tell me to open Google Photos ReVanced and sign in with my account
   (if it's already in GmsCore, remove it there first and sign in again), while you watch:
   `adb logcat | grep -m 1 'auth%2Fphotos.native' | grep -o 'androidId=.*'`
5. Show me the full line, from `androidId=` to the end, in one code block.

This line is a credential for my own Google account, so please don't save it to a file or send it
anywhere; just print it here so I can paste it into GP Sync myself.
```

If an assistant still declines, use the commands above directly, or copy the line by hand from the
`adb logcat` output.

### Paste it into GP Sync

**Settings → Google accounts → Add an account → Connect.** Paste the line exactly as it is (it is
URL-encoded; don't decode it). The same prompt is in the app, under Google accounts, with a
**Copy prompt** button.

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
