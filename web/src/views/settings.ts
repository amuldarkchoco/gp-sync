import { get, post, type Settings, type Status } from "../lib/api";
import { $, $$, copyText, esc, html, toast } from "../lib/dom";
import { bytes, hour, num } from "../lib/format";
import { icon, type IconName } from "../lib/icons";
import { capabilities, install, installHelp, installState, onInstallChange } from "../lib/install";
import { host, refresh, status } from "../lib/store";
import { setTheme, theme as currentTheme } from "../lib/theme";
import { badge, cardHead, syncChips } from "../lib/ui";
import type { View } from "./view";

// [key, title, icon, short line for the menu, icon tile color (iOS system colors), page intro]
const SECTIONS: [string, string, IconName, string, string, string][] = [
  [
    "sync",
    "Sync",
    "refresh",
    "Pause, hours and speed",
    "#0a84ff",
    "Pause backups, choose upload hours and limit the upload speed.",
  ],
  [
    "accounts",
    "Google accounts",
    "users",
    "Connect and remove",
    "#5e5ce6",
    "Connect up to 5 Google accounts. Removing one keeps its photos in Google Photos.",
  ],
  [
    "folders",
    "Folders",
    "folder",
    "What is backed up where",
    "#ff9f0a",
    "Choose which folders are backed up, and to which accounts.",
  ],
  [
    "albums",
    "Albums & duplicates",
    "library",
    "Organise in Google Photos",
    "#ff375f",
    "Sort uploads into Google Photos albums and find files you have twice.",
  ],
  [
    "alerts",
    "Phone alerts",
    "bell",
    "ntfy and Telegram",
    "#ff453a",
    "Get a message on your phone through ntfy or Telegram when something needs you.",
  ],
  [
    "app",
    "App & appearance",
    "palette",
    "Theme and install",
    "#bf5af2",
    "Choose how GP Sync looks and add it to your home screen.",
  ],
  [
    "api",
    "REST API",
    "code",
    "JSON endpoints",
    "#8e8e93",
    "Read status and statistics as JSON, with the same login as the dashboard.",
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
        <p class="text-xs text-ink-3">Hours use this device's time zone. A file that is uploading when the window closes finishes first.</p>
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

function sectionAccounts(s: Status | null): string {
  const accs = s?.accounts ?? [];
  return `<div class="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
    <section class="card">${cardHead("Connected", "users", badge(`${accs.length} of ${s?.max_accounts ?? 5}`, accs.length ? "good" : "warn"))}
      ${
        accs.length
          ? accs
              .map(
                (
                  a,
                  i,
                ) => `<div class="row"><span class="grid size-9 place-items-center rounded-full bg-panel-2 font-semibold uppercase">${esc(a[0])}</span><div class="min-w-0 flex-1"><div class="truncate text-sm font-medium">${esc(a)}</div><div class="flex gap-1 pt-0.5">${i === 0 && accs.length > 1 ? badge("Default for new folders", "info") : ""}${s?.login_failed.includes(a) ? badge("Login rejected", "bad", "warn") : badge("Working", "good", "ok")}</div></div>
                <button class="btn sm danger" data-remove="${esc(a)}">${icon("trash")}Remove</button></div>`,
              )
              .join("")
          : `<div class="empty">${icon("key")}No account yet</div>`
      }
    </section>
    <section class="card">${cardHead(accs.length >= (s?.max_accounts ?? 5) ? "Replace an account's login" : accs.length ? "Add or replace an account" : "Connect an account", "plus")}
      <div class="card-b space-y-3 text-sm">
        <ol class="space-y-2 text-ink-2">
          <li class="flex gap-2"><span class="badge info">1</span><span>Install <b>GmsCore</b> and <b>Google Photos ReVanced</b> on an Android phone.</span></li>
          <li class="flex gap-2"><span class="badge info">2</span><span>Connect it to a computer and run <code class="rounded bg-panel-2 px-1">adb logcat | grep "auth%2Fphotos.native"</code></span></li>
          <li class="flex gap-2"><span class="badge info">3</span><span>Sign in to Google Photos ReVanced, then copy the text from <code class="rounded bg-panel-2 px-1">androidId=</code> to the end of the line.</span></li>
        </ol>
        <textarea class="input" id="set-auth" rows="4" placeholder="androidId=…"></textarea>
        <div class="flex items-center justify-between gap-2"><span class="flex items-center gap-1.5 text-xs text-ink-3">${icon("lock", "size-3.5")}Stored only on ${esc(host())}, readable by this app only.</span><button class="btn primary" id="set-connect">${icon("key")}Connect</button></div>
      </div></section>
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
    ["off", "No albums", "Files are only added to the Google Photos library."],
    ["top", "First folder", "Photos/Goa Trip/… → album “Goa Trip”."],
    ["parent", "Folder of each file", "Photos/2024/Goa/… → album “Goa”."],
  ];
  return `<div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
    <section class="card">${cardHead("Albums", "library")}
      <div class="card-b space-y-2" id="set-albums">${opts
        .map(
          ([
            k,
            l,
            d,
          ]) => `<label class="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 has-[:checked]:border-accent has-[:checked]:bg-accent/10">
          <input type="radio" name="albums" value="${k}" class="mt-1 accent-[var(--accent)]" ${cfg?.albums === k ? "checked" : ""}><span><span class="block text-sm font-medium">${l}</span><span class="text-xs text-ink-3">${d}</span></span></label>`,
        )
        .join("")}
      </div></section>
    <section class="card">${cardHead("Duplicates", "copy")}
      <div class="card-b">${toggleRow("set-hash", "Check older uploads for duplicates", "Fingerprints files while the app is idle. See Library › Duplicates.", !!cfg?.hash_existing)}
      <a href="#/library/duplicates" class="btn mt-3">${icon("copy")}Open duplicates</a></div></section>
    ${actions("Albums are created the first time and reused after that. Files uploaded earlier are not moved.", `<button class="btn primary" id="set-save-albums">${icon("ok")}Save</button>`)}
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
  if (t !== "system") return "Saved in this browser.";
  const dark = !matchMedia("(prefers-color-scheme: light)").matches;
  return `Follows this device, now <b>${dark ? "dark" : "light"}</b>. Saved in this browser.`;
}

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
  const caps = capabilities();
  const ready = caps.filter((c) => c.ok).length;
  const state = installState();
  return `<div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
    <section class="card xl:col-span-2">${cardHead("Theme", "palette")}
      <div class="card-b">
        <div class="grid grid-cols-3 gap-3 sm:gap-4" id="set-theme" role="radiogroup" aria-label="Theme">${opts
          .map(
            ([k, l, ic, mock]) =>
              `<button type="button" class="theme-opt" role="radio" data-t="${k}" aria-checked="${k === theme}"><span class="theme-prev">${mock}<span class="theme-check">${icon("check")}</span></span><span class="theme-label">${icon(ic)}${l}</span></button>`,
          )
          .join("")}</div>
        <p class="mt-3 text-xs text-ink-3" id="set-theme-note">${themeNote(theme)}</p>
      </div></section>
    <section class="card xl:col-span-2">${cardHead("Install as an app", "download", installBadge())}
      <div class="card-b grid grid-cols-1 gap-4 text-sm text-ink-2 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:items-center">
        <div class="flex items-start gap-3">${tileIcon("phone", "#0a84ff", "lg")}<div class="min-w-0"><div class="font-medium text-ink">GP Sync on your home screen</div><p class="text-xs text-ink-3">Opens full screen without the browser bars, and uploads photos straight from your phone.</p>${state === "ready" ? `<button class="btn primary mt-3" id="set-install">${icon("download")}Install now</button>` : ""}</div></div>
        <div class="install-help" id="set-install-help">${installHelp()}</div>
      </div></section>
    <section class="card xl:col-span-2">${cardHead("What works on this device", "devices", badge(`${ready} of ${caps.length}`, ready === caps.length ? "good" : "info"))}
      <ul class="cap-list">${caps
        .map(
          (c) =>
            `<li class="cap ${c.ok ? "ok" : "no"}"><span class="cap-ic">${icon(c.ok ? "check" : "x")}</span><div class="min-w-0"><div class="text-sm font-medium ${c.ok ? "" : "text-ink-2"}">${esc(c.label)}</div><div class="text-xs text-ink-3">${esc(c.note)}</div></div></li>`,
        )
        .join("")}</ul></section>
    ${
      status()?.auth
        ? `<section class="card xl:col-span-2">${cardHead("Sign-in", "lock")}<form class="card-b flex flex-wrap items-center justify-between gap-3" method="post" action="logout"><span class="text-sm text-ink-2">This dashboard asks for a password. Signing out here does not affect other devices.</span><button class="btn danger" type="submit">${icon("logout")}Sign out</button></form></section>`
        : ""
    }
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
    .querySelectorAll<HTMLButtonElement>(".chip[data-acc]")
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
    void save({ albums, hash_existing: checked("set-hash") });
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
  subtitle: "How and when your library is backed up",
  mount(el, args) {
    section = sectionKey(args[0]);
    // The browser can offer installing a moment after the page opens: redraw the install card then.
    offInstall?.();
    offInstall = onInstallChange(() => {
      if (section === "app" && cfg) renderSection();
    });
    el.innerHTML = `
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-12">
      <nav class="lg:col-span-4 xl:col-span-3" aria-label="Settings sections">
        <div class="set-tabs scroll-thin lg:hidden">${SECTIONS.map(([k, l, ic, , c]) => `<a href="#/settings/${k}" data-sec="${k}" class="set-tab">${tileIcon(ic, c, "sm")}${l}</a>`).join("")}</div>
        <div class="set-nav hidden lg:flex">${SECTIONS.map(
          ([k, l, ic, d, c]) =>
            `<a href="#/settings/${k}" data-sec="${k}" class="set-item">${tileIcon(ic, c)}<span class="min-w-0 flex-1"><span class="block leading-snug">${l}</span><span class="block truncate text-xs font-normal text-ink-3">${d}</span></span>${icon("chevron", "set-chev")}</a>`,
        ).join("")}</div>
      </nav>
      <div class="min-w-0 lg:col-span-8 xl:col-span-9" id="set-body"><div class="card skeleton h-64"></div></div>
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
