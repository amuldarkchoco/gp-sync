import { get, post, type LogItem, type Status } from "../lib/api";
import { $, $$, esc, html, toast } from "../lib/dom";
import { ago, bytes, clock, dayLabel, fileName, folderOf, num } from "../lib/format";
import { icon } from "../lib/icons";
import { refresh } from "../lib/store";
import { badge, cardHead, eventMeta, openAttrs, thumb } from "../lib/ui";
import type { View } from "./view";

const FILTERS: [string, string, string][] = [
  ["all", "All", "layers"],
  ["uploaded", "Uploaded", "cloudUp"],
  ["exists", "Already in Google", "verified"],
  ["failed", "Problems", "warn"],
  ["system", "System", "settings"],
];

let kind = "all";
let query = "";
let items: LogItem[] = [];
let more = true;
let newest = 0;
let searchTimer = 0;

async function load(reset: boolean): Promise<void> {
  const before = reset || !items.length ? "" : `&before=${items[items.length - 1]!.time}`;
  const r = await get<{ items: LogItem[] }>(
    `activity?kind=${kind}&q=${encodeURIComponent(query)}&limit=100${before}`,
  );
  items = reset ? r.items : items.concat(r.items);
  more = r.items.length === 100;
  newest = items[0]?.time ?? 0;
  render();
}

function render(): void {
  const list = document.getElementById("act-list");
  if (!list) return;
  if (!items.length) {
    list.innerHTML = `<div class="empty">${icon("inbox")}${query ? "Nothing matches your search" : "No activity here yet"}</div>`;
  } else {
    let lastDay = "";
    list.innerHTML = items
      .map((l) => {
        const day = dayLabel(l.time);
        const head =
          day !== lastDay
            ? `<div class="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-bg/90 px-4 py-2 text-xs font-semibold text-ink-2 backdrop-blur">${icon("calendar", "size-3.5 text-ink-3")}${esc(day)}</div>`
            : "";
        lastDay = day;
        const m = eventMeta[l.kind] ?? eventMeta.info!;
        const lead = l.name
          ? thumb(l.name)
          : `<span class="thumb grid place-items-center text-ink-3">${icon(m.icon, "size-4")}</span>`;
        const title = l.name ? fileName(l.name) : l.text;
        const sub = l.name
          ? `${folderOf(l.name)}${l.kind === "failed" ? " · " + l.text.split(": ").slice(1).join(": ") : ""}`
          : "";
        return `${head}<div class="row ${l.name ? "clickable" : ""}" ${l.name ? openAttrs(l.name, true) : ""}><span class="w-11 shrink-0 text-[11px] leading-tight text-ink-3 tabular-nums sm:w-16 sm:text-xs">${clock(l.time)}</span>${lead}
          <div class="min-w-0 flex-1"><div class="truncate text-sm" title="${esc(l.text)}">${esc(title)}</div>${sub ? `<div class="truncate text-xs text-ink-3">${esc(sub)}</div>` : ""}</div>
          <span class="badge ${m.tone}" title="${esc(m.label)}">${icon(m.icon)}<span class="hidden sm:inline">${esc(m.label)}</span></span></div>`;
      })
      .join("");
  }
  $("#act-more").classList.toggle("hidden", !more || !items.length);
}

