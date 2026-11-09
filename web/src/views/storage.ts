import { get, post, type StorageItem, type StorageReport } from "../lib/api";
import { $, esc, html, toast } from "../lib/dom";
import { ago, bytes, date, num, pct } from "../lib/format";
import { icon } from "../lib/icons";
import { status } from "../lib/store";
import { accountMenu, wireAccountMenu } from "../lib/account-menu";
import { badge, cardHead, tile, type Tone } from "../lib/ui";
import type { View } from "./view";

// Free up Google storage: items that count against it are downloaded (and proven to be Google's
// original), deleted in Google Photos (and its Trash), and uploaded again for free. All automatic.

let account = "";
let report: StorageReport | null = null;
let timer = 0;
let ticks = 0;
let request = 0;
let shown = 50;
/** Which items the list and the Free buttons work on. */
let kind: "all" | "photo" | "video" = "all";
const picked = new Set<string>();
const KIND_NAME = { all: "photos and videos", photo: "photos", video: "videos" } as const;

async function load(): Promise<void> {
  const mine = ++request;
  const r = await get<StorageReport>(`storage?account=${encodeURIComponent(account)}`).catch(() => null);
  if (mine !== request) return;
  report = r;
  if (r && !account) account = r.account;
  render();
}

async function act(path: string, body: Record<string, unknown>, done?: string): Promise<void> {
  try {
    await post(`storage/${path}`, { account, ...body });
    if (done) toast(done, "good");
  } catch (e) {
    toast((e as Error).message, "bad");
  }
  void load();
}

const thumbOf = (i: StorageItem) =>
  `<img class="thumb" loading="lazy" decoding="async" alt="" data-kind="${i.kind}" src="api/storage/thumb?account=${encodeURIComponent(account)}&key=${encodeURIComponent(i.key)}">`;

function stateOf(
  i: StorageItem,
  r: StorageReport,
): { label: string; tone: Tone; ic: Parameters<typeof icon>[0] } {
  if (r.current?.key === i.key)
    return r.current.step === "downloading"
      ? { label: "Downloading", tone: "info", ic: "download" }
      : r.current.step === "deleting"
        ? { label: "Replacing in Google", tone: "info", ic: "loader" }
        : { label: "Uploading", tone: "info", ic: "upload" };
  switch (i.state) {
    case "queued":
      return { label: "Queued", tone: "", ic: "hourglass" };
    case "downloaded":
      return { label: "Downloaded", tone: "info", ic: "hourglass" };
    case "in_google":
      return { label: "Retrying", tone: "warn", ic: "refresh" };
    case "checking":
      return { label: "Checking with Google", tone: "info", ic: "loader" };
    case "done":
      return { label: "Freed", tone: "good", ic: "ok" };
    case "counts":
    case "counted":
      return { label: "Still counts", tone: "bad", ic: "warn" };
    case "failed":
      return { label: "Didn't work", tone: "bad", ic: "error" };
    default:
      return { label: "", tone: "", ic: "info" };
  }
}

function actions(i: StorageItem, r: StorageReport): string {
  const cancel = `<button class="btn icon sm" data-cancel="${esc(i.key)}" title="Forget it (the downloaded copy is removed)" aria-label="Cancel">${icon("x")}</button>`;
  if (r.current?.key === i.key) return "";
  switch (i.state) {
    case "":
      return r.blocked
        ? ""
        : `<button class="btn sm" data-get="${esc(i.key)}">${icon("sparkles")}Free up</button>`;
    case "queued":
      return cancel;
    case "downloaded":
    case "in_google":
      return cancel;
    case "failed":
      return `<button class="btn sm" data-get="${esc(i.key)}">${icon("retry")}Try again</button>${cancel}`;
    default:
      return "";
  }
}

