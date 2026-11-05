import { get, post, type DateItem, type DatesReport } from "../lib/api";
import { $, esc, html, toast } from "../lib/dom";
import { ago, fileName, folderOf, num, pct } from "../lib/format";
import { icon } from "../lib/icons";
import { status } from "../lib/store";
import { badge, openAttrs, thumb, tile, type Tone } from "../lib/ui";
import type { View } from "./view";

// Fix dates: photos and videos with no date of their own get their date in Google Photos from the
// upload. When that date is wrong, the user deletes the item in Google Photos and GP Sync uploads it
// again with the right one (a date the user picks, or the earliest identical copy on the server).

let account = "";
let report: DatesReport | null = null;
let show: "wrong" | "all" = "wrong";
let shown = 60;
let editing = "";
let timer = 0;
let ticks = 0;
let request = 0;
const picked = new Set<string>();

async function load(): Promise<void> {
  const mine = ++request;
  const r = await get<DatesReport>(`dates?account=${encodeURIComponent(account)}`).catch(() => null);
  if (mine !== request) return;
  report = r;
  if (r && !account) account = r.account;
  render();
}

async function act(path: string, body: Record<string, unknown>, done?: string): Promise<void> {
  try {
    await post(`dates/${path}`, { account, ...body });
    if (done) toast(done, "good");
  } catch (e) {
    toast((e as Error).message, "bad");
  }
  void load();
}

