# Changelog

## 1.5.0

- Fixed: the repeated "Could not update album … 404" error. One item missing from Google (deleted,
  or moved to the Trash or Locked folder) made Google refuse a whole batch, so albums like Snapchat
  were never made. Items are now checked against the library first (a replaced item is found under
  its new key), and a refused batch is split so everything else still goes in.
- Downloads: when freeing storage, choose "Delete the downloaded copy after the upload". Turned
  off, the copies are kept on the server, per account, to save or delete on the new Downloads page.
- Diagnostics: one JSON file with versions, checks, settings (no secrets), what each worker is
  doing and the recent log and activity. Health › Diagnostics (JSON), or `gpsync diagnostics`.
- `gpsync` command in the image: status, logs, activity, check-login, refresh, storage, free,
  downloads and diagnostics (`docker exec <container> gpsync …`).
- README: an Attention section (free storage depends on Google, what deleting in Google loses,
  Live Photos and more), AI assistant prompts for the login line and for installing on a laptop,
  server or Umbrel (docs/PROMPTS.md), and new screenshots.

## 1.4.2

- Settings, regrouped: Backup (Sync, Folders, Google accounts), Google Photos (Albums, Dates,
  Sources, Duplicates, Google tools) and App. Every option lives there, including the per-app
  album, caption and archive choices and pausing account copies.
- Dates explains why some photos have no date and what the "Date unknown" album is for.
- Google accounts: each account with its folders and state, buttons for its storage and dates,
  Manage to check logins, read libraries or check dates for several accounts at once, and a prompt
  to give Claude Code or Codex to fetch the login line from your phone.
- Fix dates and Free storage pick accounts from a menu; links open them on a given account.
- Free storage frees photos only, videos only, or both, including everything at once ("Free all").
  Items shared with you, in the Trash or the Locked folder are never touched.
- Activity names what happened: Date fixed, Re-uploaded free, Copied, Deleted in Google,
  Downloaded, with a "Google changes" filter. Copies between accounts are now logged too.
- The light/dark switch is a rounded rectangle that fits its square knob. Appearance is simpler.

## 1.4.1

- The light/dark switch changes the page at the knob's own speed: the new theme spreads from the
  knob as it slides, follows your finger when you drag, and shrinks back if you drag back.
- Dark mode is neutral graphite instead of violet, with a moon-blue accent that matches the switch.
- Your time zone is saved whenever the dashboard opens. It was only saved with the Schedule or
  Alerts settings, so dates from file names, schedule hours and daily stats could be off by hours.
- Free storage checks the downloaded copy again, byte for byte, right before deleting Google's copy,
  and downloads it again if it is gone or damaged. Broken downloads no longer leave files behind.
- Warnings from the Google Photos library are one line each in the log (and count as problems),
  instead of a dozen wrapped fragments.

## 1.4.0

- Fix dates is automatic: GP Sync checks the file is unchanged, deletes Google's copy (Trash, then
  permanently) and uploads it again with the right date. No albums or manual steps.
- Free storage is automatic: items that count against your storage are downloaded, deleted in Google
  and uploaded again free, keeping the date Google showed (Snapchat saves included).
- Accounts work at the same time: Free storage, Fix dates and copies run in parallel per account and
  per copy pair. Overview lists everything running under "Also running".
- Every re-upload sends its original date to Google, and each job keeps its own date when several
  run at once.
- Backups reuse each account's Google login instead of signing in every round; parallel downloads
  reserve disk space; library reads are one at a time per account.
- Faster tests (32 s to 3 s) and Docker builds; releases can update the Umbrel store right away.

## 1.3.0

- New look: warm paper and amber by day, ink-black and indigo by night, with clean solid cards in
  place of frosted glass. The accent follows the theme, like the light of the new switch.
- Light/dark switch in the header and in Settings: a glass knob lit along its edge, blue below at
  night and amber above by day, whose pixel moon rebuilds into a sun. Tap or drag it.
- The header shows only the page title; each page's one-line description sits above its content.
- Shorter, plainer text across Fix dates, Sources, Free storage, Copy, Settings, About and Upload.
- Phones: text that was cut off wraps to a second line, filters that didn't fit become a tidy grid
  instead of hiding choices, item buttons line up in one row, and dialog buttons stack.

## 1.2.3

- Sources: a new page shows where every photo and video came from (a camera, Snapchat, a screenshot,
  Instagram, TikTok, WhatsApp, Telegram, or "saved from an app"), with the evidence for each.
- Items saved from apps can go into an album per app, get a searchable caption, or be archived.
  Nothing changes in Google until you choose, and your own captions are never replaced.
- Snapchat saves get an estimated save date (shown with its margin), worked out from your own camera
  photos. New uploads use it; items already in Google change only when you accept it in Fix dates.
