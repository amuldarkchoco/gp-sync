import { get, tz, type History, type Metrics, type Status } from "../lib/api";
import { areaChart, columns, sparkline } from "../lib/charts";
import { $, $$, html } from "../lib/dom";
import { bytes, clock, date, num, speed } from "../lib/format";
import { NetChart, rangeButtons, type Range } from "../lib/netchart";
import { badge, cardHead, tile } from "../lib/ui";
import type { View } from "./view";

let chart: NetChart | null = null;
let last: Status | null = null;
let hist: History | null = null;
let timer = 0;

function gauge(value: number, max: number, color: string): string {
  // Half-circle gauge, scale grows to the best value seen so it stays readable.
  const p = Math.max(0, Math.min(1, max ? value / max : 0));
  const r = 52;
  const len = Math.PI * r;
  return `<svg viewBox="0 0 120 68" class="w-full max-w-[180px]" aria-hidden="true">
    <path d="M8,62 A${r},${r} 0 0 1 112,62" fill="none" stroke="var(--panel-2)" stroke-width="10" stroke-linecap="round"/>
    <path d="M8,62 A${r},${r} 0 0 1 112,62" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${len}" stroke-dashoffset="${len * (1 - p)}" style="transition:stroke-dashoffset .5s"/>
  </svg>`;
}

async function loadSlow(): Promise<void> {
  const [h, lat] = await Promise.all([
    get<History>(`history?days=30&tz=${tz}`),
    get<Metrics>("metrics?hours=24"),
  ]);
  hist = h;
  if (!document.getElementById("n-usage")) return;
  const sum = (days: number, k: "net_sent" | "net_received") => {
    const from = new Date(h.today + "T00:00:00");
    from.setDate(from.getDate() - days + 1);
    const key = from.toLocaleDateString("sv");
    return h.data.filter((d) => d.day >= key).reduce((a, d) => a + d[k], 0);
  };
  const rows: [string, number, number][] = [
    ["Today", sum(1, "net_sent"), sum(1, "net_received")],
    ["Last 7 days", sum(7, "net_sent"), sum(7, "net_received")],
    ["Last 30 days", sum(30, "net_sent"), sum(30, "net_received")],
  ];
  const max = Math.max(1, ...rows.flatMap((r) => [r[1], r[2]]));
  html(
    $("#n-usage"),
    rows
      .map(
        ([l, s, r]) => `<div class="py-2.5"><div class="mb-1.5 text-sm font-medium">${l}</div>
        <div class="flex items-center gap-2 text-xs"><span class="w-16 text-ink-3">Sent</span><div class="bar h-1.5 flex-1"><i style="width:${(s / max) * 100}%;background:var(--s1)"></i></div><span class="w-20 text-right tabular-nums">${bytes(s)}</span></div>
        <div class="mt-1 flex items-center gap-2 text-xs"><span class="w-16 text-ink-3">Received</span><div class="bar h-1.5 flex-1"><i style="width:${(r / max) * 100}%;background:var(--s2)"></i></div><span class="w-20 text-right tabular-nums">${bytes(r)}</span></div></div>`,
      )
      .join(""),
  );
  const days = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(h.today + "T00:00:00");
    d.setDate(d.getDate() - 29 + i);
    const key = d.toLocaleDateString("sv");
    return { d, row: h.data.find((x) => x.day === key) };
  });
  html(
    $("#n-daily"),
    columns(
      days.map((x) => x.row?.net_sent ?? 0),
      days.map((x) => date(x.d.getTime() / 1000)),
      {
        tip: (v, i) =>
          `${days[i]!.d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}\nSent ${bytes(v)}\nPeak upload ${speed(days[i]!.row?.peak_up ?? 0)}`,
        every: 7,
        height: 160,
      },
    ),
  );
  areaChart($("#n-lat"), {
    series: [{ name: "Response", color: "var(--s3)", values: lat.points.map((p) => p.latency) }],
    times: lat.points.map((p) => p.time),
    timeFormat: clock,
    format: (v) => `${Math.round(v)} ms`,
    height: 200,
    zoomable: true,
    empty: "Response times build up over the next hour",
  });
}

