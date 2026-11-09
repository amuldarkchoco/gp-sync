import { get, post, type AppSourceId, type Settings, type Status } from "../lib/api";
import { $, $$, copyText, esc, html, toast } from "../lib/dom";
import { bytes, hour, num } from "../lib/format";
import { icon, type IconName } from "../lib/icons";
import { install, installHelp, installState, onInstallChange } from "../lib/install";
import { host, refresh, status } from "../lib/store";
import { setTheme, theme as currentTheme } from "../lib/theme";
import { avatar } from "../lib/account-menu";
import { badge, cardHead, syncChips } from "../lib/ui";
import type { View } from "./view";

// [key, title, icon, short line for the menu, icon tile color (iOS system colors), page intro, group]
const SECTIONS: [string, string, IconName, string, string, string, string][] = [
  [
    "sync",
    "Sync",
    "refresh",
    "Pause, hours and speed",
    "#0a84ff",
    "Pause backups, choose upload hours and limit the upload speed.",
    "Backup",
  ],
  [
    "folders",
    "Folders",
    "folder",
    "What is backed up where",
    "#ff9f0a",
    "Choose which folders are backed up, and to which accounts.",
    "Backup",
  ],
  [
    "accounts",
    "Google accounts",
    "users",
    "Connect and manage",
    "#5e5ce6",
    "Connect up to 5 Google accounts and run account work on several at once.",
    "Backup",
  ],
  [
    "albums",
    "Albums",
    "library",
    "Albums from folders",
    "#ff375f",
    "Put new uploads into Google Photos albums named after their folders.",
    "Google Photos",
  ],
  [
    "dates",
    "Dates",
    "calendar",
    "Photos without a date",
    "#ff9f0a",
    "Some photos and videos carry no date. Choose how GP Sync dates and groups them.",
    "Google Photos",
  ],
  [
    "sources",
    "Sources",
    "layers",
    "Saved from apps",
    "#30b0c7",
    "What GP Sync does in Google Photos with items saved from Snapchat, Instagram and other apps.",
    "Google Photos",
  ],
  [
    "duplicates",
    "Duplicates",
    "copy",
    "Files you have twice",
    "#34c759",
    "Find files you have more than once, here and in Google Photos.",
    "Google Photos",
  ],
  [
    "tools",
    "Google tools",
    "sparkles",
    "Storage, dates, copies",
    "#5e5ce6",
    "Work GP Sync does inside your Google accounts. Each account works on its own, side by side.",
    "Google Photos",
  ],
  [
    "alerts",
    "Phone alerts",
    "bell",
    "ntfy and Telegram",
    "#ff453a",
    "Get a message on your phone through ntfy or Telegram when something needs you.",
    "App",
  ],
  [
    "app",
    "Appearance",
    "palette",
    "Theme and install",
    "#bf5af2",
    "How GP Sync looks, and GP Sync as an app.",
    "App",
  ],
  [
    "api",
    "REST API",
    "code",
    "JSON endpoints",
    "#8e8e93",
    "Read status and statistics as JSON, with the same login as the dashboard.",
    "App",
  ],
];

/** Small colored icon tile, like the iOS Settings list. */
function tileIcon(ic: IconName, color: string, size = ""): string {
  return `<span class="set-ic ${size}" style="--c:${color}">${icon(ic)}</span>`;
}

/** Title block at the top of each section. */
function sectionHead(key: string): string {
  const sec = SECTIONS.find(([k]) => k === key) ?? SECTIONS[0]!;
  const [, title, ic, , color, intro] = sec;
  return `<header class="set-head">${tileIcon(ic, color, "lg")}<div class="min-w-0"><h2 class="text-lg font-semibold tracking-tight">${esc(title)}</h2><p class="text-sm text-ink-3">${esc(intro)}</p></div></header>`;
}

/** One bar for a section's buttons: a short note on the left, actions on the right. */
function actions(note: string, buttons: string): string {
  return `<div class="set-actions xl:col-span-2"><span class="min-w-0 flex-1 text-xs text-ink-3">${note}</span><div class="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:justify-end">${buttons}</div></div>`;
}

let cfg: Settings | null = null;
let section = "sync";
let draft = { start: 1, end: 7, enabled: false, speed: 0 };

async function save(changes: Partial<Settings> | Record<string, unknown>, message = "Saved"): Promise<void> {
  try {
    const r = await post<{ settings: Settings }>("settings", changes);
    cfg = r.settings;
    toast(message, "good");
    void refresh();
  } catch (e) {
    toast((e as Error).message, "bad");
  }
}

/** Sources settings have their own endpoint (it starts the work in Google Photos). */
async function saveSources(changes: Record<string, unknown>, message = "Saved"): Promise<void> {
  try {
    const r = await post<{ settings: Settings["sources"] }>("sources/settings", { settings: changes });
    if (cfg) cfg.sources = r.settings;
    if (message) toast(message, "good");
  } catch (e) {
    toast((e as Error).message, "bad");
  }
}

function sw(id: string, on: boolean): string {
  return `<button type="button" role="switch" class="switch" id="${id}" aria-checked="${on}"></button>`;
}

function field(label: string, control: string, hint = ""): string {
  return `<label class="block"><span class="mb-1.5 block text-sm font-medium">${label}</span>${control}${hint ? `<span class="mt-1 block text-xs text-ink-3">${hint}</span>` : ""}</label>`;
}

function toggleRow(id: string, label: string, sub: string, on: boolean): string {
  return `<div class="flex items-center gap-3 border-b border-line py-3 last:border-0"><div class="min-w-0 flex-1"><div class="text-sm font-medium">${label}</div>${sub ? `<div class="text-xs text-ink-3">${sub}</div>` : ""}</div>${sw(id, on)}</div>`;
}

function hoursBar(): string {
  const now = new Date().getHours();
  const allowed = (h: number) =>
    !draft.enabled || draft.start === draft.end
      ? true
      : draft.start < draft.end
        ? h >= draft.start && h < draft.end
        : h >= draft.start || h < draft.end;
  return `<div class="flex gap-[2px]">${Array.from(
    { length: 24 },
    (_, h) =>
      `<div class="relative h-9 flex-1 rounded-[4px] ${allowed(h) ? "bg-s1" : "bg-panel-2"}" data-tip="${hour(h)}–${hour(h + 1)}: ${allowed(h) ? "uploads run" : "no uploads"}${h === now ? " (now)" : ""}">${h === now ? '<i class="absolute -bottom-2 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-ink"></i>' : ""}</div>`,
  ).join("")}</div>
  <div class="mt-3 flex justify-between text-[10px] text-ink-3"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>`;
}

