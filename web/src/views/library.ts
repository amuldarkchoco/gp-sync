import { get, type Duplicates, type FileItem, type Status } from "../lib/api";
import { $, $$, esc, html } from "../lib/dom";
import { ago, bytes, fileName, folderOf, num } from "../lib/format";
import { icon } from "../lib/icons";
import { host, status } from "../lib/store";
import { badge, openAttrs, thumb } from "../lib/ui";
import type { View } from "./view";

const STATUS: Record<string, [string, "good" | "info" | "bad"]> = {
  uploaded: ["Uploaded", "good"],
  exists: ["In Google", "info"],
  failed: ["Failed", "bad"],
};

let tab = "files";
let q = "";
let st = "all";
let folder = "";
let sort = "new";
let items: FileItem[] = [];
let total = 0;
let timer = 0;

let loading = false;
let request = 0;
let observer: IntersectionObserver | null = null;

async function loadFiles(reset: boolean): Promise<void> {
  if (!reset && (loading || items.length >= total)) return;
  const mine = ++request;
  loading = true;
  const offset = reset ? 0 : items.length;
  try {
    const r = await get<{ total: number; items: FileItem[] }>(
      `files?q=${encodeURIComponent(q)}&status=${st}&folder=${encodeURIComponent(folder)}&sort=${sort}&limit=60&offset=${offset}`,
    );
    if (mine !== request) return; // a newer search or filter answered first
    total = r.total;
    if (reset) {
      items = r.items;
      renderFiles();
    } else {
      items = items.concat(r.items);
      appendFiles(r.items);
    }
  } finally {
    if (mine === request) loading = false;
  }
}

function tileHtml(f: FileItem): string {
  const [label, tone] = STATUS[f.status] ?? [f.status, "info"];
  const link = f.google_url
    ? `<a href="${esc(f.google_url)}" target="_blank" rel="noopener" class="btn icon sm absolute top-2 right-2 bg-black/50 text-white backdrop-blur" title="Open in Google Photos" aria-label="Open in Google Photos">${icon("external")}</a>`
    : "";
  return `<figure class="card media-tile group cursor-pointer overflow-hidden" ${openAttrs(f.name, f.status === "failed")}>
    <div class="shimmer relative aspect-square overflow-hidden">${thumb(f.name, "zoom-img fade-img size-full object-cover", f.mtime)}
      <div class="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100"></div>${link}
      <div class="on-media absolute bottom-2 left-2 flex gap-1">${badge(label, tone)}${f.undated ? badge("No date", "warn", "calendar", "No date inside the file: see Fix dates") : ""}${f.kind === "video" ? `<span class="badge">${icon("video")}</span>` : ""}</div></div>
    <figcaption class="p-2.5"><div class="truncate text-sm font-medium" title="${esc(f.name)}">${esc(fileName(f.name))}</div>
      <div class="truncate text-xs text-ink-3">${bytes(f.size)} · ${esc(folderOf(f.name))}</div>
      ${f.status === "failed" ? `<div class="mt-1 truncate text-xs text-bad" title="${esc(f.error)}">${esc(f.error)}</div>` : `<div class="text-xs text-ink-3">${ago(f.updated)}</div>`}
    </figcaption></figure>`;
}

function moreHtml(): string {
  return items.length < total
    ? `<button class="btn" id="lib-more">${icon("plus")}Show more (${num(total - items.length)} left)</button>`
    : items.length > 60
      ? `<span class="text-xs text-ink-3">All ${num(total)} shown</span>`
      : "";
}

function renderFiles(): void {
  const body = document.getElementById("lib-body");
  if (!body) return;
  html($("#lib-count"), `${num(total)} file${total === 1 ? "" : "s"}`);
  body.innerHTML = items.length
    ? `<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 2xl:grid-cols-8" id="lib-grid" data-gallery>${items.map(tileHtml).join("")}</div>
      <div class="mt-4 flex min-h-10 justify-center" id="lib-sentinel">${moreHtml()}</div>`
    : `<div class="empty">${icon("library")}No files match</div>`;
  watchEnd();
}

/** Add the next page to the end, leaving the tiles already shown untouched. */
function appendFiles(more: FileItem[]): void {
  const grid = document.getElementById("lib-grid");
  if (!grid) return renderFiles();
  grid.insertAdjacentHTML("beforeend", more.map(tileHtml).join(""));
  html($("#lib-count"), `${num(total)} file${total === 1 ? "" : "s"}`);
  const end = document.getElementById("lib-sentinel");
  if (end) end.innerHTML = moreHtml();
}

/** Load the next page shortly before the end of the grid scrolls into view. */
function watchEnd(): void {
  observer?.disconnect();
  const end = document.getElementById("lib-sentinel");
  if (!end) return;
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadFiles(false);
    },
    { root: document.getElementById("view"), rootMargin: "900px 0px" },
  );
  observer.observe(end);
}

