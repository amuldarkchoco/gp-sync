import {
  get,
  post,
  tz,
  type FolderFiles,
  type FolderGroup,
  type FolderReport,
  type Settings,
} from "../lib/api";
import { sparkline } from "../lib/charts";
import { $, $$, esc, html, toast } from "../lib/dom";
import { ago, bytes, date, fileName, num, pct } from "../lib/format";
import { icon, type IconName } from "../lib/icons";
import { host } from "../lib/store";
import { badge, cardHead, openAttrs, thumb, type Tone } from "../lib/ui";
import type { View } from "./view";

// #/folders              → one row per device (the folders phone backup apps make)
// #/folders/d/Photos/x   → one device: its photos and videos (and folders, if it has real ones)
// #/folders/f            → every top folder
// #/folders/f/Photos/x   → any folder: what's inside it, and its photos and videos

/** Whole percent; 99 until the very last file is in, so "100%" always means done. */
const percent = (part: number, whole: number) => {
  const p = Math.round(pct(part, whole));
  return p === 100 && part < whole ? 99 : p;
};

let group: "folders" | "devices" = "devices";
let path = "";
let days = 30;
let report: FolderReport | null = null;
let request = 0;

// the photos and videos of the open folder
let files: FolderFiles | null = null;
let shownFiles: FolderFiles["items"] = [];
let fStatus = "all";
let fKind = "all";
let fSort = "new";
let fRequest = 0;
let fLoading = false;
let observer: IntersectionObserver | null = null;

// ---- upload order: folders whose files go to Google first (saved in settings)
let prio: string[] = [];

async function loadPrio(): Promise<void> {
  const st = await get<Settings>("settings").catch(() => null);
  prio = st?.priority ?? [];
  renderPrio();
  if (report) render();
}

async function savePrio(next: string[], message: string): Promise<void> {
  const before = prio;
  prio = next;
  renderPrio();
  if (report) render();
  try {
    const st = await post<Settings>("settings", { priority: next });
    prio = st.priority ?? next;
    toast(message, "good");
  } catch (e) {
    prio = before;
    toast((e as Error).message, "bad");
  }
  renderPrio();
  if (report) render();
}

/** "Photos/I2220 (2)" -> "I2220", "Photos/trip/day2" -> "day2". */
function prioName(p: string): string {
  const parts = p.split("/");
  return parts.length === 2 ? deviceName(parts[1]!) : (parts.at(-1) ?? p);
}

function prioBadge(p: string): string {
  const i = prio.indexOf(p);
  return i < 0 ? "" : badge(`#${i + 1} first`, "good", "up");
}

function renderPrio(): void {
  const card = document.getElementById("fo-prio-card");
  if (!card) return;
  const show = !path && prio.length > 0;
  card.classList.toggle("hidden", !show);
  if (!show) return;
  html(
    card,
    `${cardHead("Upload order", "up", `<span class="text-xs text-ink-3">These go to Google first</span>`)}
     <ol class="divide-y divide-line">${prio
       .map(
         (p, i) => `<li class="flex items-center gap-3 px-4 py-2.5">
           <span class="grid size-6 shrink-0 place-items-center rounded-full bg-panel-2 text-xs tabular-nums">${i + 1}</span>
           <a class="min-w-0 flex-1" href="#/folders/${p.split("/").length === 2 ? "d" : "f"}/${p.split("/").map(encodeURIComponent).join("/")}"><span class="block truncate text-sm font-medium">${esc(prioName(p))}</span><span class="block truncate text-xs text-ink-3">${esc(p)}</span></a>
           <button class="btn icon sm" data-prio-move="${esc(p)}" data-dir="-1" ${i === 0 ? "disabled" : ""} aria-label="Earlier">${icon("up")}</button>
           <button class="btn icon sm" data-prio-move="${esc(p)}" data-dir="1" ${i === prio.length - 1 ? "disabled" : ""} aria-label="Later">${icon("down")}</button>
           <button class="btn icon sm" data-prio-remove="${esc(p)}" aria-label="Back to the usual order">${icon("x")}</button></li>`,
       )
       .join("")}</ol>
     <p class="border-t border-line px-4 py-2.5 text-xs text-ink-3">Everything else follows in the usual order. A change applies to the files still waiting right away.</p>`,
  );
}

