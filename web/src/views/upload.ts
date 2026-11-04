// Upload photos and videos from a phone or computer into the upload folder (Photos/Uploads on Umbrel), from where
// they are backed up to Google Photos like everything else. Files go up in 8 MB pieces, so a
// dropped connection only repeats the current piece: uploads resume by themselves.

import { get, type UploadInfo } from "../lib/api";
import { $, esc, html, toast } from "../lib/dom";
import { host } from "../lib/store";
import { bytes, duration, num, pct, speed } from "../lib/format";
import { icon } from "../lib/icons";
import { badge, cardHead } from "../lib/ui";
import type { View } from "./view";

type ItemState = "waiting" | "uploading" | "retrying" | "saved" | "duplicate" | "failed";

interface Item {
  id: string;
  file: File;
  folder: string;
  state: ItemState;
  sent: number;
  started: number;
  result: string;
  tries: number;
  preview: string;
  xhr?: XMLHttpRequest;
  cancelled?: boolean;
}

interface PieceResult {
  ok?: boolean;
  offset?: number;
  saved?: string;
  duplicate?: string;
  error?: string;
}

const MEDIA = /^(image|video)\//;
const EXT =
  /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?|dng|cr2|nef|arw|raw|mp4|mov|m4v|3gp|3g2|avi|mkv|webm|mts|m2ts|wmv|mpe?g)$/i;
const VIDEO = /\.(mp4|mov|m4v|3gp|3g2|avi|mkv|webm|mts|m2ts|wmv|mpe?g)$/i;
const PARALLEL = 2;
const MAX_TRIES = 8;

let items: Item[] = [];
let info: UploadInfo | null = null;
let folder = ""; // "" = sort by date
let startedAt = 0;
const newFolders: string[] = []; // named here, created with the first file

function newId(): string {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const isVideo = (f: File) => f.type.startsWith("video") || VIDEO.test(f.name);

function add(files: FileList | File[]): void {
  let skipped = 0;
  for (const f of files) {
    if (!MEDIA.test(f.type) && !EXT.test(f.name)) {
      skipped++;
      continue;
    }
    const canShow = f.type.startsWith("image/") && !/heic|heif/i.test(f.type);
    items.push({
      id: newId(),
      file: f,
      folder,
      state: "waiting",
      sent: 0,
      started: 0,
      result: "",
      tries: 0,
      preview: canShow || isVideo(f) ? URL.createObjectURL(f) : "",
    });
  }
  if (skipped) toast(`${skipped} file(s) skipped: only photos and videos`, "bad");
  if (!startedAt) startedAt = performance.now();
  pump();
  render();
}

function pump(): void {
  while (items.filter((i) => i.state === "uploading" || i.state === "retrying").length < PARALLEL) {
    const next = items.find((i) => i.state === "waiting");
    if (!next) break;
    void send(next);
  }
}

function putPiece(it: Item, offset: number, piece: Blob): Promise<{ status: number; data: PieceResult }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    it.xhr = xhr;
    const q = new URLSearchParams({
      id: it.id,
      name: it.file.name,
      offset: String(offset),
      total: String(it.file.size),
      mtime: String(it.file.lastModified || Date.now()),
      folder: it.folder,
    });
    xhr.open("POST", "api/upload?" + q.toString());
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      it.sent = offset + e.loaded;
      renderSoon();
    };
    xhr.onload = () => {
      let data: PieceResult = {};
      try {
        data = JSON.parse(xhr.responseText) as PieceResult;
      } catch {
        /* not JSON */
      }
      resolve({ status: xhr.status, data });
    };
    xhr.onerror = () => reject(new Error("Connection lost"));
    xhr.onabort = () => reject(new Error("Cancelled"));
    xhr.send(piece);
  });
}