async function loadDuplicates(): Promise<void> {
  const d = await get<Duplicates>("duplicates");
  const body = document.getElementById("lib-body");
  if (!body || tab !== "dups") return;
  html($("#lib-count"), `${num(d.groups.length)} groups · ${bytes(d.wasted)} could be freed`);
  body.innerHTML = `
    <div class="mb-4 flex flex-wrap items-center gap-2 text-sm text-ink-2">${badge(`${num(d.hashed)} of ${num(d.total)} files checked`, d.hashed >= d.total ? "good" : "info", "search")}
      <span class="text-ink-3">Files with identical content. Nothing is deleted: tidy up on ${esc(host())} if you want.</span></div>
    ${
      d.groups.length
        ? `<div class="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">${d.groups
            .map(
              (
                g,
              ) => `<div class="card overflow-hidden" data-gallery><div class="flex items-center gap-2 border-b border-line px-4 py-2.5 text-sm">${badge(`${g.count} copies`, "warn", "copy")}<span class="text-ink-3">${bytes(g.size)} each</span><span class="ml-auto text-xs text-ink-3">${bytes(g.wasted)} extra</span></div>
                ${g.files.map((f) => `<div class="row clickable" ${openAttrs(f)}>${thumb(f)}<div class="min-w-0 flex-1"><div class="truncate text-sm">${esc(fileName(f))}</div><div class="truncate text-xs text-ink-3">${esc(folderOf(f))}</div></div></div>`).join("")}</div>`,
            )
            .join("")}</div>`
        : `<div class="empty">${icon("shield")}No duplicates found</div>`
    }`;
}

function folderOptions(s: Status | null): string {
  // Only backed-up folders: Library lists what was sent to Google, others would look empty.
  const names = s ? Object.keys(s.folders).filter((f) => s.folders[f]?.files && s.folders[f]?.account) : [];
  if (folder && !names.includes(folder)) names.push(folder); // a deeper folder, opened from Folders
  return `<option value="">All folders</option>${names.map((n) => `<option ${n === folder ? "selected" : ""}>${esc(n)}</option>`).join("")}`;
}

function show(): void {
  request++; // answers for the other tab are dropped
  loading = false;
  $$("button", $("#lib-tab")).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.t === tab)));
  $("#lib-tools").classList.toggle("hidden", tab !== "files");
  observer?.disconnect();
  $("#lib-body").innerHTML =
    `<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 2xl:grid-cols-8">${'<div class="card overflow-hidden"><div class="shimmer media-tile aspect-square"></div><div class="space-y-1.5 p-2.5"><div class="skeleton h-3.5 w-3/4"></div><div class="skeleton h-3 w-1/2"></div></div></div>'.repeat(12)}</div>`;
  if (tab === "files") void loadFiles(true);
  else void loadDuplicates();
}

const library: View = {
  subtitle: "Every photo and video the app knows about",
  mount(el, args) {
    tab = args[0] === "duplicates" ? "dups" : "files";
    if (args[0] === "folder") folder = args.slice(1).map(decodeURIComponent).join("/");
    el.innerHTML = `
    <section class="card mb-4 flex flex-wrap items-center gap-2 p-3">
      <div class="seg" id="lib-tab"><button data-t="files">${icon("library")}Files</button><button data-t="dups">${icon("copy")}Duplicates</button></div>
      <span class="text-sm text-ink-3" id="lib-count"></span>
      <div class="flex w-full flex-wrap items-center gap-2 lg:ml-auto lg:w-auto" id="lib-tools">
        <label class="relative min-w-48 flex-1">${icon("search", "absolute top-3 left-3 size-4 text-ink-3")}<input class="input pl-9" id="lib-q" placeholder="Search by name or folder"></label>
        <div class="seg" id="lib-st">${[
          ["all", "All"],
          ["uploaded", "Uploaded"],
          ["exists", "In Google"],
          ["failed", "Failed"],
          ["undated", "No date"],
        ]
          .map(([k, l]) => `<button data-s="${k}" aria-pressed="${k === st}">${l}</button>`)
          .join("")}</div>
        <select class="input w-auto" id="lib-folder">${folderOptions(status())}</select>
        <select class="input w-auto" id="lib-sort"><option value="new">Newest</option><option value="old">Oldest</option><option value="name">Name</option><option value="size">Largest</option></select>
      </div>
    </section>
    <div id="lib-body"></div>`;
    $<HTMLSelectElement>("#lib-sort").value = sort;
    $("#lib-tab").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!b) return;
      tab = b.dataset.t ?? "files";
      show();
    });
    $("#lib-st").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!b) return;
      st = b.dataset.s ?? "all";
      $$("button", $("#lib-st")).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      void loadFiles(true);
    });
    $<HTMLInputElement>("#lib-q").addEventListener("input", (e) => {
      q = (e.target as HTMLInputElement).value.trim();
      clearTimeout(timer);
      timer = window.setTimeout(() => void loadFiles(true), 250);
    });
    $<HTMLSelectElement>("#lib-folder").addEventListener("change", (e) => {
      folder = (e.target as HTMLSelectElement).value;
      void loadFiles(true);
    });
    $<HTMLSelectElement>("#lib-sort").addEventListener("change", (e) => {
      sort = (e.target as HTMLSelectElement).value;
      void loadFiles(true);
    });
    $("#lib-body").addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("#lib-more")) void loadFiles(false);
    });
    show();
  },
  unmount() {
    observer?.disconnect();
    observer = null;
    request++;
    loading = false;
  },
  update(s) {
    const sel = document.getElementById("lib-folder") as HTMLSelectElement | null;
    if (sel && sel.options.length <= (folder ? 2 : 1) && Object.keys(s.folders).length)
      sel.innerHTML = folderOptions(s);
  },
};

export default library;