function sectionSync(s: Status | null): string {
  const presets = [0, 2, 5, 10, 20, 50];
  return `<div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
    <section class="card xl:col-span-2">${cardHead("Status", "activity")}
      <div class="card-b flex flex-col gap-4 md:flex-row md:items-center">
        <div class="min-w-0 flex-1"><div class="flex flex-wrap gap-1.5" id="set-chips">${s ? syncChips(s) : ""}</div></div>
        <div class="grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap">
          <span class="col-span-2 flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-1.5 text-sm">Paused ${sw("set-pause", !!s?.paused)}</span>
          <button class="btn" id="set-scan">${icon("refresh")}Scan now</button>
          <button class="btn" id="set-retry">${icon("retry")}Retry failed${s?.counts.failed ? ` <span class="count bad">${s.counts.failed}</span>` : ""}</button>
        </div>
      </div></section>
    <section class="card">${cardHead("Upload hours", "clock", sw("set-sch", draft.enabled))}
      <div class="card-b space-y-4">
        <div id="set-bar">${hoursBar()}</div>
        <div class="grid grid-cols-2 gap-3">
          ${field("From", `<select class="input" id="set-start">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === draft.start ? "selected" : ""}>${hour(h)}</option>`).join("")}</select>`)}
          ${field("Until", `<select class="input" id="set-end">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === draft.end ? "selected" : ""}>${hour(h)}</option>`).join("")}</select>`)}
        </div>
        <p class="text-xs text-ink-3">In this device's time zone. A file already uploading finishes first.</p>
      </div></section>
    <section class="card">${cardHead("Upload speed limit", "gauge")}
      <div class="card-b space-y-4">
        <div class="seg grid w-full grid-cols-3 sm:grid-cols-6" id="set-speed">${presets.map((p) => `<button data-mbps="${p}" aria-pressed="${p === draft.speed}">${p ? `${p} Mbps` : "No limit"}</button>`).join("")}</div>
        ${field("Custom (Mbps)", `<input class="input" id="set-mbps" type="number" min="0" step="0.5" value="${draft.speed || ""}" placeholder="No limit">`, "Leave room for video calls and streaming at home. Limits the upload to Google only.")}
        <div class="flex items-center gap-2 text-sm text-ink-2" id="set-speed-note"></div>
      </div></section>
    <section class="card xl:col-span-2">${cardHead("How syncing works", "info")}
      <div class="card-b grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
        ${(
          [
            [
              "search",
              "Scan",
              `Folders are checked every ${s?.interval ?? 5} minutes, or right away with Scan now.`,
            ],
            [
              "hourglass",
              "Settle",
              `New files wait ${Math.round((s?.settle_seconds ?? 120) / 60)} min so copies can finish first.`,
            ],
            [
              "cloudUp",
              "Upload",
              "Original quality. Files already in Google Photos are recognised and skipped.",
            ],
            ["retry", "Retry", "A failed file is tried 5 times. Network or Google outages don't count."],
          ] as [IconName, string, string][]
        )
          .map(
            ([ic, t, d]) =>
              `<div class="stat-tile"><div class="flex items-center gap-2 font-medium">${icon(ic, "size-4 text-accent")}${t}</div><div class="text-xs text-ink-3">${d}</div></div>`,
          )
          .join("")}
      </div></section>
    ${actions("Hours and speed apply from the next file.", `<button class="btn primary" id="set-save-sync">${icon("ok")}Save hours and speed</button>`)}
  </div>`;
}

/** What to give Claude Code, Codex or another coding assistant on the computer the phone is plugged into. */
const AUTH_PROMPT = `I'm setting up GP Sync (https://github.com/kshanxs/gp-sync), an open-source self-hosted tool that backs up MY OWN photos to MY OWN Google Photos account. This is a normal, documented setup step for that project; it is not an attack or an attempt to access anyone else's account.

To authorise the tool, I need the Google Photos sign-in line that MY apps on MY OWN Android phone, which is plugged into this computer by USB, have already written to the device's own debug log (the standard adb logcat). I am the account owner and the device owner. Nothing is being intercepted: adb only reads the log my own phone exposes to the computer I connected it to.

Please run these read-only commands and help me:

1. Confirm the phone is connected: "adb devices". If it shows "unauthorized", tell me to accept the USB debugging prompt on the phone, then re-run it. If no device, tell me to check the cable and that USB debugging is on.
2. Confirm the apps: adb shell pm list packages | grep -i -E "revanced|microg|gms" (on Windows, findstr /i instead of grep). Both GmsCore (microG) and Google Photos ReVanced should appear.
3. Read the line already in the log: adb logcat -d -b all | grep -o 'androidId=.*' | grep 'auth%2Fphotos.native' | tail -1
4. If that prints nothing, tell me to open Google Photos ReVanced and sign in with my account (if it's already in GmsCore, remove it there first and sign in again), while you watch: adb logcat | grep -m 1 'auth%2Fphotos.native' | grep -o 'androidId=.*'
5. Show me the full line, from "androidId=" to the end, in one code block.

This line is a credential for my own Google account, so please don't save it to a file or send it anywhere; just print it here so I can paste it into GP Sync myself.`;

function accountFolders(s: Status | null, a: string): string[] {
  return Object.entries(s?.folders ?? {})
    .filter(([, f]) => (f.accounts ?? (f.account ? [f.account] : [])).includes(a))
    .map(([name]) => name);
}

