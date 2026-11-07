import { get, post, type DateItem, type DatesReport } from "../lib/api";
import {
  dateFixable as fixable,
  dateWaiting as waiting,
  filterDates,
  type DateFilter,
} from "../lib/date-filters";
import { $, animateChange, esc, html, toast } from "../lib/dom";
import { ago, fileName, folderOf, num, pct } from "../lib/format";
import { icon } from "../lib/icons";
import { status } from "../lib/store";
import { badge, openAttrs, thumb, type Tone } from "../lib/ui";
import type { View } from "./view";

// Fix dates: photos and videos with no date of their own get their date in Google Photos from the
// upload. When that date is wrong, the user deletes the item in Google Photos and GP Sync uploads it
// again with the right one (a date the user picks, or the earliest identical copy on the server).

let account = "";
let report: DatesReport | null = null;
let show: DateFilter = "wrong";
let shown = 60;
let editing = "";
let timer = 0;
let ticks = 0;
let request = 0;
const picked = new Set<string>();

function selectedItems(): DateItem[] {
  return (report?.items ?? []).filter((i) => picked.has(i.name));
}

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
  filename: "the date in the file name",
  estimated: "the estimated Snapchat save date (see Sources)",
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
        : i.google_source === "google"
          ? { label: "Fixed", tone: "good", ic: "ok" }
          : { label: "Reuploaded · verify date", tone: "info", ic: "info" };
    case "failed":
      return { label: "Didn't work", tone: "bad", ic: "error" };
    default:
      return i.wrong
        ? { label: "Wrong date", tone: "warn", ic: "calendar" }
        : i.google == null
          ? { label: "Check Google date", tone: "info", ic: "info" }
          : { label: "", tone: "", ic: "info" };
  }
}

