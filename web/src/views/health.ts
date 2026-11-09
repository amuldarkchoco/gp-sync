import { get, post, type AppLog, type Health, type Status } from "../lib/api";
import { areaChart } from "../lib/charts";
import { $, $$, esc, html, toast } from "../lib/dom";
import { host } from "../lib/store";
import { ago, bytes, clock, date, duration, pct } from "../lib/format";
import { icon } from "../lib/icons";
import { badge, cardHead, phaseBadge, phaseInfo } from "../lib/ui";
import type { View } from "./view";

let h: Health | null = null;
let level = "all";
let q = "";
let logs: AppLog[] = [];
let timer = 0;
let qTimer = 0;

async function loadHealth(): Promise<void> {
  try {
    h = await get<Health>("health");
  } catch (e) {
    // Keep what is on screen; only say so when there is nothing to show yet.
    const box = document.getElementById("hl-accounts");
    if (!h && box)
      box.innerHTML = `<div class="empty">${icon("warn")}Couldn't load: ${esc((e as Error).message)}</div>`;
    return;
  }
  render();
}

function storageBar(label: string, used: number, total: number, sub: string): string {
  const p = pct(used, total);
  const tone = p > 90 ? "var(--bad)" : p > 75 ? "var(--warn)" : "";
  return `<div class="py-2.5"><div class="mb-1.5 flex items-center justify-between text-sm"><span class="font-medium">${label}</span><span class="text-ink-3 tabular-nums">${bytes(total - used)} free</span></div>
    <div class="bar"><i style="width:${p}%;${tone ? `background:${tone}` : ""}"></i></div><div class="mt-1 text-xs text-ink-3">${sub}</div></div>`;
}

function render(): void {
  if (!h || !document.getElementById("hl-accounts")) return;
  html(
    $("#hl-accounts"),
    h.accounts.length
      ? h.accounts
          .map(
            (
              a,
            ) => `<div class="row"><span class="grid size-9 place-items-center rounded-full bg-panel-2 text-sm font-semibold uppercase">${esc(a.email[0] ?? "?")}</span>
            <div class="min-w-0 flex-1"><div class="truncate text-sm font-medium">${esc(a.email)}</div><div class="text-xs text-ink-3">Login saved ${a.login_saved ? date(a.login_saved, true) : "unknown"} · last upload ${ago(a.last_success)}</div></div>
            ${a.login_rejected ? badge("Rejected", "bad", "warn") : badge("OK", "good", "ok")}</div>`,
          )
          .join("")
      : `<div class="empty">${icon("key")}No Google account yet. <a class="text-accent" href="#/settings/accounts">Connect one</a></div>`,
  );
  const c = h.checks;
  const checks: [string, boolean, string][] = [
    ["Media folders readable (read-only)", c.media_readable, c.media_readable ? "OK" : "Not found"],
    ["Phone upload folder", c.upload_folder, c.upload_folder ? "Writable" : "Not mounted"],
    ["Statistics database", c.turso, c.turso ? "Turso" : "SQLite fallback"],
    ["Errors in the last 24 h", c.errors_24h === 0, c.errors_24h ? String(c.errors_24h) : "None"],
  ];
  html(
    $("#hl-checks"),
    checks
      .map(
        ([l, ok, v]) =>
          `<div class="row py-2">${icon(ok ? "ok" : "warn", `size-4 ${ok ? "text-good" : "text-warn"}`)}<span class="flex-1 text-sm">${l}</span>${badge(v, ok ? "good" : "warn")}</div>`,
      )
      .join(""),
  );
  const d = h.disk_media;
  const a = h.disk_data;
  html(
    $("#hl-storage"),
    (d
      ? storageBar(`Storage on ${host()}`, d.used, d.total, `${bytes(d.used)} of ${bytes(d.total)} used`)
      : "") +
      (a && (!d || a.total !== d.total)
        ? storageBar("App data disk", a.used, a.total, `${bytes(a.used)} of ${bytes(a.total)}`)
        : "") +
      `<div class="mt-2 grid grid-cols-3 gap-2">
        <div class="stat-tile"><div class="text-xs text-ink-3">Upload state</div><div class="num">${bytes(h.db_bytes)}</div><div class="text-[11px] text-ink-3">SQLite</div></div>
        <div class="stat-tile"><div class="text-xs text-ink-3">Statistics</div><div class="num">${bytes(h.stats_bytes)}</div><div class="truncate text-[11px] text-ink-3">${esc(h.stats_engine.split(" (")[0])}</div></div>
        <div class="stat-tile"><div class="text-xs text-ink-3">Thumbnails</div><div class="num">${bytes(h.thumbs_bytes)}</div><div class="text-[11px] text-ink-3">on disk</div></div>
      </div>
      ${cacheBox(h)}`,
  );
}

