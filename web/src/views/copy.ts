import {
  get,
  post,
  type CopyCandidate,
  type CopyCandidates,
  type CopyItem,
  type CopyReport,
} from "../lib/api";
import { $, esc, html, toast } from "../lib/dom";
import { ago, bytes, date, num, pct } from "../lib/format";
import { icon, type IconName } from "../lib/icons";
import { status } from "../lib/store";
import { badge, cardHead, tile, type Tone } from "../lib/ui";
import type { View } from "./view";

// Copy one Google account to another: what the second one lacks, original files, nothing deleted.

let src = "";
let dst = "";
let report: CopyReport | null = null;
let request = 0;
let timer = 0;
let ticks = 0;
let kinds = new Set<"photo" | "video">(["photo", "video"]);
let fromYear = "";
let toYear = "";
let mode: "selected" | "all" = "selected";
let selected = new Map<string, CopyCandidate>();
let candidates: CopyCandidates | null = null;
let candidateRequest = 0;
let candidateScope = "";
let candidateError = false;
let wasRefreshing = false;
let offset = 0;
let search = "";

async function loadCandidates(): Promise<void> {
  const mine = ++candidateRequest;
  candidateScope = `${src}\n${dst}`;
  candidates = null;
  candidateError = false;
  render();
  const params = new URLSearchParams({
    src,
    dst,
    kinds: [...kinds].join(",") || "none",
    from_year: fromYear,
    to_year: toYear,
    q: mode === "selected" ? search : "",
    offset: String(offset),
    limit: "60",
  });
  try {
    const result = await get<CopyCandidates>(`copy/items?${params}`);
    if (mine !== candidateRequest) return;
    candidates = result;
  } catch {
    if (mine !== candidateRequest) return;
    candidateError = true;
    toast("Couldn't load items to copy", "bad");
  }
  render();
}

async function load(): Promise<void> {
  const mine = ++request;
  const r = await get<CopyReport>(`copy?src=${encodeURIComponent(src)}&dst=${encodeURIComponent(dst)}`).catch(
    () => null,
  );
  if (mine !== request) return;
  report = r;
  if (r) {
    src = r.src;
    dst = r.dst;
  }
  if (document.activeElement?.id !== "cp-search") render();
  if (wasRefreshing && r && !r.refreshing) candidateScope = "";
  wasRefreshing = !!r?.refreshing;
  if (r?.listed?.src && r.listed.dst && candidateScope !== `${src}\n${dst}`) void loadCandidates();
}

async function act(
  path: string,
  body: Record<string, unknown> = {},
  done?: (r: Record<string, number>) => string,
) {
  try {
    const r = await post<Record<string, number>>(`copy/${path}`, { src, dst, ...body });
    if (done) toast(done(r), "good");
  } catch (e) {
    toast((e as Error).message, "bad");
  }
  void load();
}

const STATES: Record<CopyItem["state"], [string, Tone, IconName]> = {
  queued: ["Waiting", "", "hourglass"],
  copied: ["Copied", "good", "check"],
  done: ["Copied", "good", "verified"],
  exists: ["Duplicate", "info", "copy"],
  failed: ["Didn't work", "bad", "error"],
  counts: ["Counted against storage", "bad", "warn"],
};

const thumbOf = (i: CopyItem) =>
  `<img class="thumb" loading="lazy" decoding="async" alt="" data-kind="${i.kind}" src="api/storage/thumb?account=${encodeURIComponent(src)}&key=${encodeURIComponent(i.key)}">`;

function itemRow(i: CopyItem): string {
  const [label, tone, ic] = STATES[i.state] ?? [i.state, "", "info"];
  return `<div class="row px-4">${thumbOf(i)}
    <div class="min-w-0 flex-1"><div class="truncate text-sm">${esc(i.name)}</div>
      <div class="truncate text-xs ${i.error && !["done", "exists"].includes(i.state) ? "text-bad" : "text-ink-3"}">${i.error && i.state !== "done" ? esc(i.error) : `${i.kind === "video" ? "Video" : "Photo"} · ${i.taken ? date(i.taken, true) : "no date"} · ${bytes(i.size)}`}</div></div>
    ${badge(label, tone, ic)}</div>`;
}

