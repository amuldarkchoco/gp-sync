// Hand-made SVG charts: crisp at any size, redrawn on resize, with hover tooltips.
// Colors come from CSS variables (--s1 blue, --s2 orange, --s3 aqua), validated for
// color-blind readers; text always uses ink colors, never the series color.

import { esc } from "./dom";
import { icon } from "./icons";

export interface Series {
  name: string;
  color: string; // CSS color, e.g. "var(--s1)"
  values: (number | null)[];
}

export interface AreaOptions {
  series: Series[];
  times?: number[]; // unix seconds for each point (x labels and tooltip)
  format: (v: number) => string;
  height?: number;
  yMax?: number;
  timeFormat?: (unix: number) => string;
  empty?: string;
  zoomable?: boolean; // drag across the chart to zoom in, double-click (or the button) to zoom out
  animate?: boolean; // draw the lines in when first shown (default true)
}

type ChartEl = HTMLElement & {
  _opts?: AreaOptions;
  _zoom?: [number, number] | null;
  _drag?: number | null;
  _drawn?: boolean;
  _view?: { start: number; n: number; max: number; ih: number; w: number };
};

const PAD = { top: 14, right: 14, bottom: 24, left: 58 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Smooth line through points that never overshoots (monotone cubic, Fritsch–Carlson). */
export function smoothPath(pts: [number, number][]): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n < 3) return pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1]![0] - pts[i]![0]);
    m.push((pts[i + 1]![1] - pts[i]![1]) / (dx[i] || 1));
  }
  const t: number[] = [m[0]!];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2);
  t.push(m[n - 2]!);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i]! / m[i]!;
    const b = t[i + 1]! / m[i]!;
    const h = a * a + b * b;
    if (h > 9) {
      const k = 3 / Math.sqrt(h);
      t[i] = k * a * m[i]!;
      t[i + 1] = k * b * m[i]!;
    }
  }
  let d = `M${pts[0]![0].toFixed(1)},${pts[0]![1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    const h = dx[i]! / 3;
    d += `C${(x0 + h).toFixed(1)},${(y0 + t[i]! * h).toFixed(1)} ${(x1 - h).toFixed(1)},${(y1 - t[i + 1]! * h).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}

const observers = new WeakMap<Element, ResizeObserver>();

/** Smooth line + soft area chart with a crosshair tooltip. Redraws itself when the box changes size. */
export function areaChart(el: HTMLElement, opts: AreaOptions): void {
  const c = el as ChartEl;
  const firstOpts = !c._opts;
  if (
    c._opts &&
    (c._opts.times?.[0] !== opts.times?.[0] || c._opts.zoomable !== opts.zoomable) &&
    !opts.zoomable
  )
    c._zoom = null;
  c._opts = opts;
  if (!observers.has(el)) {
    let lastW = 0;
    const ro = new ResizeObserver(() => {
      if (Math.abs(el.clientWidth - lastW) > 1) {
        lastW = el.clientWidth;
        drawArea(c);
      }
    });
    ro.observe(el);
    observers.set(el, ro);
    el.style.position = "relative";
    el.style.touchAction = "pan-y";
    el.addEventListener("pointermove", (e) => hoverArea(c, e));
    el.addEventListener("pointerleave", () => {
      hideCrosshair(c);
      c._drag = null;
      el.querySelector(".zoom-sel")?.remove();
    });
    el.addEventListener("pointerdown", (e) => {
      if (!c._opts?.zoomable || e.button !== 0 || (e.target as Element).closest("button")) return;
      c._drag = e.clientX - el.getBoundingClientRect().left;
    });
    el.addEventListener("pointerup", (e) => {
      if (c._drag == null || !c._view) return;
      const x0 = c._drag;
      const x1 = e.clientX - el.getBoundingClientRect().left;
      c._drag = null;
      el.querySelector(".zoom-sel")?.remove();
      if (Math.abs(x1 - x0) < 12) return;
      const { start, n, w } = c._view;
      const iw = w - PAD.left - PAD.right;
      const idx = (x: number) =>
        start + Math.max(0, Math.min(n - 1, Math.round(((x - PAD.left) / iw) * (n - 1))));
      const a = idx(Math.min(x0, x1));
      const b = idx(Math.max(x0, x1));
      if (b - a >= 2) {
        c._zoom = [a, b];
        drawArea(c);
      }
    });
    el.addEventListener("dblclick", () => {
      if (c._zoom) {
        c._zoom = null;
        drawArea(c);
      }
    });
    el.addEventListener("click", (e) => {
      if ((e.target as Element).closest("[data-unzoom]")) {
        c._zoom = null;
        drawArea(c);
      }
    });
  }
  if (firstOpts) c._drawn = false;
  drawArea(c);
}