function sectionAccounts(s: Status | null): string {
  const accs = s?.accounts ?? [];
  const max = s?.max_accounts ?? 5;
  const full = accs.length >= max;
  const list = accs.length
    ? accs
        .map((a, i) => {
          const folders = accountFolders(s, a);
          const bad = s?.login_failed.includes(a);
          const sub = [
            i === 0 && accs.length > 1 ? "Main" : "",
            folders.length ? folders.join(", ") : "No folders yet",
          ].filter(Boolean);
          return `<div class="row flex-wrap py-3">${avatar(a, "size-9")}
            <div class="min-w-0 flex-1"><div class="truncate text-sm font-medium">${esc(a)}</div><div class="truncate text-xs text-ink-3">${esc(sub.join(" · "))}</div></div>
            ${bad ? badge("Login rejected", "bad", "warn") : badge("Working", "good", "ok")}
            <div class="row-actions flex w-full items-center justify-end gap-1.5 sm:w-auto">
              <a class="btn sm" href="#/storage/${encodeURIComponent(a)}">${icon("cloud")}Storage</a>
              <a class="btn sm" href="#/dates/${encodeURIComponent(a)}">${icon("calendar")}Dates</a>
              <button class="btn icon sm danger" data-remove="${esc(a)}" aria-label="Remove ${esc(a)}" title="Remove">${icon("trash")}</button>
            </div></div>`;
        })
        .join("")
    : `<div class="empty">${icon("key")}No account yet</div>`;
  const steps: [string, string][] = [
    ["1", "Install <b>GmsCore</b> and <b>Google Photos ReVanced</b> on an Android phone."],
    [
      "2",
      `Plug it into a computer and run <code class="rounded bg-panel-2 px-1">adb logcat | grep "auth%2Fphotos.native"</code>`,
    ],
    [
      "3",
      'Sign in to Google Photos ReVanced and copy from <code class="rounded bg-panel-2 px-1">androidId=</code> to the end of the line.',
    ],
  ];
  const actionsList: [string, IconName, string, string][] = [
    ["login", "key", "Check login", ""],
    ["library", "refresh", "Read library", ""],
    ["dates", "calendar", "Check dates", ""],
    ["retry", "retry", "Retry fixes", ""],
  ];
  return `<div class="flex flex-col gap-4">
    <section class="card">${cardHead("Connected", "users", badge(`${accs.length} of ${max}`, accs.length ? "good" : "warn"))}${list}</section>
    ${
      accs.length
        ? `<section class="card">${cardHead("Manage", "sliders", accs.length > 1 ? `<button type="button" class="link-btn" id="mg-all">Select all</button>` : "")}
      <div class="card-b space-y-4">
        <div class="flex flex-wrap gap-1.5" id="mg-accs">${accs.map((a) => `<button type="button" class="chip" data-acc="${esc(a)}" aria-pressed="${accs.length === 1}">${icon("ok", "size-3.5")}${esc(a)}</button>`).join("")}</div>
        <div class="grid grid-cols-2 gap-2 lg:grid-cols-4" id="mg-actions">${actionsList.map(([k, ic, l, cls]) => `<button type="button" class="btn justify-center whitespace-nowrap ${cls}" data-act="${k}">${icon(ic)}${l}</button>`).join("")}</div>
        <div class="space-y-1 empty:hidden" id="mg-out"></div>
      </div>
      <div class="flex items-center justify-between gap-3 border-t border-line px-4 py-3"><span class="text-xs text-ink-3">Removing keeps the photos in Google Photos.</span><button type="button" class="btn sm danger shrink-0" data-act="remove" id="mg-remove">${icon("trash")}Remove</button></div></section>`
        : ""
    }
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
      <section class="card flex flex-col">${cardHead(full ? "Replace a login" : "Add an account", "plus")}
        <div class="card-b flex flex-1 flex-col gap-3 text-sm">
          <ol class="space-y-2 text-ink-2">${steps.map(([n, t]) => `<li class="flex gap-2"><span class="badge info">${n}</span><span>${t}</span></li>`).join("")}</ol>
          <textarea class="input" id="set-auth" rows="3" placeholder="androidId=…"></textarea>
          <div class="mt-auto flex items-center justify-between gap-2"><span class="flex min-w-0 items-center gap-1.5 text-xs text-ink-3">${icon("lock", "size-3.5 shrink-0")}<span class="truncate">Stays on ${esc(host())}</span></span><button class="btn primary shrink-0" id="set-connect">${icon("key")}Connect</button></div>
        </div></section>
      <section class="card flex flex-col">${cardHead("Let an AI assistant do it", "sparkles")}
        <div class="card-b flex flex-1 flex-col gap-3 text-sm">
          <p class="text-ink-2">Paste this into Claude Code, Codex or a similar assistant on the computer your phone is plugged into. It runs the steps and hands you the <code class="rounded bg-panel-2 px-1">androidId=</code> line.</p>
          <pre class="prompt-box" id="set-prompt">${esc(AUTH_PROMPT)}</pre>
          <div class="mt-auto flex items-center justify-between gap-2"><span class="flex min-w-0 items-center gap-1.5 text-xs text-ink-3">${icon("warn", "size-3.5 shrink-0")}<span class="truncate">The line is a login</span></span><button class="btn shrink-0 whitespace-nowrap" id="set-copy-prompt">${icon("copy")}Copy prompt</button></div>
        </div></section>
    </div>
  </div>`;
}

function sectionFolders(s: Status | null): string {
  const accs = s?.accounts ?? [];
  const folders = Object.entries(s?.folders ?? {});
  const many = accs.length > 1;
  return `<section class="card">${cardHead(`Folders on ${host()}`, "folder", many ? "Tap accounts to back a folder up to each of them" : "Choose which folders to back up")}
    ${
      folders.length
        ? `<div>${folders
            .map(([name, f]) => {
              const on = f.accounts ?? (f.account ? [f.account] : []);
              const extra = on.slice(1);
              const copied = extra.length
                ? ` · copies ${extra.map((a) => `${num(f.copies?.[a] ?? 0)} in ${esc(a.split("@")[0])}`).join(", ")}`
                : "";
              return `<div class="border-b border-line px-4 py-3 last:border-b-0">
                <div class="flex items-center gap-3"><span class="grid size-9 shrink-0 place-items-center rounded-lg bg-panel-2 text-ink-2">${icon("folder")}</span>
                  <div class="min-w-0 flex-1"><div class="truncate text-sm font-medium">${esc(name)}</div><div class="truncate text-xs text-ink-3">${num(f.files)} files · ${bytes(f.bytes)}${on.length ? ` · ${num(f.synced_files)} backed up${copied}` : " · not backed up"}</div></div></div>
                <div class="mt-2.5 flex flex-wrap gap-1.5 pl-12" data-folder="${esc(name)}">${
                  accs.length
                    ? accs
                        .map(
                          (a) =>
                            `<button type="button" class="chip" data-acc="${esc(a)}" aria-pressed="${on.includes(a)}">${icon("ok", "size-3.5")}${esc(a)}${on[0] === a && on.length > 1 ? '<span class="opacity-70">· main</span>' : ""}</button>`,
                        )
                        .join("")
                    : '<span class="text-xs text-ink-3">Connect a Google account first</span>'
                }</div></div>`;
            })
            .join("")}</div>
          <div class="flex flex-wrap items-center justify-between gap-2 border-t border-line p-4"><span class="text-xs text-ink-3">${many ? "The first account turned on is the main one; the others get copies. " : ""}Files are only read, never changed or deleted.</span><button class="btn primary" id="set-save-folders">${icon("ok")}Save folders</button></div>`
        : `<div class="empty">${icon("folderOpen")}No folders found. Mount folders under /media.</div>`
    }</section>`;
}