const RANGES: [number, string][] = [
  [7, "7 d"],
  [30, "30 d"],
  [90, "90 d"],
  [366, "1 y"],
];
const FILE_STATES: Record<string, [string, Tone, IconName]> = {
  backed_up: ["In Google", "good", "cloud"],
  waiting: ["Waiting", "info", "hourglass"],
  failed: ["Failed", "bad", "error"],
};

function parse(args: string[]): void {
  group = args[0] === "f" ? "folders" : "devices";
  path = args[0] === "f" || args[0] === "d" ? args.slice(1).map(decodeURIComponent).join("/") : "";
}

/** A link inside the current view: devices stay devices, folders stay folders. */
function folderHref(p: string): string {
  const kind = group === "devices" ? "d" : "f";
  if (!p) return group === "devices" ? "#/folders" : "#/folders/f";
  return `#/folders/${kind}/${p.split("/").map(encodeURIComponent).join("/")}`;
}

/** "I2220 (2)" -> "I2220": a phone that paired again is still the same device. */
const deviceName = (folder: string) => folder.replace(/ \(\d+\)$/, "");

/** Backup apps name files by a long code; a date says more about such a photo. */
function fileTitle(f: { name: string; mtime: number; kind: string }): string {
  const base = fileName(f.name);
  return /^[0-9a-f]{24,}\./i.test(base) && f.mtime
    ? `${f.kind === "video" ? "Video" : "Photo"} · ${date(f.mtime, true)}`
    : base;
}

function rangeText(): string {
  return days === 366 ? "the last year" : `the last ${days} days`;
}

// ---- loading

async function load(): Promise<void> {
  const mine = ++request;
  const kind = path ? "folders" : group; // inside a device it is a folder like any other
  const r = await get<FolderReport>(
    `folders?group=${kind}&path=${encodeURIComponent(path)}&days=${days}&tz=${tz}`,
  ).catch(() => null);
  if (mine !== request) return; // the user moved on
  report = r;
  render();
}

async function loadFiles(reset: boolean): Promise<void> {
  if (!reset && (fLoading || !files || shownFiles.length >= files.total)) return;
  const mine = ++fRequest;
  fLoading = true;
  const offset = reset ? 0 : shownFiles.length;
  try {
    const r = await get<FolderFiles>(
      `folders/files?path=${encodeURIComponent(path)}&status=${fStatus}&kind=${fKind}&sort=${fSort}&offset=${offset}&limit=60`,
    );
    if (mine !== fRequest) return;
    files = r;
    shownFiles = reset ? r.items : shownFiles.concat(r.items);
    if (reset) renderFiles();
    else appendFiles(r.items);
  } catch {
    if (reset) html($("#fo-files"), `<div class="empty">${icon("warn")}Couldn't load the files</div>`);
  } finally {
    if (mine === fRequest) fLoading = false;
  }
}

// ---- top bar