function drawArea(c: ChartEl): void {
  const opts = c._opts;
  if (!opts) return;
  const W = Math.max(c.clientWidth, 120);
  const H = opts.height ?? (c.clientHeight || 220);
  const total = Math.max(...opts.series.map((s) => s.values.length), 0);
  const [start, stop] = c._zoom && c._zoom[1] < total ? c._zoom : [0, total - 1];
  const series = opts.series.map((s) => ({ ...s, values: s.values.slice(start, stop + 1) }));
  const times = opts.times?.slice(start, stop + 1);
  const n = stop - start + 1;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  if (n < 2 || !all.length) {
    c.innerHTML = `<div class="empty h-full" style="min-height:${H}px">${icon("chart")}${esc(opts.empty ?? "No data yet")}</div>`;
    return;
  }
  const max = niceMax(opts.yMax ?? Math.max(...all));
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (i / (n - 1)) * iw;
  const y = (v: number) => PAD.top + ih - (Math.min(v, max) / max) * ih;
  const animate = opts.animate !== false && !c._drawn;
  let svg = `<svg width="${W}" height="${H}" class="block overflow-visible select-none" role="img">`;
  for (let g = 0; g <= 4; g++) {
    const v = (max * g) / 4;
    const yy = Math.round(y(v)) + 0.5;
    svg += `<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${yy}" y2="${yy}" stroke="var(--line)" ${g ? 'stroke-dasharray="2 5"' : ""}/>`;
    svg += `<text x="${PAD.left - 10}" y="${yy + 4}" text-anchor="end" font-size="11" fill="var(--ink-3)" class="tabular-nums">${esc(opts.format(v))}</text>`;
  }
  if (times && opts.timeFormat) {
    const ticks = Math.max(2, Math.min(7, Math.floor(iw / 95)));
    for (let t = 0; t < ticks; t++) {
      const i = Math.round((t / (ticks - 1)) * (n - 1));
      const anchor = t === 0 ? "start" : t === ticks - 1 ? "end" : "middle";
      svg += `<text x="${x(i)}" y="${H - 6}" text-anchor="${anchor}" font-size="11" fill="var(--ink-3)">${esc(opts.timeFormat(times[i] ?? 0))}</text>`;
    }
  }
  series.forEach((s, si) => {
    // Split at gaps (null) so missing data isn't drawn as a line.
    const segs: [number, number][][] = [];
    let cur: [number, number][] = [];
    s.values.forEach((v, i) => {
      if (v == null) {
        if (cur.length) segs.push(cur);
        cur = [];
      } else cur.push([x(i), y(v)]);
    });
    if (cur.length) segs.push(cur);
    const id = `g${Math.random().toString(36).slice(2, 8)}`;
    svg += `<defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${s.color}" stop-opacity="${si ? 0.22 : 0.38}"/><stop offset="0.55" stop-color="${s.color}" stop-opacity="${si ? 0.07 : 0.12}"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient></defs>`;
    for (const seg of segs) {
      const d = smoothPath(seg);
      const first = seg[0]!;
      const last = seg[seg.length - 1]!;
      const len = Math.round(iw * 3);
      svg += `<path class="chart-area ${animate ? "draw" : ""}" d="${d}L${last[0]},${y(0)}L${first[0]},${y(0)}Z" fill="url(#${id})"/>`;
      svg += `<path class="chart-line ${animate ? "draw" : ""}" style="color:${s.color};--len:${len}" d="${d}" fill="none" stroke="${s.color}" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    // Latest value: a small glowing dot at the end of the line.
    const lastSeg = segs[segs.length - 1];
    const end = lastSeg?.[lastSeg.length - 1];
    if (end && !c._zoom) {
      svg += `<circle cx="${end[0]}" cy="${end[1]}" r="7" fill="${s.color}" opacity="0.18"/><circle cx="${end[0]}" cy="${end[1]}" r="3.5" fill="${s.color}" stroke="var(--surface)" stroke-width="1.5"/>`;
    }
  });
  svg += `<g class="xh" style="display:none"><line y1="${PAD.top}" y2="${PAD.top + ih}" stroke="var(--ink-3)" stroke-opacity="0.6" stroke-dasharray="3 3"/>`;
  series.forEach((s) => {
    svg += `<circle r="5" fill="${s.color}" stroke="var(--surface)" stroke-width="2.5"/>`;
  });
  svg += `</g></svg>`;
  if (c._zoom) {
    svg += `<button data-unzoom class="btn sm absolute top-1 right-1 shadow-lg">${icon("x", "size-3.5")}Zoom out</button>`;
  } else if (opts.zoomable) {
    svg += `<span class="pointer-events-none absolute top-0 right-1 hidden text-[10px] text-ink-3 lg:block">Drag to zoom</span>`;
  }
  c.innerHTML = svg;
  c._drawn = true;
  c._view = { start, n, max, ih, w: W };
}

function hoverArea(c: ChartEl, e: PointerEvent): void {
  const opts = c._opts;
  const v = c._view;
  const g = c.querySelector<SVGGElement>(".xh");
  if (!opts || !g || !v) return;
  const iw = v.w - PAD.left - PAD.right;
  const rect = c.getBoundingClientRect();
  const px = e.clientX - rect.left;
  if (c._drag != null) {
    // Show the range being selected for zooming.
    let sel = c.querySelector<SVGRectElement>(".zoom-sel");
    const svg = c.querySelector("svg");
    if (!sel && svg) {
      sel = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      sel.setAttribute("class", "zoom-sel");
      sel.setAttribute("rx", "4");
      svg.append(sel);
    }
    const a = Math.max(PAD.left, Math.min(c._drag, px));
    const b = Math.min(v.w - PAD.right, Math.max(c._drag, px));
    sel?.setAttribute("x", String(a));
    sel?.setAttribute("width", String(Math.max(0, b - a)));
    sel?.setAttribute("y", String(PAD.top));
    sel?.setAttribute("height", String(v.ih));
  }
  const i = Math.max(0, Math.min(v.n - 1, Math.round(((px - PAD.left) / iw) * (v.n - 1))));
  const xx = PAD.left + (i / (v.n - 1)) * iw;
  g.style.display = "";
  const line = g.querySelector("line");
  line?.setAttribute("x1", String(xx));
  line?.setAttribute("x2", String(xx));
  const rows: string[] = [];
  g.querySelectorAll("circle").forEach((circle, si) => {
    const s = opts.series[si];
    const val = s?.values[v.start + i];
    circle.style.display = val == null ? "none" : "";
    if (val != null) {
      circle.setAttribute("cx", String(xx));
      circle.setAttribute("cy", String(PAD.top + v.ih - (Math.min(val, v.max) / v.max) * v.ih));
    }
    if (s) {
      rows.push(
        `<div class="flex items-center gap-2 py-0.5"><i class="inline-block h-2 w-3 rounded-full" style="background:${s.color}"></i><span class="text-ink-2">${esc(s.name)}</span><b class="ml-auto pl-4 tabular-nums">${val == null ? "–" : esc(opts.format(val))}</b></div>`,
      );
    }
  });
  const t = opts.times?.[v.start + i];
  const head =
    t != null && opts.timeFormat
      ? `<div class="mb-1 border-b border-line pb-1 font-medium text-ink-2">${esc(opts.timeFormat(t))}</div>`
      : "";
  showTip(head + rows.join(""), e.clientX, e.clientY);
}

function hideCrosshair(c: ChartEl): void {
  const g = c.querySelector<SVGGElement>(".xh");
  if (g) g.style.display = "none";
  hideTip();
}

/** Tiny smooth line for stat tiles. Not interactive (the tile shows the value). */
export function sparkline(values: number[], color = "var(--s1)", h = 36): string {
  const v = values.slice(-60);
  if (v.length < 2) return `<svg class="h-9 w-full" aria-hidden="true"></svg>`;
  const max = Math.max(...v, 1e-9);
  const pts = v.map((y, i): [number, number] => [(i / (v.length - 1)) * 100, h - 3 - (y / max) * (h - 6)]);
  const d = smoothPath(pts);
  const id = `sp${Math.random().toString(36).slice(2, 7)}`;
  return `<svg class="block w-full overflow-visible" style="height:${h}px" viewBox="0 0 100 ${h}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="0.4"/><stop offset="0.6" stop-color="${color}" stop-opacity="0.1"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <path d="${d}L100,${h}L0,${h}Z" fill="url(#${id})"/>
    <path class="spark-line" style="color:${color}" d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

/** Progress ring. */
export function ring(percent: number, size = 160, stroke = 12): string {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, percent));
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="-rotate-90" aria-hidden="true">
    <defs><linearGradient id="ringg" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)"/><stop offset="1" stop-color="var(--accent-2)"/></linearGradient></defs>
    <circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--panel-2)" stroke-width="${stroke}"/>
    <circle class="ring-arc" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="url(#ringg)" stroke-width="${stroke}" stroke-linecap="round"
      stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - p / 100)}" style="transition:stroke-dashoffset .6s ease"/>
  </svg>`;
}

/** Column chart in HTML: bars grow from the baseline with 4px rounded tops; hover highlights one bar. */
export function columns(
  values: number[],
  labels: string[],
  opts: {
    color?: string;
    tip: (v: number, i: number) => string;
    height?: number;
    every?: number;
    highlight?: number;
  },
): string {
  const max = Math.max(...values, 1);
  const h = opts.height ?? 140;
  const every = opts.every ?? 1;
  const color = (i: number) => (i === opts.highlight ? "var(--s3)" : (opts.color ?? "var(--s1)"));
  return `<div class="cols flex items-end gap-[3px]" style="height:${h}px">${values
    .map(
      (
        v,
        i,
      ) => `<div class="col relative flex h-full flex-1 cursor-default items-end" data-tip="${esc(opts.tip(v, i))}">
        ${
          v
            ? `<div class="col-bar w-full rounded-t-[4px]" style="height:${Math.max(3, (v / max) * 100)}%;animation-delay:${Math.min(i * 18, 400)}ms;background:linear-gradient(180deg, color-mix(in oklab, ${color(i)} 100%, white 12%), color-mix(in oklab, ${color(i)} 75%, transparent))"></div>`
            : `<div class="h-[2px] w-full rounded bg-panel-2"></div>`
        }
      </div>`,
    )
    .join("")}</div>
    <div class="mt-1.5 flex gap-[3px] text-[10px] text-ink-3">${labels
      .map(
        (l, i) => `<div class="flex-1 text-center whitespace-nowrap">${i % every === 0 ? esc(l) : ""}</div>`,
      )
      .join("")}</div>`;
}

/** Contribution graph: one cell per day, weeks as columns, a single-hue sequential scale. */
export function heatmap(
  days: { day: string; value: number; tip: string }[],
  opts: { cell?: number; gap?: number } = {},
): string {
  const cell = opts.cell ?? 13;
  const gap = opts.gap ?? 3;
  if (!days.length) return "";
  const first = new Date(days[0]!.day + "T00:00:00");
  const lead = (first.getDay() + 6) % 7; // Monday first
  const max = Math.max(...days.map((d) => d.value), 1);
  const level = (v: number) => (v <= 0 ? 0 : Math.min(4, Math.ceil((v / max) * 4)));
  const shades = ["var(--panel-2)", "var(--h1)", "var(--h2)", "var(--h3)", "var(--h4)"];
  const weeks = Math.ceil((days.length + lead) / 7);
  const W = 28 + weeks * (cell + gap);
  const H = 18 + 7 * (cell + gap);
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" class="heat block overflow-visible" style="min-width:${Math.round(W * 0.8)}px;max-height:${Math.round(H * 1.5)}px" role="img" aria-label="Uploads per day">`;
  ["Mon", "", "Wed", "", "Fri", "", ""].forEach((d, i) => {
    if (d)
      svg += `<text x="0" y="${18 + i * (cell + gap) + cell - 2}" font-size="10" fill="var(--ink-3)">${d}</text>`;
  });
  let lastMonth = -1;
  days.forEach((d, idx) => {
    const pos = idx + lead;
    const col = Math.floor(pos / 7);
    const row = pos % 7;
    const date = new Date(d.day + "T00:00:00");
    if (row === 0 || idx === 0) {
      const m = date.getMonth();
      if (m !== lastMonth && (date.getDate() <= 7 || idx === 0)) {
        lastMonth = m;
        svg += `<text x="${28 + col * (cell + gap)}" y="11" font-size="10" fill="var(--ink-3)">${date.toLocaleDateString([], { month: "short" })}</text>`;
      }
    }
    svg += `<rect x="${28 + col * (cell + gap)}" y="${18 + row * (cell + gap)}" width="${cell}" height="${cell}" rx="3" fill="${shades[level(d.value)]}" data-tip="${esc(d.tip)}"/>`;
  });
  return svg + "</svg>";
}