/** "5 Nov 2026, 18:47" in the viewer's time zone. */
function when(unix: number | null): string {
  if (unix == null) return "unknown";
  return new Date(unix * 1000).toLocaleString([], {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Value for <input type="datetime-local"> (local time). */
function localInput(unix: number): string {
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const SOURCE: Record<DateItem["source"], string> = {
  manual: "the date you picked",
  copy: "the earliest identical copy here",
  file: "the file's time on this server",
  google: "Google Photos (earlier than any copy here)",
};

function stateOf(i: DateItem, r: DatesReport): { label: string; tone: Tone; ic: Parameters<typeof icon>[0] } {
  if (r.current?.key === i.name) return { label: "Uploading", tone: "info", ic: "upload" };
  switch (i.fix) {
    case "waiting":
      return { label: "Delete it in Google Photos", tone: "warn", ic: "external" };
    case "in_google":
      return { label: "Still in Google's Trash", tone: "warn", ic: "trash" };
    case "done":
      return i.wrong
        ? { label: "Date wrong again", tone: "bad", ic: "warn" }
        : { label: "Fixed", tone: "good", ic: "ok" };
    case "failed":
      return { label: "Didn't work", tone: "bad", ic: "error" };
    default:
      return i.wrong
        ? { label: "Wrong date", tone: "warn", ic: "calendar" }
        : { label: "", tone: "", ic: "info" };
  }
}

function actions(i: DateItem, r: DatesReport): string {
  const open = i.google_url
    ? `<a class="btn sm primary" href="${esc(i.google_url)}" target="_blank" rel="noopener">${icon("external")}Open in Google Photos</a>`
    : "";
  const cancel = `<button class="btn icon sm" data-cancel="${esc(i.name)}" title="Stop waiting (nothing changes in Google)" aria-label="Cancel">${icon("x")}</button>`;
  const edit = `<button class="btn sm" data-edit="${esc(i.name)}">${icon("calendar")}Set date</button>`;
  if (r.current?.key === i.name) return "";
  switch (i.fix) {
    case "waiting":
    case "in_google":
      return `${open}${cancel}`;
    case "failed":
      return `${edit}<button class="btn sm" data-fix="${esc(i.name)}">${icon("retry")}Try again</button>${cancel}`;
    default:
      return `${edit}${i.wrong ? `<button class="btn sm" data-fix="${esc(i.name)}">${icon("retry")}Fix</button>` : ""}`;
  }
}

function editor(i: DateItem): string {
  return `<div class="mt-2 flex flex-wrap items-center gap-2" data-editor="${esc(i.name)}">
    <input type="datetime-local" class="input w-auto" id="dt-input" value="${localInput(i.best)}" max="${localInput(Date.now() / 1000)}">
    <button class="btn sm primary" data-save="${esc(i.name)}">${icon("ok")}Save</button>
    ${i.manual ? `<button class="btn sm" data-auto="${esc(i.name)}">${icon("refresh")}Back to automatic</button>` : ""}
    <button class="btn sm" data-close>Cancel</button>
  </div>`;
}

function row(i: DateItem, r: DatesReport): string {
  const s = stateOf(i, r);
  const cur = r.current?.key === i.name ? r.current : null;
  const canPick = i.wrong && (i.fix === "" || i.fix === "failed" || i.fix === "done");
  const hint =
    i.fix === "waiting"
      ? "Delete it in Google Photos, then empty it from Google's Trash. GP Sync then uploads it again with the right date (checks every 2 minutes)."
      : i.fix === "in_google"
        ? "Google still has it. Open Google Photos › Library › Trash and delete it there too."
        : i.error;
  return `<div class="row flex-wrap items-start px-4 py-3 sm:flex-nowrap" data-gallery>
    ${canPick ? `<input type="checkbox" class="mt-3 size-4 accent-[var(--accent)]" data-pick="${esc(i.name)}" ${picked.has(i.name) ? "checked" : ""} aria-label="Pick ${esc(fileName(i.name))}">` : '<span class="w-4 shrink-0"></span>'}
    <span class="clickable" ${openAttrs(i.name)}>${thumb(i.name)}</span>
    <div class="min-w-0 flex-1 basis-48">
      <div class="flex flex-wrap items-center gap-2"><span class="truncate text-sm font-medium" title="${esc(i.name)}">${esc(fileName(i.name))}</span>${s.label ? badge(s.label, s.tone, s.ic) : ""}${i.kind === "video" ? `<span class="badge">${icon("video")}</span>` : ""}</div>
      <div class="truncate text-xs text-ink-3">${esc(folderOf(i.name))}</div>
      <div class="mt-1 grid gap-0.5 text-xs sm:grid-cols-2">
        <span class="text-ink-3">Google Photos shows <b class="${i.wrong ? "text-warn" : "text-ink-2"}">${esc(when(i.google))}</b></span>
        <span class="text-ink-3">Should be <b class="text-ink-2">${esc(when(i.best))}</b> · from ${SOURCE[i.source]}</span>
      </div>
      ${cur ? `<div class="bar mt-2"><i style="width:${pct(cur.done, cur.total)}%"></i></div>` : ""}
      ${hint ? `<div class="mt-1 text-xs ${i.fix === "failed" ? "text-bad" : "text-ink-3"}">${esc(hint)}</div>` : ""}
      ${editing === i.name ? editor(i) : ""}
    </div>
    <div class="flex w-full shrink-0 flex-wrap items-center justify-end gap-1.5 empty:hidden sm:w-auto">${actions(i, r)}</div>
  </div>`;
}

function render(): void {
  const r = report;
  const accs = status()?.accounts ?? [];
  html(
    $("#dt-acc"),
    accs.length > 1
      ? `<select class="input w-auto" id="dt-account">${accs.map((a) => `<option ${a === account ? "selected" : ""}>${esc(a)}</option>`).join("")}</select>`
      : `<span class="text-sm text-ink-2">${esc(account || "No account")}</span>`,
  );
  if (!r || !r.account) {
    html(
      $("#dt-body"),
      `<div class="card empty">${icon("users")}Connect a Google account first (Settings › Google accounts)</div>`,
    );
    return;
  }
  html(
    $("#dt-refresh"),
    r.refreshing
      ? `${icon("loader", "spin")}Reading your library…`
      : `${icon("refresh")}Check dates with Google`,
  );
  ($("#dt-refresh") as HTMLButtonElement).disabled = r.refreshing;
  html(
    $("#dt-when"),
    r.refreshed ? `Checked with Google ${ago(r.refreshed)}` : "Not checked with Google yet",
  );
  const list = show === "wrong" ? r.items.filter((i) => i.wrong || i.fix) : r.items;
  const fixable = r.items.filter((i) => i.wrong && (i.fix === "" || i.fix === "failed"));
  html(
    $("#dt-body"),
    `${r.error ? `<section class="card mb-4 p-4 text-sm text-bad">${esc(r.error)}</section>` : ""}
    <div class="grid grid-cols-2 gap-4 xl:grid-cols-4">
      ${tile({ label: "No date inside", value: num(r.undated), ic: "calendar", sub: `Already uploaded · ${num(r.checked)} checked` })}
      ${tile({ label: "Wrong date in Google", value: num(r.wrong), ic: "warn", sub: r.wrong ? "Fix them below" : "All match", tone: r.wrong ? "warn" : "good" })}
      ${tile({ label: "Waiting for you", value: num(r.waiting), ic: "hourglass", sub: r.waiting ? "Delete them in Google Photos" : "Nothing to delete" })}
      ${tile({ label: "Album", value: r.album ? esc(r.album) : "Off", ic: "library", sub: `<a class="underline" href="#/settings/albums">Change in Settings</a>` })}
    </div>
    <div class="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[22rem_1fr]">
      <section class="card order-2 self-start xl:order-none"><div class="card-h">${icon("info", "size-4 text-ink-3")}<span>How dates work</span></div>
        <div class="card-b space-y-3 text-sm">
          <p class="text-ink-2">Google Photos dates a photo by the date saved <b>inside</b> it. Snapchat saves, screenshots and chat pictures have none, so Google uses the date sent with the upload.</p>
          <p class="text-ink-3">GP Sync now sends the best date it knows: one you pick, or else the earliest identical copy on ${esc(status()?.host ?? "this server")}. Snapchat Memories saved again later carry the save day, so set those by hand.</p>
        </div>
        <ol class="space-y-3 border-t border-line p-4 text-sm">
          <li class="flex gap-3"><span class="grid size-6 shrink-0 place-items-center rounded-full bg-panel-2 text-xs">1</span><span><b>Check the date</b> and change it with Set date if you remember better.</span></li>
          <li class="flex gap-3"><span class="grid size-6 shrink-0 place-items-center rounded-full bg-panel-2 text-xs">2</span><span><b>Press Fix</b>, then delete the item in Google Photos with the link and empty it from Google's Trash. GP Sync never deletes anything in Google.</span></li>
          <li class="flex gap-3"><span class="grid size-6 shrink-0 place-items-center rounded-full bg-panel-2 text-xs">3</span><span><b>GP Sync notices</b> within 2 minutes and uploads it again from ${esc(status()?.host ?? "this server")} with the right date.</span></li>
        </ol>
        <div class="border-t border-line px-4 py-3 text-xs text-ink-3">Comes back: original quality, favourite, archive, caption and GP Sync's own albums. Doesn't come back: albums you made in Google Photos, shared links and comments.</div>
      </section>
      <section class="card min-w-0 overflow-hidden">
        <div class="card-h">${icon("clock", "size-4 text-ink-3")}<span>Files without a date</span><div class="sub">
          <div class="seg" id="dt-show"><button data-show="wrong" aria-pressed="${show === "wrong"}">Wrong (${num(r.wrong)})</button><button data-show="all" aria-pressed="${show === "all"}">All (${num(r.undated)})</button></div>
          <button class="btn sm" id="dt-picked" ${picked.size ? "" : "disabled"}>${icon("retry")}Fix picked (${picked.size})</button>
          <button class="btn sm" id="dt-all" ${fixable.length ? "" : "disabled"}>${icon("retry")}Fix all wrong</button>
        </div></div>
        ${
          r.refreshed
            ? ""
            : `<p class="border-b border-line px-4 py-2.5 text-xs text-ink-3">${icon("info", "inline size-3.5 -mt-0.5")} Dates of files that were already in Google before GP Sync uploaded them show as unknown until you press Check dates with Google.</p>`
        }
        ${
          list.length
            ? `<div class="divide-y divide-line">${list
                .slice(0, shown)
                .map((i) => row(i, r))
                .join(
                  "",
                )}</div>${list.length > shown ? `<div class="flex justify-center p-3"><button class="btn" id="dt-more">${icon("plus")}Show more (${num(list.length - shown)} left)</button></div>` : ""}`
            : `<div class="empty">${icon("shield")}${show === "wrong" ? "Every date matches" : "Every uploaded file has its own date"}</div>`
        }
      </section>
    </div>`,
  );
}

function fixList(names: string[]): void {
  if (!names.length) return;
  void act(
    "fix",
    { paths: names },
    `${num(names.length)} waiting: delete ${names.length === 1 ? "it" : "them"} in Google Photos now`,
  );
}

function onClick(e: Event): void {
  const t = e.target as HTMLElement;
  const b = t.closest<HTMLElement>("button");
  if (!b) return;
  if (b.id === "dt-refresh") void act("refresh", {}, "Reading your library from Google");
  else if (b.dataset.show) {
    show = b.dataset.show as "wrong" | "all";
    shown = 60;
    render();
  } else if (b.dataset.fix) fixList([b.dataset.fix]);
  else if (b.dataset.cancel) void act("cancel", { paths: [b.dataset.cancel] });
  else if (b.dataset.edit) {
    editing = b.dataset.edit;
    render();
  } else if (b.dataset.close !== undefined) {
    editing = "";
    render();
  } else if (b.dataset.save) {
    const v = ($("#dt-input") as HTMLInputElement).value;
    const unix = v ? new Date(v).getTime() / 1000 : NaN;
    if (!Number.isFinite(unix)) return toast("Pick a date and time", "bad");
    editing = "";
    void act(
      "set",
      { path: b.dataset.save, when: unix },
      "Date saved. Press Fix to change it in Google Photos.",
    );
  } else if (b.dataset.auto) {
    editing = "";
    void act("set", { path: b.dataset.auto, when: null }, "Back to the automatic date");
  } else if (b.id === "dt-picked") {
    fixList([...picked]);
    picked.clear();
  } else if (b.id === "dt-all") {
    const names = (report?.items ?? []).filter((i) => i.wrong && (i.fix === "" || i.fix === "failed"));
    if (confirm(`Fix ${names.length} item(s)? You then delete each one in Google Photos.`))
      fixList(names.map((i) => i.name));
  } else if (b.id === "dt-more") {
    shown += 60;
    render();
  }
}

const dates: View = {
  subtitle: "Give photos and videos without a date the right one in Google Photos",
  mount(el) {
    account = status()?.accounts?.[0] ?? "";
    shown = 60;
    editing = "";
    el.innerHTML = `
    <section class="card mb-4 flex flex-wrap items-center gap-2 p-3">
      <span class="flex items-center gap-2 px-1">${icon("users", "size-4 text-ink-3")}<span id="dt-acc"></span></span>
      <span class="text-xs text-ink-3 lg:ml-auto" id="dt-when"></span>
      <button class="btn" id="dt-refresh">${icon("refresh")}Check dates with Google</button>
    </section>
    <div id="dt-body"><div class="grid grid-cols-2 gap-4 xl:grid-cols-4">${'<div class="card skeleton h-28"></div>'.repeat(4)}</div><div class="card skeleton mt-4 h-72"></div></div>`;
    el.addEventListener("click", onClick);
    el.addEventListener("change", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.id === "dt-account") {
        account = t.value;
        picked.clear();
        void load();
      } else if (t.dataset.pick) {
        if (t.checked) picked.add(t.dataset.pick);
        else picked.delete(t.dataset.pick);
        const btn = document.getElementById("dt-picked") as HTMLButtonElement | null;
        if (btn) {
          btn.disabled = !picked.size;
          btn.innerHTML = `${icon("retry")}Fix picked (${picked.size})`;
        }
      }
    });
    void load();
    timer = window.setInterval(() => {
      if (editing) return; // don't redraw under the date picker
      const r = report;
      const active =
        r?.refreshing || r?.current || r?.items.some((i) => i.fix === "waiting" || i.fix === "in_google");
      if (active || ++ticks % 8 === 0) void load(); // busy: every 4 s, else every 30 s
    }, 4000);
  },
  unmount() {
    clearInterval(timer);
    request++;
  },
};

export default dates;