function actions(i: DateItem, r: DatesReport): string {
  const open = i.google_url
    ? `<a class="link-btn sm" href="${esc(i.google_url)}" target="_blank" rel="noopener noreferrer">${icon("external")}Open in Google Photos</a>`
    : "";
  const cancel = `<button class="btn icon sm" data-cancel="${esc(i.name)}" title="Stop waiting (nothing changes in Google)" aria-label="Cancel">${icon("x")}</button>`;
  const edit = `<button class="btn sm" data-edit="${esc(i.name)}">${icon("calendar")}Set date</button>`;
  if (r.current?.key === i.name) return open;
  switch (i.fix) {
    case "waiting":
    case "in_google":
      return `${open}<button class="btn sm" data-recheck="${esc(i.name)}">${icon("refresh")}Recheck now</button>${cancel}`;
    case "failed":
      return `${open}${edit}<button class="btn sm" data-fix="${esc(i.name)}">${icon("retry")}Try again</button>${cancel}`;
    default:
      return `${open}${edit}${i.wrong ? `<button class="btn sm primary" data-fix="${esc(i.name)}">${icon("retry")}Fix date</button>` : ""}`;
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
  const canPick = waiting(i) || fixable(i);
  const googleLabel =
    i.google_source === "google"
      ? "Google date · last checked"
      : i.google_source === "sent"
        ? "Last sent · not verified"
        : "Google date · not checked";
  const previousLabel = i.previous_google_source === "sent" ? "Before fix · last sent" : "Before fix";
  const hint =
    i.fix === "waiting"
      ? "Delete it in Google Photos, then empty it from Google's Trash. GP Sync then uploads it again with the right date (checks every 2 minutes)."
      : i.fix === "in_google"
        ? "Google still has it. Open Google Photos › Library › Trash and delete it there too."
        : i.error;
  return `<div class="row flex-wrap items-start px-4 py-3 sm:flex-nowrap">
    ${canPick ? `<input type="checkbox" class="mt-3 size-4 accent-[var(--accent)]" data-pick="${esc(i.name)}" ${picked.has(i.name) ? "checked" : ""} aria-label="Pick ${esc(fileName(i.name))}">` : '<span class="w-4 shrink-0"></span>'}
    <span class="clickable" ${openAttrs(i.name)}>${thumb(i.name)}</span>
    <div class="min-w-0 flex-1 basis-48">
      <div class="flex flex-wrap items-center gap-2"><span class="truncate text-sm font-medium" title="${esc(i.name)}">${esc(fileName(i.name))}</span>${s.label ? badge(s.label, s.tone, s.ic) : ""}${i.kind === "video" ? `<span class="badge">${icon("video")}</span>` : ""}</div>
      <div class="truncate text-xs text-ink-3">${esc(folderOf(i.name))}</div>
      <div class="mt-2 grid gap-2 text-xs sm:grid-cols-2 xl:grid-cols-3">
        <div><span class="block text-ink-3">${googleLabel}</span><b class="${i.wrong ? "text-warn" : "text-ink-2"}">${esc(when(i.google))}</b></div>
        <div><span class="block text-ink-3">Suggested date</span><b class="text-ink-2">${esc(when(i.best))}</b><span class="block text-ink-3">From ${SOURCE[i.source]}</span></div>
        ${i.fix ? `<div><span class="block text-ink-3">${previousLabel}</span><b class="text-ink-2">${i.previous_google == null ? "Not recorded" : esc(when(i.previous_google))}</b></div>` : ""}
      </div>
      ${cur ? `<div class="bar mt-2"><i style="width:${pct(cur.done, cur.total)}%"></i></div>` : ""}
      ${hint ? `<div class="mt-1 text-xs ${i.fix === "failed" ? "text-bad" : "text-ink-3"}">${esc(hint)}</div>` : ""}
      ${!i.google_url ? `<div class="mt-1 text-xs text-ink-3">Google Photos link unavailable; check dates with Google to look it up.</div>` : ""}
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
  const available = new Set(r.items.filter((i) => waiting(i) || fixable(i)).map((i) => i.name));
  for (const name of picked) if (!available.has(name)) picked.delete(name);
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
  const list = filterDates(r.items, show);
  const fixableItems = r.items.filter(fixable);
  const pickedFixable = selectedItems().filter(fixable).length;
  const pickedWaiting = selectedItems().filter(waiting).length;
  const tabs: [DateFilter, string, number][] = [
    ["wrong", "Needs review", filterDates(r.items, "wrong").length],
    ["waiting", "Waiting", r.waiting],
    ["fixed", "Fixed", filterDates(r.items, "fixed").length],
    ["all", "All", r.items.length],
  ];
  const empty: Record<DateFilter, string> = {
    wrong: "No dates need review",
    waiting: "No items waiting for deletion",
    fixed: "No fixed dates yet",
    all: "No uploaded files without a date",
  };
  html(
    $("#dt-body"),
    `<section class="card min-w-0 overflow-hidden">
        <div class="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <div class="min-w-0 flex-1"><h2 class="font-semibold">Files without a date</h2>
            <p class="mt-1 text-xs text-ink-3">${num(r.undated)} files · ${num(r.wrong)} with different dates · ${num(r.waiting)} waiting</p></div>
          <span class="text-xs text-ink-3">Album: ${r.album ? esc(r.album) : "Off"} · <a class="underline" href="#/settings/albums">Settings</a> · <a class="underline" href="#/sources">Where they came from</a></span>
        </div>
        ${r.error ? `<p class="border-b border-line px-4 py-3 text-sm text-bad" role="alert">${esc(r.error)}</p>` : ""}
        <div class="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <div class="seg" id="dt-show" aria-label="Date status">
            ${tabs.map(([id, label, count]) => `<button data-show="${id}" aria-pressed="${show === id}">${label} (${num(count)})</button>`).join("")}
          </div>
          <div class="flex flex-wrap items-center gap-2 sm:ml-auto" id="dt-actions">
            ${pickedFixable ? `<button class="btn sm primary" id="dt-picked">${icon("retry")}Fix picked (${num(pickedFixable)})</button>` : ""}
            ${pickedWaiting ? `<button class="btn sm" id="dt-recheck-picked">${icon("refresh")}Recheck picked (${num(pickedWaiting)})</button>` : ""}
            ${(show === "wrong" || show === "all") && fixableItems.length ? `<button class="btn sm" id="dt-all">${icon("retry")}Fix all wrong (${num(fixableItems.length)})</button>` : ""}
            ${(show === "waiting" || show === "all") && r.waiting ? `<button class="btn sm" id="dt-recheck-all">${icon("refresh")}Recheck all waiting (${num(r.waiting)})</button>` : ""}
          </div>
        </div>
        ${
          r.refreshed
            ? ""
            : `<p class="border-b border-line px-4 py-2.5 text-xs text-ink-3">${icon("info", "inline size-3.5 -mt-0.5")} Check dates with Google to verify dates. A last-sent date is not confirmation of what Google shows.</p>`
        }
        <div id="dt-list" aria-live="polite">${
          list.length
            ? `<div class="divide-y divide-line" data-gallery>${list
                .slice(0, shown)
                .map((i) => row(i, r))
                .join(
                  "",
                )}</div>${list.length > shown ? `<div class="flex justify-center p-3"><button class="btn" id="dt-more">${icon("plus")}Show more (${num(list.length - shown)} left)</button></div>` : ""}`
            : `<div class="empty">${icon("shield")}${empty[show]}</div>`
        }</div>
      </section>`,
  );
}

async function fixList(names: string[]): Promise<void> {
  if (!names.length) return;
  const selectedAccount = account;
  let queued = 0;
  try {
    for (let i = 0; i < names.length; i += 1000) {
      const result = await post<{ queued: number }>("dates/fix", {
        account: selectedAccount,
        paths: names.slice(i, i + 1000),
      });
      queued += result.queued;
    }
    toast(
      queued ? `${num(queued)} waiting: delete them in Google Photos` : "No items were queued",
      queued ? "good" : "info",
    );
  } catch (e) {
    toast(`${num(queued)} queued before an error: ${(e as Error).message}`, "bad");
  }
  void load();
}

async function recheck(names: string[] | null): Promise<void> {
  try {
    const result = await post<{ queued: number }>("dates/recheck", {
      account,
      ...(names === null ? { all: true } : { paths: names }),
    });
    toast(
      result.queued
        ? `Queued ${num(result.queued)} waiting item(s) for recheck`
        : "No waiting items to recheck",
      result.queued ? "good" : "info",
    );
  } catch (e) {
    toast((e as Error).message, "bad");
  }
  void load();
}

function onClick(e: Event): void {
  const t = e.target as HTMLElement;
  const b = t.closest<HTMLElement>("button");
  if (!b) return;
  if (b.id === "dt-refresh") void act("refresh", {}, "Reading your library from Google");
  else if (b.dataset.show) {
    if (b.dataset.show === show) return;
    show = b.dataset.show as DateFilter;
    shown = 60;
    render();
    document
      .querySelector<HTMLButtonElement>(`#dt-show [data-show="${show}"]`)
      ?.focus({ preventScroll: true });
    animateChange(document.getElementById("dt-list"));
  } else if (b.dataset.fix) void fixList([b.dataset.fix]);
  else if (b.dataset.recheck) void recheck([b.dataset.recheck]);
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
    const names = selectedItems()
      .filter(fixable)
      .map((i) => i.name);
    void fixList(names);
    for (const name of names) picked.delete(name);
  } else if (b.id === "dt-all") {
    const names = (report?.items ?? []).filter(fixable);
    if (confirm(`Fix ${names.length} item(s)? You then delete each one in Google Photos.`))
      void fixList(names.map((i) => i.name));
  } else if (b.id === "dt-recheck-picked") {
    void recheck(
      selectedItems()
        .filter(waiting)
        .map((i) => i.name),
    );
  } else if (b.id === "dt-recheck-all") {
    void recheck(null);
  } else if (b.id === "dt-more") {
    shown += 60;
    render();
  }
}