function renderBar(): void {
  $$("button", $("#fo-group")).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.g === group)));
  $$("button", $("#fo-range")).forEach((b) =>
    b.setAttribute("aria-pressed", String(Number(b.dataset.d) === days)),
  );
  const sep = `<span class="text-ink-3">${icon("chevron", "size-3.5")}</span>`;
  const parts = path.split("/").filter(Boolean);
  // A device starts at its folder (Photos/iPhone); show it by name, then what's inside it.
  const from = group === "devices" ? Math.min(2, parts.length) : 0;
  const steps = parts.slice(from).map((part, i, all) => {
    const to = parts.slice(0, from + i + 1).join("/");
    return i === all.length - 1
      ? `<span class="font-medium">${esc(part)}</span>`
      : `<a class="link-btn" href="${folderHref(to)}">${esc(part)}</a>`;
  });
  if (group === "devices" && from) {
    const dev = deviceName(parts[from - 1] ?? "");
    steps.unshift(
      steps.length
        ? `<a class="link-btn" href="${folderHref(parts.slice(0, from).join("/"))}">${icon("phone", "size-4")}${esc(dev)}</a>`
        : `<span class="flex items-center gap-1.5 font-medium">${icon("phone", "size-4 text-ink-3")}${esc(dev)}</span>`,
    );
  }
  const root =
    group === "devices"
      ? path
        ? `<a class="link-btn" href="#/folders">${icon("devices", "size-4")}Devices</a>`
        : `<span class="flex items-center gap-1.5 font-medium">${icon("devices", "size-4 text-ink-3")}Devices on ${esc(host())}</span>`
      : path
        ? `<a class="link-btn" href="#/folders/f">${icon("folder", "size-4")}${esc(host())}</a>`
        : `<span class="flex items-center gap-1.5 font-medium">${icon("folder", "size-4 text-ink-3")}Folders on ${esc(host())}</span>`;
  const crumbs = [root, ...steps].join(sep);
  html($("#fo-crumbs"), `<div class="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">${crumbs}</div>`);
}

// ---- summary: one compact card instead of six big tiles

function stat(label: string, value: string, sub: string): string {
  return `<div class="min-w-0"><div class="label truncate">${esc(label)}</div><div class="num mt-1 truncate text-lg sm:text-xl">${value}</div><div class="truncate text-xs text-ink-3">${sub}</div></div>`;
}

function renderSummary(r: FolderReport): void {
  const t = r.total;
  const done = percent(t.synced, t.files);
  const parts = path.split("/").filter(Boolean);
  const title = !path
    ? group === "devices"
      ? "All devices"
      : "All folders"
    : group === "devices" && parts.length === 2
      ? deviceName(parts[1]!)
      : (parts.at(-1) ?? path);
  html(
    $("#fo-summary"),
    `<div class="flex flex-wrap items-center gap-x-3 gap-y-1"><span class="truncate text-base font-semibold">${esc(title)}</span>
       <span class="text-xs text-ink-3">${num(t.files)} files · ${bytes(t.bytes)}</span>
       ${path ? prioBadge(path) : ""}
       <span class="ml-auto text-xs text-ink-3 tabular-nums">${done}% in Google Photos</span>
       ${path && t.files > t.synced ? `<button class="btn sm ${prio.includes(path) ? "" : "primary"}" data-prio-toggle="${esc(path)}">${icon(prio.includes(path) ? "x" : "up")}${prio.includes(path) ? "Usual order" : "Upload first"}</button>` : ""}</div>
     <div class="bar mt-2"><i style="width:${done}%"></i></div>
     <div class="mt-4 grid grid-cols-3 gap-4 lg:grid-cols-6">
       ${stat("Photos", num(t.photos), bytes(t.photo_bytes))}
       ${stat("Videos", num(t.videos), bytes(t.video_bytes))}
       ${stat("Backed up", num(t.synced), `${num(t.files - t.synced)} waiting`)}
       ${stat(`New in ${RANGES.find(([d]) => d === days)?.[1] ?? `${days} d`}`, num(t.new), `${num(t.new_week)} this week`)}
       ${stat("Today", num(t.new_day), "added")}
       ${stat("Last added", t.last_added ? ago(t.last_added) : "–", t.last_added ? date(t.last_added, true) : "Nothing yet")}
     </div>`,
  );
}

// ---- devices and subfolders

function rowTarget(c: FolderGroup): string {
  if (group === "devices" && !path) return c.folders.length === 1 ? folderHref(c.folders[0]!) : "";
  const to = c.folders[0] ?? path;
  // A phone's folder opens as that device, whichever way it was reached.
  if (c.device) return `#/folders/d/${to.split("/").map(encodeURIComponent).join("/")}`;
  return folderHref(to);
}