function row(i: StorageItem, r: StorageReport): string {
  const s = stateOf(i, r);
  const cur = r.current?.key === i.key ? r.current : null;
  const hint = ["downloaded", "in_google", "failed", "counts"].includes(i.state) ? (i.error ?? "") : "";
  return `<div class="row flex-wrap items-start px-4 py-3 sm:flex-nowrap">
    ${i.state === "" && !r.blocked ? `<input type="checkbox" class="mt-3 size-4 accent-[var(--accent)]" data-pick="${esc(i.key)}" ${picked.has(i.key) ? "checked" : ""} aria-label="Pick ${esc(i.name)}">` : '<span class="w-4"></span>'}
    ${thumbOf(i)}
    <div class="min-w-0 flex-1 basis-40">
      <div class="flex flex-wrap items-center gap-2"><span class="truncate text-sm font-medium">${esc(i.name)}</span>${s.label ? badge(s.label, s.tone, s.ic) : ""}</div>
      <div class="text-xs text-ink-3">${i.kind === "video" ? "Video" : "Photo"} · ${i.taken ? date(i.taken, true) : "no date"} · <b class="text-ink-2">${bytes(i.quota)}</b> of storage</div>
      ${cur ? `<div class="bar mt-2"><i style="width:${pct(cur.done, cur.total)}%"></i></div>` : ""}
      ${hint ? `<div class="mt-1 text-xs ${i.state === "failed" || i.state === "counts" ? "text-bad" : "text-ink-3"}">${esc(hint)}</div>` : ""}
    </div>
    <div class="row-actions flex w-full shrink-0 flex-wrap items-center justify-end gap-1.5 empty:hidden sm:w-auto">${actions(i, r)}</div>
  </div>`;
}

