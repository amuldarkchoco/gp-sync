# Changelog

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