const network: View = {
  subtitle: "Live speed, Google response time and data used",
  mount(el) {
    el.innerHTML = `
    <div class="grid grid-cols-2 gap-4 xl:grid-cols-4">
      <div class="card flex flex-col items-center p-4 text-center" id="n-up"></div>
      <div class="card flex flex-col items-center p-4 text-center" id="n-down"></div>
      ${tile({ id: "n-latency", label: "Google response", value: "–", ic: "zap", chart: "" })}
      ${tile({ id: "n-total", label: "Since start", value: "–", ic: "layers", chart: "" })}
    </div>
    <div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-12">
      <section class="card lg:col-span-12">
        ${cardHead("Upload and download", "wifi", `<span class="hidden items-center gap-3 sm:flex"><span class="flex items-center gap-1.5"><i class="size-2 rounded-full bg-s1"></i>Upload</span><span class="flex items-center gap-1.5"><i class="size-2 rounded-full bg-s2"></i>Download</span></span><div class="seg ml-2" id="n-range">${rangeButtons("live")}</div>`)}
        <div class="card-b"><div id="n-chart" data-chart class="h-[340px] w-full"></div></div>
      </section>
      <section class="card lg:col-span-8">${cardHead("Google response time", "zap", "Last 24 h · connection to photos.googleapis.com")}<div class="card-b"><div id="n-lat" data-chart class="h-[200px] w-full"></div></div></section>
      <section class="card lg:col-span-4">${cardHead("Data used", "database")}<div class="px-4 py-1 [&>*]:border-b [&>*]:border-line [&>*:last-child]:border-0" id="n-usage"><div class="skeleton my-3 h-32"></div></div></section>
      <section class="card lg:col-span-12">${cardHead("Sent per day", "chart", "Last 30 days")}<div class="card-b" id="n-daily"><div class="skeleton h-40"></div></div></section>
    </div>`;
    chart = new NetChart($("#n-chart"), 340);
    $("#n-range").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-range]");
      if (!b) return;
      $$("button", $("#n-range")).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      chart?.setRange(b.dataset.range as Range, last);
    });
    void loadSlow();
    timer = window.setInterval(loadSlow, 60_000);
  },
  update(s) {
    last = s;
    chart?.update(s);
    const best = (a: number[], floor: number) => Math.max(floor, ...a) * 1.15;
    const g = (id: string, label: string, now: number, arr: number[], color: string, extra: string) =>
      html(
        $(id),
        `<div class="label self-start">${label}</div>${gauge(now, best(arr, 125_000), color)}<div class="num mt-1 text-2xl">${speed(now)}</div><div class="mt-1 text-xs text-ink-3">${extra}</div>`,
      );
    const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    g(
      "#n-up",
      "Upload",
      s.net.up_now,
      s.net.up,
      "var(--s1)",
      `avg ${speed(avg(s.net.up))} · peak ${speed(Math.max(0, ...s.net.up))}`,
    );
    g(
      "#n-down",
      "Download",
      s.net.down_now,
      s.net.down,
      "var(--s2)",
      `avg ${speed(avg(s.net.down))} · peak ${speed(Math.max(0, ...s.net.down))}`,
    );
    const r = s.resources;
    const lat = r.latency_now;
    const tone = lat == null ? "bad" : lat < 150 ? "good" : lat < 400 ? "warn" : "bad";
    const t = $("#n-latency");
    html($("[data-v]", t), lat == null ? "Unreachable" : `${Math.round(lat)} ms`);
    html(
      $("[data-s]", t),
      `${badge(lat == null ? "Offline" : tone === "good" ? "Fast" : tone === "warn" ? "OK" : "Slow", tone)} ${r.latency_avg ? `avg ${Math.round(r.latency_avg)} ms` : ""}`,
    );
    html(
      $("[data-c]", t),
      sparkline(
        r.latency.map((x) => x.ms ?? 0),
        "var(--s3)",
      ),
    );
    const tt = $("#n-total");
    html($("[data-v]", tt), bytes(s.net.sent));
    html($("[data-s]", tt), `sent · ${bytes(s.net.received)} received`);
    const today = hist?.data.find((d) => d.day === hist?.today);
    html(
      $("[data-c]", tt),
      today
        ? `<div class="text-xs text-ink-3">Today: ${bytes(today.net_sent)} sent · ${num(today.photos + today.videos)} files</div>`
        : "",
    );
  },
  unmount() {
    clearInterval(timer);
    chart = null;
  },
};

export default network;
