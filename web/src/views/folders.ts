import { get, tz, type FolderGroup, type FolderReport } from "../lib/api";
import { sparkline } from "../lib/charts";
import { $, $$, esc, html } from "../lib/dom";
import { ago, bytes, date, num, pct } from "../lib/format";
import { icon } from "../lib/icons";
import { host } from "../lib/store";
import { cardHead, tile } from "../lib/ui";

/** Whole percent; 99 until the very last file is in, so "100%" always means done. */
const percent = (part: number, whole: number) => {
  const p = Math.round(pct(part, whole));
  return p === 100 && part < whole ? 99 : p;
};
import type { View } from "./view";

// #/folders            → every top folder
// #/folders/f/Photos/x → any folder, one level at a time
// #/folders/devices    → one row per device (the folders phone backup apps make)

let group: "folders" | "devices" = "folders";
let path = "";
let days = 30;
let report: FolderReport | null = null;
let request = 0;

const RANGES: [number, string][] = [
  [7, "7 d"],
  [30, "30 d"],
  [90, "90 d"],
  [366, "1 y"],
];

function parse(args: string[]): void {
  if (args[0] === "devices") {
    group = "devices";
    path = "";
  } else {
    group = "folders";
    path = args[0] === "f" ? args.slice(1).map(decodeURIComponent).join("/") : "";
  }
}

function folderHref(p: string): string {
  return p ? `#/folders/f/${p.split("/").map(encodeURIComponent).join("/")}` : "#/folders";
}

function libraryHref(p: string): string {
  return `#/library/folder/${p.split("/").map(encodeURIComponent).join("/")}`;
}

function rangeText(): string {
  return days === 366 ? "the last year" : `the last ${days} days`;
}

async function load(): Promise<void> {
  const mine = ++request;
  const r = await get<FolderReport>(
    `folders?group=${group}&path=${encodeURIComponent(path)}&days=${days}&tz=${tz}`,
  ).catch(() => null);
  if (mine !== request) return; // the user moved on
  report = r;
  render();
}

function renderBar(): void {
  $$("button", $("#fo-group")).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.g === group)));
  $$("button", $("#fo-range")).forEach((b) =>
    b.setAttribute("aria-pressed", String(Number(b.dataset.d) === days)),
  );
  const crumbs =
    group === "devices"
      ? `<span class="flex items-center gap-1.5 font-medium">${icon("devices", "size-4 text-ink-3")}Devices on ${esc(host())}</span>`
      : [
          `<a class="link-btn" href="#/folders">${icon("folder", "size-4")}${esc(host())}</a>`,
          ...path
            .split("/")
            .filter(Boolean)
            .map((part, i, all) => {
              const to = all.slice(0, i + 1).join("/");
              return i === all.length - 1
                ? `<span class="font-medium">${esc(part)}</span>`
                : `<a class="link-btn" href="${folderHref(to)}">${esc(part)}</a>`;
            }),
        ].join(`<span class="text-ink-3">${icon("chevron", "size-3.5")}</span>`);
  html($("#fo-crumbs"), `<div class="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">${crumbs}</div>`);
  const lib = $("#fo-lib") as HTMLAnchorElement;
  lib.classList.toggle("hidden", group !== "folders" || !path);
  lib.href = libraryHref(path);
}