function render(): void {
  const r = report;
  const accs = status()?.accounts ?? [];
  // Redrawn only when it changes: a redraw would close the menu while it is open.
  const accKey = [account, ...accs, ...(status()?.login_failed ?? [])].join("|");
  const accBox = $("#st-acc");
  if (accBox.dataset.key !== accKey) {
    accBox.dataset.key = accKey;
    html(accBox, accountMenu("st-account", account));
    wireAccountMenu("st-account", pickAccount);
  }
  if (!r || !r.account) {
    html(
      $("#st-body"),
      `<div class="card empty">${icon("users")}Connect a Google account first (Settings › Accounts)</div>`,
    );
    return;
  }
  html(
    $("#st-refresh"),
    r.refreshing
      ? `${icon("loader", "spin")}Reading your library…`
      : `${icon("refresh")}${r.listed ? "Refresh from Google" : "Read my library"}`,
  );
  ($("#st-refresh") as HTMLButtonElement).disabled = r.refreshing;
  html($("#st-when"), r.refreshed ? `Updated ${ago(r.refreshed)}` : "");
  if (!r.listed) {
    html(
      $("#st-body"),
      `<section class="card p-6 text-center"><div class="mx-auto max-w-lg space-y-2">${icon("cloud", "mx-auto size-8 text-ink-3")}
        <div class="text-base font-medium">See what uses your Google storage</div>
        <p class="text-sm text-ink-3">GP Sync reads your library list (nothing changes) and shows what counts against storage. The first read can take a few minutes.</p>
        ${r.error ? `<p class="text-sm text-bad">${esc(r.error)}</p>` : ""}</div></section>`,
    );
    return;
  }
  const busy = r.items.filter((i) =>
    ["queued", "downloaded", "in_google", "checking"].includes(i.state),
  ).length;
  const oursCount = r.ours.counted > 0;
  const listed = r.items.filter((i) => kind === "all" || i.kind === kind);
  const fresh = listed.filter((i) => !i.state);
  const kinds = r.kinds ?? { photo: { count: 0, bytes: 0 }, video: { count: 0, bytes: 0 } };
  const ofKind =
    kind === "all"
      ? { count: kinds.photo.count + kinds.video.count, bytes: kinds.photo.bytes + kinds.video.bytes }
      : kinds[kind];
  const canFree = !(r.blocked || oursCount);
  const segs = (["all", "photo", "video"] as const)
    .map((k) => {
      const n = k === "all" ? kinds.photo.count + kinds.video.count : kinds[k].count;
      return `<button data-kind="${k}" aria-pressed="${k === kind}">${k === "all" ? "Both" : k === "photo" ? "Photos" : "Videos"} <span class="opacity-60">${num(n)}</span></button>`;
    })
    .join("");
  const oursOk = r.ours.seen > 0 && r.ours.counted === 0;
  html(
    $("#st-body"),
    `${
      r.blocked
        ? `<section class="card mb-4 flex flex-wrap items-start gap-3 border-bad/40 p-4">${icon("warn", "size-5 shrink-0 text-bad")}<div class="min-w-0 flex-1 text-sm"><div class="font-medium">Stopped: Google counted a re-upload against storage</div><div class="mt-0.5 text-ink-3">Nothing more is moved. Downloaded files stay here, and nothing was deleted.</div></div><button class="btn sm" id="st-unblock">Try again anyway</button></section>`
        : ""
    }
    ${r.error ? `<section class="card mb-4 p-4 text-sm text-bad">${esc(r.error)}</section>` : ""}
    ${oursCount ? `<section class="card mb-4 flex items-start gap-3 p-4 text-sm">${icon("warn", "size-5 shrink-0 text-warn")}<div><div class="font-medium">GP Sync's uploads count against storage in this account</div><div class="mt-0.5 text-ink-3">Re-uploading wouldn't free anything, so nothing is deleted here.</div></div></section>` : ""}
    <div class="grid grid-cols-2 gap-4 xl:grid-cols-4">
      ${tile({ label: "Counts against storage", value: bytes(r.counted_bytes), ic: "cloud", sub: `${num(r.counted)} of ${num(r.total)} items` })}
      ${tile({ label: "Freed by GP Sync", value: bytes(r.freed.bytes), ic: "sparkles", sub: `${num(r.freed.count)} item${r.freed.count === 1 ? "" : "s"} moved`, tone: r.freed.count ? "good" : "" })}
      ${tile({ label: "In progress", value: num(busy), ic: "hourglass", sub: busy ? "One at a time in this account" : "Nothing running" })}
      ${tile({
        label: "GP Sync uploads",
        value: r.ours.seen ? (oursOk ? "Free" : `${num(r.ours.counted)} count`) : "–",
        ic: oursOk ? "verified" : "info",
        sub: r.ours.seen ? `${num(r.ours.seen)} found in Google` : "None found in Google yet",
        tone: r.ours.seen ? (oursOk ? "good" : "bad") : "",
      })}
    </div>
    <div class="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[22rem_1fr]">
      <section class="card self-start">${cardHead("How it works", "info")}
        <ol class="card-b space-y-3 text-sm">
          <li class="flex gap-3"><span class="grid size-6 shrink-0 place-items-center rounded-full bg-panel-2 text-xs">1</span><span><b>Downloaded</b> here and checked against Google's original.</span></li>
          <li class="flex gap-3"><span class="grid size-6 shrink-0 place-items-center rounded-full bg-panel-2 text-xs">2</span><span><b>Deleted in Google</b>, Trash included.</span></li>
          <li class="flex gap-3"><span class="grid size-6 shrink-0 place-items-center rounded-full bg-panel-2 text-xs">3</span><span><b>Uploaded again</b> the free way, then the copy here is removed.</span></li>
        </ol>
        <div class="border-t border-line px-4 py-3 text-xs text-ink-3">Keeps quality, date, favourite, archive and caption. Albums, shared links and comments are lost.</div>
      </section>
      <section class="card min-w-0 overflow-hidden">
        ${cardHead("Biggest first", "layers", `${num(ofKind.count)} · ${bytes(ofKind.bytes)}`)}
        <div class="flex flex-col gap-3 border-b border-line px-4 py-3 sm:flex-row sm:items-center">
          <div class="seg" id="st-kind" aria-label="Photos or videos">${segs}</div>
          ${
            canFree
              ? `<div class="grid grid-cols-3 gap-2 sm:ml-auto sm:flex">
            <button class="btn sm justify-center whitespace-nowrap" id="st-picked" ${picked.size ? "" : "disabled"}>${icon("check")}Picked (${picked.size})</button>
            <button class="btn sm justify-center whitespace-nowrap" id="st-next" ${fresh.length ? "" : "disabled"}>${icon("sparkles")}10 biggest</button>
            <button class="btn sm primary justify-center whitespace-nowrap" id="st-all" ${ofKind.count ? "" : "disabled"}>${icon("sparkles")}Free all</button></div>`
              : ""
          }
        </div>
        <p class="border-b border-line px-4 py-2.5 text-xs text-ink-3">Other accounts run alongside, and copies too. Downloads need free space here: ${bytes(r.free_space)} left.</p>
        ${
          listed.length
            ? `<div class="divide-y divide-line">${listed
                .slice(0, shown)
                .map((i) => row(i, r))
                .join(
                  "",
                )}</div>${listed.length > shown ? `<div class="flex justify-center p-3"><button class="btn" id="st-more">${icon("plus")}Show more (${num(listed.length - shown)} left)</button></div>` : ""}`
            : `<div class="empty">${icon("shield")}No ${KIND_NAME[kind]} in this account count against storage</div>`
        }
      </section>
    </div>`,
  );
}