function cacheBox(x: Health): string {
  const c = x.cache;
  if (!c) return "";
  const redis = c.backend === "Redis";
  return `<div class="mt-3 rounded-xl border border-line p-3">
    <div class="flex items-center gap-2 text-sm font-medium">${icon("cache", "size-4 text-ink-3")}Cache
      <span class="ml-auto">${redis ? badge(`Redis ${c.version ?? ""}`.trim(), "good", "ok") : badge(c.backend === "memory" ? "In app memory" : "Redis unreachable", c.backend === "memory" ? "good" : "warn", c.backend === "memory" ? "memory" : "warn")}</span></div>
    <div class="mt-2 grid grid-cols-3 gap-2 text-center">
      <div><div class="num">${(c.hit_rate * 100).toFixed(0)}%</div><div class="text-[11px] text-ink-3">hit rate</div></div>
      <div><div class="num">${bytes(c.used)}</div><div class="text-[11px] text-ink-3">${c.limit ? `of ${bytes(c.limit)}` : "used"}</div></div>
      <div><div class="num">${c.keys}</div><div class="text-[11px] text-ink-3">entries</div></div>
    </div></div>`;
}

async function loadLogs(reset: boolean): Promise<void> {
  const before = reset || !logs.length ? "" : `&before=${logs[logs.length - 1]!.time}`;
  let r: { items: AppLog[] };
  try {
    r = await get<{ items: AppLog[] }>(`logs?level=${level}&q=${encodeURIComponent(q)}&limit=200${before}`);
  } catch (e) {
    toast(`App log: ${(e as Error).message}`, "bad");
    return;
  }
  logs = reset ? r.items : logs.concat(r.items);
  const box = document.getElementById("hl-logs");
  if (!box) return;
  box.innerHTML = logs.length
    ? logs
        .map(
          (l) =>
            `<div class="flex gap-3 border-b border-line px-4 py-1.5 last:border-0 ${l.level === "error" ? "bg-bad/5" : ""}"><span class="shrink-0 text-ink-3 tabular-nums">${date(l.time)} ${clock(l.time)}</span><span class="${l.level === "error" ? "text-bad" : l.level === "warning" ? "text-warn" : "text-ink-2"} break-all whitespace-pre-wrap">${esc(l.text)}</span></div>`,
        )
        .join("")
    : `<div class="empty">${icon("logs")}No log lines</div>`;
  $("#hl-more").classList.toggle("hidden", r.items.length < 200);
}

