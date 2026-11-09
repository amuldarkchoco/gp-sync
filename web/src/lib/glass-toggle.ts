// Light/dark switch with a glass knob, after "Glass Light Toggle" by Zsolt Kacso
// (experiments.thisiswhitespace.com), rebuilt in CSS + SVG for a small header control:
//  - a rounded-square glass knob slides along a recessed track;
//  - a strip of light hugs the glass and orbits it as it moves: bottom and blue for night, top and
//    amber for day, washing the track and spilling a little onto the page;
//  - the icon is a pixel matrix: every moon pixel is paired with a sun pixel by angle and flies to
//    it with its own delay and swirl, scrubbed by the knob's position (drag halfway, it holds).
// Everything is driven by one number, --p (0 = night, 1 = day), so dragging and animating share
// the same code path. Pure helpers are exported for tests.

import { resolvedTheme, setTheme } from "./theme";

const GRID = 17;
const C = 8; // centre cell

export interface Px {
  x: number;
  y: number;
  /** Brightness 0..1. */
  b: number;
}

/** Crescent moon with two small stars. */
export function moonPixels(): Px[] {
  const out: Px[] = [];
  for (let y = 0; y < GRID; y++)
    for (let x = 0; x < GRID; x++) {
      const inDisk = (x - C) ** 2 + (y - C) ** 2 <= 6.2 ** 2;
      const inBite = (x - 11) ** 2 + (y - 5) ** 2 <= 5 ** 2;
      if (inDisk && !inBite) out.push({ x, y, b: 1 });
    }
  for (const [x, y, b] of [
    [14, 2, 1],
    [16, 6, 0.6],
    [12, 0, 0.5],
  ] as const)
    out.push({ x, y, b });
  return out;
}