async function send(it: Item): Promise<void> {
  it.state = "uploading";
  it.started = it.started || performance.now();
  const chunk = info?.chunk_bytes ?? 8 * 1024 * 1024;
  let offset = 0;
  try {
    // Continue where an earlier attempt stopped.
    offset = (await get<{ offset: number }>(`upload?id=${it.id}`)).offset;
  } catch {
    offset = 0;
  }
  while (!it.cancelled) {
    try {
      const end = Math.min(offset + chunk, it.file.size);
      const { status, data } = await putPiece(it, offset, it.file.slice(offset, end));
      if (status === 409 && typeof data.offset === "number") {
        offset = data.offset; // the app has a different amount: go from there
        continue;
      }
      if (status !== 200 || !data.ok) {
        if (status >= 500 && status !== 507 && it.tries < MAX_TRIES)
          throw new Error(data.error ?? String(status));
        it.state = "failed";
        it.result = data.error ?? `HTTP ${status}`;
        break;
      }
      if (data.saved || data.duplicate) {
        it.state = data.duplicate ? "duplicate" : "saved";
        it.result = data.duplicate ?? data.saved ?? "";
        it.sent = it.file.size;
        break;
      }
      offset = Number(data.offset ?? end);
      it.sent = offset;
      it.tries = 0;
      if (it.state === "retrying") it.state = "uploading";
    } catch (e) {
      if (it.cancelled) break;
      it.tries++;
      if (it.tries > MAX_TRIES) {
        it.state = "failed";
        it.result = (e as Error).message;
        break;
      }
      it.state = "retrying";
      it.result = `${(e as Error).message}. Trying again (${it.tries}/${MAX_TRIES})…`;
      render();
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** it.tries)));
      try {
        offset = (await get<{ offset: number }>(`upload?id=${it.id}`)).offset;
      } catch {
        /* still offline: the next try asks again */
      }
    }
  }
  if (it.cancelled) {
    it.state = "failed";
    it.result = "Cancelled";
  }
  done();
}

function done(): void {
  pump();
  render();
  if (!items.some((i) => ["waiting", "uploading", "retrying"].includes(i.state))) {
    const saved = items.filter((i) => i.state === "saved").length;
    if (saved) toast(`${saved} file(s) saved to ${host()}. Backup to Google starts shortly.`, "good");
    startedAt = 0;
    void loadInfo();
  }
}

let raf = 0;
function renderSoon(): void {
  if (!raf) raf = requestAnimationFrame(() => ((raf = 0), render()));
}

const STATE: Record<ItemState, [string, "good" | "info" | "bad" | "" | "warn"]> = {
  waiting: ["Waiting", ""],
  uploading: ["Uploading", "info"],
  retrying: ["Reconnecting", "warn"],
  saved: ["Saved", "good"],
  duplicate: ["Already here", "warn"],
  failed: ["Failed", "bad"],
};

function previewMarkup(i: Item): string {
  if (!i.preview)
    return `<span class="thumb grid size-14 place-items-center text-ink-3">${icon(isVideo(i.file) ? "video" : "photo")}</span>`;
  return isVideo(i.file)
    ? `<span class="relative size-14 shrink-0"><video class="thumb size-14" src="${i.preview}#t=0.1" muted playsinline preload="metadata"></video><span class="absolute right-1 bottom-1 grid size-4 place-items-center rounded bg-black/60 text-white">${icon("play", "size-2.5")}</span></span>`
    : `<img class="thumb size-14" src="${i.preview}" alt="">`;
}

function isActive(i: Item): boolean {
  return i.state === "waiting" || i.state === "uploading" || i.state === "retrying";
}