- Dates in file names (WhatsApp, Telegram, screenshots, Pixel) are used for files with no date inside.
- Fixes: the "Date unknown" album adds new files reliably; local hours start on the hour in zones such
  as India; searches treat % and _ literally; uploads deleted here are stored again; a reconnecting
  upload no longer races its retry; thumbnails are written safely in parallel; replacing a Google
  login removes the old saved copy; malformed requests get a clear error.

## 1.2.2

- Fix dates: recheck selected or all waiting items, with clearer status views and animated transitions.
- Show known before-fix dates and distinguish Google-verified dates from upload estimates; keep Google
  Photos links available when known. Older fixes may not have a recorded before-fix date.
- Overview: make device and folder switches responsive and preserve the selected view.
- Folders and devices: distinguish adding files from changing backup priority, and move priority
  controls below the folder statistics.

## 1.2.1

- Copy accounts: choose individual photos and videos or copy all items matching your filters.
  Duplicates are skipped; copying albums is not available with the connected Google login.
- Folders and devices: track daily photo and video arrivals and see which are waiting, backed up
  or failed. Arrival dates are estimates based on filesystem timestamps.
- Refreshed the dashboard with layered glass surfaces, dimensional details, updated navigation
  and clearer overview metrics in both light and dark themes.
- Made the weekly-summary scheduling test independent of the current date.

## 1.2.0

- Uploads per day and the streak refresh as soon as new files upload (they waited up to
  two minutes on Overview); the History page now refreshes too (it only loaded once)
- The streak counts the same uploads as the heat map, and says "1 active day" (not "days")
- Right dates for photos and videos with no date inside (Snapchat saves, screenshots, chat
  pictures): Google Photos dates those by the upload, which used to be the time the file was copied
  to the server. GP Sync now sends the best date it knows: one you pick, else the earliest identical
  copy on the server
- Fix dates page: lists uploaded files without a date, the date Google Photos shows and the date
  they should have (an earlier date already in Google is kept). Set date picks your own; Fix waits
  for you to delete the item in Google Photos (GP Sync never deletes there), then uploads it again
  with the right date and brings back favourite, archive, caption and GP Sync's albums
- Album for files without a date ("Date unknown" by default, on): asked once after connecting a
  Google account (and once after this update); change it in Settings › Albums & duplicates.
  Library has a "No date" filter and badge
- Date facts are kept in the Turso database

## 1.1.5

- Upload first: pick folders or devices whose photos go to Google before the rest (Upload first
  on a folder or device; reorder or remove them in the Upload order card on Folders). A change
  re-orders the files still waiting right away
- Overview: "Where your photos are" card with pie charts per device (or folder) and photos vs
  videos, by files or size, with each device's backed-up share
- Folders: the chart sits in the summary card at the top (it was below the endless photo grid);
  a phone's folder (Photos/iPhone) shows as a device everywhere and opens the device view
- Copy accounts: every connected account is a card under "Copy from" and "Copy to"; pick any
  two (picking one that's on the other side swaps them); shows how many accounts are connected.
  With one account the empty card above "Connect a second Google account" is gone
- After an update, open dashboards reload by themselves, so nobody keeps the old page

## 1.1.4

- Folders and Devices only list and count the folders you back up; others (like Downloads) are
  named in a short note with a link to choose folders
- Every Folders page shows a photos and videos grid, also the first one (newest first, from all
  backed-up folders)
- Library's folder menu only offers backed-up folders (others looked empty there)

## 1.1.3

- Folders redesigned: devices and folders come first, under one compact summary (the chart moved
  to the bottom, with its 7 d to 1 y switch). Each device shows thumbnails of its newest photos
- Opening a device or folder shows its photos and videos right there, backed up or not, with
  In Google / Waiting / Failed badges, photo/video filter, sorting and endless scrolling. Before,
  folders opened Library, which only lists uploaded files, so many looked empty
- Backup apps' 00..ff folders are no longer listed: the device's photos are shown instead
- A device keeps its name in the path (Devices › iPhone), and files named by a long code show
  their date as the title

## 1.1.2

- New Copy accounts page: copies everything one connected Google account owns to another,
  newest first, one file at a time. Items the other account already has are skipped. Each file
  is downloaded, checked to be Google's original, uploaded the free way, and its favourite,
  archive and caption come along; then the copy on the server is removed. Filter by photos,
  videos and years; pause, resume, stop and retry failed ones. Nothing is deleted in either
  account. Every 25 copies GP Sync checks with Google that they don't count against the other
  account's storage, and pauses if they do. Albums, people names and shared albums don't come over
- Duplicates are never copied: items the other account already has, files Google reports as
  already there while uploading, and the same file twice in the account copied from. A
  "Duplicates found" card shows how many (and how much space), with a list of them
- Free storage: an item is asked about at most every 2 minutes while it waits for you, a new
  upload is checked once a minute (it gave up after a few seconds before), and a download that
  hits an internet or Google outage waits instead of failing
- One Google login per account is reused, instead of a new one for every file

## 1.1.0

- New Folders page (Insights): photos, videos, size and how much is backed up for any folder,
  opened one level at a time, plus a Devices view with one row per phone (the folders phone
  backup apps make, such as Photos/iPhone; "Pixel" and "Pixel (2)" count as one device)
- Added per day: a chart of new photos and videos for the folder or device (7 days to a year),
  and a small trend line with the new count for each subfolder or device
- Files are dated by when they arrived on the server, not the photo's own date
- Overview folder names open the Folders page; Library can show any folder, however deep
- New Free storage page: lists the photos and videos that count against your Google storage,
  biggest first, and moves them to free uploads one at a time. GP Sync downloads each one and
  checks it is exactly Google's original; you delete it in Google Photos (GP Sync never deletes
  anything there); GP Sync notices, uploads it again the free way with its date, favourite,
  archive and caption, and checks with Google that it no longer counts. Albums and shared links
  don't come back. If Google counts a re-upload, everything stops