function rowHtml(c: FolderGroup): string {
  const done = percent(c.synced, c.files);
  const devices = group === "devices" && !path;
  const ic = devices ? (c.uploads ? "upload" : "phone") : c.device ? "phone" : "folder";
  const sub = devices
    ? c.uploads
      ? "Sent from the Upload page"
      : c.folders.length > 1
        ? c.folders.map((f) => `<a class="link-btn" href="${folderHref(f)}">${esc(f)}</a>`).join(" · ")
        : esc(c.folders[0] ?? "")
    : `${c.device ? "Device · " : ""}${num(c.photos)} photos · ${num(c.videos)} videos`;
  const href = rowTarget(c);
  const tag = href ? "a" : "div";
  const thumbs = (c.recent ?? [])
    .map(
      (n) =>
        `<span class="block size-10 overflow-hidden rounded-lg bg-panel-2">${thumb(n, "size-full object-cover")}</span>`,
    )
    .join("");
  return `<${tag} ${href ? `href="${href}"` : ""} class="row ${href ? "clickable" : ""} flex-wrap gap-y-2 px-4 py-3">
    <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-panel-2 text-ink-2">${icon(ic, "size-5")}</span>
    <div class="min-w-0 flex-1 basis-40">
      <div class="flex items-center gap-2"><span class="truncate text-sm font-medium">${esc(c.name)}</span>${c.folders.length === 1 ? prioBadge(c.folders[0]!) : ""}${c.new ? badge(`+${num(c.new)} new`, "info") : ""}</div>
      <div class="truncate text-xs text-ink-3">${sub}</div>
      <div class="mt-1.5 flex items-center gap-2"><div class="bar h-1.5 max-w-48 flex-1"><i style="width:${done}%"></i></div><span class="text-xs text-ink-3 tabular-nums">${done}%</span></div>
    </div>
    ${thumbs ? `<div class="hidden gap-1.5 md:flex">${thumbs}</div>` : ""}
    <div class="hidden w-28 text-right text-sm tabular-nums sm:block">${num(c.files)}<div class="text-xs text-ink-3">${bytes(c.bytes)}</div></div>
    <div class="hidden w-28 lg:block" data-tip="${esc(`${num(c.new)} added in ${rangeText()}\n${num(c.new_week)} this week\nLast added ${c.last_added ? ago(c.last_added) : "never"}`)}">${sparkline(c.series, c.new ? "var(--s1)" : "var(--line)", 28)}</div>
    <span class="text-ink-3">${href ? icon("chevron", "size-4") : ""}</span>
  </${tag}>`;
}

function renderList(r: FolderReport): void {
  const rows = r.children.filter((c) => c.name); // loose files are in the photos below
  const card = $("#fo-list-card");
  card.classList.toggle("hidden", !rows.length && !!path); // a folder without folders inside: just its photos
  html(
    $("#fo-list-head"),
    cardHead(
      group === "devices" && !path ? "Devices" : path ? "Folders inside" : "Folders",
      group === "devices" && !path ? "devices" : "layers",
      `<span class="text-xs text-ink-3">${num(rows.length)}</span>`,
    ),
  );
  const skipped = !path ? (r.not_backed_up ?? []) : [];
  const note = skipped.length
    ? `<div class="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 text-xs text-ink-3">${icon("info", "size-3.5")}<span>Not backed up, so not counted here: ${skipped
        .map(
          (f) =>
            `<a class="link-btn" href="#/folders/f/${encodeURIComponent(f.name)}">${esc(f.name)}</a> (${num(f.files)})`,
        )
        .join(", ")}.</span><a class="link-btn" href="#/settings/folders">Choose folders</a></div>`
    : "";
  html(
    $("#fo-list"),
    rows.length
      ? rows.map(rowHtml).join("") + note
      : `<div class="empty">${icon(group === "devices" ? "phone" : "folder")}${
          group === "devices" && !path
            ? "No device folders yet. Phone backup apps make one folder per device inside a backed-up folder (for example Photos/iPhone)."
            : "No folders here"
        }</div>`,
  );
}

// ---- photos and videos of the open folder