function sectionAlbums(): string {
  const opts: [string, string, string][] = [
    ["off", "No albums", "Only added to the library."],
    ["top", "First folder", "Photos/Goa Trip/… → “Goa Trip”"],
    ["parent", "Each file's folder", "Photos/2024/Goa/… → “Goa”"],
  ];
  return `<div class="flex flex-col gap-4">
    <section class="card">${cardHead("Folder albums", "library")}
      <div class="card-b grid grid-cols-1 gap-2 sm:grid-cols-3" id="set-albums">${opts
        .map(
          ([
            k,
            l,
            d,
          ]) => `<label class="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 has-[:checked]:border-accent has-[:checked]:bg-accent/10">
          <input type="radio" name="albums" value="${k}" class="mt-1 accent-[var(--accent)]" ${cfg?.albums === k ? "checked" : ""}><span class="min-w-0"><span class="block text-sm font-medium">${l}</span><span class="block text-xs text-ink-3">${d}</span></span></label>`,
        )
        .join("")}
      </div></section>
    ${actions("Albums are made once and reused. Applies to new uploads.", `<button class="btn primary" id="set-save-albums">${icon("ok")}Save</button>`)}
  </div>`;
}

function sectionDates(): string {
  const steps: [IconName, string, string][] = [
    [
      "photo",
      "No date inside",
      "Snapchat saves, screenshots and chat pictures often carry no date of their own.",
    ],
    ["warn", "Google guesses", "Google Photos then dates them by the upload, so they land on the wrong day."],
    [
      "sparkles",
      "GP Sync helps",
      "It sends a better date when it can, keeps them in one album, and fixes ones already uploaded.",
    ],
  ];
  return `<div class="flex flex-col gap-4">
    <section class="card">${cardHead("Why some photos have no date", "info")}
      <div class="card-b grid grid-cols-1 gap-3 sm:grid-cols-3">${steps
        .map(
          ([ic, t, d]) =>
            `<div class="stat-tile"><div class="flex items-center gap-2 text-sm font-medium">${icon(ic, "size-4 text-accent")}${t}</div><div class="text-xs text-ink-3">${d}</div></div>`,
        )
        .join("")}</div></section>
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
      <section class="card flex flex-col">${cardHead("“Date unknown” album", "library", sw("set-undated", cfg?.undated?.album ?? true))}
        <div class="card-b flex flex-1 flex-col gap-3">
          <p class="text-sm text-ink-2">Every photo and video without a date goes into one album, so they are easy to find and check. Turned off, nothing new is added and the album stays as it is.</p>
          ${field("Album name", `<input class="input" id="set-undated-name" maxlength="80" value="${esc(cfg?.undated?.name ?? "Date unknown")}">`)}
        </div></section>
      <section class="card flex flex-col">${cardHead("Estimate Snapchat dates", "clock", sw("set-estimate", cfg?.sources?.estimate_dates ?? true))}
        <div class="card-b flex flex-1 flex-col gap-3">
          <p class="text-sm text-ink-2">Snapchat saves get an estimated date, worked out from your own camera photos. Dates in file names (WhatsApp, screenshots) are always used.</p>
          <p class="text-xs text-ink-3">For new uploads. Items already in Google change only in Fix dates.</p>
          <a href="#/dates" class="btn mt-auto self-start">${icon("calendar")}Open Fix dates</a>
        </div></section>
    </div>
    ${actions("A new album name starts a new album; the old one stays in Google Photos.", `<button class="btn primary" id="set-save-dates">${icon("ok")}Save</button>`)}
  </div>`;
}

const APP_SOURCES: [AppSourceId, string][] = [
  ["snapchat", "Snapchat"],
  ["instagram", "Instagram"],
  ["tiktok", "TikTok"],
  ["whatsapp", "WhatsApp"],
  ["telegram", "Telegram"],
  ["screenshot", "Screenshots"],
  ["app_export", "Saved from apps"],
];

function sectionSources(): string {
  const src = cfg?.sources;
  if (!src) return `<div class="card empty">${icon("layers")}Not available</div>`;
  const swc = (id: string, on: boolean, label: string) =>
    `<button type="button" role="switch" class="switch" id="${id}" aria-checked="${on}" aria-label="${label}"></button>`;
  const rows = APP_SOURCES.map(([id, label]) => {
    const a = src[id];
    return `<div class="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3 last:border-b-0 md:grid-cols-[9rem_minmax(0,1fr)_4.5rem_4.5rem_4.5rem]" data-src="${id}">
      <span class="col-span-4 text-sm font-medium md:col-span-1">${label}</span>
      <input class="input h-9 text-sm" data-set="album_name" maxlength="80" value="${esc(a.album_name)}" aria-label="${label} album name">
      <span class="grid justify-items-center">${swc(`src-${id}-album`, a.album, `${label}: album`)}</span>
      <span class="grid justify-items-center">${swc(`src-${id}-caption`, a.caption, `${label}: caption`)}</span>
      <span class="grid justify-items-center">${swc(`src-${id}-archive`, a.archive, `${label}: archive`)}</span>
    </div>`;
  }).join("");
  return `<div class="flex flex-col gap-4">
    <section class="card">${cardHead("Items saved from apps", "layers", `<a class="link-btn" href="#/sources">Open Sources</a>`)}
      <div class="hidden grid-cols-[9rem_minmax(0,1fr)_4.5rem_4.5rem_4.5rem] gap-x-4 border-b border-line px-4 py-2 text-xs font-medium text-ink-3 md:grid">
        <span>App</span><span>Album name</span><span class="text-center">Album</span><span class="text-center">Caption</span><span class="text-center">Archive</span></div>
      <div class="flex justify-end gap-x-4 border-b border-line px-4 py-2 text-xs font-medium text-ink-3 md:hidden"><span class="w-11 text-center">Album</span><span class="w-11 text-center">Caption</span><span class="w-11 text-center">Archive</span></div>
      ${rows}
      <div class="grid grid-cols-1 gap-2 border-t border-line p-4 text-xs text-ink-3 sm:grid-cols-3">
        <span><b class="text-ink-2">Album</b> groups them in Google Photos.</span>
        <span><b class="text-ink-2">Caption</b> makes them searchable. Yours are never replaced.</span>
        <span><b class="text-ink-2">Archive</b> hides them from the timeline. Off undoes it.</span>
      </div></section>
    ${actions("Nothing changes in Google until you save.", `<button class="btn primary" id="set-save-sources">${icon("ok")}Save</button>`)}
  </div>`;
}