function render(): void {
  void keepAwake(items.some(isActive));
  const list = document.getElementById("up-list");
  if (!list) return;
  const total = items.reduce((a, i) => a + i.file.size, 0);
  const sent = items.reduce((a, i) => a + (i.state === "failed" ? 0 : i.sent), 0);
  const active = items.filter((i) => i.state === "uploading" || i.state === "retrying");
  const elapsed = startedAt ? (performance.now() - startedAt) / 1000 : 0;
  const rate = elapsed > 1 ? sent / elapsed : 0;
  const left = rate > 0 ? (total - sent) / rate : 0;
  const count = (s: ItemState) => items.filter((i) => i.state === s).length;
  html(
    $("#up-summary"),
    items.length
      ? `<div class="flex flex-wrap items-center gap-1.5">${badge(`${num(items.length)} files · ${bytes(total)}`, "", "layers")}${count("saved") ? badge(`${count("saved")} saved`, "good", "ok") : ""}${count("duplicate") ? badge(`${count("duplicate")} already there`, "warn", "copy") : ""}${count("retrying") ? badge(`${count("retrying")} reconnecting`, "warn", "wifi") : ""}${count("failed") ? badge(`${count("failed")} failed`, "bad", "error") : ""}${active.length && rate ? badge(speed(rate), "info", "up") : ""}${active.length && left > 2 ? badge(`~${duration(left)} left`, "", "clock") : ""}</div>
         <div class="bar mt-3 ${active.length ? "active" : ""}"><i style="width:${pct(sent, total)}%"></i></div>
         <div class="mt-1.5 flex justify-between text-xs text-ink-3 tabular-nums"><span>${bytes(sent)} of ${bytes(total)}</span><span>${pct(sent, total).toFixed(0)}%</span></div>`
      : `<div class="text-sm text-ink-3">Files appear here with a preview while they upload.</div>`,
  );
  if (!items.length) {
    list.innerHTML = `<div class="empty">${icon("inbox")}Nothing uploaded yet in this visit</div>`;
    return;
  }
  // Keep previews (video elements) in place: only rebuild rows whose content changed.
  const order = items.slice().reverse();
  const existing = new Map(
    [...list.querySelectorAll<HTMLElement>("[data-item]")].map((r) => [r.dataset.item, r]),
  );
  if (!list.querySelector("[data-item]")) list.innerHTML = "";
  let prev: Element | null = null;
  for (const i of order) {
    const [label, tone] = STATE[i.state];
    const body = `<div class="min-w-0 flex-1"><div class="truncate text-sm font-medium">${esc(i.file.name)}</div>
      ${
        i.state === "uploading" || i.state === "retrying"
          ? `<div class="bar active mt-1.5 h-1.5"><i style="width:${pct(i.sent, i.file.size)}%"></i></div><div class="mt-1 truncate text-xs text-ink-3 tabular-nums">${i.state === "retrying" ? esc(i.result) : `${bytes(i.sent)} of ${bytes(i.file.size)}`}</div>`
          : `<div class="truncate text-xs text-ink-3">${esc(i.result ? (i.state === "failed" ? i.result : "→ " + i.result) : `${bytes(i.file.size)}${i.folder ? ` → ${i.folder}` : ""}`)}</div>`
      }</div>
      ${badge(label, tone)}
      ${["uploading", "waiting", "retrying"].includes(i.state) ? `<button class="btn icon sm" data-cancel="${i.id}" aria-label="Cancel">${icon("x")}</button>` : i.state === "failed" ? `<button class="btn icon sm" data-retry="${i.id}" aria-label="Try again">${icon("retry")}</button>` : ""}`;
    let row = existing.get(i.id);
    if (!row) {
      row = document.createElement("div");
      row.dataset.item = i.id;
      row.className = "row";
      row.innerHTML = `<span data-p>${previewMarkup(i)}</span><span class="contents" data-b></span>`;
    }
    const opener = (i.state === "saved" || i.state === "duplicate") && i.result;
    row.classList.toggle("clickable", !!opener);
    if (opener) row.setAttribute("data-open", i.result);
    const b = row.querySelector<HTMLElement>("[data-b]");
    if (b && b.dataset.html !== body) {
      b.innerHTML = body;
      b.dataset.html = body;
    }
    if (prev ? prev.nextElementSibling !== row : list.firstElementChild !== row) {
      if (prev) prev.after(row);
      else list.prepend(row);
    }
    prev = row;
    existing.delete(i.id);
  }
  existing.forEach((r) => r.remove());
}

function folderPicker(): string {
  const names = [...new Set([...(info?.folders ?? []), ...newFolders])].sort();
  return `<label class="block"><span class="mb-1.5 block text-sm font-medium">Save into</span>
    <select class="input" id="up-folder">
      <option value="">By date (year / month)</option>
      ${names.map((n) => `<option value="${esc(n)}" ${n === folder ? "selected" : ""}>${esc(n)}</option>`).join("")}
      <option value="__new">New folder…</option>
    </select></label>
    <div class="mt-2 hidden gap-2" id="up-new"><input class="input" id="up-new-name" maxlength="80" placeholder="e.g. Goa Trip"><button class="btn" id="up-new-ok">${icon("plus")}Add</button></div>
    <p class="mt-1.5 text-xs text-ink-3">With albums turned on (Settings › Albums), a named folder becomes a Google Photos album.</p>`;
}