/** Every connected account as a card, on both sides: pick any one as "from" and any as "to". */
function picker(side: "src" | "dst", accs: string[]): string {
  const chosen = side === "src" ? src : dst;
  const other = side === "src" ? dst : src;
  return `<div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Copy ${side === "src" ? "from" : "to"}">${accs
    .map((a) => {
      const on = a === chosen;
      const hint = a === other ? "Picked on the other side: picking it here swaps them" : "";
      return `<button class="flex min-w-0 max-w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition ${on ? "border-accent bg-accent/10" : "border-line hover:bg-panel-2"}" role="radio" aria-checked="${on}" data-side="${side}" data-acc="${esc(a)}" ${hint ? `title="${hint}"` : ""}>
        <span class="grid size-7 shrink-0 place-items-center rounded-full ${on ? "bg-accent text-white" : "bg-panel-2 text-ink-2"} text-xs font-semibold uppercase">${esc(a.slice(0, 1))}</span>
        <span class="min-w-0 truncate ${on ? "font-medium" : a === other ? "text-ink-3" : ""}">${esc(a)}</span>
        ${on ? icon("check", "size-4 shrink-0 text-accent") : ""}</button>`;
    })
    .join("")}</div>`;
}

function selection(r: CopyReport): { count: number; bytes: number } {
  void r;
  return mode === "all"
    ? { count: candidates?.total ?? 0, bytes: candidates?.bytes ?? 0 }
    : { count: selected.size, bytes: [...selected.values()].reduce((n, item) => n + item.size, 0) };
}

let dupOpen = false;

function dupCard(r: CopyReport): string {
  const d = r.duplicates;
  if (!d.count) return "";
  const list = dupOpen ? d.items : d.items.slice(0, 5);
  return `<section class="card overflow-hidden">${cardHead(
    "Duplicates (not copied)",
    "copy",
    `<span class="text-xs text-ink-3">${num(d.count)} · ${bytes(d.bytes)}</span>`,
  )}
    <p class="border-b border-line px-4 py-2.5 text-xs text-ink-3">${esc(r.dst)} already has these, or they are the same file twice in ${esc(r.src)}. They are skipped, so nothing is copied twice.</p>
    <div class="divide-y divide-line">${list.map(itemRow).join("")}</div>
    ${d.items.length > 5 ? `<div class="flex justify-center p-3"><button class="btn sm" id="cp-dups">${dupOpen ? "Show fewer" : `Show ${num(d.items.length - 5)} more`}</button></div>` : ""}
  </section>`;
}

function startCard(r: CopyReport): string {
  const years = Object.keys(r.years);
  const sel = selection(r);
  const opt = (cur: string) =>
    `<option value="">Any</option>${years.map((y) => `<option ${y === cur ? "selected" : ""}>${y}</option>`).join("")}`;
  return `<section class="card self-start">${cardHead("What to copy", "sliders")}
    <div class="card-b space-y-4">
      <div class="seg"><button data-mode="selected" aria-pressed="${mode === "selected"}">Choose items</button><button data-mode="all" aria-pressed="${mode === "all"}">All matching</button></div>
      <div class="flex flex-wrap gap-2" id="cp-kinds">${(["photo", "video"] as const)
        .map(
          (k) =>
            `<button class="chip" data-kind="${k}" aria-pressed="${kinds.has(k)}">${icon(k === "photo" ? "photo" : "video")}${k === "photo" ? "Photos" : "Videos"} · ${num(r.todo[k].count)}</button>`,
        )
        .join("")}</div>
      ${
        years.length > 1
          ? `<div class="grid grid-cols-2 gap-2 text-sm"><label><span class="text-ink-3">From year</span><select class="input mt-1" id="cp-from">${opt(fromYear)}</select></label>
             <label><span class="text-ink-3">To year</span><select class="input mt-1" id="cp-to">${opt(toYear)}</select></label></div>`
          : ""
      }
      <div class="rounded-xl bg-panel-2 p-3 text-sm"><b>${num(sel.count)}</b> item${sel.count === 1 ? "" : "s"} · ${bytes(sel.bytes)} from <b>${esc(r.src)}</b> to <b>${esc(r.dst)}</b>.</div>
      <button class="btn primary w-full justify-center" id="cp-start" ${sel.count ? "" : "disabled"}>${icon("copy")}Start copying</button>
      <p class="text-xs text-ink-3">Copies keep quality, date, favourite, archive and caption. Nothing is deleted. Albums aren't copied.</p>
    </div></section>`;
}