function sectionDuplicates(): string {
  return `<div class="flex flex-col gap-4">
    <section class="card">${cardHead("Check older uploads", "copy", sw("set-hash", !!cfg?.hash_existing))}
      <div class="card-b flex flex-col gap-3 sm:flex-row sm:items-center">
        <p class="flex-1 text-sm text-ink-2">New files are always checked. With this on, files uploaded before are fingerprinted too, while the app is idle, so every copy you have twice shows up.</p>
        <a href="#/library/duplicates" class="btn shrink-0 self-start sm:self-center">${icon("copy")}Open duplicates</a>
      </div></section>
    ${actions("Fingerprinting reads files only; nothing is deleted.", `<button class="btn primary" id="set-save-dups">${icon("ok")}Save</button>`)}
  </div>`;
}

function sectionTools(): string {
  const tools: [IconName, string, string, string, string][] = [
    [
      "cloud",
      "Free storage",
      "Items that count against your Google storage are downloaded, checked, deleted in Google and uploaded again for free. Photos, videos or both.",
      "#/storage",
      "",
    ],
    [
      "calendar",
      "Fix dates",
      "Items Google dated by their upload are replaced with ones carrying the right date. Only when the file here is unchanged.",
      "#/dates",
      "",
    ],
    [
      "users",
      "Copy accounts",
      "Copy photos and videos from one Google account to another, in original quality, with dates.",
      "#/copy",
      sw("set-copy-run", !cfg?.copy_paused),
    ],
  ];
  return `<div class="flex flex-col gap-4">
    <section class="card">${cardHead("Tools", "sparkles")}${tools
      .map(
        ([
          ic,
          t,
          d,
          href,
          extra,
        ]) => `<div class="flex flex-col gap-3 border-b border-line px-4 py-4 last:border-b-0 sm:flex-row sm:items-center">
          <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-panel-2 text-accent">${icon(ic)}</span>
          <div class="min-w-0 flex-1"><div class="text-sm font-medium">${t}</div><div class="text-xs text-ink-3">${d}</div>${extra ? `<div class="mt-1 text-xs text-ink-2" id="set-copy-note">${cfg?.copy_paused ? "Paused: nothing is copied." : "Running."}</div>` : ""}</div>
          <div class="flex shrink-0 items-center gap-3">${extra}<a href="${href}" class="btn sm whitespace-nowrap">Open${icon("chevron")}</a></div>
        </div>`,
      )
      .join("")}</section>
    <section class="card flex items-start gap-3 p-4 text-sm text-ink-2">${icon("info", "size-5 shrink-0 text-ink-3")}<div>Kept: quality, date, favourite, archive and caption. Lost: albums made by hand, shared links and comments. Run work for several accounts at once from <a class="underline" href="#/settings/accounts">Google accounts › Manage</a>.</div></section>
  </div>`;
}

function sectionAlerts(): string {
  const n = cfg?.notify;
  return `<div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
    <section class="card">${cardHead("Channels", "bell")}
      <div class="card-b space-y-3">
        ${field("ntfy topic address", `<input class="input" id="n-url" value="${esc(n?.ntfy_url)}" placeholder="https://ntfy.sh/my-photos-123">`)}
        ${field("ntfy access token (optional)", `<input class="input" id="n-token" type="password" placeholder="${n?.ntfy_token_set ? "Saved · type to replace" : ""}">`)}
        ${field("Telegram bot token", `<input class="input" id="t-token" type="password" placeholder="${n?.telegram_token_set ? "Saved · type to replace" : "123456:ABC…"}">`)}
        ${field("Telegram chat ID", `<input class="input" id="t-chat" value="${esc(n?.telegram_chat)}">`, "With ntfy, subscribe to the same topic in the ntfy app. For Telegram, create a bot with @BotFather and send it a message first.")}
      </div></section>
    <section class="card">${cardHead("Send an alert when", "zap")}
      <div class="card-b">
        ${toggleRow("a-login", "Google rejects a login", "Once per problem", !!n?.on_login)}
        ${toggleRow("a-gave", "A file fails 5 times", "The app stops trying that file", !!n?.on_gave_up)}
        ${toggleRow("a-round", "A backup round finishes", "", !!n?.on_round)}
        <div class="flex items-center gap-3 py-3"><span class="flex-1 text-sm text-ink-2">…only rounds with at least</span><input class="input w-24" id="a-min" type="number" min="1" value="${n?.round_min ?? 20}"><span class="text-sm text-ink-3">files</span></div>
        ${toggleRow("a-week", "Weekly summary", "Mondays at 9:00", !!n?.weekly)}
      </div></section>
    ${actions(
      "Save first, then send a test to check it arrives.",
      `<button class="btn" id="n-week">${icon("chart")}Weekly summary</button>
      <button class="btn" id="n-test">${icon("bell")}Send test</button>
      <button class="btn primary" id="n-save">${icon("ok")}Save alerts</button>`,
    )}
  </div>`;
}

function installBadge(): string {
  switch (installState()) {
    case "installed":
      return badge("Installed", "good", "ok");
    case "ready":
      return badge("Ready to install", "info", "download");
    case "insecure":
      return badge("Needs HTTPS to install", "warn", "lock", "Browsers install apps only from secure pages");
    case "ios":
      return badge("Add from Safari", "info", "phone");
    default:
      return isSecureContext ? badge("Secure page", "good", "lock") : "";
  }
}

