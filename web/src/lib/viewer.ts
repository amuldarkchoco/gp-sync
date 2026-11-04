// Full-screen viewer for photos and videos, with an info panel (status, errors, retry).
// Swipe or use the arrow keys to move, Esc or swipe down to close.

import { get, mediaUrl, post, previewUrl, thumbUrl, type FileInfo } from "./api";
import { $, esc, toast } from "./dom";
import { ago, bytes, clock, date, fileName, folderOf, ms } from "./format";
import { icon } from "./icons";
import { refresh } from "./store";
import { badge, eventMeta, type Tone } from "./ui";

const STATUS: Record<string, [string, Tone]> = {
  uploaded: ["Backed up", "good"],
  exists: ["Already in Google", "info"],
  failed: ["Failed", "bad"],
  waiting: ["Waiting", ""],
  missing: ["No longer in the folder", "warn"],
};

let names: string[] = [];
let index = 0;
let root: HTMLElement | null = null;
let infoOpen = false;
let touch: { x: number; y: number } | null = null;

function el(): HTMLElement {
  if (root) return root;
  root = document.createElement("div");
  root.id = "viewer";
  root.className = "fixed inset-0 z-[55] hidden flex-col bg-black/90 backdrop-blur-xl";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.innerHTML = `
    <div class="flex h-14 shrink-0 items-center gap-2 px-3 text-white sm:px-4" style="padding-top:env(safe-area-inset-top)">
      <button class="btn icon border-white/10 bg-white/10 text-white" data-v="close" aria-label="Close">${icon("x")}</button>
      <div class="min-w-0 flex-1"><div class="truncate text-sm font-medium" id="vw-name"></div><div class="truncate text-xs text-white/60" id="vw-sub"></div></div>
      <a class="btn icon border-white/10 bg-white/10 text-white" id="vw-google" target="_blank" rel="noopener" title="Open in Google Photos" aria-label="Open in Google Photos">${icon("external")}</a>
      <a class="btn icon border-white/10 bg-white/10 text-white" id="vw-dl" title="Download original" aria-label="Download original">${icon("download")}</a>
      <button class="btn icon border-white/10 bg-white/10 text-white" data-v="info" title="Details" aria-label="Details">${icon("info")}</button>
    </div>
    <div class="relative flex min-h-0 flex-1">
      <div class="relative flex min-w-0 flex-1">
      <div class="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden" id="vw-stage"></div>
      <button class="btn icon absolute top-1/2 left-3 hidden -translate-y-1/2 border-white/10 bg-white/10 text-white sm:inline-flex" data-v="prev" aria-label="Previous">${icon("chevron", "size-5 rotate-180")}</button>
      <button class="btn icon absolute top-1/2 right-3 hidden -translate-y-1/2 border-white/10 bg-white/10 text-white sm:inline-flex" data-v="next" aria-label="Next" id="vw-next">${icon("chevron", "size-5")}</button>
      </div>
      <aside id="vw-info" class="scroll-thin absolute inset-x-0 bottom-0 hidden max-h-[60%] overflow-y-auto rounded-t-3xl border-t border-line bg-bg p-4 sm:static sm:max-h-none sm:w-96 sm:rounded-none sm:border-t-0 sm:border-l"></aside>
    </div>`;
  document.body.append(root);
  root.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-v]");
    const act = b?.dataset.v;
    if (act === "close") close();
    else if (act === "prev") go(-1);
    else if (act === "next") go(1);
    else if (act === "info") {
      infoOpen = !infoOpen;
      $("#vw-info").classList.toggle("hidden", !infoOpen);
    } else if (act === "retry") void retry(b as HTMLButtonElement);
    else if ((e.target as HTMLElement).id === "vw-stage") close();
  });
  root.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    if (t && !(e.target as HTMLElement).closest("#vw-info")) touch = { x: t.clientX, y: t.clientY };
  });
  root.addEventListener("touchend", (e) => {
    const t = e.changedTouches[0];
    if (!touch || !t) return;
    const dx = t.clientX - touch.x;
    const dy = t.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
    else if (dy > 90) close();
  });
  document.addEventListener("keydown", (e) => {
    if (root?.classList.contains("hidden")) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight") go(1);
    else if (e.key === "ArrowLeft") go(-1);
    else if (e.key === "i") $("[data-v=info]", root!).click();
  });
  return root;
}

function close(): void {
  root?.classList.add("hidden");
  root?.classList.remove("flex");
  $("#vw-stage", root!).innerHTML = "";
  document.body.style.overflow = "";
}

function go(step: number): void {
  if (names.length < 2) return;
  index = (index + step + names.length) % names.length;
  void show();
}

async function retry(b: HTMLButtonElement): Promise<void> {
  b.disabled = true;
  const r = await post<{ ok: boolean }>("retry", { path: names[index] });
  toast(r.ok ? "This file will be tried again now" : "Nothing to retry", r.ok ? "good" : "info");
  void refresh();
  void show();
}