- The page also shows whether GP Sync's own uploads count against storage (they shouldn't)

## 1.0.3

- Health: the page no longer fails to load when a Google login file is named differently from
  the account inside it, and Remove now deletes such a login too
- Health: if the page can't reach the app it says so instead of staying empty
- Settings › App & appearance: the Install button appears as soon as the browser offers to install
- Settings: an old or mistyped settings link opens Sync with Sync marked in the menu
- App log download is named gp-sync-log-<date>.txt
- Code: Python moved to backend/, the dashboard stays in web/ (files moved with git, history kept)

## 1.0.2

- Settings menu: each section has a colored icon (like iOS Settings), the rows have a little
  space between them, and hovering lights up only the row under the pointer (the soft glow no
  longer spills over the rows next to it); the open section is marked with a blue edge
- App & appearance, redone: pick the theme from three small pictures of the dashboard
  (System, Dark, Light) at the top; the change fades in across the page, and System shows
  whether the device is in dark or light mode right now
- Install as an app: a clearer card with the steps for this device in one place
- What works on this device: a tidy two-column list with a count ("4 of 7")
- Every settings section starts with its title and a one-line explanation
- Save and other buttons sit in one bar at the end of each section, with a short note; on
  phones they fill the width so they are easy to tap
- Sync: the status card no longer repeats the "Sync" title, and the Pause, Scan now and Retry
  buttons line up on phones
- Phones: the section tabs show their icons, and the open one stays in view

## 1.0.1

- Overview: Customize is now a small "Edit" link (next to the page subtitle on wider screens,
  above the cards on phones) instead of a big button on top of the page
- Overview: the backup ring's glow no longer shows a cut-off square edge (light mode), and an
  empty ring no longer shows a dot
- Upload on Android: "Take photo" and "Record video" are separate buttons, so the camera opens
  (one button asking for both opened nothing on Android); iPhone keeps one button
- Upload: "Where files go" works smoothly on phones: choosing or adding a folder updates the card
  in place, the Add button no longer gets squeezed, Enter adds the folder
- Phones: new pull to refresh: a small chip with a drawing circle follows your finger; the
  header and page no longer get dragged down
- Phone tab bar: the Upload button is a clean circle with a soft shadow (no square halo)
- Light mode: softer glows on blue buttons and text boxes; no outline left on buttons after a
  tap (keyboard users still get a clear focus ring)
- History: the upload time card no longer mentions an old version number
- README: more screenshots (phone and desktop)

## 1.0.0

First release of GP Sync:

- Backs up the photos and videos in Umbrel's Photos and Videos folders to Google Photos in
  original quality, every 5 minutes; nothing on Umbrel is changed or deleted
- Up to 5 Google accounts: back each folder up to one or several of them at once (the first
  is the main backup, the others get copies, tracked and retried per account)
- Folder choice, albums, duplicate finder, alerts (ntfy, Telegram)
- Dashboard inspired by iOS and Material 3: frosted-glass cards, pill buttons, tonal badges, system
  fonts, tuned dark and light themes, and charts with gentle depth (color-blind-safe series)
- Live status, network and resource charts, history, insights, photo viewer
- Upload from your phone (resumable): choose files or use the camera, screen kept on while
  uploading; installable as a phone app (iPhone, Android, desktop), with a list of what works on each device;
  44px touch targets, no zoom on text fields, clear messages
- Runs anywhere Docker runs (Linux, Windows, macOS, NAS, Raspberry Pi, Umbrel) and backs up any
  mounted folder, including an Immich library; optional sign-in page (PASSWORD), folder exclusions
- Light when idle: cache in the app's memory, answers the browser keeps, versioned thumbnails