/** A small picture of the dashboard in one theme (fixed colors, so it looks the same in either theme). */
function themeMock(kind: "dark" | "light"): string {
  const lines = (n: number) =>
    Array.from({ length: n }, (_, i) => `<i${i === 0 ? ' class="on"' : ""}></i>`).join("");
  return `<span class="pv pv-${kind}" aria-hidden="true">
    <span class="pv-side">${lines(5)}</span>
    <span class="pv-main"><span class="pv-top"><i></i><b></b></span>
      <span class="pv-row"><span class="pv-card"><em></em><i></i></span><span class="pv-card"><em class="g"></em><i></i></span></span>
      <span class="pv-card wide"><i></i><i class="short"></i><span class="pv-bar"><b></b></span></span></span>
  </span>`;
}

function themeNote(t: string): string {
  if (t !== "system") return "This browser";
  const dark = !matchMedia("(prefers-color-scheme: light)").matches;
  return `Following this device: ${dark ? "dark" : "light"}`;
}

// The header switch also picks light or dark: show that choice here when the page is open.
window.addEventListener("themechange", () => {
  const box = document.getElementById("set-theme");
  if (!box) return;
  $$("button", box).forEach((x) => x.setAttribute("aria-checked", String(x.dataset.t === currentTheme())));
  const note = document.getElementById("set-theme-note");
  if (note) note.innerHTML = themeNote(currentTheme());
});

function sectionApp(): string {
  const theme = currentTheme();
  const opts: [string, string, IconName, string][] = [
    [
      "system",
      "System",
      "devices",
      `${themeMock("dark")}${themeMock("light").replace("pv pv-light", "pv pv-light pv-half")}`,
    ],
    ["dark", "Dark", "moon", themeMock("dark")],
    ["light", "Light", "sun", themeMock("light")],
  ];
  const state = installState();
  const signIn = !!status()?.auth;
  return `<div class="flex flex-col gap-4">
    <section class="card">${cardHead("Theme", "palette", `<span id="set-theme-note">${themeNote(theme)}</span>`)}
      <div class="card-b">
        <div class="grid grid-cols-3 gap-3 sm:gap-4" id="set-theme" role="radiogroup" aria-label="Theme">${opts
          .map(
            ([k, l, ic, mock]) =>
              `<button type="button" class="theme-opt" role="radio" data-t="${k}" aria-checked="${k === theme}"><span class="theme-prev">${mock}<span class="theme-check">${icon("check")}</span></span><span class="theme-label">${icon(ic)}${l}</span></button>`,
          )
          .join("")}</div>
      </div></section>
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
      <section class="card flex flex-col ${signIn ? "" : "md:col-span-2"}">${cardHead("Install as an app", "download", installBadge())}
        <div class="card-b flex flex-1 flex-col gap-3 text-sm text-ink-2">
          <div class="install-help" id="set-install-help">${installHelp()}</div>
          ${state === "ready" ? `<button class="btn primary mt-auto self-start" id="set-install">${icon("download")}Install</button>` : ""}
        </div></section>
      ${
        signIn
          ? `<section class="card flex flex-col">${cardHead("Sign-in", "lock")}
        <form class="card-b flex flex-1 flex-col gap-3 text-sm text-ink-2" method="post" action="logout">
          <p>Signing out here doesn't sign out other devices.</p>
          <button class="btn danger mt-auto self-start" type="submit">${icon("logout")}Sign out</button>
        </form></section>`
          : ""
      }
    </div>
  </div>`;
}

function sectionApi(): string {
  const base = location.href.split("#")[0]!.replace(/\/?$/, "/");
  const eps: [string, string][] = [
    ["GET", "api/status"],
    ["GET", "api/history?days=365&tz=0"],
    ["GET", "api/totals"],
    ["GET", "api/insights"],
    ["GET", "api/metrics?hours=24"],
    ["GET", "api/activity?kind=all&limit=100"],
    ["GET", "api/logs?level=error"],
    ["GET", "api/files?status=failed"],
    ["GET", "api/duplicates"],
    ["GET", "api/resources"],
    ["GET", "api/health"],
    ["GET", "api/about"],
    ["POST", "api/upload?name=IMG_1.jpg (raw body)"],
    ["POST", "api/sync"],
    ["POST", "api/pause"],
    ["POST", "api/retry"],
  ];
  return `<section class="card">${cardHead("REST API", "code", "JSON · same login as the dashboard")}
    <div>${eps
      .map(
        ([m, p]) =>
          `<div class="row font-mono text-xs">${badge(m, m === "GET" ? "info" : "warn")}<span class="min-w-0 flex-1 truncate">${esc(p)}</span><button class="btn icon sm" data-copy="${esc(base + p.split(" ")[0])}" aria-label="Copy">${icon("copy")}</button></div>`,
      )
      .join("")}</div>
    <div class="border-t border-line p-4 text-xs text-ink-3">Statistics, activity, upload times, metrics and the app log live in a Turso database at <code>/data/stats.db</code> (SQLite-compatible: tables <code>hourly</code>, <code>events</code>, <code>uploads</code>, <code>samples</code>, <code>logs</code>).</div>
  </section>`;
}

let drawnWithStatus = false;
let offInstall: (() => void) | null = null;

/** A known section key; anything else (an old or mistyped link) opens Sync. */
function sectionKey(key: string | undefined): string {
  return SECTIONS.some(([k]) => k === key) ? (key as string) : "sync";
}

function renderSection(): void {
  drawnWithStatus = status() !== null;
  const body = document.getElementById("set-body");
  if (!body) return;
  const s = status();
  $$("[data-sec]").forEach((a) =>
    a.setAttribute("aria-current", a.dataset.sec === section ? "page" : "false"),
  );
  const map: Record<string, () => string> = {
    sync: () => sectionSync(s),
    accounts: () => sectionAccounts(s),
    folders: () => sectionFolders(s),
    albums: sectionAlbums,
    dates: sectionDates,
    sources: sectionSources,
    duplicates: sectionDuplicates,
    tools: sectionTools,
    alerts: sectionAlerts,
    app: sectionApp,
    api: sectionApi,
  };
  const key = sectionKey(section);
  body.innerHTML = `${sectionHead(key)}${map[key]!()}`;
  // Phones: keep the chosen tab in view in the scrolling row.
  document
    .querySelector<HTMLElement>(`.set-tabs [data-sec="${key}"]`)
    ?.scrollIntoView({ block: "nearest", inline: "center" });
  wire();
}

