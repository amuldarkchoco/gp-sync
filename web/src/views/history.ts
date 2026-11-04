import { get, tz, type Day, type History, type Totals } from "../lib/api";
import { heatLegend, heatmap } from "../lib/charts";
import { $, $$, esc, html } from "../lib/dom";
import { bytes, date, duration, num } from "../lib/format";
import { icon } from "../lib/icons";
import { cardHead, tile } from "../lib/ui";
import type { View } from "./view";

let hist: History | null = null;
let metric: "files" | "data" = "files";
let span = 30;

function dayKey(d: Date): string {
  return d.toLocaleDateString("sv");
}

function lastDays(n: number): { key: string; date: Date; row: Day | undefined }[] {
  const by = new Map(hist?.data.map((d) => [d.day, d]));
  const end = new Date((hist?.today ?? dayKey(new Date())) + "T00:00:00");
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(end);
    d.setDate(d.getDate() - (n - 1 - i));
    return { key: dayKey(d), date: d, row: by.get(dayKey(d)) };
  });
}

const val = (r: Day | undefined) =>
  metric === "files" ? (r?.photos ?? 0) + (r?.videos ?? 0) : (r?.photo_bytes ?? 0) + (r?.video_bytes ?? 0);

function renderYear(): void {
  const days = lastDays(365).map(({ key, date: d, row }) => ({
    day: key,
    value: val(row),
    tip: `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" })}\n${row && row.photos + row.videos ? `${row.photos} photos, ${row.videos} videos · ${bytes(row.photo_bytes + row.video_bytes)}` : "Nothing uploaded"}`,
  }));
  html($("#h-year"), heatmap(days, { cell: 14, gap: 3 }));
}

function renderDaily(): void {
  const rows = lastDays(span);
  const max = Math.max(1, ...rows.map((r) => val(r.row)));
  const fmt = (v: number) => (metric === "files" ? num(v) : bytes(v));
  const every = span <= 31 ? 5 : 15;
  html(
    $("#h-daily"),
    `<div class="cols flex h-56 items-end gap-[3px]">${rows
      .map(({ date: d, row }) => {
        const p = metric === "files" ? (row?.photos ?? 0) : (row?.photo_bytes ?? 0);
        const v = metric === "files" ? (row?.videos ?? 0) : (row?.video_bytes ?? 0);
        const tip = `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}\nPhotos: ${fmt(p)}\nVideos: ${fmt(v)}`;
        return `<div class="col flex h-full flex-1 flex-col justify-end gap-[2px]" data-tip="${esc(tip)}">
          ${v ? `<div class="col-bar rounded-t-[4px] bg-s2" style="height:${(v / max) * 100}%"></div>` : ""}
          ${p ? `<div class="col-bar ${v ? "" : "rounded-t-[4px]"} bg-s1" style="height:${(p / max) * 100}%"></div>` : ""}
          ${p || v ? "" : `<div class="h-[2px] rounded bg-panel-2"></div>`}</div>`;
      })
      .join("")}</div>
    <div class="mt-1.5 flex gap-[2px] text-[10px] text-ink-3">${rows
      .map(
        (r, i) =>
          `<div class="flex-1 text-center whitespace-nowrap">${(rows.length - 1 - i) % every === 0 ? esc(date(r.date.getTime() / 1000)) : ""}</div>`,
      )
      .join("")}</div>`,
  );
}

