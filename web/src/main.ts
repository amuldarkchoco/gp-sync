import "./style.css";
import { get, post, type Status } from "./lib/api";
import { enableTips } from "./lib/charts";
import { $, $$, esc, html, toast } from "./lib/dom";
import { pct } from "./lib/format";
import { icon, type IconName } from "./lib/icons";
import { onMode, onStatus, refresh, startPolling, status } from "./lib/store";
import { install, installState, onInstallChange } from "./lib/install";
import { openViewer } from "./lib/viewer";
import { initTheme } from "./lib/theme";
import { glassToggle, wireGlassToggles } from "./lib/glass-toggle";
import { phaseBadge, phaseInfo, syncChips, thumbFallback } from "./lib/ui";
import type { View } from "./views/view";
import about from "./views/about";
import activity from "./views/activity";
import health from "./views/health";
import copyView from "./views/copy";
import folders from "./views/folders";
import historyView from "./views/history";
import insights from "./views/insights";
import library from "./views/library";
import network from "./views/network";
import overview from "./views/overview";
import settings from "./views/settings";
import dates from "./views/dates";
import sources from "./views/sources";
import { askUndated } from "./lib/undated";
import { watchSegs } from "./lib/fit-segs";
import storage from "./views/storage";
import upload from "./views/upload";

interface Route {
  id: string;
  title: string;
  ic: IconName;
  view: View;
  group: string;
}

const ROUTES: Route[] = [
  { id: "overview", title: "Overview", ic: "dashboard", view: overview, group: "Backup" },
  { id: "upload", title: "Upload", ic: "upload", view: upload, group: "Backup" },
  { id: "activity", title: "Activity", ic: "activity", view: activity, group: "Backup" },
  { id: "library", title: "Library", ic: "library", view: library, group: "Backup" },
  { id: "storage", title: "Free storage", ic: "cloud", view: storage, group: "Backup" },
  { id: "copy", title: "Copy accounts", ic: "users", view: copyView, group: "Backup" },
  { id: "dates", title: "Fix dates", ic: "clock", view: dates, group: "Backup" },
  { id: "sources", title: "Sources", ic: "layers", view: sources, group: "Backup" },
  { id: "folders", title: "Folders", ic: "folder", view: folders, group: "Insights" },
  { id: "history", title: "History", ic: "calendar", view: historyView, group: "Insights" },
  { id: "insights", title: "Insights", ic: "chart", view: insights, group: "Insights" },
  { id: "network", title: "Network", ic: "wifi", view: network, group: "Insights" },
  { id: "health", title: "Health", ic: "health", view: health, group: "System" },
  { id: "settings", title: "Settings", ic: "settings", view: settings, group: "System" },
  { id: "about", title: "About", ic: "info", view: about, group: "System" },
];
const TABS = ["overview", "activity", "upload", "network"];

initTheme();

// ---- shell

function navLink(r: Route): string {
  return `<a href="#/${r.id}" class="nav-item" data-nav="${r.id}">${icon(r.ic)}<span>${r.title}</span><span class="count hidden" data-count="${r.id}"></span></a>`;
}