function pickerCard(): string {
  if (mode !== "selected") return "";
  const page = candidates;
  return `<section class="card overflow-hidden">${cardHead(
    "Choose photos and videos",
    "library",
    `<span class="text-xs text-ink-3">${num(selected.size)} selected</span>`,
  )}
    <div class="flex flex-wrap gap-2 border-b border-line p-4">
      <label class="min-w-0 flex-1"><span class="sr-only">Search filenames</span><input class="input" id="cp-search" placeholder="Search filenames" value="${esc(search)}"></label>
      <button class="btn sm" id="cp-search-go">Search</button>
      <button class="btn sm" id="cp-select-page" ${page?.items.length ? "" : "disabled"}>Select page</button>
      <button class="btn sm" id="cp-clear" ${selected.size ? "" : "disabled"}>Clear selection</button>
    </div>
    ${
      !page
        ? candidateError
          ? `<div class="empty">Couldn't load items <button class="btn sm" id="cp-reload">Try again</button></div>`
          : `<div class="empty">Loading items…</div>`
        : page.items.length
          ? `<div class="grid grid-cols-2 gap-2 p-4 sm:grid-cols-3 lg:grid-cols-4">${page.items
              .map(
                (i) =>
                  `<button class="overflow-hidden rounded-xl border text-left ${selected.has(i.key) ? "border-accent bg-accent/10" : "border-line"}" data-item="${esc(i.key)}" aria-pressed="${selected.has(i.key)}">
          <div class="relative aspect-square overflow-hidden bg-panel-2"><img class="size-full object-cover" loading="lazy" alt="" src="api/storage/thumb?account=${encodeURIComponent(src)}&key=${encodeURIComponent(i.key)}"><span class="absolute right-2 top-2 rounded-full bg-panel-2 p-1">${icon(selected.has(i.key) ? "check" : i.kind === "video" ? "video" : "photo")}</span></div>
          <span class="block truncate px-2 pt-2 text-sm">${esc(i.name)}</span><span class="block truncate px-2 pb-2 text-xs text-ink-3">${i.taken ? date(i.taken, true) : "No date"} · ${bytes(i.size)}</span></button>`,
              )
              .join("")}</div>`
          : `<div class="empty">No items match</div>`
    }
    ${page && page.total > 60 ? `<div class="flex items-center justify-between border-t border-line p-3"><button class="btn sm" id="cp-prev" ${offset ? "" : "disabled"}>Previous</button><span class="text-xs text-ink-3">${num(offset + 1)}–${num(Math.min(offset + 60, page.total))} of ${num(page.total)}</span><button class="btn sm" id="cp-next" ${offset + 60 < page.total ? "" : "disabled"}>Next</button></div>` : ""}
    </section>`;
}

function progressCard(r: CopyReport): string {
  const j = r.jobs;
  const total = j.copied + j.exists + j.failed + j.counts + j.queued;
  if (!total && !r.current) return "";
  const done = total - j.queued;
  const cur = r.current;
  return `<section class="card">${cardHead(
    r.paused ? "Paused" : j.queued || cur ? "Copying" : "Finished",
    r.paused ? "pause" : j.queued || cur ? "loader" : "ok",
    `${j.queued || cur || r.paused ? `<button class="btn sm" id="cp-pause">${icon(r.paused ? "play" : "pause")}${r.paused ? "Resume" : "Pause"}</button>` : ""}${j.queued || cur ? `<button class="btn sm" id="cp-stop">${icon("x")}Stop</button>` : ""}${j.failed ? `<button class="btn sm" id="cp-retry">${icon("retry")}Retry ${num(j.failed)} failed</button>` : ""}`,
  )}
    <div class="card-b space-y-3">
      <div class="flex items-center justify-between text-sm"><span>${num(done)} of ${num(total)} done</span><span class="text-ink-3 tabular-nums">${Math.floor(pct(done, total))}%</span></div>
      <div class="bar"><i style="width:${pct(done, total)}%"></i></div>
      ${cur ? `<div class="rounded-xl bg-panel-2 p-3 text-sm"><div class="flex items-center gap-2">${icon(cur.step === "downloading" ? "download" : "upload", "size-4 text-ink-3")}<span class="truncate">${cur.step === "downloading" ? "Downloading" : "Uploading"} ${esc(cur.name)}</span><span class="ml-auto shrink-0 text-xs text-ink-3">${bytes(cur.done)} / ${bytes(cur.total)}</span></div><div class="bar mt-2"><i style="width:${pct(cur.done, cur.total)}%"></i></div></div>` : ""}
      <div class="flex flex-wrap gap-1.5">${badge(`${num(j.copied)} copied · ${bytes(j.copied_bytes)}`, "good", "check")}${j.exists ? badge(`${num(j.exists)} already there`, "info", "verified") : ""}${j.failed ? badge(`${num(j.failed)} didn't work`, "bad", "error") : ""}${j.queued ? badge(`${num(j.queued)} waiting · ${bytes(j.queued_bytes)}`, "", "hourglass") : ""}</div>
      ${j.copied ? `<p class="text-xs text-ink-3">${num(j.verified)} of ${num(j.copied)} checked with Google: they don't count against ${esc(r.dst)}'s storage.</p>` : ""}
    </div></section>`;
}

function render(): void {
  const accs = status()?.accounts ?? report?.accounts ?? [];
  const r = report;
  if (accs.length < 2) {
    html(
      $("#cp-body"),
      `<section class="card p-6 text-center"><div class="mx-auto max-w-lg space-y-2">${icon("users", "mx-auto size-8 text-ink-3")}
        <div class="text-base font-medium">Connect a second Google account</div>
        <p class="text-sm text-ink-3">Connect a second Google account to copy between them.</p>
        <a class="btn primary mt-2" href="#/settings/accounts">${icon("plus")}Add an account</a></div></section>`,
    );
    $("#cp-bar").classList.add("hidden"); // nothing to pick with one account
    return;
  }
  const max = status()?.max_accounts ?? 5;
  $("#cp-bar").classList.remove("hidden");
  html(
    $("#cp-bar"),
    `<div class="grid gap-4 p-4 lg:grid-cols-[1fr_auto_1fr] lg:items-start">
       <div class="min-w-0"><div class="label mb-2">Copy from</div>${picker("src", accs)}</div>
       <button class="btn icon self-center justify-self-center" id="cp-swap" title="Swap from and to" aria-label="Swap from and to">${icon("refresh")}</button>
       <div class="min-w-0"><div class="label mb-2">Copy to</div>${picker("dst", accs)}</div>
     </div>
     <div class="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 text-xs text-ink-3">
       <span>${num(accs.length)} of ${num(max)} accounts connected${accs.length < max ? ` · <a class="link-btn" href="#/settings/accounts">Add an account</a>` : ""}</span>
       <span class="ml-auto">${r?.refreshed?.src ? `Libraries read ${ago(Math.min(r.refreshed.src, r.refreshed.dst ?? r.refreshed.src))}` : ""}</span>
       <button class="btn sm" id="cp-refresh" ${r?.refreshing ? "disabled" : ""}>${r?.refreshing ? `${icon("loader", "spin")}Reading libraries…` : `${icon("refresh")}${r?.listed?.src && r.listed.dst ? "Refresh from Google" : "Read both libraries"}`}</button>
     </div>`,
  );
  if (!r || r.ready === false) {
    html($("#cp-body"), `<div class="card empty">${icon("warn")}Couldn't load</div>`);
    return;
  }
  if (!r.listed.src || !r.listed.dst) {
    html(
      $("#cp-body"),
      `<section class="card p-6 text-center"><div class="mx-auto max-w-lg space-y-2">${icon("library", "mx-auto size-8 text-ink-3")}
        <div class="text-base font-medium">Read both libraries first</div>
        <p class="text-sm text-ink-3">GP Sync reads the list of photos in both accounts (nothing is changed) to find what ${esc(r.dst)} doesn't have yet. The first read can take a few minutes for a big library.</p>
        ${r.error ? `<p class="text-sm text-bad">${esc(r.error)}</p>` : ""}</div></section>`,
    );
    return;
  }
  const todo = r.todo.photo.count + r.todo.video.count;
  html(
    $("#cp-body"),
    `${r.jobs.counts && r.paused ? `<section class="card mb-4 flex items-start gap-3 border-bad/40 p-4">${icon("warn", "size-5 shrink-0 text-bad")}<div class="text-sm"><div class="font-medium">Paused: Google counted a copy against ${esc(r.dst)}'s storage</div><div class="mt-0.5 text-ink-3">Copies would use that account's storage. Nothing was deleted.</div></div></section>` : ""}
    ${r.error ? `<section class="card mb-4 p-4 text-sm text-warn">${esc(r.error)} Copying goes on by itself when it's back.</section>` : ""}
    <div class="grid grid-cols-2 gap-4 xl:grid-cols-4">
      ${tile({ label: "In " + r.src.split("@")[0], value: num(r.src_total), ic: "library", sub: "Photos and videos it owns" })}
      ${tile({ label: "Duplicates found", value: num(r.duplicates.count), ic: "copy", sub: r.duplicates.count ? `${bytes(r.duplicates.bytes)} · not copied` : "None so far" })}
      ${tile({ label: "Still to copy", value: num(todo), ic: "copy", sub: bytes(r.todo.photo.bytes + r.todo.video.bytes) })}
      ${tile({ label: "Copied", value: num(r.jobs.copied), ic: "check", sub: bytes(r.jobs.copied_bytes), tone: r.jobs.copied ? "good" : "" })}
    </div>
    <div class="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[22rem_1fr]">
      ${startCard(r)}
      <div class="min-w-0 space-y-4">
        ${pickerCard()}
        ${progressCard(r)}
        ${r.failed.length ? `<section class="card overflow-hidden">${cardHead("Didn't work", "error")}<div class="divide-y divide-line">${r.failed.slice(0, 20).map(itemRow).join("")}</div></section>` : ""}
        ${dupCard(r)}
        <section class="card overflow-hidden">${cardHead("Latest", "history")}${
          r.recent.length
            ? `<div class="divide-y divide-line">${r.recent.map(itemRow).join("")}</div>`
            : `<div class="empty">${icon("copy")}Nothing copied yet</div>`
        }</section>
      </div>
    </div>`,
  );
}

function onClick(e: Event): void {
  const b = (e.target as HTMLElement).closest<HTMLElement>("button");
  if (!b) return;
  if (b.id === "cp-refresh") void act("refresh", {}, () => "Reading both libraries from Google");
  else if (b.dataset.side && b.dataset.acc) {
    const acc = b.dataset.acc;
    const side = b.dataset.side;
    if (side === "src" && acc !== src) [src, dst] = acc === dst ? [acc, src] : [acc, dst];
    else if (side === "dst" && acc !== dst) [src, dst] = acc === src ? [dst, acc] : [src, acc];
    else return;
    selected.clear();
    fromYear = "";
    toYear = "";
    offset = 0;
    search = "";
    candidates = null;
    candidateScope = "";
    candidateRequest++;
    void load();
  } else if (b.id === "cp-swap") {
    [src, dst] = [dst, src];
    selected.clear();
    fromYear = "";
    toYear = "";
    offset = 0;
    search = "";
    candidates = null;
    candidateScope = "";
    candidateRequest++;
    void load();
  } else if (b.dataset.mode) {
    mode = b.dataset.mode === "all" ? "all" : "selected";
    offset = 0;
    void loadCandidates();
  } else if (b.dataset.item) {
    const item = candidates?.items.find((i) => i.key === b.dataset.item);
    if (item) {
      if (selected.has(item.key)) selected.delete(item.key);
      else if (selected.size < 5000) selected.set(item.key, item);
      else toast("Choose at most 5,000 items at a time", "bad");
      render();
    }
  } else if (b.id === "cp-select-page") {
    for (const item of candidates?.items ?? []) {
      if (selected.size >= 5000) break;
      selected.set(item.key, item);
    }
    render();
  } else if (b.id === "cp-clear") {
    selected.clear();
    render();
  } else if (b.id === "cp-search-go") {
    search = ($("#cp-search") as HTMLInputElement).value.trim();
    offset = 0;
    void loadCandidates();
  } else if (b.id === "cp-reload") {
    void loadCandidates();
  } else if (b.id === "cp-prev" || b.id === "cp-next") {
    offset = Math.max(0, offset + (b.id === "cp-next" ? 60 : -60));
    void loadCandidates();
  } else if (b.dataset.kind) {
    const k = b.dataset.kind as "photo" | "video";
    if (kinds.has(k)) kinds.delete(k);
    else kinds.add(k);
    selected.clear();
    offset = 0;
    void loadCandidates();
  } else if (b.id === "cp-start") {
    const sel = report ? selection(report) : { count: 0, bytes: 0 };
    if (
      !confirm(
        `Copy ${num(sel.count)} items (${bytes(sel.bytes)}) from ${src} to ${dst}?\n\nNothing is deleted in either account.`,
      )
    )
      return;
    void (async () => {
      try {
        const result = await post<{ queued: number }>("copy/start", {
          src,
          dst,
          kinds: [...kinds],
          from_year: fromYear || null,
          to_year: toYear || null,
          ...(mode === "selected" ? { keys: [...selected.keys()] } : {}),
        });
        toast(`${num(result.queued)} item${result.queued === 1 ? "" : "s"} queued`, "good");
        selected.clear();
        offset = 0;
        await load();
        await loadCandidates();
      } catch (e) {
        toast((e as Error).message, "bad");
      }
    })();
  } else if (b.id === "cp-pause") void act("pause", { paused: !report?.paused });
  else if (b.id === "cp-stop") {
    if (confirm("Stop copying? What's already copied stays. The rest is taken off the list."))
      void act("stop", {}, (r) => `${num(r.removed ?? 0)} taken off the list`);
  } else if (b.id === "cp-dups") {
    dupOpen = !dupOpen;
    render();
  } else if (b.id === "cp-retry") void act("retry", {}, (r) => `${num(r.queued ?? 0)} queued again`);
}

const copyView: View = {
  subtitle: "Copy items between Google accounts",
  mount(el) {
    kinds = new Set(["photo", "video"]);
    fromYear = "";
    toYear = "";
    mode = "selected";
    selected.clear();
    candidates = null;
    candidateScope = "";
    wasRefreshing = false;
    offset = 0;
    search = "";
    el.innerHTML = `
    <section class="card mb-4 hidden" id="cp-bar"></section>
    <div id="cp-body"><div class="grid grid-cols-2 gap-4 xl:grid-cols-4">${'<div class="card skeleton h-28"></div>'.repeat(4)}</div><div class="card skeleton mt-4 h-72"></div></div>`;
    el.addEventListener("click", onClick);
    el.addEventListener("change", (e) => {
      const t = e.target as HTMLSelectElement;
      if (t.id === "cp-from") fromYear = t.value;
      else if (t.id === "cp-to") toYear = t.value;
      else return;
      selected.clear();
      offset = 0;
      void loadCandidates();
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.target as HTMLElement).id === "cp-search") {
        e.preventDefault();
        document.getElementById("cp-search-go")?.click();
      }
    });
    void load();
    timer = window.setInterval(() => {
      const r = report;
      const active = r?.refreshing || r?.current || (r?.jobs.queued && !r.paused);
      if (active || ++ticks % 7 === 0) void load(); // busy: every 3 s, else every 20 s
    }, 3000);
  },
  unmount() {
    clearInterval(timer);
    request++;
    candidateRequest++;
  },
};

export default copyView;
