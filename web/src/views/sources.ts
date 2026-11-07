import {
  get,
  post,
  type AppSourceId,
  type SourceId,
  type SourceItem,
  type SourceSettings,
  type SourcesReport,
} from "../lib/api";
import { $, animateChange, esc, html, toast } from "../lib/dom";
import { ago, fileName, folderOf, num, pct } from "../lib/format";
import { icon } from "../lib/icons";
import { acceptable, actionSummary, estimateLabel, SOURCE_HELP, sourceTabs } from "../lib/sources";
import { badge, openAttrs, thumb, type Tone } from "../lib/ui";
import type { View } from "./view";

// Sources: where every photo and video came from (a camera, Snapchat, a screenshot, another app),
// with the evidence for it. Items saved from apps can go into an album per app, get a searchable
// caption, or be archived. Snapchat saves also get an estimated save date.

let report: SourcesReport | null = null;
let source: SourceId | "" = "";
let shown = 60;
let timer = 0;
let ticks = 0;
let request = 0;
let editing = false; // the settings form has unsaved changes: don't redraw under it
const picked = new Set<string>();

async function load(): Promise<void> {
  const mine = ++request;
  const r = await get<SourcesReport>(`sources?source=${encodeURIComponent(source)}`).catch(() => null);
  if (mine !== request) return;
  report = r;
  if (r) source = r.source;
  render();
}

const CONFIDENCE: Record<SourceItem["confidence"], [string, Tone, string]> = {
  marker: ["Certain", "good", "A record inside the file says so"],
  name: ["From file name", "info", "Only the file name points to it"],
  likely: ["No camera data", "", "Nothing inside names an app"],
  "": ["", "", ""],
};

