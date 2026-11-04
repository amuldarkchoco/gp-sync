// The upload/download chart used on Overview and Network: live (last 90 s) or saved history.

import { get, type Metrics, type Status } from "./api";
import { areaChart, replay } from "./charts";
import { clock, date, speed } from "./format";

export type Range = "live" | "1" | "24" | "168" | "336";

export const RANGES: [Range, string][] = [
  ["live", "Live"],
  ["1", "1 h"],
  ["24", "24 h"],
  ["168", "7 d"],
  ["336", "14 d"],
];

export class NetChart {
  private range: Range = "live";
  private history: Metrics | null = null;
  private loadedAt = 0;

  constructor(
    private el: HTMLElement,
    private height: number,
  ) {}

  setRange(r: Range, s: Status | null): void {
    this.range = r;
    this.history = null;
    replay(this.el);
    if (r === "live") {
      if (s) this.live(s);
    } else void this.load();
  }

  update(s: Status): void {
    if (this.range === "live") this.live(s);
    else if (Date.now() - this.loadedAt > 60_000) void this.load();
  }

  private live(s: Status): void {
    const n = s.net.up.length;
    const times = Array.from({ length: n }, (_, i) => s.now - (n - 1 - i));
    areaChart(this.el, {
      series: [
        { name: "Upload", color: "var(--s1)", values: s.net.up },
        { name: "Download", color: "var(--s2)", values: s.net.down },
      ],
      times,
      timeFormat: (t) => new Date(t * 1000).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" }),
      format: speed,
      height: this.height,
      empty: "Collecting speed samples…",
    });
  }

  private async load(): Promise<void> {
    this.loadedAt = Date.now();
    const range = this.range;
    const m = await get<Metrics>(`metrics?hours=${range}`);
    if (range !== this.range) return;
    this.history = m;
    const long = m.hours > 24;
    areaChart(this.el, {
      series: [
        { name: "Upload", color: "var(--s1)", values: m.points.map((p) => p.up) },
        { name: "Download", color: "var(--s2)", values: m.points.map((p) => p.down) },
      ],
      times: m.points.map((p) => p.time),
      timeFormat: (t) => (long ? `${date(t)} ${clock(t)}` : clock(t)),
      format: speed,
      height: this.height,
      zoomable: true,
      empty: "History builds up minute by minute. Check back soon.",
    });
  }

  get data(): Metrics | null {
    return this.history;
  }
}

export function rangeButtons(active: Range, ranges = RANGES): string {
  return ranges
    .map(([r, l]) => `<button data-range="${r}" aria-pressed="${r === active}">${l}</button>`)
    .join("");
}