/** Manage: run one action on each chosen account, and list how it went. */
function wireManage(): void {
  const box = document.getElementById("mg-accs");
  if (!box) return;
  const chips = () => $$<HTMLButtonElement>(".chip", box);
  chips().forEach((c) =>
    c.addEventListener("click", () =>
      c.setAttribute("aria-pressed", String(c.getAttribute("aria-pressed") !== "true")),
    ),
  );
  document.getElementById("mg-all")?.addEventListener("click", () => {
    const all = chips().every((c) => c.getAttribute("aria-pressed") === "true");
    chips().forEach((c) => c.setAttribute("aria-pressed", String(!all)));
  });
  const out = $("#mg-out");
  const line = (a: string, ok: boolean, text: string) =>
    `<div class="flex items-center gap-2 text-sm">${icon(ok ? "ok" : "error", `size-4 shrink-0 ${ok ? "text-good" : "text-bad"}`)}<span class="min-w-0 truncate"><b class="font-medium">${esc(a)}</b> · ${esc(text)}</span></div>`;
  box.closest("section")!.addEventListener("click", async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-act]");
    if (!b) return;
    const picked = chips()
      .filter((c) => c.getAttribute("aria-pressed") === "true")
      .map((c) => c.dataset.acc ?? "");
    if (!picked.length) return toast("Choose one or more accounts first", "bad");
    const act = b.dataset.act;
    if (act === "remove" && !confirm(`Remove ${picked.join(", ")}?\n\nTheir photos stay in Google Photos.`))
      return;
    b.disabled = true;
    const lines: string[] = [];
    try {
      if (act === "login") {
        const r = await post<Record<string, string>>("health/check-login");
        for (const a of picked)
          lines.push(line(a, r[a] === "ok", r[a] === "ok" ? "Login works" : (r[a] ?? "Not checked")));
      } else {
        for (const a of picked) {
          try {
            if (act === "library") await post("storage/refresh", { account: a });
            else if (act === "dates") await post("dates/refresh", { account: a });
            else if (act === "retry") await post("dates/recheck", { account: a });
            else if (act === "remove") await post("accounts/remove", { email: a });
            const done: Record<string, string> = {
              library: "Reading its Google library",
              dates: "Checking dates with Google",
              retry: "Waiting date fixes tried now",
              remove: "Removed",
            };
            lines.push(line(a, true, done[act ?? ""] ?? "Done"));
          } catch (err) {
            lines.push(line(a, false, (err as Error).message));
          }
        }
      }
    } catch (err) {
      lines.push(line(picked.join(", "), false, (err as Error).message));
    } finally {
      b.disabled = false;
    }
    if (act === "remove") {
      await refresh();
      renderSection();
      toast(`Removed ${picked.length} account${picked.length > 1 ? "s" : ""}`, "good");
      return;
    }
    out.innerHTML = lines.join("");
  });
}