function shell(): string {
  const groups = [...new Set(ROUTES.map((r) => r.group))];
  return `
  <div class="flex h-dvh overflow-hidden">
    <aside class="app-sidebar hidden w-64 shrink-0 flex-col border-r border-line lg:flex">
      <a href="#/overview" class="flex items-center gap-3 px-5 pt-6 pb-5">
        <img src="icon.svg" alt="" class="brand-icon size-11 rounded-[14px]">
        <div class="min-w-0"><div class="truncate text-base font-semibold tracking-tight">GP Sync</div><div class="text-xs text-ink-3" id="side-version"></div></div>
      </a>
      <nav class="scroll-thin flex-1 space-y-4 overflow-y-auto px-3 py-2">
        ${groups
          .map(
            (g) =>
              `<div><div class="label px-3 pb-1.5">${g}</div><div class="space-y-0.5">${ROUTES.filter(
                (r) => r.group === g,
              )
                .map(navLink)
                .join("")}</div></div>`,
          )
          .join("")}
      </nav>
      <button class="nav-item mx-3 hidden" id="side-install">${icon("download")}<span>Install app</span></button>
      <div class="side-status m-3 card p-4" id="side-status">
        <div class="skeleton h-5 w-24"></div><div class="skeleton mt-3 h-2"></div><div class="skeleton mt-3 h-10"></div>
      </div>
    </aside>

    <div class="flex min-w-0 flex-1 flex-col">
      <header id="topbar" class="app-topbar z-30 flex shrink-0 items-center gap-3 border-b border-line px-4 lg:px-6" style="padding-top:env(safe-area-inset-top);height:calc(4rem + env(safe-area-inset-top))">
        <div class="min-w-0 flex-1">
          <h1 class="keep-line truncate text-lg font-semibold tracking-tight" id="page-title">Overview</h1>
        </div>
        <span class="lg:hidden max-[420px]:hidden" id="top-phase"></span>
        <span class="hidden lg:block"><span id="live" class="badge good hidden" data-tip="Updates arrive the moment something happens"><span class="dot live"></span>Live</span></span>
        <span class="hidden" id="offline">${'<span class="badge bad">' + icon("cloudOff") + "Offline</span>"}</span>
        <button class="btn icon hidden" id="btn-install" title="Install app" aria-label="Install app">${icon("download")}</button>
        <button class="btn icon" id="btn-sync" title="Scan now" aria-label="Scan now">${icon("refresh")}</button>
        <button class="btn icon" id="btn-pause" title="Pause" aria-label="Pause">${icon("pause")}</button>
        ${glassToggle("sm")}
        <a class="btn primary hidden sm:inline-flex" href="#/upload" aria-label="Add photos and videos from this device" title="Add photos and videos from this device">${icon("upload")}<span>Add files</span></a>
      </header>
      <div id="ptr" aria-hidden="true" style="top:calc(4rem + env(safe-area-inset-top))"><svg viewBox="0 0 40 40"><circle class="ptr-track" cx="20" cy="20" r="11"/><circle class="ptr-arc" cx="20" cy="20" r="11" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100" transform="rotate(-90 20 20)"/></svg></div>
      <main id="view" class="scroll-thin flex-1 overflow-y-auto px-4 pt-4 pb-28 lg:px-6 lg:pt-6 lg:pb-8"></main>
    </div>
  </div>

  <nav id="tabbar" class="app-tabbar fixed inset-x-0 bottom-0 z-40 border-t border-line lg:hidden" style="padding-bottom:env(safe-area-inset-bottom)" aria-label="Main navigation">
    <div class="mx-auto grid max-w-lg grid-cols-5">
      ${TABS.map((id) => ROUTES.find((r) => r.id === id) as Route)
        .map((r) =>
          r.id === "upload"
            ? `<a href="#/upload" data-nav="upload" class="tab-fab" aria-label="Add photos and videos from this device"><span>${icon("upload", "size-5")}</span></a>`
            : `<a href="#/${r.id}" data-nav="${r.id}" class="tab"><span class="tab-ic">${icon(r.ic, "size-5")}<i class="tab-dot hidden" data-dot="${r.id}"></i></span><span>${r.title}</span></a>`,
        )
        .join("")}
      <button id="btn-more" class="tab" aria-haspopup="dialog"><span class="tab-ic">${icon("more", "size-5")}<i class="tab-dot hidden" data-dot="more"></i></span><span>More</span></button>
    </div>
  </nav>

  <div id="sheet" class="fixed inset-0 z-50 hidden lg:hidden" role="dialog" aria-label="More pages">
    <div class="sheet-bg absolute inset-0 bg-black/50" data-close></div>
    <div class="sheet-panel app-sheet absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-line p-4 shadow-2xl" style="padding-bottom:calc(1rem + env(safe-area-inset-bottom))">
      <div class="mx-auto mb-3 h-1 w-10 rounded-full bg-panel-2"></div>
      <div class="grid grid-cols-3 gap-2">
        ${ROUTES.filter((r) => !TABS.includes(r.id))
          .map(
            (r) =>
              `<a href="#/${r.id}" class="card sheet-item relative flex flex-col items-center gap-2 py-4 text-sm">${icon(r.ic, "size-6 text-ink-2")}${r.title}<span class="count absolute top-2 right-2 hidden" data-count="${r.id}"></span></a>`,
          )
          .join("")}
      </div>
    </div>
  </div>`;
}

// ---- routing

let active: Route | null = null;
let unsubscribe: (() => void) | null = null;