/** Round sun with eight rays. */
export function sunPixels(): Px[] {
  const seen = new Set<string>();
  const out: Px[] = [];
  const add = (x: number, y: number) => {
    const k = `${x},${y}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ x, y, b: 1 });
  };
  for (let y = 0; y < GRID; y++)
    for (let x = 0; x < GRID; x++) if ((x - C) ** 2 + (y - C) ** 2 <= 3.6 ** 2) add(x, y);
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    for (const r of i % 2 ? [5.8, 7] : [5.6, 6.6, 7.6])
      add(Math.round(C + Math.cos(a) * r), Math.round(C + Math.sin(a) * r));
  }
  return out;
}

const angle = (p: Px) =>
  ((Math.atan2(p.y - C, p.x - C) + Math.PI * 2.75) % (Math.PI * 2)) + Math.hypot(p.x - C, p.y - C) * 1e-3;

export interface Pair {
  from: Px;
  to: Px;
  /** Start of this pixel's flight, as a share of the whole move (0..0.3). */
  delay: number;
  /** Sideways swing in grid cells, so the swarm swirls instead of sliding. */
  curl: number;
}

/** Pair moon and sun pixels by sweeping angle: the morph reads as one coherent swirl. Extra
 * pixels on the bigger side share a partner and start dark there, so nothing pops in. */
export function pairPixels(a: Px[], b: Px[], rand: () => number = Math.random): Pair[] {
  const A = [...a].sort((p, q) => angle(p) - angle(q));
  const B = [...b].sort((p, q) => angle(p) - angle(q));
  const big = A.length >= B.length ? A : B;
  const small = big === A ? B : A;
  let last = -1;
  return big.map((p, i) => {
    const j = Math.floor((i * small.length) / big.length);
    const partner = { ...small[j]!, b: j === last ? 0 : small[j]!.b };
    last = j;
    const [from, to] = big === A ? [p, partner] : [partner, p];
    return {
      from,
      to,
      delay: (1 - from.x / (GRID - 1)) * 0.22 + rand() * 0.08,
      curl: (rand() * 2 - 1) * 3 + (from.y - C) * 0.25,
    };
  });
}

let pairs: Pair[] | null = null;

function icon(): string {
  pairs ??= pairPixels(moonPixels(), sunPixels());
  const r = (n: number) => Math.round(n * 100) / 100;
  return `<svg class="gt-icon" viewBox="-0.5 -0.5 ${GRID} ${GRID}" aria-hidden="true">${pairs
    .map(
      (p) =>
        `<rect x="${p.from.x - 0.4}" y="${p.from.y - 0.4}" width="0.8" height="0.8" rx="0.12" style="--dx:${p.to.x - p.from.x};--dy:${p.to.y - p.from.y};--d:${r(p.delay)};--c:${r(p.curl)};--a0:${p.from.b};--a1:${p.to.b}"/>`,
    )
    .join("")}</svg>`;
}

/** Markup for one toggle. `size` "lg" is the big one in Settings. */
export function glassToggle(size: "sm" | "lg" = "sm"): string {
  const day = resolvedTheme() === "light";
  return `<button type="button" class="gt gt-${size}" role="switch" aria-checked="${day}" aria-label="Light mode" title="Light or dark" style="--p:${day ? 1 : 0}">
    <span class="gt-track"><span class="gt-spill"></span></span>
    <span class="gt-knob"><span class="gt-glow"></span><span class="gt-ring"></span>${icon()}<span class="gt-shine"></span></span>
  </button>`;
}

/** Radius that reveals `share` (0..1) of the page from (x, y): at 1 it reaches the farthest corner. */
export function revealRadius(share: number, x: number, y: number, w: number, h: number): number {
  const s = Math.min(1, Math.max(0, share));
  return s * Math.hypot(Math.max(x, w - x), Math.max(y, h - y));
}

type VT = { ready: Promise<void>; skipTransition: () => void };

/** A theme switch in progress: the other theme spreads from the knob in a circle that follows the
 * knob, so a tap moves at the knob's speed and a drag follows the finger (drag back, it shrinks).
 * `target` is where the knob is heading (null while dragging); it settles when it gets there. */
interface Reveal {
  el: HTMLElement;
  from: 0 | 1;
  target: 0 | 1 | null;
}
let reveal: Reveal | null = null;

function canReveal(): boolean {
  return "startViewTransition" in document && !matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function knobP(el: HTMLElement): number {
  return Number(getComputedStyle(el).getPropertyValue("--p")) || 0;
}

function placeReveal(el: HTMLElement, share: number): void {
  const k = el.querySelector(".gt-knob")!.getBoundingClientRect();
  const x = k.left + k.width / 2;
  const y = k.top + k.height / 2;
  const root = document.documentElement.style;
  root.setProperty("--reveal-x", `${x}px`);
  root.setProperty("--reveal-y", `${y}px`);
  root.setProperty("--reveal-r", `${revealRadius(share, x, y, innerWidth, innerHeight)}px`);
}

/** Start switching theme from toggle `el`. False when the browser can't show it (then switch at once). */
function startReveal(el: HTMLElement, target: 0 | 1 | null): boolean {
  if (reveal || !canReveal()) return false;
  const from: 0 | 1 = resolvedTheme() === "light" ? 1 : 0;
  const r: Reveal = { el, from, target };
  reveal = r;
  const html = document.documentElement;
  placeReveal(el, 0);
  html.classList.add("theme-reveal");
  el.classList.add("revealing");
  // The knob sets off at once (it is drawn live above the page); the circle catches up with it.
  if (target !== null) el.style.setProperty("--p", String(target));
  const vt = (document as Document & { startViewTransition: (cb: () => void) => VT }).startViewTransition(
    () => {
      // The other theme is drawn inside the circle; it is saved only when the knob settles there.
      html.dataset.theme = from ? "dark" : "light";
    },
  );
  const settle = (end: 0 | 1) => {
    if (reveal !== r) return;
    reveal = null;
    vt.skipTransition();
    html.classList.remove("theme-reveal");
    el.classList.remove("revealing");
    setTheme(end ? "light" : "dark"); // back to the old theme if the knob went back
  };
  const tick = () => {
    if (reveal !== r) return;
    // The page redrew the toggle away mid-switch: finish where it was heading.
    if (!el.isConnected) return settle(r.target ?? (Number(el.style.getPropertyValue("--p")) >= 0.5 ? 1 : 0));
    const p = knobP(el);
    placeReveal(el, Math.abs(p - from));
    if (r.target !== null && Math.abs(p - r.target) < 0.002) settle(r.target);
    else requestAnimationFrame(tick);
  };
  vt.ready.then(() => requestAnimationFrame(tick)).catch(() => settle(r.target ?? (from ? 0 : 1)));
  return true;
}

/** Wire every toggle inside `root` (click, keyboard, drag) and keep them in step with the theme. */
export function wireGlassToggles(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLButtonElement>(".gt:not([data-wired])")) {
    el.dataset.wired = "";
    let start: { x: number; p: number } | null = null;
    let moved = 0;
    const travel = () => {
      const knob = el.querySelector<HTMLElement>(".gt-knob")!;
      return Math.max(1, el.clientWidth - knob.offsetWidth - 2 * knob.offsetLeft);
    };
    el.addEventListener("pointerdown", (e) => {
      if (reveal) return;
      start = { x: e.clientX, p: Number(el.style.getPropertyValue("--p")) || 0 };
      moved = 0;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!start) return;
      moved = Math.max(moved, Math.abs(e.clientX - start.x));
      if (moved < 4) return;
      if (!el.classList.contains("dragging")) {
        el.classList.add("dragging");
        startReveal(el, null);
      }
      const p = Math.min(1, Math.max(0, start.p + (e.clientX - start.x) / travel()));
      el.style.setProperty("--p", String(p));
      // Without the reveal, the theme flips as the knob passes the middle.
      if (reveal?.el !== el && p >= 0.5 !== (resolvedTheme() === "light")) choose(p >= 0.5);
    });
    const end = () => {
      if (!start) return;
      const dragged = moved >= 4;
      const target: 0 | 1 = Number(el.style.getPropertyValue("--p")) >= 0.5 ? 1 : 0;
      start = null;
      el.classList.remove("dragging");
      if (!dragged) return;
      if (reveal?.el === el) {
        reveal.target = target;
        el.style.setProperty("--p", String(target)); // glides the rest of the way; the circle follows
      } else choose(target === 1);
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    // Clicks (and Space/Enter, which buttons turn into clicks) flip it, unless it was a drag.
    el.addEventListener("click", (e) => {
      if (moved >= 4) {
        e.preventDefault();
        moved = 0;
        return;
      }
      if (reveal) return;
      const day = el.getAttribute("aria-checked") !== "true";
      if (!startReveal(el, day ? 1 : 0)) choose(day);
    });
  }
}

/** Switch theme at once. */
function choose(day: boolean): void {
  if (resolvedTheme() === (day ? "light" : "dark")) return syncToggles();
  setTheme(day ? "light" : "dark");
}

/** Put every toggle on the page in the current theme's position (not one being dragged). */
export function syncToggles(): void {
  const day = resolvedTheme() === "light";
  for (const el of document.querySelectorAll<HTMLElement>(".gt")) {
    el.setAttribute("aria-checked", String(day));
    if (!el.classList.contains("dragging")) el.style.setProperty("--p", day ? "1" : "0");
  }
}

if (typeof window !== "undefined") window.addEventListener("themechange", syncToggles);