function day(unix: number | null): string {
  if (unix == null) return "unknown";
  return new Date(unix * 1000).toLocaleDateString([], {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function isApp(r: SourcesReport, s: SourceId | ""): s is AppSourceId {
  return (r.app_sources as string[]).includes(s);
}

function googleState(i: SourceItem): string {
  if (!i.uploaded) return badge("Not in Google yet", "", "hourglass");
  return [
    i.album ? badge(i.album, "info", "library", "Added to this album") : "",
    i.archived ? badge("Archived", "", "package", "Hidden from the timeline, still in albums") : "",
    i.captioned ? badge("Captioned", "", "info", i.captioned) : "",
  ].join("");
}

function row(i: SourceItem, r: SourcesReport): string {
  const [conf, tone, tip] = CONFIDENCE[i.confidence] ?? CONFIDENCE[""];
  const detail = [
    i.device,
    i.app_version ? `${r.labels[i.detected] ?? i.app} ${i.app_version}` : "",
    i.os_version ? `iOS ${i.os_version}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<div class="row flex-wrap items-start px-4 py-3 sm:flex-nowrap">
    <input type="checkbox" class="mt-3 size-4 accent-[var(--accent)]" data-pick="${esc(i.name)}" ${picked.has(i.name) ? "checked" : ""} aria-label="Pick ${esc(fileName(i.name))}">
    <span class="clickable" ${openAttrs(i.name)}>${thumb(i.name)}</span>
    <div class="min-w-0 flex-1 basis-48">
      <div class="flex flex-wrap items-center gap-2"><span class="truncate text-sm font-medium" title="${esc(i.name)}">${esc(fileName(i.name))}</span>${conf ? badge(conf, tone, undefined, tip) : ""}${i.decided ? badge(`You chose · detected ${r.labels[i.detected] ?? i.detected}`, "warn") : ""}${i.kind === "video" ? `<span class="badge">${icon("video")}</span>` : ""}</div>
      <div class="truncate text-xs text-ink-3">${esc(folderOf(i.name))}${detail ? ` · ${esc(detail)}` : ""}</div>
      <div class="mt-1 text-xs text-ink-2">${i.reasons.map(esc).join(" · ") || "No evidence recorded"}</div>
      <div class="mt-2 grid gap-2 text-xs sm:grid-cols-2">
        <div><span class="block text-ink-3">${i.taken ? "Date inside the file" : "On this server since"}</span><b class="text-ink-2">${esc(day(i.taken ?? i.mtime))}</b></div>
        ${i.estimate ? `<div><span class="block text-ink-3">Estimated save date</span><b class="text-ink-2">${esc(estimateLabel(i.estimate))}</b><span class="block text-ink-3">${esc(i.estimate.reason)}</span></div>` : ""}
      </div>
      <div class="mt-2 flex flex-wrap gap-1.5 empty:hidden">${googleState(i)}</div>
    </div>
    <div class="flex w-full shrink-0 flex-wrap items-center justify-end gap-1.5 empty:hidden sm:w-auto">${
      i.google_url
        ? `<a class="link-btn sm" href="${esc(i.google_url)}" target="_blank" rel="noopener noreferrer">${icon("external")}Open in Google Photos</a>`
        : ""
    }</div>
  </div>`;
}

function toggle(id: string, label: string, on: boolean, hint: string): string {
  return `<label class="flex items-start gap-2 text-sm"><input type="checkbox" class="mt-0.5 size-4 accent-[var(--accent)]" data-set="${id}" ${on ? "checked" : ""}>
    <span><span class="font-medium">${label}</span><span class="block text-xs text-ink-3">${hint}</span></span></label>`;
}

function settingsCard(r: SourcesReport, s: AppSourceId): string {
  const a = r.settings[s];
  const label = r.labels[s] ?? s;
  return `<section class="card mb-4 p-4" id="so-settings">
    <div class="flex flex-wrap items-center gap-2"><h2 class="font-semibold">In Google Photos: ${esc(label)}</h2>
      <span class="text-xs text-ink-3">${esc(actionSummary(r.settings, s))}</span></div>
    <div class="mt-3 grid gap-3 sm:grid-cols-2">
      <div class="space-y-2">
        ${toggle("album", "Add to an album", a.album, "Groups them in one place. Leaves them in the timeline.")}
        <input class="input" data-set="album_name" maxlength="80" value="${esc(a.album_name)}" aria-label="Album name" ${a.album ? "" : "disabled"}>
      </div>
      ${toggle("caption", "Add a caption", a.caption, `Searchable in Google Photos, e.g. “Saved from ${esc(label)}”. Never replaces a caption you wrote.`)}
      ${toggle("archive", "Archive", a.archive, "Takes them out of the timeline. Still in albums and search. Turning it off undoes it.")}
      ${s === "snapchat" ? toggle("estimate_dates", "Use the estimated date for new uploads", r.settings.estimate_dates, "Items already in Google change only when you accept their date below.") : ""}
    </div>
    <div class="mt-3 flex justify-end gap-2"><button class="btn sm primary" id="so-save">${icon("ok")}Save</button></div>
  </section>`;
}

function firstRun(r: SourcesReport): string {
  const lines = r.app_sources
    .filter((s) => (r.counts[s] ?? 0) > 0)
    .map(
      (s) =>
        `<li><b>${esc(r.labels[s])}</b> (${num(r.counts[s])}): ${esc(actionSummary(r.settings, s))}</li>`,
    )
    .join("");
  return `<section class="card mb-4 border-accent p-4" role="region" aria-labelledby="so-ask-title">
    <div class="flex items-center gap-3"><span class="grid size-10 place-items-center rounded-xl bg-panel-2 text-ink-2">${icon("sparkles", "size-5")}</span>
      <h2 id="so-ask-title" class="text-lg font-semibold tracking-tight">Sort items saved from apps?</h2></div>
    <p class="mt-3 text-sm text-ink-2">GP Sync found where your photos and videos came from. Items saved from apps (Snapchat above all) often have no date, so they pile up on the day they were copied here.</p>
    <ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-2">${lines || "<li>No items saved from apps found yet.</li>"}</ul>
    <p class="mt-2 text-xs text-ink-3">Albums group them without hiding them. Captions make them searchable. Archive (off by default) takes them out of the timeline. Nothing changes in Google until you choose. You can change each source below at any time.</p>
    <div class="mt-4 flex flex-wrap justify-end gap-2">
      <button class="btn" data-ask="label">Only label them here</button>
      <button class="btn primary" data-ask="apply">${icon("ok")}Use these settings</button>
    </div>
  </section>`;
}

function render(): void {
  const r = report;
  if (!r) {
    html($("#so-body"), `<div class="card empty">${icon("warn")}Could not load sources</div>`);
    return;
  }
  const available = new Set(r.items.map((i) => i.name));
  for (const name of picked) if (!available.has(name)) picked.delete(name);
  const tabs = sourceTabs(r.sources, r.counts);
  const pickedItems = r.items.filter((i) => picked.has(i.name));
  const withEstimate = acceptable(pickedItems.length ? pickedItems : r.items);
  const checking = r.checked < r.total;
  const cameras = r.devices
    .slice(0, 8)
    .map((d) => `<span class="badge">${icon("camera")}${esc(d.name)} · ${num(d.files)}</span>`)
    .join("");
  html(
    $("#so-body"),
    `${r.settings.asked ? "" : firstRun(r)}
    ${r.error ? `<p class="card mb-4 px-4 py-3 text-sm text-bad" role="alert">${esc(r.error)}</p>` : ""}
    ${
      r.needs_library && r.settings.asked
        ? `<p class="card mb-4 flex flex-wrap items-center gap-2 px-4 py-3 text-sm text-ink-2">${icon("info")}<span class="flex-1">Captions wait until GP Sync has read your library, so it never overwrites one you wrote.${r.refreshed ? ` Last read ${ago(r.refreshed)}.` : ""}</span>
            <button class="btn sm" id="so-refresh" ${r.refreshing ? "disabled" : ""}>${r.refreshing ? `${icon("loader", "spin")}Reading…` : `${icon("refresh")}Read library`}</button></p>`
        : ""
    }
    ${isApp(r, r.source) ? settingsCard(r, r.source) : ""}
    <section class="card min-w-0 overflow-hidden">
      <div class="flex flex-wrap items-center gap-3 border-b border-line p-4">
        <div class="min-w-0 flex-1"><h2 class="font-semibold">${esc(r.labels[r.source] ?? r.source)}</h2>
          <p class="mt-1 text-xs text-ink-3">${esc(SOURCE_HELP[r.source] ?? "")}</p></div>
        <span class="text-xs text-ink-3">${checking ? `Checking files… ${num(r.checked)} of ${num(r.total)} (${pct(r.checked, r.total)}%)` : `${num(r.total)} files checked`}${r.estimated ? ` · ${num(r.estimated)} Snapchat dates estimated` : ""}</span>
      </div>
      ${checking ? `<div class="bar mx-4 mt-3"><i style="width:${pct(r.checked, r.total)}%"></i></div>` : ""}
      <div class="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <div class="seg" id="so-show" aria-label="Source">
          ${tabs.map((s) => `<button data-show="${s}" aria-pressed="${r.source === s}" data-tip="${esc(SOURCE_HELP[s] ?? "")}">${esc(r.labels[s] ?? s)} (${num(r.counts[s] ?? 0)})</button>`).join("")}
        </div>
        <div class="flex flex-wrap items-center gap-2 sm:ml-auto">
          ${
            pickedItems.length
              ? `<select class="input w-auto" id="so-move" aria-label="Change the source of the picked items">
                  <option value="">Change source (${num(pickedItems.length)})…</option>
                  <option value="auto">Back to what was detected</option>
                  ${r.sources
                    .filter((s) => s !== r.source && s !== "unknown")
                    .map((s) => `<option value="${s}">${esc(r.labels[s] ?? s)}</option>`)
                    .join("")}
                </select>
                <button class="btn sm" id="so-clear">${icon("x")}Clear picks</button>`
              : `<button class="btn sm" id="so-pick-all" ${r.items.length ? "" : "disabled"}>${icon("check")}Pick all shown</button>`
          }
          ${withEstimate.length ? `<button class="btn sm primary" id="so-accept">${icon("calendar")}Accept estimated dates (${num(withEstimate.length)})</button>` : ""}
        </div>
      </div>
      ${r.source === "camera" && cameras ? `<div class="flex flex-wrap gap-1.5 border-b border-line px-4 py-3">${cameras}</div>` : ""}
      <div id="so-list" aria-live="polite">${
        r.items.length
          ? `<div class="divide-y divide-line" data-gallery>${r.items
              .slice(0, shown)
              .map((i) => row(i, r))
              .join("")}</div>${
              r.items.length > shown
                ? `<div class="flex justify-center p-3"><button class="btn" id="so-more">${icon("plus")}Show more (${num(r.items.length - shown)} left)</button></div>`
                : r.more
                  ? `<p class="p-3 text-center text-xs text-ink-3">${num(r.more)} more not shown</p>`
                  : ""
            }`
          : `<div class="empty">${icon("shield")}${checking ? "Still checking files…" : "No files from this source"}</div>`
      }</div>
    </section>`,
  );
}

function readSettings(s: AppSourceId): Partial<SourceSettings> {
  const form = $("#so-settings");
  const val = (k: string) => form?.querySelector<HTMLInputElement>(`[data-set="${k}"]`);
  const out: Record<string, unknown> = {
    [s]: {
      album: !!val("album")?.checked,
      album_name: val("album_name")?.value.trim() ?? "",
      caption: !!val("caption")?.checked,
      archive: !!val("archive")?.checked,
    },
  };
  if (s === "snapchat") out.estimate_dates = !!val("estimate_dates")?.checked;
  return out as Partial<SourceSettings>;
}

async function saveSettings(changes: Record<string, unknown>, done: string): Promise<void> {
  try {
    await post("sources/settings", { settings: changes });
    toast(done, "good");
  } catch (e) {
    toast((e as Error).message, "bad");
  }
  editing = false;
  void load();
}

async function decide(to: string): Promise<void> {
  const names = [...picked];
  if (!names.length || !to) return;
  try {
    const res = await post<{ updated: number }>("sources/decide", { paths: names, source: to });
    toast(`${num(res.updated)} item(s) updated`, "good");
    picked.clear();
  } catch (e) {
    toast((e as Error).message, "bad");
  }
  void load();
}

async function accept(): Promise<void> {
  const r = report;
  if (!r) return;
  const pickedItems = r.items.filter((i) => picked.has(i.name));
  const items = acceptable(pickedItems.length ? pickedItems : r.items);
  if (!items.length) return;
  const inGoogle = items.filter((i) => i.uploaded).length;
  if (
    !confirm(
      `Use the estimated date for ${items.length} Snapchat item(s)?` +
        (inGoogle
          ? `\n\n${inGoogle} already in Google wait in Fix dates: you delete each one in Google Photos, then GP Sync uploads it again with the new date.`
          : ""),
    )
  )
    return;
  try {
    const res = await post<{ accepted: number; queued: number }>("sources/accept-dates", {
      paths: items.map((i) => i.name),
    });
    toast(
      `${num(res.accepted)} date(s) accepted${res.queued ? ` · ${num(res.queued)} waiting in Fix dates` : ""}`,
      "good",
    );
    picked.clear();
  } catch (e) {
    toast((e as Error).message, "bad");
  }
  void load();
}

function onClick(e: Event): void {
  const b = (e.target as HTMLElement).closest<HTMLElement>("button");
  if (!b || !report) return;
  const r = report;
  if (b.dataset.show) {
    if (b.dataset.show === source) return;
    source = b.dataset.show as SourceId;
    shown = 60;
    picked.clear();
    editing = false;
    void load().then(() => {
      document
        .querySelector<HTMLButtonElement>(`#so-show [data-show="${source}"]`)
        ?.focus({ preventScroll: true });
      animateChange(document.getElementById("so-list"));
    });
  } else if (b.dataset.ask) {
    const changes: Record<string, unknown> = { asked: true };
    if (b.dataset.ask === "label")
      for (const s of r.app_sources) changes[s] = { album: false, caption: false, archive: false };
    void saveSettings(
      changes,
      b.dataset.ask === "label"
        ? "Sources are only labelled here"
        : "Items saved from apps will be sorted in Google",
    );
  } else if (b.id === "so-save" && isApp(r, r.source)) {
    void saveSettings(readSettings(r.source), "Saved");
  } else if (b.id === "so-refresh") {
    void post("dates/refresh", { account: r.account })
      .then(() => toast("Reading your library from Google", "good"))
      .catch((err: Error) => toast(err.message, "bad"))
      .finally(() => void load());
  } else if (b.id === "so-accept") void accept();
  else if (b.id === "so-pick-all") {
    for (const i of r.items) picked.add(i.name);
    render();
  } else if (b.id === "so-clear") {
    picked.clear();
    render();
  } else if (b.id === "so-more") {
    shown += 60;
    render();
  }
}

function onChange(e: Event): void {
  const t = e.target as HTMLInputElement | HTMLSelectElement;
  if (t.id === "so-move") void decide(t.value);
  else if (t instanceof HTMLInputElement && t.dataset.pick) {
    if (t.checked) picked.add(t.dataset.pick);
    else picked.delete(t.dataset.pick);
    const name = t.dataset.pick;
    render();
    [...document.querySelectorAll<HTMLInputElement>("#so-body [data-pick]")]
      .find((input) => input.dataset.pick === name)
      ?.focus({ preventScroll: true });
  } else if (t instanceof HTMLInputElement && t.dataset.set) {
    editing = true;
    if (t.dataset.set === "album") {
      const name = $("#so-settings")?.querySelector<HTMLInputElement>('[data-set="album_name"]');
      if (name) name.disabled = !t.checked;
    }
  }
}

const sources: View = {
  subtitle: "Where every photo and video came from: a camera, Snapchat, a screenshot, another app",
  mount(el) {
    picked.clear();
    source = "";
    shown = 60;
    editing = false;
    el.innerHTML = `
    <details class="mb-4 px-1 text-sm text-ink-3">
      <summary class="cursor-pointer font-medium text-ink-2">How GP Sync knows where a file came from</summary>
      <div class="mt-2 space-y-2 leading-relaxed">
        <p>Only evidence inside the file (or its name) is used, never a guess from its size. Snapchat writes a small record into each saved picture with its version, the phone and the iOS version. Screenshots, Instagram and TikTok leave markers too. Camera photos name their phone.</p>
        <p>Most videos and some pictures saved from apps carry no app name at all. They are shown as “Saved from an app”.</p>
        <p>Snapchat saves have no date. GP Sync estimates when each was saved from the iOS version it was saved on, placed in time by your own camera photos. It's shown with its margin, and changes items already in Google only when you accept it.</p>
      </div>
    </details>
    <div id="so-body"><div class="card skeleton h-72"></div></div>`;
    el.addEventListener("click", onClick);
    el.addEventListener("change", onChange);
    el.addEventListener("input", (e) => {
      if ((e.target as HTMLElement).dataset.set) editing = true;
    });
    void load();
    timer = window.setInterval(() => {
      if (editing) return; // don't redraw under the settings form
      const r = report;
      const active = r && (r.checked < r.total || r.refreshing);
      if (active || ++ticks % 6 === 0) void load(); // busy: every 5 s, else every 30 s
    }, 5000);
  },
  unmount() {
    clearInterval(timer);
    request++;
  },
};

export default sources;