function wire(): void {
  const on = (id: string, ev: string, fn: (e: Event) => void) =>
    document.getElementById(id)?.addEventListener(ev, fn);
  $$<HTMLButtonElement>(".switch").forEach((b) =>
    b.addEventListener("click", () =>
      b.setAttribute("aria-checked", String(b.getAttribute("aria-checked") !== "true")),
    ),
  );
  const checked = (id: string) => document.getElementById(id)?.getAttribute("aria-checked") === "true";
  const val = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? "";

  // sync
  on("set-pause", "click", async () => {
    await post("pause");
    void refresh();
  });
  on("set-scan", "click", async () => {
    await post("sync");
    toast("Scanning now");
  });
  on("set-retry", "click", async () => {
    await post("retry");
    toast("Failed files will be tried again", "good");
  });
  const redrawBar = () => {
    const bar = document.getElementById("set-bar");
    if (bar) bar.innerHTML = hoursBar();
  };
  on("set-sch", "click", () => {
    draft.enabled = checked("set-sch");
    redrawBar();
  });
  on("set-start", "change", () => {
    draft.start = Number(val("set-start"));
    redrawBar();
  });
  on("set-end", "change", () => {
    draft.end = Number(val("set-end"));
    redrawBar();
  });
  const speedNote = () => {
    const n = document.getElementById("set-speed-note");
    if (n)
      n.innerHTML = draft.speed
        ? `${icon("info", "size-4 text-ink-3")}About ${bytes((draft.speed * 1e6) / 8)}/s, ${bytes(((draft.speed * 1e6) / 8) * 3600)} per hour`
        : `${icon("zap", "size-4 text-ink-3")}Uploads use all available bandwidth`;
  };
  speedNote();
  on("set-speed", "click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!b) return;
    draft.speed = Number(b.dataset.mbps);
    $$("button", $("#set-speed")).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    ($("#set-mbps") as HTMLInputElement).value = draft.speed ? String(draft.speed) : "";
    speedNote();
  });
  on("set-mbps", "input", () => {
    draft.speed = Math.max(0, Number(val("set-mbps")) || 0);
    $$("button", $("#set-speed")).forEach((x) =>
      x.setAttribute("aria-pressed", String(Number(x.dataset.mbps) === draft.speed)),
    );
    speedNote();
  });
  on("set-save-sync", "click", () =>
    save({
      schedule: { enabled: draft.enabled, start: draft.start, end: draft.end },
      speed_limit_mbps: draft.speed,
      tz_offset_min: -new Date().getTimezoneOffset(),
    }),
  );

  // accounts
  on("set-connect", "click", async () => {
    const auth = val("set-auth").trim();
    if (!auth) return toast("Paste the androidId=… text first", "bad");
    const r = await fetch("api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "auth=" + encodeURIComponent(auth),
    });
    const d = (await r.json().catch(() => ({}))) as { email?: string; error?: string };
    if (r.ok && d.email) {
      toast(`Connected ${d.email}. Turn it on for folders in Settings › Folders.`, "good");
      await refresh();
      renderSection();
    } else toast(d.error || "That doesn't look like a Google Photos login. Copy the whole line.", "bad");
  });
  on("set-copy-prompt", "click", () => void copyText(AUTH_PROMPT));
  wireManage();
  $$<HTMLButtonElement>("[data-remove]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm(`Remove ${b.dataset.remove}? Files already in Google Photos stay there.`)) return;
      await post("accounts/remove", { email: b.dataset.remove });
      await refresh();
      renderSection();
    }),
  );

  // folders
  // Folder account chips: tap to turn an account on or off for that folder.
  document
    .querySelectorAll<HTMLButtonElement>("[data-folder] .chip[data-acc]")
    .forEach((chip) =>
      chip.addEventListener("click", () =>
        chip.setAttribute("aria-pressed", String(chip.getAttribute("aria-pressed") !== "true")),
      ),
    );
  on("set-save-folders", "click", () => {
    const folders: Record<string, string[]> = {};
    $$<HTMLElement>("[data-folder]").forEach((row) => {
      folders[row.dataset.folder ?? ""] = $$<HTMLButtonElement>('.chip[aria-pressed="true"]', row).map(
        (c) => c.dataset.acc ?? "",
      );
    });
    void save({ folders }, "Folders saved. Scanning now.");
  });

  // albums
  on("set-save-albums", "click", () => {
    const albums =
      (document.querySelector('input[name="albums"]:checked') as HTMLInputElement | null)?.value ?? "off";
    void save({ albums });
  });
  on("set-save-dups", "click", () => void save({ hash_existing: checked("set-hash") }));
  on("set-save-dates", "click", async () => {
    await saveSources({ estimate_dates: checked("set-estimate") }, "");
    void save({
      undated: { album: checked("set-undated"), name: val("set-undated-name").trim(), asked: true },
    });
  });
  on("set-save-sources", "click", () => {
    const changes: Record<string, unknown> = { asked: true };
    for (const [id] of APP_SOURCES) {
      const row = document.querySelector<HTMLElement>(`[data-src="${id}"]`);
      changes[id] = {
        album: checked(`src-${id}-album`),
        album_name: row?.querySelector<HTMLInputElement>('[data-set="album_name"]')?.value.trim() ?? "",
        caption: checked(`src-${id}-caption`),
        archive: checked(`src-${id}-archive`),
      };
    }
    void saveSources(changes, "Sources saved. Google Photos is updated in the background.");
  });
  on("set-copy-run", "click", async () => {
    const running = checked("set-copy-run");
    try {
      await post("copy/pause", { paused: !running });
      if (cfg) cfg.copy_paused = !running;
      const note = document.getElementById("set-copy-note");
      if (note) note.textContent = running ? "Running." : "Paused: nothing is copied.";
      toast(running ? "Copies running" : "Copies paused", "good");
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  });

  // alerts
  on("n-save", "click", () =>
    save(
      {
        notify: {
          ntfy_url: val("n-url").trim(),
          ntfy_token: val("n-token"),
          telegram_token: val("t-token"),
          telegram_chat: val("t-chat").trim(),
          on_login: checked("a-login"),
          on_gave_up: checked("a-gave"),
          on_round: checked("a-round"),
          round_min: Math.max(1, Number(val("a-min")) || 1),
          weekly: checked("a-week"),
        },
        tz_offset_min: -new Date().getTimezoneOffset(),
      },
      "Alerts saved",
    ),
  );
  on("n-test", "click", async () => {
    try {
      const r = await post<{ ok: boolean; results: Record<string, string> }>("notify/test");
      toast(r.ok ? "Test alert sent" : Object.values(r.results).join(", "), r.ok ? "good" : "bad");
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  });
  on("n-week", "click", async () => {
    const r = await post<{ ok: boolean; message: string }>("notify/weekly");
    toast(r.ok ? "Weekly summary sent" : r.message, r.ok ? "good" : "bad");
  });

  // app
  on("set-install", "click", () => void install());
  on("set-theme", "click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!b) return;
    const t = b.dataset.t ?? "dark";
    const pick = () => {
      setTheme(t);
      $$("button", $("#set-theme")).forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      const note = document.getElementById("set-theme-note");
      if (note) note.innerHTML = themeNote(t);
    };
    // Cross-fade the whole page where the browser can; a plain swap elsewhere.
    const doc = document as Document & { startViewTransition?: (fn: () => void) => unknown };
    if (doc.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches)
      doc.startViewTransition(pick);
    else pick();
  });

  // api
  $$<HTMLButtonElement>("[data-copy]").forEach((b) =>
    b.addEventListener("click", () => void copyText(b.dataset.copy ?? "")),
  );
}

const settings: View = {
  subtitle: "How and when backups run",
  mount(el, args) {
    section = sectionKey(args[0]);
    // The browser can offer installing a moment after the page opens: redraw the install card then.
    offInstall?.();
    offInstall = onInstallChange(() => {
      if (section === "app" && cfg) renderSection();
    });
    el.innerHTML = `
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <nav aria-label="Settings sections">
        <div class="set-tabs scroll-thin lg:hidden">${SECTIONS.map(([k, l, ic, , c]) => `<a href="#/settings/${k}" data-sec="${k}" class="set-tab">${tileIcon(ic, c, "sm")}${l}</a>`).join("")}</div>
        <div class="set-nav hidden lg:flex">${SECTIONS.map(
          ([k, l, ic, d, c, , g], i) =>
            `${g !== SECTIONS[i - 1]?.[6] ? `<div class="set-group">${g}</div>` : ""}<a href="#/settings/${k}" data-sec="${k}" class="set-item">${tileIcon(ic, c)}<span class="min-w-0 flex-1"><span class="block leading-snug">${l}</span><span class="block truncate text-xs font-normal text-ink-3">${d}</span></span>${icon("chevron", "set-chev")}</a>`,
        ).join("")}</div>
      </nav>
      <div class="min-w-0" id="set-body"><div class="card skeleton h-64"></div></div>
    </div>`;
    void get<Settings>("settings").then((c) => {
      cfg = c;
      draft = {
        start: c.schedule.start,
        end: c.schedule.end,
        enabled: c.schedule.enabled,
        speed: c.speed_limit_mbps,
      };
      renderSection();
    });
  },
  route(args) {
    section = sectionKey(args[0]);
    if (cfg) renderSection();
  },
  unmount() {
    offInstall?.();
    offInstall = null;
  },
  update(s) {
    // Opened straight from a link: the section may have been drawn before the first status.
    if (cfg && !drawnWithStatus) renderSection();
    const chips = document.getElementById("set-chips");
    if (chips) html(chips, syncChips(s));
    const p = document.getElementById("set-pause");
    if (p && document.activeElement !== p) p.setAttribute("aria-checked", String(s.paused));
  },
};

export default settings;