function renderMonths(): void {
  const months = new Map<string, { p: number; v: number; b: number; e: number; s: number; r: number }>();
  for (const d of hist?.data ?? []) {
    const k = d.day.slice(0, 7);
    const m = months.get(k) ?? { p: 0, v: 0, b: 0, e: 0, s: 0, r: 0 };
    m.p += d.photos;
    m.v += d.videos;
    m.b += d.photo_bytes + d.video_bytes;
    m.e += d.existing;
    m.s += d.net_sent;
    m.r += d.net_received;
    months.set(k, m);
  }
  const rows = [...months.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  html(
    $("#h-months"),
    rows.length
      ? `<table class="w-full text-sm"><thead class="text-left text-xs text-ink-3"><tr class="border-b border-line">
          <th class="px-4 py-2 font-medium">Month</th><th class="px-4 py-2 text-right font-medium">Photos</th><th class="px-4 py-2 text-right font-medium">Videos</th><th class="hidden px-4 py-2 text-right font-medium sm:table-cell">Already there</th><th class="px-4 py-2 text-right font-medium">Uploaded</th><th class="hidden px-4 py-2 text-right font-medium md:table-cell">Network sent</th><th class="hidden px-4 py-2 text-right font-medium md:table-cell">Received</th></tr></thead>
          <tbody>${rows
            .map(
              ([k, m]) =>
                `<tr class="border-b border-line last:border-0"><td class="px-4 py-2">${new Date(k + "-01T00:00:00").toLocaleDateString([], { month: "long", year: "numeric" })}</td><td class="px-4 py-2 text-right tabular-nums">${num(m.p)}</td><td class="px-4 py-2 text-right tabular-nums">${num(m.v)}</td><td class="hidden px-4 py-2 text-right tabular-nums sm:table-cell">${num(m.e)}</td><td class="px-4 py-2 text-right tabular-nums">${bytes(m.b)}</td><td class="hidden px-4 py-2 text-right tabular-nums md:table-cell">${bytes(m.s)}</td><td class="hidden px-4 py-2 text-right tabular-nums md:table-cell">${bytes(m.r)}</td></tr>`,
            )
            .join("")}</tbody></table>`
      : `<div class="empty">${icon("calendar")}No history yet</div>`,
  );
}

function renderTotals(t: Totals): void {
  const best = (hist?.data ?? []).reduce<Day | null>(
    (a, d) => (!a || d.photos + d.videos > a.photos + a.videos ? d : a),
    null,
  );
  const tiles = [
    tile({ label: "Photos", value: num(t.photos), ic: "photo", sub: bytes(t.photo_bytes) }),
    tile({ label: "Videos", value: num(t.videos), ic: "video", sub: bytes(t.video_bytes) }),
    tile({
      label: "Already in Google",
      value: num(t.existing),
      ic: "verified",
      sub: "Found, not uploaded again",
    }),
    tile({
      label: "Upload time",
      value: duration((t.photo_ms + t.video_ms) / 1000),
      ic: "timer",
      sub: "Time spent sending files",
    }),
    tile({
      label: "Best day",
      value: best ? num(best.photos + best.videos) : "–",
      ic: "trend",
      sub: best
        ? new Date(best.day + "T00:00:00").toLocaleDateString([], {
            day: "numeric",
            month: "short",
            year: "numeric",
          })
        : "",
    }),
    tile({
      label: "Since",
      value: t.since ? date(t.since, true) : "–",
      ic: "history",
      sub: `${bytes(t.net_sent)} sent in total`,
    }),
  ];
  html($("#h-tiles"), tiles.join(""));
}

const historyView: View = {
  subtitle: "What was backed up, day by day",
  mount(el) {
    el.innerHTML = `
    <div class="grid grid-cols-2 gap-4 md:grid-cols-3 2xl:grid-cols-6" id="h-tiles">${'<div class="card skeleton h-28"></div>'.repeat(6)}</div>
    <div class="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-12">
      <section class="card xl:col-span-12">
        ${cardHead("Last 12 months", "calendar", `<div class="seg" id="h-metric"><button data-m="files" aria-pressed="true">Files</button><button data-m="data" aria-pressed="false">Data</button></div>`)}
        <div class="card-b"><div class="scroll-thin overflow-x-auto pb-1" id="h-year"><div class="skeleton h-32"></div></div><div class="mt-2 flex justify-end">${heatLegend()}</div></div>
      </section>
      <section class="card xl:col-span-12">
        ${cardHead("Per day", "chart", `<span class="hidden items-center gap-3 sm:flex"><span class="flex items-center gap-1.5"><i class="size-2 rounded-full bg-s1"></i>Photos</span><span class="flex items-center gap-1.5"><i class="size-2 rounded-full bg-s2"></i>Videos</span></span><div class="seg ml-2" id="h-span"><button data-d="30" aria-pressed="true">30 d</button><button data-d="90" aria-pressed="false">90 d</button></div>`)}
        <div class="card-b" id="h-daily"><div class="skeleton h-56"></div></div>
      </section>
      <section class="card overflow-x-auto xl:col-span-12">${cardHead("Per month", "layers")}<div id="h-months"></div></section>
    </div>`;
    const seg = (id: string, fn: (b: HTMLButtonElement) => void) =>
      $(id).addEventListener("click", (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
        if (!b) return;
        $$("button", $(id)).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        fn(b);
      });
    seg("#h-metric", (b) => {
      metric = b.dataset.m as "files" | "data";
      renderYear();
      renderDaily();
    });
    seg("#h-span", (b) => {
      span = Number(b.dataset.d);
      renderDaily();
    });
    void Promise.all([get<History>(`history?days=371&tz=${tz}`), get<Totals>("totals")]).then(([h, t]) => {
      hist = h;
      renderTotals(t);
      renderYear();
      renderDaily();
      renderMonths();
    });
  },
};

export default historyView;