function fileTile(f: FolderFiles["items"][number]): string {
  const [label, tone, ic] = FILE_STATES[f.state] ?? [f.state, "info", "info"];
  return `<figure class="card media-tile group cursor-pointer overflow-hidden" ${openAttrs(f.name, f.state === "failed")}>
    <div class="shimmer relative aspect-square overflow-hidden">${thumb(f.name, "zoom-img fade-img size-full object-cover", f.mtime)}
      <div class="on-media absolute bottom-2 left-2 flex gap-1">${badge(label, tone, ic)}${f.kind === "video" ? `<span class="badge">${icon("video")}</span>` : ""}</div></div>
    <figcaption class="p-2.5"><div class="truncate text-sm font-medium" title="${esc(f.name)}">${esc(fileTitle(f))}</div>
      <div class="truncate text-xs text-ink-3">${bytes(f.size)} · added ${date(f.added)}</div>
      ${f.error ? `<div class="mt-1 truncate text-xs text-bad" title="${esc(f.error)}">${esc(f.error)}</div>` : ""}</figcaption></figure>`;
}

function moreHtml(): string {
  if (!files) return "";
  return shownFiles.length < files.total
    ? `<button class="btn" id="fo-more">${icon("plus")}Show more (${num(files.total - shownFiles.length)} left)</button>`
    : shownFiles.length > 60
      ? `<span class="text-xs text-ink-3">All ${num(files.total)} shown</span>`
      : "";
}

function renderFilesHead(): void {
  const c = files?.counts;
  const n = (k: keyof NonNullable<typeof c>) => (c ? ` · ${num(c[k])}` : "");
  html(
    $("#fo-files-tools"),
    `<div class="seg" id="fo-fstatus">${[
      ["all", "All", n("all")],
      ["backed_up", "In Google", n("backed_up")],
      ["waiting", "Waiting", n("waiting")],
      ["failed", "Failed", n("failed")],
    ]
      .filter(([k]) => k !== "failed" || !c || c.failed)
      .map(([k, l, x]) => `<button data-s="${k}" aria-pressed="${k === fStatus}">${l}${x}</button>`)
      .join("")}</div>
     <div class="seg" id="fo-fkind">${[
       ["all", "Both"],
       ["photo", "Photos"],
       ["video", "Videos"],
     ]
       .map(([k, l]) => `<button data-k="${k}" aria-pressed="${k === fKind}">${l}</button>`)
       .join("")}</div>
     <select class="input w-auto" id="fo-fsort">${[
       ["new", "Newest added"],
       ["old", "Oldest added"],
       ["size", "Largest"],
       ["name", "Name"],
     ]
       .map(([k, l]) => `<option value="${k}" ${k === fSort ? "selected" : ""}>${l}</option>`)
       .join("")}</select>`,
  );
}

function renderFiles(): void {
  renderFilesHead();
  const body = document.getElementById("fo-files");
  if (!body) return;
  body.innerHTML = shownFiles.length
    ? `<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 2xl:grid-cols-8" id="fo-grid" data-gallery>${shownFiles.map(fileTile).join("")}</div>
       <div class="mt-4 flex min-h-10 justify-center" id="fo-sentinel">${moreHtml()}</div>`
    : `<div class="empty">${icon("library")}${fStatus === "all" && fKind === "all" ? "No photos or videos here" : "Nothing matches"}</div>`;
  watchEnd();
}

function appendFiles(more: FolderFiles["items"]): void {
  const grid = document.getElementById("fo-grid");
  if (!grid) return renderFiles();
  grid.insertAdjacentHTML("beforeend", more.map(fileTile).join(""));
  const end = document.getElementById("fo-sentinel");
  if (end) end.innerHTML = moreHtml();
}

/** Load the next page shortly before the end of the grid scrolls into view. */
function watchEnd(): void {
  observer?.disconnect();
  const end = document.getElementById("fo-sentinel");
  if (!end) return;
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadFiles(false);
    },
    { root: document.getElementById("view"), rootMargin: "900px 0px" },
  );
  observer.observe(end);
}

// ---- chart