function renderTiles(r: FolderReport): void {
  const t = r.total;
  html(
    $("#fo-tiles"),
    [
      tile({ label: "Photos", value: num(t.photos), ic: "photo", sub: bytes(t.photo_bytes) }),
      tile({ label: "Videos", value: num(t.videos), ic: "video", sub: bytes(t.video_bytes) }),
      tile({ label: "Size", value: bytes(t.bytes), ic: "disk", sub: `${num(t.files)} files` }),
      tile({
        label: "Backed up",
        value: `${percent(t.synced, t.files)}%`,
        ic: "cloud",
        sub: `${num(t.synced)} of ${num(t.files)} in Google Photos`,
        tone: t.files && t.synced >= t.files ? "good" : "",
      }),
      tile({
        label: `New in ${RANGES.find(([d]) => d === days)?.[1] ?? `${days} d`}`,
        value: num(t.new),
        ic: "trend",
        sub: `${num(t.new_day)} today · ${num(t.new_week)} this week`,
      }),
      tile({
        label: "Last added",
        value: t.last_added ? ago(t.last_added) : "–",
        ic: "clock",
        sub: t.last_added ? date(t.last_added, true) : "Nothing yet",
      }),
    ].join(""),
  );
}

/** Stacked columns of photos and videos added; a year is shown per week so bars stay readable. */
function renderChart(r: FolderReport): void {
  let rows = r.daily.map((d) => ({ ...d, label: d.day }));
  if (days > 90) {
    const weeks: typeof rows = [];
    for (let end = rows.length; end > 0; end -= 7) {
      const chunk = rows.slice(Math.max(0, end - 7), end);
      weeks.unshift({
        day: chunk[0]!.day,
        label: `Week of ${chunk[0]!.day}`,
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
      : `<div class="cols flex h-56 items-end gap-[3px]">${rows
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

function rowTarget(c: FolderGroup): string {
  if (group === "devices") return c.folders.length === 1 ? folderHref(c.folders[0]!) : "";
  if (!c.name) return libraryHref(c.folders[0] ?? path); // loose files: show them
  return c.has_sub ? folderHref(c.folders[0]!) : libraryHref(c.folders[0]!);
}

function rowHtml(c: FolderGroup): string {
  const done = percent(c.synced, c.files);
  const name = c.name || "Files in this folder";
  const ic = group === "devices" ? (c.uploads ? "upload" : "phone") : c.name ? "folder" : "photo";
  const sub =
    group === "devices"
      ? c.uploads
        ? "Sent from the Upload page"
        : c.folders.length > 1
          ? c.folders.map((f) => `<a class="link-btn" href="${folderHref(f)}">${esc(f)}</a>`).join(" · ")
          : esc(c.folders[0] ?? "")
      : `${num(c.photos)} photos · ${num(c.videos)} videos`;
  const href = rowTarget(c);
  const open = href ? `href="${href}"` : "";
  const tag = href ? "a" : "div";
  return `<${tag} ${open} class="row ${href ? "clickable" : ""} grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 px-4 py-3 md:grid-cols-[auto_minmax(0,2fr)_repeat(3,minmax(0,1fr))_minmax(0,1.3fr)_auto]">
    <span class="grid size-9 place-items-center rounded-xl bg-panel-2 text-ink-2">${icon(ic, "size-4")}</span>
    <div class="min-w-0"><div class="truncate text-sm font-medium">${esc(name)}</div><div class="truncate text-xs text-ink-3">${sub}</div></div>
    <span class="text-ink-3 md:order-last">${href ? icon("chevron", "size-4") : ""}</span>
    <div class="hidden text-right text-sm tabular-nums md:block">${num(c.photos)}<div class="text-xs text-ink-3">photos</div></div>
    <div class="hidden text-right text-sm tabular-nums md:block">${num(c.videos)}<div class="text-xs text-ink-3">videos</div></div>
    <div class="hidden text-right text-sm tabular-nums md:block">${bytes(c.bytes)}<div class="text-xs text-ink-3">${done}% backed up</div></div>
    <div class="col-span-3 flex min-w-0 items-center gap-3 md:col-span-1" data-tip="${esc(`${num(c.new)} added in ${rangeText()}\n${num(c.new_week)} this week\nLast added ${c.last_added ? ago(c.last_added) : "never"}`)}">
      <div class="min-w-16 flex-1">${sparkline(c.series, c.new ? "var(--s1)" : "var(--line)", 28)}</div>
      <div class="w-14 text-right text-sm tabular-nums">${c.new ? `+${num(c.new)}` : "0"}<div class="text-xs text-ink-3">new</div></div>
    </div>
    <div class="col-span-3 md:hidden"><div class="bar"><i style="width:${done}%"></i></div><div class="mt-1 truncate text-xs text-ink-3">${num(c.photos)} photos · ${num(c.videos)} videos · ${bytes(c.bytes)} · ${done}% backed up</div></div>
  </${tag}>`;
}

function renderList(r: FolderReport): void {
  const what = group === "devices" ? "Devices" : path ? "Inside this folder" : "Folders";
  html(
    $("#fo-list-head"),
    cardHead(
      what,
      group === "devices" ? "devices" : "layers",
      `<span class="text-xs text-ink-3">New = added in ${rangeText()}</span>`,
    ),
  );
  html(
    $("#fo-list"),
    r.children.length
      ? r.children.map(rowHtml).join("")
      : `<div class="empty">${icon(group === "devices" ? "phone" : "folder")}${
          group === "devices"
            ? "No device folders yet. Phone backup apps make one folder per device inside a backed-up folder (for example Photos/iPhone)."
            : "No photos or videos here"
        }</div>`,
  );
}

function render(): void {
  renderBar();
  const r = report;
  if (!r) {
    html($("#fo-chart"), `<div class="empty">${icon("warn")}Couldn't load this folder</div>`);
    return;
  }
  if (!r.ready) {
    html(
      $("#fo-chart"),
      `<div class="empty">${icon("loader", "spin")}Counting files: the first scan is still running</div>`,
    );
    return;
  }
  renderTiles(r);
  renderChart(r);
  renderList(r);
}

function skeleton(): void {
  html($("#fo-tiles"), '<div class="card skeleton h-28"></div>'.repeat(6));
  html($("#fo-chart"), '<div class="skeleton h-56"></div>');
  html($("#fo-list"), '<div class="skeleton m-4 h-12"></div>'.repeat(3));
}

const folders: View = {
  subtitle: "Photos and videos per folder and device, and what's new",
  mount(el, args) {
    parse(args);
    el.innerHTML = `
    <section class="card mb-4 flex flex-wrap items-center gap-2 p-3">
      <div class="seg" id="fo-group"><button data-g="devices">${icon("devices")}Devices</button><button data-g="folders">${icon("folder")}Folders</button></div>
      <div class="order-first w-full min-w-0 px-1 pb-1 sm:order-none sm:w-auto sm:flex-1 sm:pb-0" id="fo-crumbs"></div>
      <a class="btn sm hidden" id="fo-lib">${icon("library")}Show files</a>
      <div class="seg" id="fo-range">${RANGES.map(([d, l]) => `<button data-d="${d}">${l}</button>`).join("")}</div>
    </section>
    <div class="grid grid-cols-2 gap-4 md:grid-cols-3 2xl:grid-cols-6" id="fo-tiles"></div>
    <section class="card mt-4">
      ${cardHead("Added per day", "chart", `<span class="flex items-center gap-3"><span class="flex items-center gap-1.5"><i class="size-2 rounded-full bg-s1"></i>Photos</span><span class="flex items-center gap-1.5"><i class="size-2 rounded-full bg-s2"></i>Videos</span></span>`)}
      <div class="card-b" id="fo-chart"></div>
    </section>
    <section class="card mt-4 overflow-hidden"><div id="fo-list-head"></div><div class="divide-y divide-line" id="fo-list"></div></section>`;
    $("#fo-group").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (b) location.hash = b.dataset.g === "devices" ? "#/folders/devices" : "#/folders";
    });
    $("#fo-range").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!b) return;
      days = Number(b.dataset.d);
      void load();
    });
    skeleton();
    renderBar();
    void load();
  },
  route(args) {
    parse(args);
    skeleton();
    void load();
  },
  unmount() {
    request++;
  },
};

export default folders;
