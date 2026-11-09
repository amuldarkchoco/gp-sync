import { get, tz, type FolderReport, type History, type Insights, type Status } from "../lib/api";
import { donut, heatLegend, heatmap, ring, setRing, sparkline, type Slice } from "../lib/charts";
import { $, $$, animateChange, esc, html } from "../lib/dom";
import { ago, bytes, clock, duration, fileName, ms, num, pct, speed } from "../lib/format";
import { icon } from "../lib/icons";
import { NetChart, rangeButtons, type Range } from "../lib/netchart";
import { jobLink, jobStep, jobTitle } from "../lib/jobs";
import { badge, cardHead, etaText, eventMeta, openAttrs, phaseInfo, thumb, tile } from "../lib/ui";
import type { View } from "./view";

let chart: NetChart | null = null;
let hist: History | null = null;
let ins: Insights | null = null;
let slowTimer = 0;
let slowSynced = -1; // uploaded count the heat map and streak were last loaded for
let slowAt = 0;
let last: Status | null = null;

// ---- where the photos are: pie charts per device (or folder) and photos vs videos
let share: FolderReport | null = null;
let shareBy: "devices" | "folders" = "devices";
let shareMetric: "files" | "bytes" = "files";
let shareAt = 0;
let shareRequest = 0;
let shareError = false;
let kindsDrawn = false; // the photos/videos donut needs the status, which can come later
const SLICE_COLORS = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)"];
const OTHER = "var(--ink-3)";

async function loadShare(interactive = false): Promise<void> {
  shareAt = Date.now();
  const mine = ++shareRequest;
  const by = shareBy;
  if (interactive) {
    share = null;
    shareError = false;
    renderShare();
  }
  const r = await get<FolderReport>(`folders?group=${by}&days=30&tz=${tz}`).catch(() => null);
  if (mine !== shareRequest || by !== shareBy) return;
  share = r;
  shareError = !r;
  renderShare();
  if (interactive) animateChange(document.getElementById("ov-share-body"));
}

function pctText(part: number, whole: number): string {
  const p = whole ? (part / whole) * 100 : 0;
  return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
}

function legendRow(color: string, name: string, value: number, total: number, extra = "", href = ""): string {
  const label = href
    ? `<a class="truncate hover:underline" href="${href}">${esc(name)}</a>`
    : `<span class="truncate">${esc(name)}</span>`;
  return `<li class="flex items-center gap-2 py-1.5 text-sm"><i class="size-2.5 shrink-0 rounded-full" style="background:${color}"></i>${label}
    <span class="ml-auto shrink-0 tabular-nums">${pctText(value, total)}</span>
    <span class="w-16 shrink-0 text-right text-xs text-ink-3 tabular-nums sm:w-20">${shareMetric === "files" ? num(value) : bytes(value)}</span>${extra}</li>`;
}