const activity: View = {
  subtitle: "Everything the app did, saved for 90 days",
  mount(el, args) {
    kind = FILTERS.some(([k]) => k === args[0]) ? (args[0] as string) : "all";
    query = "";
    el.innerHTML = `
    <div class="grid grid-cols-1 gap-4 xl:grid-cols-12">
      <section class="card flex min-h-[70vh] flex-col overflow-hidden xl:col-span-8">
        <div class="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <div class="seg" id="act-filter">${FILTERS.map(([k, l, ic]) => `<button data-k="${k}" aria-pressed="${k === kind}">${icon(ic as "layers")}${l}</button>`).join("")}</div>
          <label class="relative ml-auto w-full sm:w-64">${icon("search", "absolute top-3 left-3 size-4 text-ink-3")}<input class="input pl-9" id="act-q" placeholder="Search files and messages"></label>
        </div>
        <div id="act-list" class="scroll-thin flex-1 overflow-y-auto" data-gallery><div class="space-y-2 p-4">${'<div class="skeleton h-10"></div>'.repeat(6)}</div></div>
        <div class="border-t border-line p-3 text-center"><button class="btn sm" id="act-more">${icon("history")}Load older</button></div>
      </section>
      <div class="flex flex-col gap-4 xl:col-span-4">
        <section class="card">${cardHead("Problems", "warn", '<button class="btn sm" id="act-retry">' + icon("retry") + "Retry all</button>")}<div id="act-failed" data-gallery></div></section>
        <section class="card">${cardHead("Totals", "chart")}<div class="grid grid-cols-2 gap-2 p-4" id="act-totals"></div></section>
      </div>
    </div>`;
    $("#act-filter").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!b) return;
      kind = b.dataset.k ?? "all";
      $$("button", $("#act-filter")).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      void load(true);
    });
    $<HTMLInputElement>("#act-q").addEventListener("input", (e) => {
      query = (e.target as HTMLInputElement).value.trim();
      clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => void load(true), 250);
    });
    $("#act-more").addEventListener("click", () => void load(false));
    $("#act-retry").addEventListener("click", async () => {
      await post("retry");
      toast("Failed files will be tried again now", "good");
      void refresh();
    });
    void load(true);
  },
  update(s: Status) {
    html(
      $("#act-failed"),
      s.failed.length
        ? s.failed
            .slice(0, 8)
            .map(
              (f) =>
                `<div class="row clickable" ${openAttrs(f.name, true)}>${thumb(f.name)}<div class="min-w-0 flex-1"><div class="truncate text-sm">${esc(fileName(f.name))}</div><div class="truncate text-xs text-ink-3" title="${esc(f.error)}">${esc(f.error)}</div></div>${badge(`${f.attempts}×`, f.attempts >= 5 ? "bad" : "warn", undefined, f.attempts >= 5 ? "Gave up after 5 tries" : "Attempts so far")}</div>`,
            )
            .join("") +
            (s.counts.failed > 8
              ? `<div class="px-4 py-2 text-xs text-ink-3">and ${s.counts.failed - 8} more</div>`
              : "")
        : `<div class="empty">${icon("shield")}No problems</div>`,
    );
    $("#act-retry").classList.toggle("hidden", !s.failed.length);
    const t: [string, string, string][] = [
      ["Uploaded", num(s.counts.uploaded), "cloudUp"],
      ["Already in Google", num(s.counts.exists), "verified"],
      ["Failed", num(s.counts.failed), "error"],
      ["This session", `${num(s.session.uploaded_files)} · ${bytes(s.session.uploaded_bytes)}`, "timer"],
    ];
    html(
      $("#act-totals"),
      t
        .map(
          ([l, v, ic]) =>
            `<div class="stat-tile"><div class="flex items-center gap-1.5 text-xs text-ink-3">${icon(ic as "cloudUp", "size-3.5")}${l}</div><div class="num truncate text-lg">${v}</div></div>`,
        )
        .join("") + `<div class="col-span-2 text-xs text-ink-3">Last scan ${ago(s.last_scan, s.now)}</div>`,
    );
    // New entries arrived: refresh the first page quietly when the user is at the top.
    const top = s.log[0]?.time ?? 0;
    const list = document.getElementById("act-list");
    if (top > newest && list && list.scrollTop < 40 && !query) void load(true);
  },
  route(args) {
    const k = args[0];
    if (k && k !== kind) {
      kind = k;
      $$("button", $("#act-filter")).forEach((x) =>
        x.setAttribute("aria-pressed", String(x.dataset.k === kind)),
      );
      void load(true);
    }
  },
};

export default activity;