function route(): void {
  const [id = "overview", ...rest] = location.hash.replace(/^#\/?/, "").split("/");
  const r = ROUTES.find((x) => x.id === id) ?? ROUTES[0]!;
  $("#sheet").classList.add("hidden");
  $$("[data-nav]").forEach((a) => {
    const on = a.dataset.nav === r.id;
    a.toggleAttribute("aria-current", on);
    if (on) a.setAttribute("aria-current", "page");
    if (a.classList.contains("tab")) a.classList.toggle("on", on);
  });
  if (active !== r) {
    const swap = () => mountView(r, rest);
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (doc.startViewTransition && active) doc.startViewTransition(swap);
    else swap();
  } else {
    r.view.route?.(rest);
  }
}

function mountView(r: Route, rest: string[]): void {
  active?.view.unmount?.();
  unsubscribe?.();
  active = r;
  const el = $("#view");
  el.scrollTop = 0;
  // The page's one-line description sits above its content, not in the header.
  el.innerHTML = r.view.subtitle ? `<p class="page-intro">${esc(r.view.subtitle)}</p>` : "";
  const page = document.createElement("div");
  el.append(page);
  document.title = `${r.title} · GP Sync`;
  $("#page-title").textContent = r.title;
  r.view.mount(page, rest);
  if (r.view.update) unsubscribe = onStatus(r.view.update.bind(r.view));
}

/** Reload the open page (pull to refresh, or after big changes). */
export function reloadView(): void {
  if (!active) return;
  const [, ...rest] = location.hash.replace(/^#\/?/, "").split("/");
  mountView(active, rest);
  void refresh();
}

function pullToRefresh(): void {
  // Like iOS and Android: only the indicator moves, the header and page stay put. It follows the
  // finger with some resistance, draws a circle while pulling, and spins once let go past the mark.
  const main = $("#view");
  const ind = $("#ptr");
  const arc = ind.querySelector<SVGCircleElement>(".ptr-arc")!;
  const svg = ind.querySelector("svg")!;
  const PULL = 72; // px of (resisted) pull that triggers a refresh
  let startX = 0;
  let startY: number | null = null;
  let pull = 0;
  let busy = false;
  const draw = (d: number) => {
    const p = Math.min(1, d / PULL);
    ind.style.transform = `translate(-50%, ${Math.min(d, PULL * 1.15) - 44}px) scale(${0.6 + p * 0.4})`;
    ind.style.opacity = String(Math.min(1, p * 1.6));
    arc.style.strokeDashoffset = String(100 - p * 85);
    svg.style.transform = `rotate(${p * 200}deg)`;
    ind.classList.toggle("ready", p >= 1);
  };
  const reset = () => {
    ind.classList.add("back");
    ind.classList.remove("ready", "spin");
    ind.style.transform = "";
    ind.style.opacity = "0";
    svg.style.transform = "";
    setTimeout(() => ind.classList.remove("back"), 260);
  };
  main.addEventListener(
    "touchstart",
    (e) => {
      if (busy || e.touches.length > 1 || main.scrollTop > 0) {
        startY = null;
        return;
      }
      startX = e.touches[0]!.clientX;
      startY = e.touches[0]!.clientY;
      pull = 0;
    },
    { passive: true },
  );
  main.addEventListener(
    "touchmove",
    (e) => {
      if (startY == null) return;
      const t = e.touches[0]!;
      const dy = t.clientY - startY;
      // A sideways swipe (charts, chips) or scrolling up is not a pull.
      if (pull === 0 && (dy <= 0 || Math.abs(t.clientX - startX) > dy)) {
        if (Math.abs(t.clientX - startX) > 8 || dy < -4) startY = null;
        return;
      }
      if (main.scrollTop > 0) return;
      pull = Math.max(0, dy) * 0.5; // resistance, as on iOS
      draw(pull);
    },
    { passive: true },
  );
  const end = () => {
    if (startY == null) return;
    startY = null;
    if (pull >= PULL && !busy) {
      busy = true;
      navigator.vibrate?.(8);
      ind.classList.add("back", "spin");
      ind.style.transform = `translate(-50%, ${PULL * 0.6 - 44}px)`;
      arc.style.strokeDashoffset = "75";
      reloadView();
      setTimeout(() => {
        reset();
        busy = false;
      }, 800);
    } else if (pull > 0) reset();
    pull = 0;
  };
  main.addEventListener("touchend", end);
  main.addEventListener("touchcancel", end);
}

// ---- live shell updates

function updateShell(s: Status): void {
  const p = phaseInfo(s);
  $("#side-version").textContent = `Version ${s.version}`;
  const done = pct(s.library.synced_files, s.library.files);
  html(
    $("#side-status"),
    `<div class="flex items-center justify-between gap-2">${phaseBadge(s)}<span class="text-xs text-ink-3 tabular-nums">${done.toFixed(done < 100 && done > 99 ? 1 : 0)}%</span></div>
     <div class="bar mt-2.5 ${s.phase === "uploading" ? "active" : ""}"><i style="width:${done}%"></i></div>
     <div class="mt-2 truncate text-xs text-ink-3" title="${esc(p.detail)}">${esc(p.detail)}</div>
     <div class="mt-3 flex flex-wrap gap-1">${syncChips(s)}</div>`,
  );
  html($("#top-phase"), phaseBadge(s));
  syncButton(s);
  const failed = s.counts.failed;
  const warnHealth = s.login_failed.length > 0 || s.phase === "error";
  const counts: Record<string, [string, string]> = {
    activity: failed ? [String(failed), "bad"] : ["", ""],
    library: [
      s.library.files ? Intl.NumberFormat([], { notation: "compact" }).format(s.library.files) : "",
      "",
    ],
    health: warnHealth ? ["!", "bad"] : ["", ""],
    dates: s.dates?.waiting ? [String(s.dates.waiting), "info"] : ["", ""],
    settings: s.accounts.length ? ["", ""] : ["1", "info"],
    overview: s.phase === "uploading" && s.total ? [`${s.done}/${s.total}`, "info"] : ["", ""],
  };
  $$("[data-count]").forEach((el) => {
    const [v, tone] = counts[el.dataset.count ?? ""] ?? ["", ""];
    el.textContent = v;
    el.classList.remove("bad", "info");
    if (tone) el.classList.add(tone);
    el.classList.toggle("hidden", !v);
  });
  $$("[data-dot]").forEach((el) => {
    const id = el.dataset.dot;
    const on = (id === "activity" && failed > 0) || (id === "more" && (warnHealth || !s.accounts.length));
    el.classList.toggle("hidden", !on);
  });
  const pause = $("#btn-pause");
  const label = s.paused ? "Resume uploads" : "Pause uploads";
  if (pause.title !== label) {
    pause.title = label;
    pause.setAttribute("aria-label", label);
    pause.innerHTML = icon(s.paused ? "play" : "pause", "size-4 swap-in");
    pause.classList.toggle("primary", s.paused);
  }
}

// The scan button spins while a scan runs, and for at least a moment after a tap,
// so a quick scan still shows that it happened.
let scanHoldUntil = 0;
let scanTimer = 0;

function syncButton(s: Status | null = status()): void {
  const btn = $("#btn-sync");
  const working = s?.phase === "scanning" || s?.phase === "starting";
  const busy = working || Date.now() < scanHoldUntil;
  btn.classList.toggle("busy", busy);
  btn.classList.toggle("uploading", s?.phase === "uploading" && !busy);
  btn.toggleAttribute("aria-busy", busy);
  const label = busy ? "Scanning…" : s?.phase === "uploading" ? "Uploading · scan again" : "Scan now";
  if (btn.title !== label) {
    btn.title = label;
    btn.setAttribute("aria-label", label);
  }
}

function haptic(): void {
  if (matchMedia("(pointer: coarse)").matches) navigator.vibrate?.(8);
}

/** Touch feedback: a ripple from where the finger lands. */
function ripples(): void {
  const SEL =
    ".btn, .tab, .nav-item, .set-item, .set-tab, a.card, .row.clickable, .seg button, figure[data-open]";
  document.addEventListener(
    "pointerdown",
    (e) => {
      const host = (e.target as Element | null)?.closest?.<HTMLElement>(SEL);
      if (!host || (host as HTMLButtonElement).disabled) return;
      const r = host.getBoundingClientRect();
      const size = Math.max(r.width, r.height) * 2;
      const dot = document.createElement("span");
      dot.className = "ripple";
      dot.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
      host.append(dot);
      dot.addEventListener("animationend", () => dot.remove(), { once: true });
      setTimeout(() => dot.remove(), 900);
    },
    { passive: true },
  );
}

function installButtons(): void {
  const show = installState() === "ready";
  $("#btn-install").classList.toggle("hidden", !show);
  $("#side-install").classList.toggle("hidden", installState() === "installed");
}

/** The server works out local days, schedule hours and dates in file names in this time zone:
 * keep it current (it used to be saved only with the Schedule or Alerts settings). */
async function saveTimeZone(): Promise<void> {
  const tz = -new Date().getTimezoneOffset();
  try {
    const s = await get<{ tz_offset_min: number }>("settings");
    if (s.tz_offset_min !== tz) await post("settings", { tz_offset_min: tz });
  } catch {
    // signed out or offline: tried again next time the dashboard opens
  }
}

function boot(): void {
  const root = $("#app");
  root.innerHTML = shell();
  enableTips();
  pullToRefresh();
  // Thumbnails and file rows open the viewer, with the other files of the same list.
  const openFrom = (target: HTMLElement) => {
    const item = target.closest<HTMLElement>("[data-open]");
    if (!item || target.closest("a, button:not([data-open]), input, select")) return false;
    const gallery = item.closest("[data-gallery]") ?? item.parentElement ?? document.body;
    const list = [
      ...new Set([...gallery.querySelectorAll<HTMLElement>("[data-open]")].map((x) => x.dataset.open ?? "")),
    ];
    openViewer(list, list.indexOf(item.dataset.open ?? ""), item.dataset.info === "1");
    return true;
  };
  document.addEventListener("click", (e) => openFrom(e.target as HTMLElement));
  document.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && openFrom(e.target as HTMLElement)) e.preventDefault();
  });
  // A soft light follows the mouse over cards: at most once per frame, never for touch.
  let lightFrame = 0;
  let lastMove: PointerEvent | null = null;
  document.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType !== "mouse") return;
      lastMove = e;
      if (lightFrame) return;
      lightFrame = requestAnimationFrame(() => {
        lightFrame = 0;
        const ev = lastMove;
        const card = (ev?.target as Element | null)?.closest?.<HTMLElement>(".card");
        if (!ev || !card) return;
        const r = card.getBoundingClientRect();
        card.style.setProperty("--mx", `${ev.clientX - r.left}px`);
        card.style.setProperty("--my", `${ev.clientY - r.top}px`);
      });
    },
    { passive: true },
  );
  // Library pictures fade in once decoded, and their placeholder stops shimmering.
  document.addEventListener(
    "load",
    (e) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLImageElement && t.classList.contains("fade-img")) {
        t.classList.add("loaded");
        t.parentElement?.classList.add("done");
      }
    },
    true,
  );
  document.addEventListener(
    "error",
    (e) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLImageElement && t.dataset.kind) thumbFallback(t);
    },
    true,
  );
  window.addEventListener("hashchange", route);
  watchSegs();
  $("#btn-more").addEventListener("click", () => {
    haptic();
    $("#sheet").classList.remove("hidden");
  });
  $("#sheet").addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("[data-close]")) $("#sheet").classList.add("hidden");
  });
  $$(".tab, .tab-fab").forEach((t) => t.addEventListener("click", haptic));
  $("#btn-sync").addEventListener("click", async () => {
    scanHoldUntil = Date.now() + 1200;
    syncButton();
    clearTimeout(scanTimer);
    scanTimer = window.setTimeout(() => syncButton(), 1250);
    try {
      await post("sync");
      toast(status()?.paused ? "Scanning (uploads stay paused)" : "Scanning for new photos and videos");
    } catch {
      toast("Couldn't reach the app", "bad");
    }
    setTimeout(refresh, 600);
  });
  $("#btn-pause").addEventListener("click", async () => {
    const btn = $<HTMLButtonElement>("#btn-pause");
    btn.disabled = true;
    try {
      await post("pause");
      toast(status()?.paused ? "Uploads resumed" : "Uploads paused", "good");
      await refresh();
    } finally {
      btn.disabled = false;
    }
  });
  $("#btn-install").addEventListener("click", () => void install());
  $("#side-install").addEventListener("click", () => void install());
  installButtons();
  onInstallChange(installButtons);
  ripples();
  wireGlassToggles();
  const offline = $("#offline");
  new MutationObserver(() =>
    offline.classList.toggle("hidden", document.documentElement.dataset.offline !== "1"),
  ).observe(document.documentElement, { attributes: true, attributeFilter: ["data-offline"] });
  onStatus(updateShell);
  onStatus(askUndated);
  onMode((live) => $("#live").classList.toggle("hidden", !live));
  route();
  startPolling();
  void saveTimeZone();
  if ("serviceWorker" in navigator && isSecureContext) {
    navigator.serviceWorker.register("sw.js").catch(() => undefined);
  }
}

boot();