function renderShare(): void {
  const el = document.getElementById("ov-share-body");
  if (!el) return;
  $$("button", $("#ov-share-by")).forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.by === shareBy)),
  );
  $$("button", $("#ov-share-metric")).forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.m === shareMetric)),
  );
  const m = (f: { files: number; bytes: number }) => (shareMetric === "files" ? f.files : f.bytes);
  const fmt = (v: number) => (shareMetric === "files" ? num(v) : bytes(v));
  // Groups: biggest first; past five slices the rest is one grey "Other", so colours never repeat.
  const groups = [...(share?.children ?? [])].filter((c) => c.name && m(c) > 0).sort((a, b) => m(b) - m(a));
  const shown = groups.length > 5 ? groups.slice(0, 4) : groups;
  const rest = groups.slice(shown.length);
  const total = groups.reduce((a, g) => a + m(g), 0);
  const slices: Slice[] = shown.map((g, i) => ({
    label: g.name,
    value: m(g),
    color: SLICE_COLORS[i]!,
    tip: `${g.name}\n${fmt(m(g))} · ${pctText(m(g), total)}\n${Math.round(pct(g.synced, g.files))}% in Google Photos`,
  }));
  const restValue = rest.reduce((a, g) => a + m(g), 0);
  if (rest.length)
    slices.push({
      label: "Other",
      value: restValue,
      color: OTHER,
      tip: `${rest.length} more\n${fmt(restValue)} · ${pctText(restValue, total)}`,
    });
  const link = (g: (typeof groups)[number]) =>
    `#/folders/${shareBy === "devices" || g.device ? "d" : "f"}/${(g.folders[0] ?? g.name).split("/").map(encodeURIComponent).join("/")}`;
  const backed = (g: (typeof groups)[number]) => {
    const p = Math.round(pct(g.synced, g.files));
    return `<span class="flex w-16 shrink-0 items-center gap-1.5 sm:w-24" title="${p}% in Google Photos"><span class="bar h-1.5 flex-1"><i style="width:${p}%"></i></span><span class="w-8 text-right text-[11px] text-ink-3 tabular-nums">${p}%</span></span>`;
  };
  const lib = last?.library;
  kindsDrawn = !!lib;
  const kinds = lib
    ? [
        {
          label: "Photos",
          value: shareMetric === "files" ? (lib.photos ?? 0) : (lib.photo_bytes ?? 0),
          color: "var(--s1)",
        },
        {
          label: "Videos",
          value: shareMetric === "files" ? (lib.videos ?? 0) : (lib.video_bytes ?? 0),
          color: "var(--s2)",
        },
      ]
    : [];
  const kindTotal = kinds.reduce((a, k) => a + k.value, 0);
  const center = (v: number, sub: string) =>
    `<div><div class="num text-xl">${shareMetric === "files" ? num(v) : bytes(v)}</div><div class="text-[11px] text-ink-3">${sub}</div></div>`;
  html(
    el,
    `<div class="grid gap-6 md:grid-cols-2">
      <div class="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
        ${donut(slices, center(total, shareBy === "devices" ? "on devices" : "in folders"))}
        <div class="w-full min-w-0 flex-1"><div class="label mb-1">${shareBy === "devices" ? "By device" : "By folder"}</div>
          ${
            groups.length
              ? `<ul>${shown.map((g, i) => legendRow(SLICE_COLORS[i]!, g.name, m(g), total, backed(g), link(g))).join("")}${rest.length ? legendRow(OTHER, `Other (${rest.length})`, restValue, total) : ""}</ul>`
              : `<p class="py-2 text-sm text-ink-3">${share ? (shareBy === "devices" ? "No device folders found. Try Folders." : "No folders found.") : shareError ? "Couldn't load this view." : "Loading…"}</p>`
          }</div>
      </div>
      <div class="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
        ${donut(
          kinds.map((k) => ({ ...k, tip: `${k.label}\n${fmt(k.value)} · ${pctText(k.value, kindTotal)}` })),
          center(kindTotal, "backed-up library"),
        )}
        <div class="w-full min-w-0 flex-1"><div class="label mb-1">Photos and videos</div>
          <ul>${kinds.map((k) => legendRow(k.color, k.label, k.value, kindTotal)).join("")}</ul>
          ${lib ? `<p class="mt-2 text-xs text-ink-3">${shareMetric === "files" ? `Videos are ${pctText(lib.videos ?? 0, lib.files)} of the files but ${pctText(lib.video_bytes ?? 0, lib.bytes)} of the space.` : `Photos take ${bytes(lib.photo_bytes)} and videos ${bytes(lib.video_bytes)}.`}</p>` : ""}
        </div>
      </div>
    </div>`,
  );
}

function streak(h: History): number {
  // Same count as the heat map, so the streak and the coloured days agree.
  const byDay = new Map(h.data.map((d) => [d.day, d.photos + d.videos]));
  let n = 0;
  const d = new Date(h.today + "T00:00:00");
  if (!byDay.get(h.today)) d.setDate(d.getDate() - 1); // today may still be coming
  for (;;) {
    const key = d.toLocaleDateString("sv"); // YYYY-MM-DD
    if (!byDay.get(key)) return n;
    n++;
    d.setDate(d.getDate() - 1);
  }
}

async function loadSlow(): Promise<void> {
  slowAt = Date.now();
  [hist, ins] = await Promise.all([
    get<History>(`history?days=371&tz=${tz}`),
    get<Insights>(`insights?tz=${tz}`),
  ]);
  renderSlow();
}