const health: View = {
  subtitle: "Accounts, storage and logs",
  mount(el) {
    el.innerHTML = `
    <div class="grid grid-cols-2 gap-4 xl:grid-cols-4" id="hl-tiles">
      <div class="card p-4" id="hl-t1"></div><div class="card p-4" id="hl-t2"></div><div class="card p-4" id="hl-t3"></div><div class="card p-4" id="hl-t4"></div>
    </div>
    <div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
      <section class="card">${cardHead("CPU", "cpu", '<span id="hl-cpu-now" class="num text-sm text-ink"></span>')}<div class="card-b"><div id="hl-cpu" data-chart class="h-[160px]"></div></div></section>
      <section class="card">${cardHead("Memory", "memory", '<span id="hl-mem-now" class="num text-sm text-ink"></span>')}<div class="card-b"><div id="hl-mem" data-chart class="h-[160px]"></div></div></section>
      <section class="card">${cardHead("Disk", "disk", '<span id="hl-io-now" class="text-xs"></span>')}<div class="card-b"><div id="hl-io" data-chart class="h-[160px]"></div></div></section>
    </div>
    <div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-12">
      <section class="card lg:col-span-7">${cardHead("Google accounts", "users", `<button class="btn sm" id="hl-check">${icon("shield")}Check logins</button>`)}<div id="hl-accounts"><div class="skeleton m-4 h-12"></div></div><div class="label border-t border-line px-4 pt-3 pb-1">System checks</div><div id="hl-checks"></div></section>
      <section class="card lg:col-span-5">${cardHead("Storage", "disk")}<div class="px-4 pb-4" id="hl-storage"><div class="skeleton my-3 h-24"></div></div></section>
      <section class="card flex flex-col lg:col-span-12">
        <div class="card-h">${icon("logs", "size-4 text-ink-3")}<span>App log</span><span class="badge">Turso · 30 days</span>
          <div class="sub flex-wrap"><div class="seg" id="hl-level"><button data-l="all" aria-pressed="true">All</button><button data-l="error" aria-pressed="false">Errors</button></div>
          <input class="input h-8 w-40 sm:w-56" id="hl-q" placeholder="Search the log">
          <button class="btn sm" id="hl-dl">${icon("download")}Save</button>
          <a class="btn sm primary" href="api/diagnostics?hours=48" download title="Versions, checks, settings without secrets, and the last 48 hours of log and activity">${icon("code")}Diagnostics (JSON)</a></div></div>
        <div id="hl-logs" class="scroll-thin max-h-[420px] overflow-y-auto font-mono text-xs"></div>
        <div class="border-t border-line p-2 text-center"><button class="btn sm" id="hl-more">${icon("history")}Older</button></div>
      </section>
    </div>`;
    $("#hl-check").addEventListener("click", async (e) => {
      const b = e.currentTarget as HTMLButtonElement;
      b.disabled = true;
      try {
        const r = await post<Record<string, string>>("health/check-login");
        const bad = Object.entries(r).filter(([, v]) => v !== "ok");
        toast(
          bad.length ? `${bad.length} login(s) rejected: ${bad[0]![1]}` : "All logins work",
          bad.length ? "bad" : "good",
        );
        void loadHealth();
      } finally {
        b.disabled = false;
      }
    });
    $("#hl-level").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!b) return;
      level = b.dataset.l ?? "all";
      $$("button", $("#hl-level")).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      void loadLogs(true);
    });
    $<HTMLInputElement>("#hl-q").addEventListener("input", (e) => {
      q = (e.target as HTMLInputElement).value.trim();
      clearTimeout(qTimer);
      qTimer = window.setTimeout(() => void loadLogs(true), 250);
    });
    $("#hl-more").addEventListener("click", () => void loadLogs(false));
    $("#hl-dl").addEventListener("click", () => {
      const text = logs
        .slice()
        .reverse()
        .map((l) => `${new Date(l.time * 1000).toISOString()} ${l.level.toUpperCase()} ${l.text}`)
        .join("\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      a.download = `gp-sync-log-${new Date().toISOString().slice(0, 10)}.txt`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
    void loadHealth();
    void loadLogs(true);
    timer = window.setInterval(loadHealth, 30_000);
  },
  update(s: Status) {
    const r = s.resources;
    const times = r.cpu.map((_, i) => s.now - (r.cpu.length - 1 - i));
    const tf = (t: number) =>
      new Date(t * 1000).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" });
    areaChart($("#hl-cpu"), {
      series: [{ name: "CPU", color: "var(--s1)", values: r.cpu }],
      times,
      timeFormat: tf,
      format: (v) => `${v.toFixed(0)}%`,
      height: 160,
    });
    areaChart($("#hl-mem"), {
      series: [{ name: "Memory", color: "var(--s1)", values: r.mem }],
      times,
      timeFormat: tf,
      format: (v) => bytes(v, 0),
      height: 160,
    });
    areaChart($("#hl-io"), {
      series: [
        { name: "Read", color: "var(--s1)", values: r.read },
        { name: "Write", color: "var(--s2)", values: r.write },
      ],
      times,
      timeFormat: tf,
      format: (v) => `${bytes(v, 0)}/s`,
      height: 160,
    });
    $("#hl-cpu-now").textContent = `${r.cpu_now.toFixed(1)}%`;
    $("#hl-mem-now").textContent = bytes(r.mem_now);
    html(
      $("#hl-io-now"),
      `<span class="flex items-center gap-2"><span class="flex items-center gap-1"><i class="size-2 rounded-full bg-s1"></i>Read ${bytes(r.read_now)}/s</span><span class="flex items-center gap-1"><i class="size-2 rounded-full bg-s2"></i>Write ${bytes(r.write_now)}/s</span></span>`,
    );
    const p = phaseInfo(s);
    const t = (label: string, value: string, sub: string, ic: Parameters<typeof icon>[0]) =>
      `<div class="flex items-center gap-2"><span class="grid size-7 place-items-center rounded-lg bg-panel-2 text-ink-2">${icon(ic)}</span><span class="label">${label}</span></div><div class="mt-2.5 flex flex-wrap items-center gap-1.5">${value}</div><div class="mt-1.5 truncate text-xs text-ink-3">${sub}</div>`;
    html($("#hl-t1"), t("Backup", phaseBadge(s), esc(p.detail), "cloud"));
    html(
      $("#hl-t2"),
      t(
        "Google",
        s.accounts.length
          ? s.login_failed.length
            ? badge(`${s.login_failed.length} login rejected`, "bad", "warn")
            : badge(`${s.accounts.length} account${s.accounts.length > 1 ? "s" : ""} OK`, "good", "ok")
          : badge("No account", "warn", "key"),
        r.latency_now == null ? "Google can't be reached" : `Responds in ${Math.round(r.latency_now)} ms`,
        "users",
      ),
    );
    const d = h?.disk_media;
    html(
      $("#hl-t3"),
      t(
        "Storage",
        d
          ? badge(
              `${bytes(d.free)} free`,
              pct(d.used, d.total) > 90 ? "bad" : pct(d.used, d.total) > 75 ? "warn" : "good",
              "disk",
            )
          : badge("…", ""),
        d ? `${pct(d.used, d.total).toFixed(0)}% of ${bytes(d.total)} used` : "",
        "disk",
      ),
    );
    html(
      $("#hl-t4"),
      t(
        "App",
        badge(`v${s.version}`, "info", "package") +
          badge(`Up ${duration(h?.uptime ?? 0).replace(/ \d+ (s|min)$/, "")}`, "", "clock"),
        `${bytes(r.mem_now)} memory · ${r.cpu_now.toFixed(1)}% CPU`,
        "server",
      ),
    );
  },
  unmount() {
    clearInterval(timer);
  },
};

export default health;