async function loadInfo(): Promise<void> {
  info = await get<UploadInfo>("upload");
  const box = document.getElementById("up-info");
  if (!box) return;
  html(
    box,
    `<div class="flex items-center gap-3"><span class="grid size-11 place-items-center rounded-xl bg-panel-2 text-ink-2">${icon("folder", "size-5")}</span><div class="min-w-0"><div class="truncate font-medium">${esc(info.folder || "Upload folder")}${folder ? ` / ${esc(folder)}` : ""}</div><div class="text-xs text-ink-3">${folder ? "Named folder" : "Sorted into year and month folders"}</div></div></div>
     <div class="flex flex-wrap gap-1.5">${info.ready ? badge("Ready", "good", "ok") : badge("Not available", "bad", "error")}${info.synced ? badge("Backed up to Google", "good", "cloud") : badge("Folder not backed up", "warn", "warn", "Turn on Photos in Settings › Folders")}${badge(`${bytes(info.free)} free`, "", "disk")}${badge("Resumes if cut off", "info", "refresh")}</div>
     ${info.ready ? folderPicker() : `<p class="text-sm text-ink-3">The upload folder isn't mounted. With Docker, mount a folder at <code>/uploads</code> (on Umbrel, update the app).</p>`}`,
  );
  if (!info.ready) $("#drop").classList.add("pointer-events-none", "opacity-50");
  const sel = document.getElementById("up-folder") as HTMLSelectElement | null;
  sel?.addEventListener("change", () => {
    if (sel.value === "__new") {
      $("#up-new").classList.replace("hidden", "flex");
      $<HTMLInputElement>("#up-new-name").focus();
    } else {
      folder = sel.value;
      $("#up-new").classList.replace("flex", "hidden");
      void loadInfo();
    }
  });
  document.getElementById("up-new-ok")?.addEventListener("click", () => {
    const name = $<HTMLInputElement>("#up-new-name")
      .value.trim()
      .replace(/[\\/<>:"|?*]/g, "");
    if (!name) return;
    folder = name;
    newFolders.push(name);
    void loadInfo();
  });
}

async function loadShared(): Promise<void> {
  // Files shared to the installed app from the phone's gallery (see public/sw.js).
  if (!("caches" in window)) return;
  const cache = await caches.open("gps-share");
  const keys = await cache.keys();
  const files: File[] = [];
  for (const k of keys) {
    const r = await cache.match(k);
    if (!r) continue;
    const blob = await r.blob();
    const name = new URL(k.url).searchParams.get("name") ?? "shared";
    files.push(new File([blob], name, { type: blob.type, lastModified: Date.now() }));
    await cache.delete(k);
  }
  if (files.length) {
    toast(`Uploading ${files.length} shared file(s)`);
    add(files);
  }
}

/** Only where it can work: Android's Share menu lists the installed app on HTTPS. */
function shareTip(): string {
  if (!/android/i.test(navigator.userAgent)) return "";
  return `<p class="flex gap-2">${icon("upload", "mt-0.5 size-4 shrink-0 text-ink-3")}<span>${
    isSecureContext
      ? "Installed as an app, GP Sync appears in the gallery's <b>Share</b> menu: share photos straight to it."
      : "Open this page over HTTPS and install it to share photos to it from the gallery."
  }</span></p>`;
}

// Keep the screen on while uploading (phones stop web pages when the screen locks).
let wakeLock: { release: () => Promise<void> } | null = null;
async function keepAwake(on: boolean): Promise<void> {
  const nav = navigator as Navigator & {
    wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> };
  };
  try {
    if (on && !wakeLock && nav.wakeLock && document.visibilityState === "visible") {
      wakeLock = await nav.wakeLock.request("screen");
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null; // not allowed here (no HTTPS, low battery): uploads still resume later
  }
}
document.addEventListener("visibilitychange", () => {
  wakeLock = null; // the system drops it when hidden; ask again when back
  if (document.visibilityState === "visible") void keepAwake(items.some((i) => isActive(i)));
});

const upload: View = {
  subtitle: "Send photos and videos from your phone to this server and Google Photos",
  mount(el) {
    el.innerHTML = `
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-12">
      <section class="card flex flex-col lg:col-span-8">
        <div id="drop" role="button" tabindex="0" aria-label="Choose photos and videos" class="group m-4 flex min-h-64 flex-1 cursor-pointer flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed border-line p-6 text-center transition duration-300 hover:border-accent/60 hover:bg-accent/5 max-sm:min-h-52">
          <span class="grid size-16 place-items-center rounded-2xl text-white shadow-xl transition-transform duration-300 group-hover:-translate-y-1 group-hover:scale-105" style="background:linear-gradient(150deg,var(--accent),var(--accent-2));box-shadow:inset 0 1px 0 rgb(255 255 255/.3),0 14px 30px -12px color-mix(in oklab,var(--accent) 80%,transparent)">${icon("cloudUp", "size-8")}</span>
          <div><div class="text-lg font-semibold"><span class="pointer-coarse:hidden">Drop photos and videos here</span><span class="hidden pointer-coarse:inline">Add photos and videos</span></div><div class="mt-1 text-sm text-ink-3"><span class="pointer-coarse:hidden">or choose them from your computer.</span><span class="hidden pointer-coarse:inline">Pick from your gallery or take a new one.</span> Full quality, any size.</div></div>
          <div class="flex flex-wrap justify-center gap-2">
            <!-- Labels open their file input natively: works in every phone browser and the installed app. -->
            <label for="pick" class="btn primary">${icon("library")}Choose files</label>
            <label for="shoot" class="btn hidden pointer-coarse:inline-flex" id="cam">${icon("camera")}Take photo or video</label>
          </div>
        </div>
        <input type="file" id="pick" class="sr-only" multiple accept="image/*,video/*">
        <input type="file" id="shoot" class="sr-only" accept="image/*,video/*" capture="environment">
        <div class="border-t border-line px-4 py-3" id="up-summary"></div>
      </section>

      <section class="card lg:col-span-4">
        ${cardHead("Where files go", "folderOpen")}
        <div class="card-b space-y-3" id="up-info"><div class="skeleton h-24"></div></div>
      </section>

      <section class="card lg:col-span-8">
        ${cardHead("This visit", "layers", `<button class="btn sm" id="up-clear">${icon("trash")}Clear finished</button>`)}
        <div id="up-list" class="scroll-thin max-h-[60vh] overflow-y-auto" data-gallery></div>
      </section>

      <section class="card lg:col-span-4">
        ${cardHead("Tips", "phone")}
        <div class="card-b space-y-3 text-sm text-ink-2">
          <p class="flex gap-2">${icon("ok", "mt-0.5 size-4 shrink-0 text-good")}<span>Files are stored on ${esc(host())} first, then backed up to Google Photos in original quality.</span></p>
          <p class="flex gap-2">${icon("refresh", "mt-0.5 size-4 shrink-0 text-ink-3")}<span>Big videos go up in pieces. If Wi-Fi drops, the upload continues where it stopped.</span></p>
          <p class="flex gap-2">${icon("copy", "mt-0.5 size-4 shrink-0 text-ink-3")}<span>Photos already on ${esc(host())} are recognised and not stored twice.</span></p>
          <p class="flex gap-2">${icon("phone", "mt-0.5 size-4 shrink-0 text-ink-3")}<span>Keep this page open while files upload: phones pause web pages in the background. The screen stays on while uploading where the phone allows it.</span></p>
          ${shareTip()}
        </div>
      </section>
    </div>`;
    const pick = $<HTMLInputElement>("#pick");
    const shoot = $<HTMLInputElement>("#shoot");
    pick.addEventListener("change", () => {
      if (pick.files) add(pick.files);
      pick.value = "";
    });
    shoot.addEventListener("change", () => {
      if (shoot.files) add(shoot.files);
      shoot.value = "";
    });
    const drop = $("#drop");
    // A tap on the empty part of the box opens the picker too. Buttons are labels that open
    // their input themselves, so their taps are left alone (cancelling them stops the picker).
    drop.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("label, input, button, a, select")) return;
      pick.click();
    });
    drop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pick.click();
      }
    });
    ["dragenter", "dragover"].forEach((t) =>
      drop.addEventListener(t, (e) => {
        e.preventDefault();
        drop.classList.add("border-accent", "bg-accent/5");
      }),
    );
    ["dragleave", "drop"].forEach((t) =>
      drop.addEventListener(t, () => drop.classList.remove("border-accent", "bg-accent/5")),
    );
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      if (e.dataTransfer?.files.length) add(e.dataTransfer.files);
    });
    $("#up-list").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!b) return;
      e.stopPropagation();
      const id = b.dataset.cancel ?? b.dataset.retry;
      const it = items.find((i) => i.id === id);
      if (!it) return;
      if (b.dataset.cancel) {
        it.cancelled = true;
        if (it.xhr) it.xhr.abort();
        if (it.state === "waiting") {
          it.state = "failed";
          it.result = "Cancelled";
        }
      } else {
        it.cancelled = false;
        it.state = "waiting";
        it.tries = 0;
        it.result = "";
        pump();
      }
      render();
    });
    $("#up-clear").addEventListener("click", () => {
      items = items.filter((i) => {
        const keep = ["waiting", "uploading", "retrying"].includes(i.state);
        if (!keep && i.preview) URL.revokeObjectURL(i.preview);
        return keep;
      });
      render();
    });
    render();
    void loadInfo();
    if (location.hash.includes("shared")) void loadShared();
  },
};

export default upload;