function renderSlow(): void {
  if (!hist || !document.getElementById("ov-year")) return;
  const today = hist.data.find((d) => d.day === hist?.today);
  const last14 = (() => {
    const m = new Map(hist.data.map((d) => [d.day, d.photos + d.videos]));
    return Array.from({ length: 14 }, (_, i) => {
      const d = new Date(hist!.today + "T00:00:00");
      d.setDate(d.getDate() - 13 + i);
      return m.get(d.toLocaleDateString("sv")) ?? 0;
    });
  })();
  const t = $("#k-today");
  html($("[data-v]", t), num((today?.photos ?? 0) + (today?.videos ?? 0)));
  html(
    $("[data-s]", t),
    `${num(today?.photos ?? 0)} photos · ${num(today?.videos ?? 0)} videos · ${bytes((today?.photo_bytes ?? 0) + (today?.video_bytes ?? 0))}`,
  );
  html($("[data-c]", t), sparkline(last14, "var(--s1)"));
  const st = streak(hist);
  const k = $("#k-streak");
  html($("[data-v]", k), `${st} day${st === 1 ? "" : "s"}`);
  const active = hist.data.filter((d) => d.photos + d.videos > 0).length;
  html($("[data-s]", k), `${num(active)} active day${active === 1 ? "" : "s"} this year`);
  html(
    $("[data-c]", k),
    `<div class="flex gap-1">${last14
      .slice(-14)
      .map(
        (v) =>
          `<i class="h-3 flex-1 rounded-[3px]" style="background:${v ? "var(--s1)" : "var(--panel-2)"}"></i>`,
      )
      .join("")}</div>`,
  );

  // Year of uploads
  const days: { day: string; value: number; tip: string }[] = [];
  const byDay = new Map(hist.data.map((d) => [d.day, d]));
  const end = new Date(hist.today + "T00:00:00");
  for (let i = 364; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    const key = d.toLocaleDateString("sv");
    const row = byDay.get(key);
    const n = (row?.photos ?? 0) + (row?.videos ?? 0);
    days.push({
      day: key,
      value: n,
      tip: `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" })}\n${n ? `${row?.photos ?? 0} photos, ${row?.videos ?? 0} videos · ${bytes((row?.photo_bytes ?? 0) + (row?.video_bytes ?? 0))}` : "Nothing uploaded"}`,
    });
  }
  const yearTotal = days.reduce((a, d) => a + d.value, 0);
  html($("#ov-year-sub"), `${num(yearTotal)} files in the last year`);
  const year = $("#ov-year");
  const first = !year.dataset.html;
  html(year, heatmap(days));
  if (first) year.scrollLeft = year.scrollWidth; // phones: start at today

  if (ins) {
    const rows: [string, string, string][] = [
      ["Time spent uploading", duration(ins.upload_ms / 1000), "timer"],
      ["Average per photo", ins.photo.avg_ms ? ms(ins.photo.avg_ms) : "–", "photo"],
      ["Average per video", ins.video.avg_ms ? ms(ins.video.avg_ms) : "–", "video"],
      ["Average photo size", bytes(ins.photo.avg_bytes), "photo"],
      ["Average video size", bytes(ins.video.avg_bytes), "video"],
      ["Average upload speed", ins.avg_speed ? speed(ins.avg_speed) : "–", "gauge"],
    ];
    html(
      $("#ov-times"),
      `<div class="grid grid-cols-2 gap-2">${rows
        .map(
          ([l, v, ic]) =>
            `<div class="stat-tile"><div class="flex items-center gap-1.5 text-xs text-ink-3">${icon(ic as "timer", "size-3.5")}${esc(l)}</div><div class="num text-lg">${esc(v)}</div></div>`,
        )
        .join("")}</div>
       ${ins.timed_files < ins.uploaded ? `<p class="mt-3 text-xs text-ink-3">${icon("info", "inline size-3.5 -mt-0.5")} Upload times are known for ${num(ins.timed_files)} of ${num(ins.uploaded)} uploads (older ones weren't timed).</p>` : ""}`,
    );
  }
}

const STEPS: Record<string, string> = {
  hashing: "Fingerprinting",
  checking: "Checking Google",
  uploading: "Uploading",
  finalizing: "Finishing",
  skipped: "Already there",
  complete: "Done",
};

function stepBadge(c: NonNullable<Status["current"]>): string {
  const up = c.step === "uploading";
  const label =
    up && c.bytes_total
      ? `Uploading ${pct(c.bytes_done, c.bytes_total).toFixed(0)}%`
      : (STEPS[c.step] ?? c.step);
  return `<span class="badge info">${icon(up ? "cloudUp" : "loader", up ? "bob" : "spin")}${esc(label)}</span>`;
}

/** What the Now card says when no file is being sent (the badge elsewhere already shows the phase). */
function nowTitle(s: Status): string {
  switch (s.phase) {
    case "paused":
      return "Uploads are paused";
    case "scanning":
      return "Scanning your folders";
    case "scheduled":
      return "Waiting for upload hours";
    case "setup":
      return "No Google account yet";
    case "error":
      return "Something went wrong";
    case "starting":
      return "Starting up";
    default:
      return s.library.files > s.library.synced_files ? "Next files go at the next scan" : "All caught up";
  }
}

function nowAction(s: Status): string {
  if (s.phase === "paused")
    return `<button class="btn sm primary shrink-0" data-now="resume">${icon("play")}Resume</button>`;
  if (s.phase === "setup")
    return `<a class="btn sm primary shrink-0" href="#/settings/accounts">${icon("key")}Connect</a>`;
  if (s.phase === "idle" && s.library.files > s.library.synced_files)
    return `<button class="btn sm shrink-0" data-now="scan">${icon("refresh")}Scan now</button>`;
  return "";
}

/** Background work across accounts, under the current upload: one line each, with progress. */
function jobsList(s: Status): string {
  const jobs = s.jobs ?? [];
  if (!jobs.length) return "";
  return `<div class="border-t border-line px-4 py-3">
    <div class="label mb-2">Also running</div>
    <ul class="space-y-2.5">${jobs
      .map((j) => {
        const step = jobStep(j);
        const bar = j.total
          ? `<div class="bar mt-1.5 h-1.5"><i style="width:${pct(j.done ?? 0, j.total)}%"></i></div>`
          : "";
        return `<li><a href="${jobLink(j)}" class="block rounded-lg hover:text-ink"><div class="flex items-center gap-2 text-sm">${icon(j.kind === "library" ? "refresh" : j.kind === "copy" ? "users" : j.kind === "dates" ? "clock" : "cloud", `size-4 shrink-0 text-accent ${j.kind === "library" ? "spin" : ""}`)}<span class="truncate font-medium">${esc(jobTitle(j))}</span></div>${step ? `<div class="truncate pl-6 text-xs text-ink-3">${esc(step)}</div>` : ""}${bar ? `<div class="pl-6">${bar}</div>` : ""}</a></li>`;
      })
      .join("")}</ul></div>`;
}

function upNext(s: Status, current: string): string {
  const next = (s.pending ?? []).filter((n) => n !== current).slice(0, 4);
  if (!next.length) return "";
  return `<div class="mt-4 label">Up next</div><div class="-mx-4 mt-1">${next
    .map(
      (n) =>
        `<div class="row clickable py-2" ${openAttrs(n)}>${thumb(n, "thumb size-8")}<div class="min-w-0 flex-1 truncate text-sm">${esc(fileName(n))}</div></div>`,
    )
    .join("")}</div>`;
}

// ---- customise: show, hide and reorder cards (saved in this browser)

const CARDS: [string, string][] = [
  ["ov-hero", "Backed up"],
  ["ov-kpis", "Speed, today, streak, CPU, memory"],
  ["ov-share", "Where your photos are"],
  ["ov-network", "Network"],
  ["ov-glance", "At a glance"],
  ["ov-now", "Now"],
  ["ov-recent", "Recent activity"],
  ["ov-times", "Upload times and sizes"],
  ["ov-year", "Uploads per day"],
];
interface Layout {
  order: string[];
  hidden: string[];
}

function layout(): Layout {
  try {
    const l = JSON.parse(localStorage.getItem("ov-layout") ?? "") as Layout;
    const known = CARDS.map(([id]) => id);
    const order = l.order.filter((id) => known.includes(id));
    return { order: [...order, ...known.filter((id) => !order.includes(id))], hidden: l.hidden ?? [] };
  } catch {
    return { order: CARDS.map(([id]) => id), hidden: [] };
  }
}

function saveLayout(l: Layout | null): void {
  if (l) localStorage.setItem("ov-layout", JSON.stringify(l));
  else localStorage.removeItem("ov-layout");
  applyLayout();
}

function applyLayout(): void {
  const l = layout();
  document.querySelectorAll<HTMLElement>("[data-card]").forEach((c) => {
    const id = c.dataset.card ?? "";
    c.style.order = String(l.order.indexOf(id));
    c.classList.toggle("hidden", l.hidden.includes(id));
  });
}

function openCustomize(): void {
  let sheet = document.getElementById("ov-sheet");
  if (!sheet) {
    sheet = document.createElement("div");
    sheet.id = "ov-sheet";
    sheet.className =
      "fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 backdrop-blur-sm sm:items-center sm:p-4";
    document.body.append(sheet);
    sheet.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const l = layout();
      const b = t.closest<HTMLElement>("[data-act]");
      if (t === sheet || t.closest("[data-done]")) {
        sheet?.remove();
        return;
      }
      if (t.closest("[data-reset]")) {
        saveLayout(null);
        renderSheet();
        return;
      }
      if (!b) return;
      const id = b.dataset.id ?? "";
      const i = l.order.indexOf(id);
      if (b.dataset.act === "toggle") {
        l.hidden = l.hidden.includes(id) ? l.hidden.filter((x) => x !== id) : [...l.hidden, id];
      } else {
        const j = b.dataset.act === "up" ? i - 1 : i + 1;
        if (j < 0 || j >= l.order.length) return;
        [l.order[i], l.order[j]] = [l.order[j]!, l.order[i]!];
      }
      saveLayout(l);
      renderSheet();
    });
  }
  renderSheet();
}