/** Ask once, then queue: each item is downloaded, deleted in Google and uploaded again free. */
function start(keys: string[]): boolean {
  if (!keys.length) return false;
  const what = keys.length === 1 ? "this item" : `${num(keys.length)} items`;
  if (
    !confirm(
      `Free up ${what} in ${account}?\n\nEach is downloaded and checked, deleted in Google Photos (Trash included) and uploaded again for free. Quality, date, favourite, archive and caption are kept; albums, shared links and comments are lost.`,
    )
  )
    return false;
  void act("download", { keys }, `Freeing ${what}`);
  return true;
}

function onClick(e: Event): void {
  const t = e.target as HTMLElement;
  const b = t.closest<HTMLElement>("button");
  if (!b) return;
  if (b.id === "st-refresh") void act("refresh", {}, "Reading your library from Google");
  else if (b.id === "st-unblock") {
    if (confirm("Google counted a re-upload against storage last time. Try again anyway?"))
      void act("check", { unblock: true });
  } else if (b.dataset.get) start([b.dataset.get]);
  else if (b.dataset.cancel) void act("cancel", { keys: [b.dataset.cancel] });
  else if (b.id === "st-picked") {
    if (start([...picked])) picked.clear();
  } else if (b.id === "st-next") {
    start(
      (report?.items ?? [])
        .filter((i) => !i.state && (kind === "all" || i.kind === kind))
        .slice(0, 10)
        .map((i) => i.key),
    );
  } else if (b.dataset.kind) {
    kind = b.dataset.kind as typeof kind;
    shown = 50;
    render();
  } else if (b.id === "st-all") {
    const k = report?.kinds;
    const n = !k ? 0 : kind === "all" ? k.photo.count + k.video.count : k[kind].count;
    const size = !k ? 0 : kind === "all" ? k.photo.bytes + k.video.bytes : k[kind].bytes;
    if (
      confirm(
        `Free up all ${KIND_NAME[kind]} in ${account}: ${num(n)} items, ${bytes(size)}?\n\nOne at a time, biggest first, each is downloaded and checked, deleted in Google Photos (Trash included) and uploaded again for free. Quality, date, favourite, archive and caption are kept; albums, shared links and comments are lost. You can cancel items that haven't started.`,
      )
    )
      void act("download", { kind }, `Freeing all ${KIND_NAME[kind]}`);
  } else if (b.id === "st-more") {
    shown += 50;
    render();
  }
}

/** Another account chosen in the menu, or opened from a link (#/storage/<account>). */
function pickAccount(next: string): void {
  account = next;
  picked.clear();
  void load();
}

/** The account named in the address, if it is connected. */
function linkedAccount(args: string[] | undefined): string {
  const want = decodeURIComponent(args?.[0] ?? "");
  const accs = status()?.accounts ?? [];
  return accs.includes(want) ? want : (accs[0] ?? "");
}

const storage: View = {
  subtitle: "Free up Google storage",
  mount(el, args) {
    account = linkedAccount(args);
    shown = 50;
    el.innerHTML = `
    <section class="card mb-4 flex flex-wrap items-center gap-2 p-3">
      <span id="st-acc" class="min-w-0"></span>
      <span class="text-xs text-ink-3 lg:ml-auto" id="st-when"></span>
      <button class="btn" id="st-refresh">${icon("refresh")}Refresh from Google</button>
    </section>
    <div id="st-body"><div class="grid grid-cols-2 gap-4 xl:grid-cols-4">${'<div class="card skeleton h-28"></div>'.repeat(4)}</div><div class="card skeleton mt-4 h-72"></div></div>`;
    el.addEventListener("click", onClick);
    el.addEventListener("change", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.pick) {
        if (t.checked) picked.add(t.dataset.pick);
        else picked.delete(t.dataset.pick);
        const btn = document.getElementById("st-picked") as HTMLButtonElement | null;
        if (btn) {
          btn.disabled = !picked.size;
          btn.innerHTML = `${icon("check")}Picked (${picked.size})`;
        }
      }
    });
    void load();
    timer = window.setInterval(() => {
      const r = report;
      const active =
        r?.refreshing ||
        r?.current ||
        r?.items.some((i) => ["queued", "downloaded", "checking"].includes(i.state));
      if (active || ++ticks % 8 === 0) void load(); // busy: every 4 s, else every 30 s
    }, 4000);
  },
  route(args) {
    const next = linkedAccount(args);
    if (next && next !== account) pickAccount(next);
  },
  unmount() {
    clearInterval(timer);
    request++;
  },
};

export default storage;