const dates: View = {
  subtitle: "Give photos and videos without a date the right one in Google Photos",
  mount(el) {
    account = status()?.accounts?.[0] ?? "";
    picked.clear();
    show = "wrong";
    shown = 60;
    editing = "";
    el.innerHTML = `
    <section class="card mb-4 flex flex-wrap items-center gap-2 p-3">
      <span class="flex items-center gap-2 px-1">${icon("users", "size-4 text-ink-3")}<span id="dt-acc"></span></span>
      <span class="text-xs text-ink-3 lg:ml-auto" id="dt-when"></span>
      <button class="btn" id="dt-refresh">${icon("refresh")}Check dates with Google</button>
    </section>
    <details class="mb-4 px-1 text-sm text-ink-3">
      <summary class="cursor-pointer font-medium text-ink-2">How fixing dates works</summary>
      <div class="mt-2 space-y-2 leading-relaxed">
        <p>Review the suggested date or choose one. Press Fix, then delete the original in Google Photos and empty Google's Trash. GP Sync never deletes it for you.</p>
        <p>GP Sync checks about every two minutes, or you can recheck now. Once Google no longer has the item, GP Sync uploads the local original again with the suggested date.</p>
        <p>Original quality, favourite, archive, caption and GP Sync albums are restored. Google-created albums, shared links and comments are not restored.</p>
      </div>
    </details>
    <div id="dt-body"><div class="card skeleton h-72"></div></div>`;
    el.addEventListener("click", onClick);
    el.addEventListener("change", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.id === "dt-account") {
        account = t.value;
        picked.clear();
        report = null;
        html($("#dt-body"), '<div class="card skeleton h-72"></div>');
        void load();
      } else if (t.dataset.pick) {
        if (t.checked) picked.add(t.dataset.pick);
        else picked.delete(t.dataset.pick);
        const name = t.dataset.pick;
        render();
        [...document.querySelectorAll<HTMLInputElement>("#dt-body [data-pick]")]
          .find((input) => input.dataset.pick === name)
          ?.focus({ preventScroll: true });
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