function renderSheet(): void {
  const sheet = document.getElementById("ov-sheet");
  if (!sheet) return;
  const l = layout();
  const title = new Map(CARDS);
  sheet.innerHTML = `<div class="card w-full max-w-md rounded-b-none bg-bg p-2 sm:rounded-2xl" style="padding-bottom:calc(.5rem + env(safe-area-inset-bottom))">
    <div class="flex items-center gap-2 px-3 py-2"><span class="font-semibold">Customize overview</span><button class="btn sm ml-auto" data-reset>${icon("retry")}Reset</button><button class="btn sm primary" data-done>Done</button></div>
    ${l.order
      .map((id, i) => {
        const on = !l.hidden.includes(id);
        return `<div class="row rounded-xl border-0"><button type="button" role="switch" class="switch" aria-checked="${on}" data-act="toggle" data-id="${id}" aria-label="Show ${esc(title.get(id) ?? id)}"></button>
          <span class="flex-1 text-sm ${on ? "" : "text-ink-3"}">${esc(title.get(id) ?? id)}</span>
          <button class="btn icon sm" data-act="up" data-id="${id}" ${i === 0 ? "disabled" : ""} aria-label="Move up">${icon("up")}</button>
          <button class="btn icon sm" data-act="down" data-id="${id}" ${i === l.order.length - 1 ? "disabled" : ""} aria-label="Move down">${icon("down")}</button></div>`;
      })
      .join("")}</div>`;
}

