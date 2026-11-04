# Changelog

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