function infoPanel(f: FileInfo): string {
  const [label, tone] = STATUS[f.status] ?? [f.status, ""];
  const rows: [string, string][] = [
    ["Folder", esc(folderOf(f.name) || "–")],
    ["Size", f.size ? bytes(f.size) : "–"],
    ["File date", f.modified ? `${date(f.modified, true)} ${clock(f.modified)}` : "–"],
    ["Google account", esc(f.account || "Not backed up")],
    ["Backed up", f.updated && (f.status === "uploaded" || f.status === "exists") ? ago(f.updated) : "–"],
    ["Upload took", f.upload_ms != null ? ms(f.upload_ms) : "–"],
  ];
  return `
    <div class="flex flex-wrap items-center gap-1.5">${badge(label, tone, tone === "good" ? "ok" : tone === "bad" ? "error" : "info")}${badge(f.kind === "video" ? "Video" : "Photo", "", f.kind === "video" ? "video" : "photo")}${f.attempts ? badge(`${f.attempts} of ${f.max_attempts} tries`, f.attempts >= f.max_attempts ? "bad" : "warn") : ""}</div>
    ${
      f.status === "failed"
        ? `<div class="mt-3 rounded-xl border border-bad/30 bg-bad/10 p-3"><div class="flex items-center gap-2 text-sm font-medium text-bad">${icon("warn")}Why it failed</div>
           <div class="mt-1.5 font-mono text-xs break-words text-ink-2">${esc(f.error || "Unknown error")}</div>
           <button class="btn primary mt-3 w-full" data-v="retry">${icon("retry")}Retry this file</button></div>`
        : ""
    }
    <div class="mt-3">${rows.map(([k, v]) => `<div class="kv"><span>${k}</span><span class="truncate">${v}</span></div>`).join("")}</div>
    ${
      f.history.length
        ? `<div class="label mt-4 mb-1">History</div>${f.history
            .map((h) => {
              const m = eventMeta[h.kind] ?? eventMeta.info!;
              return `<div class="flex items-start gap-2 border-b border-line py-2 text-xs last:border-0">${icon(m.icon, "mt-0.5 size-3.5 shrink-0 text-ink-3")}<div class="min-w-0 flex-1"><div class="break-words text-ink-2">${esc(h.text)}</div><div class="text-ink-3">${date(h.time)} ${clock(h.time)}</div></div></div>`;
            })
            .join("")}`
        : ""
    }
    ${f.sha1 ? `<div class="mt-3 truncate font-mono text-[10px] text-ink-3" title="SHA-1">${f.sha1}</div>` : ""}`;
}

async function show(): Promise<void> {
  const name = names[index]!;
  const r = el();
  $("#vw-name", r).textContent = fileName(name);
  $("#vw-sub", r).textContent =
    `${folderOf(name)}${names.length > 1 ? ` · ${index + 1} of ${names.length}` : ""}`;
  const dl = $<HTMLAnchorElement>("#vw-dl", r);
  dl.href = mediaUrl(name, true);
  dl.download = fileName(name);
  // iPhone home-screen apps have no back button: open the file in a sheet instead of in place.
  const iosApp = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (iosApp) dl.target = "_blank";
  else dl.removeAttribute("target");
  const stage = $("#vw-stage", r);
  const video = /\.(mp4|m4v|mov|webm)$/i.test(name);
  stage.innerHTML = video
    ? `<video class="max-h-full max-w-full" src="${mediaUrl(name)}" poster="${thumbUrl(name)}" controls playsinline preload="metadata"></video>`
    : `<img class="max-h-full max-w-full object-contain opacity-0 transition-opacity duration-300" alt="" src="${previewUrl(name)}">
       <img class="absolute max-h-full max-w-full scale-105 object-contain blur-xl" alt="" src="${thumbUrl(name)}" data-low>`;
  const big = stage.querySelector<HTMLImageElement>("img:not([data-low])");
  if (big) {
    big.onload = () => {
      big.classList.remove("opacity-0");
      stage.querySelector("[data-low]")?.remove();
    };
    big.onerror = () => {
      const low = stage.querySelector<HTMLImageElement>("[data-low]");
      if (low) low.className = "max-h-full max-w-full object-contain";
      big.remove();
    };
  }
  // Warm up the neighbours so swiping feels instant.
  for (const n of [names[index + 1], names[index - 1]]) {
    if (n && !/\.(mp4|m4v|mov|webm|avi|mkv|3gp)$/i.test(n)) new Image().src = previewUrl(n);
  }
  const info = $("#vw-info", r);
  info.innerHTML = `<div class="skeleton h-40"></div>`;
  const f = await get<FileInfo>("file?path=" + encodeURIComponent(name));
  if (names[index] !== name) return;
  const g = $<HTMLAnchorElement>("#vw-google", r);
  g.href = f.google_url || "#";
  g.classList.toggle("hidden", !f.google_url);
  info.innerHTML = infoPanel(f);
  if (f.status === "failed" && !infoOpen) {
    infoOpen = true;
    info.classList.remove("hidden");
  }
}

/** Open the viewer at `start` within a list of file names (relative to the media folder). */
export function openViewer(list: string[], start = 0, withInfo = false): void {
  names = list.length ? list : [];
  if (!names.length) return;
  index = Math.max(0, Math.min(start, names.length - 1));
  const r = el();
  infoOpen = withInfo || window.innerWidth >= 1280;
  $("#vw-info", r).classList.toggle("hidden", !infoOpen);
  r.querySelectorAll<HTMLElement>("[data-v=prev], [data-v=next]").forEach((b) =>
    b.classList.toggle("sm:inline-flex", names.length > 1),
  );
  r.classList.remove("hidden");
  r.classList.add("flex");
  document.body.style.overflow = "hidden";
  void show();
}