const overview: View = {
  mount(el) {
    el.innerHTML = `
    <!-- A quiet "Edit" link like iOS lists: there when wanted, no button weight on top of the page. -->
    <div class="-mt-2 mb-1 flex justify-end">
      <button class="link-btn" data-ov-custom aria-label="Customize overview">${icon("sliders")}Edit</button>
    </div>
    <div class="grid grid-flow-row-dense grid-cols-1 gap-4 lg:grid-cols-12" id="ov-grid">
      <section class="card overview-hero relative overflow-hidden p-5 lg:col-span-5 xl:col-span-4" id="ov-hero" data-card="ov-hero">
        <div class="flex items-center justify-between gap-2"><div><span class="label">Your library</span><h2 class="mt-1 text-lg font-semibold tracking-tight">Backup progress</h2></div><span id="ov-rate" class="text-xs text-ink-3 tabular-nums"></span></div>
        <div class="mt-4 flex items-center gap-4 sm:gap-5">
          <div class="ring-box relative shrink-0">${ring(0, 148, 12)}<div class="absolute inset-0 grid place-items-center text-center"><div><div class="num text-3xl" id="ov-pct">–</div><div class="text-[11px] text-ink-3">of library</div></div></div></div>
          <div class="min-w-0 space-y-1.5" id="ov-hero-text"></div>
        </div>
        <div class="mt-4 flex flex-wrap gap-1.5" id="ov-hero-badges"></div>
        <div class="mt-4 space-y-3" id="ov-folders"></div>
      </section>

      <section class="grid grid-cols-2 gap-4 md:grid-cols-3 lg:col-span-7 xl:col-span-8" data-card="ov-kpis">
        ${tile({ id: "k-up", label: "Upload", value: "–", ic: "up", chart: "" })}
        ${tile({ id: "k-down", label: "Download", value: "–", ic: "down", chart: "" })}
        ${tile({ id: "k-today", label: "Today", value: "–", ic: "calendar", chart: "" })}
        ${tile({ id: "k-streak", label: "Streak", value: "–", ic: "flame", chart: "" })}
        ${tile({ id: "k-cpu", label: "App CPU", value: "–", ic: "cpu", chart: "" })}
        ${tile({ id: "k-mem", label: "App memory", value: "–", ic: "memory", chart: "" })}
      </section>

      <section class="card lg:col-span-12" data-card="ov-share">
        ${cardHead("Where your photos are", "chart", `<div class="seg" id="ov-share-by"><button data-by="devices">Devices</button><button data-by="folders">Folders</button></div><div class="seg ml-2" id="ov-share-metric"><button data-m="files">Files</button><button data-m="bytes">Size</button></div>`)}
        <div class="card-b" id="ov-share-body" aria-live="polite"><div class="skeleton h-44"></div></div>
      </section>

      <section class="card flex min-w-0 flex-col lg:col-span-8" data-card="ov-network">
        ${cardHead("Network", "wifi", `<span class="hidden items-center gap-3 sm:flex"><span class="flex items-center gap-1.5"><i class="size-2 rounded-full bg-s1"></i>Upload</span><span class="flex items-center gap-1.5"><i class="size-2 rounded-full bg-s2"></i>Download</span></span><div class="seg ml-2" id="ov-range">${rangeButtons("live")}</div>`)}
        <div class="card-b flex-1"><div id="ov-net" data-chart class="h-[200px] w-full sm:h-[300px]"></div></div>
      </section>

      <section class="card lg:col-span-4" data-card="ov-glance">
        ${cardHead("At a glance", "sparkles")}
        <div class="px-4 py-1" id="ov-glance"></div>
      </section>

      <section class="card lg:col-span-6 xl:col-span-4" data-card="ov-now">
        ${cardHead("Now", "cloudUp", '<a href="#/upload" class="hover:text-ink">Upload from phone ›</a>')}
        <div class="card-b" id="ov-now"></div>
        <div id="ov-jobs"></div>
      </section>

      <section class="card lg:col-span-6 xl:col-span-4" data-card="ov-recent">
        ${cardHead("Recent activity", "activity", '<a href="#/activity" class="hover:text-ink">See all ›</a>')}
        <div id="ov-recent" data-gallery></div>
      </section>

      <section class="card lg:col-span-12 xl:col-span-4" data-card="ov-times">
        ${cardHead("Upload times and sizes", "timer", '<a href="#/insights" class="hover:text-ink">Insights ›</a>')}
        <div class="card-b" id="ov-times"><div class="skeleton h-40"></div></div>
      </section>

      <section class="card lg:col-span-12" data-card="ov-year">
        ${cardHead("Uploads per day", "calendar", `<span id="ov-year-sub"></span>`)}
        <div class="card-b"><div class="scroll-thin overflow-x-auto pb-1" id="ov-year"><div class="skeleton h-28"></div></div><div class="mt-2 flex justify-end">${heatLegend()}</div></div>
      </section>
    </div>`;
    applyLayout();
    $$("[data-ov-custom]").forEach((b) => b.addEventListener("click", openCustomize));
    $("#ov-now").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-now]");
      if (b) document.getElementById(b.dataset.now === "resume" ? "btn-pause" : "btn-sync")?.click();
    });
    $("#ov-share-by").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!b) return;
      if (shareBy === b.dataset.by) return;
      shareBy = b.dataset.by as "devices" | "folders";
      void loadShare(true);
    });
    $("#ov-share-metric").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!b) return;
      if (shareMetric === b.dataset.m) return;
      shareMetric = b.dataset.m as "files" | "bytes";
      renderShare();
      animateChange(document.getElementById("ov-share-body"));
    });
    void loadShare();
    chart = new NetChart($("#ov-net"), matchMedia("(max-width: 640px)").matches ? 200 : 300);
    $("#ov-range").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-range]");
      if (!b) return;
      $$("button", $("#ov-range")).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      chart?.setRange(b.dataset.range as Range, last);
    });
    slowSynced = -1;
    void loadSlow();
    slowTimer = window.setInterval(loadSlow, 60_000);
  },
  update(s) {
    last = s;
    // New uploads: refresh the heat map and streak now instead of waiting for the minute timer.
    if (s.library.synced_files !== slowSynced && Date.now() - slowAt > 10_000) {
      if (slowSynced >= 0) void loadSlow();
      slowSynced = s.library.synced_files;
    }
    if (Date.now() - shareAt > 60_000) void loadShare(); // counts change slowly: once a minute
    else if (!kindsDrawn) renderShare();
    const lib = s.library;
    const p = pct(lib.synced_files, lib.files);
    setRing($("#ov-hero .ring-box svg"), p);
    $("#ov-pct").textContent = lib.files ? `${p >= 99.95 || p === 0 ? p.toFixed(0) : p.toFixed(1)}%` : "–";
    const left = lib.files - lib.synced_files;
    const eta = etaText(s);
    html(
      $("#ov-rate"),
      s.phase === "uploading" && s.net.up_avg > 1000
        ? `${icon("up", "inline size-3 -mt-0.5")} ${speed(s.net.up_avg)}`
        : "",
    );
    html(
      $("#ov-hero-text"),
      `<div class="num text-xl">${num(lib.synced_files)} <span class="text-sm font-normal text-ink-3">of ${num(lib.files)} files</span></div>
       <div class="text-sm text-ink-2">${bytes(lib.synced_bytes)} of ${bytes(lib.bytes)}</div>
       <div class="text-xs text-ink-3">${left ? `${bytes(lib.bytes - lib.synced_bytes)} still to back up` : "Every file is in Google Photos"}</div>`,
    );
    // Badges say only what is true right now: they appear, change and go as things happen.
    html(
      $("#ov-hero-badges"),
      [
        left
          ? badge(
              `${num(left)} to go`,
              s.phase === "uploading" ? "info" : s.paused ? "warn" : "",
              "hourglass",
              s.paused ? "Waiting until uploads resume" : "Waiting for upload",
            )
          : badge("All backed up", "good", "ok"),
        eta ? badge(`~${eta} left`, "info", "clock", "At the current upload speed") : "",
        s.copies_pending
          ? badge(
              `${num(s.copies_pending)} copies to go`,
              "",
              "copy",
              "Waiting for your other Google accounts",
            )
          : "",
        s.counts.failed
          ? `<a href="#/activity/failed">${badge(`${num(s.counts.failed)} failed`, "bad", "error")}</a>`
          : "",
        s.counts.gave_up
          ? badge(`${num(s.counts.gave_up)} gave up`, "bad", "warn", "Failed 5 times; retry from Activity")
          : "",
      ].join(""),
    );
    html(
      $("#ov-folders"),
      Object.entries(s.folders)
        .filter(([, f]) => f.account && f.files)
        .map(([name, f]) => {
          const fp = pct(f.synced_files, f.files);
          return `<div><div class="mb-1 flex items-center justify-between text-xs"><a class="flex items-center gap-1.5 font-medium hover:underline" href="#/folders/f/${encodeURIComponent(name)}">${icon("folder", "size-3.5 text-ink-3")}${esc(name)}</a><span class="text-ink-3 tabular-nums">${num(f.synced_files)} / ${num(f.files)}</span></div><div class="bar"><i style="width:${fp}%"></i></div></div>`;
        })
        .join(""),
    );

    const r = s.resources;
    const setTile = (id: string, v: string, sub: string, chartSvg?: string) => {
      const t = $(id);
      html($("[data-v]", t), v);
      html($("[data-s]", t), sub);
      if (chartSvg !== undefined) html($("[data-c]", t), chartSvg);
    };
    const peak = (a: number[]) => Math.max(0, ...a);
    setTile(
      "#k-up",
      speed(s.net.up_now),
      `Peak ${speed(peak(s.net.up))} · sent ${bytes(s.net.sent)}`,
      sparkline(s.net.up, "var(--s1)"),
    );
    setTile(
      "#k-down",
      speed(s.net.down_now),
      `Peak ${speed(peak(s.net.down))} · received ${bytes(s.net.received)}`,
      sparkline(s.net.down, "var(--s2)"),
    );
    setTile(
      "#k-cpu",
      `${r.cpu_now.toFixed(1)}%`,
      `of 1 core · ${r.cores} cores here`,
      sparkline(r.cpu, "var(--s1)"),
    );
    setTile(
      "#k-mem",
      bytes(r.mem_now),
      r.mem_limit ? `${pct(r.mem_now, r.mem_limit).toFixed(1)}% of ${bytes(r.mem_limit)}` : "",
      sparkline(r.mem, "var(--s1)"),
    );
    chart?.update(s);

    const lat = r.latency_now;
    const latTone = lat == null ? "bad" : lat < 150 ? "good" : lat < 400 ? "warn" : "bad";
    const glance: [string, string, string][] = [
      [
        "users",
        "Google accounts",
        s.accounts.length
          ? s.login_failed.length
            ? badge(`${s.login_failed.length} rejected`, "bad", "warn")
            : badge(`${s.accounts.length} connected`, "good", "ok")
          : `<a href="#/settings/accounts">${badge("Connect one", "warn", "key")}</a>`,
      ],
      [
        "zap",
        "Google response",
        lat == null
          ? badge("Unreachable", "bad", "cloudOff")
          : `<span class="text-ink-2 tabular-nums">${Math.round(lat)} ms</span> ${badge(latTone === "good" ? "Fast" : latTone === "warn" ? "OK" : "Slow", latTone)}`,
      ],
      [
        "error",
        "Failed files",
        s.counts.failed
          ? `<a href="#/activity/failed">${badge(num(s.counts.failed), "bad")}</a>`
          : `<span class="text-ink-2">None</span>`,
      ],
      ["search", "Last scan", `<span class="text-ink-2">${ago(s.last_scan, s.now)}</span>`],
      [
        "clock",
        "Upload hours",
        s.schedule.enabled
          ? badge(
              `${String(s.schedule.start).padStart(2, "0")}–${String(s.schedule.end).padStart(2, "0")}`,
              s.schedule.allowed ? "good" : "warn",
            )
          : `<span class="text-ink-2">Any time</span>`,
      ],
      [
        "gauge",
        "Speed limit",
        s.speed_limit_mbps
          ? badge(`${s.speed_limit_mbps} Mbps`, "info")
          : `<span class="text-ink-2">No limit</span>`,
      ],
      [
        "cloudUp",
        "This session",
        `<span class="text-ink-2 tabular-nums">${num(s.session.uploaded_files)} · ${bytes(s.session.uploaded_bytes)}</span>`,
      ],
      [
        "database",
        "Statistics",
        `<span class="truncate text-ink-2">${esc(s.stats_engine.split(" (")[0])}</span>`,
      ],
    ];
    html(
      $("#ov-glance"),
      glance
        .map(
          ([ic, l, v]) =>
            `<div class="kv"><span class="flex items-center gap-2">${icon(ic as "users", "size-4")}${l}</span><span class="flex items-center gap-1.5">${v}</span></div>`,
        )
        .join(""),
    );

    const c = s.current;
    html(
      $("#ov-now"),
      c
        ? `<div class="flex items-center gap-3">${thumb(c.name, "thumb size-14")}
             <div class="min-w-0 flex-1"><div class="truncate font-medium" title="${esc(c.name)}">${esc(fileName(c.name))}</div>
             <div class="mt-1 flex flex-wrap gap-1">${badge(c.kind === "video" ? "Video" : "Photo", "", c.kind === "video" ? "video" : "photo")}${stepBadge(c)}</div></div></div>
           <div class="bar active mt-3"><i style="width:${pct(c.bytes_done, c.bytes_total)}%"></i></div>
           <div class="mt-1.5 flex justify-between text-xs text-ink-3 tabular-nums"><span>${bytes(c.bytes_done)} of ${bytes(c.bytes_total)}</span><span>${speed(s.net.up_now)}</span></div>
           ${s.total ? `<div class="mt-3 text-xs text-ink-3">File ${num(s.done + 1)} of ${num(s.total)} this round</div>` : ""}
           ${upNext(s, c.name)}`
        : `<div class="flex items-center gap-3"><span class="grid size-12 shrink-0 place-items-center rounded-xl bg-panel-2 ${s.phase === "paused" ? "text-warn" : s.phase === "scanning" ? "text-accent" : "text-ink-3"}">${icon(phaseInfo(s).icon, `size-6 ${s.phase === "scanning" ? "spin" : ""}`)}</span>
             <div class="min-w-0 flex-1"><div class="font-medium">${esc(nowTitle(s))}</div><div class="truncate text-xs text-ink-3">${esc(phaseInfo(s).detail)}</div></div>${nowAction(s)}</div>
           <div class="mt-4 grid grid-cols-3 gap-2 text-center">
             <div class="stat-tile"><div class="num text-lg">${num(s.counts.uploaded)}</div><div class="text-[11px] text-ink-3">Uploaded</div></div>
             <div class="stat-tile"><div class="num text-lg">${num(s.counts.exists)}</div><div class="text-[11px] text-ink-3">Already there</div></div>
             <div class="stat-tile"><div class="num text-lg">${num(left)}</div><div class="text-[11px] text-ink-3">Waiting</div></div>
           </div>${upNext(s, "")}`,
    );
    html($("#ov-jobs"), jobsList(s));

    html(
      $("#ov-recent"),
      s.log.length
        ? s.log
            .slice(0, 6)
            .map((l) => {
              const m = eventMeta[l.kind] ?? eventMeta.info!;
              const lead = l.name
                ? thumb(l.name)
                : `<span class="thumb grid place-items-center text-ink-3">${icon(m.icon, "size-4")}</span>`;
              return `<div class="row ${l.name ? "clickable" : ""}" ${l.name ? openAttrs(l.name, true) : ""}>${lead}<div class="min-w-0 flex-1"><div class="truncate text-sm">${esc(l.name ? fileName(l.name) : l.text)}</div><div class="text-xs text-ink-3">${clock(l.time)}</div></div>${badge(m.label, m.tone)}</div>`;
            })
            .join("")
        : `<div class="empty">${icon("inbox")}No activity yet</div>`,
    );
  },
  unmount() {
    clearInterval(slowTimer);
    shareRequest++;
    chart = null;
    document.getElementById("ov-sheet")?.remove();
  },
};

export default overview;