export function heatLegend(): string {
  const shades = ["var(--panel-2)", "var(--h1)", "var(--h2)", "var(--h3)", "var(--h4)"];
  return `<div class="flex items-center gap-1 text-[11px] text-ink-3">Less${shades
    .map((c) => `<i class="inline-block size-3 rounded-[3px]" style="background:${c}"></i>`)
    .join("")}More</div>`;
}

// ---- shared tooltip for anything with data-tip (bars, cells, badges)

let tipEl: HTMLDivElement | null = null;

export function showTip(markup: string, cx: number, cy: number): void {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "tip";
    document.body.append(tipEl);
  }
  tipEl.innerHTML = markup;
  tipEl.style.display = "block";
  const r = tipEl.getBoundingClientRect();
  let left = cx + 14;
  let top = cy + 14;
  if (left + r.width > window.innerWidth - 8) left = cx - r.width - 14;
  if (top + r.height > window.innerHeight - 8) top = cy - r.height - 14;
  tipEl.style.left = `${Math.max(8, left)}px`;
  tipEl.style.top = `${Math.max(8, top)}px`;
}

export function hideTip(): void {
  if (tipEl) tipEl.style.display = "none";
}

export function enableTips(): void {
  const onMove = (e: PointerEvent) => {
    const t = (e.target as Element | null)?.closest?.("[data-tip]");
    if (t) showTip(esc(t.getAttribute("data-tip")).replace(/\n/g, "<br>"), e.clientX, e.clientY);
    else if (!(e.target as Element | null)?.closest?.("[data-chart]")) hideTip();
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerdown", onMove);
  document.addEventListener("scroll", hideTip, true);
}

/** Forget zoom and play the draw-in animation again (used when the time range changes). */
export function replay(el: HTMLElement): void {
  const c = el as ChartEl;
  c._zoom = null;
  c._drawn = false;
}