/** Stacked columns of photos and videos added; a year is shown per week so bars stay readable. */
function renderChart(r: FolderReport): void {
  let rows = r.daily.map((d) => ({ ...d }));
  if (days > 90) {
    const weeks: typeof rows = [];
    for (let end = rows.length; end > 0; end -= 7) {
      const chunk = rows.slice(Math.max(0, end - 7), end);
      weeks.unshift({
        day: chunk[0]!.day,
        photos: chunk.reduce((a, d) => a + d.photos, 0),
        videos: chunk.reduce((a, d) => a + d.videos, 0),
      });
    }
    rows = weeks;
  }
  const max = Math.max(1, ...rows.map((d) => d.photos + d.videos));
  const every = rows.length <= 10 ? 1 : rows.length <= 31 ? 5 : 10;
  const nice = (day: string, long = false) =>
    new Date(day + "T00:00:00").toLocaleDateString(
      [],
      long ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short" },
    );
  const empty = !rows.some((d) => d.photos + d.videos);
  html(
    $("#fo-chart"),
    empty
      ? `<div class="empty">${icon("chart")}Nothing new in ${rangeText()}</div>`
      : `<div class="cols flex h-20 items-end gap-[3px] sm:h-28">${rows
          .map((d) => {
            const head = days > 90 ? `Week of ${nice(d.day)}` : nice(d.day, true);
            const tip = `${head}\nPhotos: ${num(d.photos)}\nVideos: ${num(d.videos)}`;
            return `<div class="col flex h-full flex-1 flex-col justify-end gap-[2px]" data-tip="${esc(tip)}">
              ${d.videos ? `<div class="col-bar rounded-t-[4px] bg-s2" style="height:${(d.videos / max) * 100}%"></div>` : ""}
              ${d.photos ? `<div class="col-bar ${d.videos ? "" : "rounded-t-[4px]"} bg-s1" style="height:${(d.photos / max) * 100}%"></div>` : ""}
              ${d.photos || d.videos ? "" : `<div class="h-[2px] rounded bg-panel-2"></div>`}</div>`;
          })
          .join("")}</div>
        <div class="mt-1.5 flex gap-[3px] text-[10px] text-ink-3">${rows
          .map(
            (d, i) =>
              `<div class="flex-1 text-center whitespace-nowrap">${(rows.length - 1 - i) % every === 0 ? esc(nice(d.day)) : ""}</div>`,
          )
          .join("")}</div>`,
  );
}

function render(): void {
  renderBar();
  const r = report;
  if (!r) {
    html($("#fo-summary"), `<div class="empty">${icon("warn")}Couldn't load this folder</div>`);
    return;
  }
  if (!r.ready) {
    html(
      $("#fo-summary"),
      `<div class="empty">${icon("loader", "spin")}Counting files: the first scan is still running</div>`,
    );
    return;
  }
  renderSummary(r);
  renderList(r);
  renderChart(r);
}

function skeleton(): void {
  html(
    $("#fo-summary"),
    '<div class="skeleton h-5 w-40"></div><div class="skeleton mt-3 h-2"></div><div class="skeleton mt-4 h-12"></div>',
  );
  html($("#fo-list"), '<div class="skeleton m-4 h-12"></div>'.repeat(3));
  html($("#fo-chart"), '<div class="skeleton h-28"></div>');
  html($("#fo-files-tools"), "");
  html(
    $("#fo-files"),
    `<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 2xl:grid-cols-8">${'<div class="card overflow-hidden"><div class="shimmer media-tile aspect-square"></div><div class="space-y-1.5 p-2.5"><div class="skeleton h-3.5 w-3/4"></div><div class="skeleton h-3 w-1/2"></div></div></div>'.repeat(6)}</div>`,
  );
}

function filesSub(): string {
  if (path) return "Including the folders inside";
  return "Newest first, from every backed-up folder";
}

function open(): void {
  files = null;
  shownFiles = [];
  fStatus = "all";
  fKind = "all";
  observer?.disconnect();
  skeleton();
  renderBar();
  renderPrio();
  void loadPrio();
  html($("#fo-files-sub"), filesSub());
  void load();
  void loadFiles(true);
}

