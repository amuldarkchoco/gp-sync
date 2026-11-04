import { get, tz, type History, type Insights, type Status } from "../lib/api";
import { heatLegend, heatmap, ring, sparkline } from "../lib/charts";
import { $, $$, esc, html } from "../lib/dom";
import { ago, bytes, clock, duration, fileName, ms, num, pct, speed } from "../lib/format";
import { icon } from "../lib/icons";
import { NetChart, rangeButtons, type Range } from "../lib/netchart";
import { badge, cardHead, etaText, eventMeta, openAttrs, phaseInfo, thumb, tile } from "../lib/ui";
import type { View } from "./view";

let chart: NetChart | null = null;
let hist: History | null = null;
let ins: Insights | null = null;
let slowTimer = 0;
let last: Status | null = null;

function streak(h: History): number {
  const byDay = new Map(h.data.map((d) => [d.day, d.photos + d.videos + d.existing]));
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
  html($("[data-s]", k), `${active} active days this year`);
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
  subtitle: "Everything at a glance",
  mount(el) {
    el.innerHTML = `
    <div class="mb-3 flex items-center justify-end gap-2"><button class="btn sm" id="ov-custom">${icon("settings")}Customize</button></div>
    <div class="grid grid-flow-row-dense grid-cols-1 gap-4 lg:grid-cols-12" id="ov-grid">
      <section class="card relative overflow-hidden p-5 lg:col-span-5 xl:col-span-4" id="ov-hero" data-card="ov-hero">
        <div class="pointer-events-none absolute -top-20 -right-20 size-64 rounded-full blur-3xl" style="background:radial-gradient(circle,var(--glow-1),transparent 70%)"></div>
        <div class="flex items-center justify-between gap-2"><span class="label">Backed up</span><span id="ov-rate" class="text-xs text-ink-3 tabular-nums"></span></div>
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
    $("#ov-custom").addEventListener("click", openCustomize);
    $("#ov-now").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-now]");
      if (b) document.getElementById(b.dataset.now === "resume" ? "btn-pause" : "btn-sync")?.click();
    });
    chart = new NetChart($("#ov-net"), matchMedia("(max-width: 640px)").matches ? 200 : 300);
    $("#ov-range").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-range]");
      if (!b) return;
      $$("button", $("#ov-range")).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      chart?.setRange(b.dataset.range as Range, last);
    });
    void loadSlow();
    slowTimer = window.setInterval(loadSlow, 60_000);
  },
  update(s) {
    last = s;
    const lib = s.library;
    const p = pct(lib.synced_files, lib.files);
    $("#ov-hero circle:last-of-type").setAttribute(
      "stroke-dashoffset",
      String(2 * Math.PI * ((148 - 12) / 2) * (1 - p / 100)),
    );
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
          return `<div><div class="mb-1 flex items-center justify-between text-xs"><span class="flex items-center gap-1.5 font-medium">${icon("folder", "size-3.5 text-ink-3")}${esc(name)}</span><span class="text-ink-3 tabular-nums">${num(f.synced_files)} / ${num(f.files)}</span></div><div class="bar"><i style="width:${fp}%"></i></div></div>`;
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
    chart = null;
    document.getElementById("ov-sheet")?.remove();
  },
};

export default overview;