const folders: View = {
  subtitle: "Photos and videos per device and folder, and what's new",
  mount(el, args) {
    parse(args);
    el.innerHTML = `
    <section class="card mb-4 flex flex-wrap items-center gap-2 p-3">
      <div class="seg" id="fo-group"><button data-g="devices">${icon("devices")}Devices</button><button data-g="folders">${icon("folder")}Folders</button></div>
      <div class="order-first w-full min-w-0 px-1 pb-1 sm:order-none sm:w-auto sm:flex-1 sm:pb-0" id="fo-crumbs"></div>
    </section>
    <section class="card mb-4">
      <div class="p-4" id="fo-summary"></div>
      <div class="border-t border-line">
        ${cardHead("Added per day", "chart", `<span class="hidden items-center gap-3 sm:flex"><span class="flex items-center gap-1.5"><i class="size-2 rounded-full bg-s1"></i>Photos</span><span class="flex items-center gap-1.5"><i class="size-2 rounded-full bg-s2"></i>Videos</span></span><div class="seg ml-2" id="fo-range">${RANGES.map(([d, l]) => `<button data-d="${d}" class="max-sm:px-2.5">${l}</button>`).join("")}</div>`)}
        <div class="card-b" id="fo-chart"></div>
      </div>
    </section>
    <section class="card mb-4 hidden overflow-hidden" id="fo-prio-card"></section>
    <section class="card mb-4 overflow-hidden" id="fo-list-card"><div id="fo-list-head"></div><div class="divide-y divide-line" id="fo-list"></div></section>
    <section class="card mb-4" id="fo-files-card">
      ${cardHead("Photos and videos", "library", `<span class="hidden text-xs text-ink-3 sm:inline" id="fo-files-sub"></span>`)}
      <div class="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3" id="fo-files-tools"></div>
      <div class="p-3" id="fo-files"></div>
    </section>`;
    $("#fo-group").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (b) location.hash = b.dataset.g === "devices" ? "#/folders" : "#/folders/f";
    });
    $("#fo-range").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!b) return;
      days = Number(b.dataset.d);
      void load();
    });
    el.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>(
        "[data-prio-toggle], [data-prio-move], [data-prio-remove]",
      );
      if (!b) return;
      e.preventDefault();
      if (b.dataset.prioToggle) {
        const p = b.dataset.prioToggle;
        if (prio.includes(p))
          void savePrio(
            prio.filter((x) => x !== p),
            `${prioName(p)} is back in the usual order`,
          );
        else void savePrio([...prio, p].slice(-10), `${prioName(p)} uploads first`);
      } else if (b.dataset.prioRemove) {
        const p = b.dataset.prioRemove;
        void savePrio(
          prio.filter((x) => x !== p),
          `${prioName(p)} is back in the usual order`,
        );
      } else if (b.dataset.prioMove) {
        const i = prio.indexOf(b.dataset.prioMove);
        const j = i + Number(b.dataset.dir);
        if (i < 0 || j < 0 || j >= prio.length) return;
        const next = [...prio];
        [next[i], next[j]] = [next[j]!, next[i]!];
        void savePrio(next, "Upload order saved");
      }
    });
    const card = $("#fo-files-card");
    card.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!b) return;
      if (b.id === "fo-more") void loadFiles(false);
      else if (b.dataset.s) {
        fStatus = b.dataset.s;
        void loadFiles(true);
      } else if (b.dataset.k) {
        fKind = b.dataset.k;
        void loadFiles(true);
      }
    });
    card.addEventListener("change", (e) => {
      const t = e.target as HTMLSelectElement;
      if (t.id === "fo-fsort") {
        fSort = t.value;
        void loadFiles(true);
      }
    });
    open();
  },
  route(args) {
    parse(args);
    open();
    document.getElementById("view")?.scrollTo({ top: 0 });
  },
  unmount() {
    request++;
    fRequest++;
    observer?.disconnect();
    observer = null;
  },
};

export default folders;
