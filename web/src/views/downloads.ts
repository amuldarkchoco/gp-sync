import { get, post, type DownloadsReport } from "../lib/api";
import { avatar } from "../lib/account-menu";
import { confirmDialog } from "../lib/dialog";
import { $, esc, html, toast } from "../lib/dom";
import { bytes, date, num } from "../lib/format";
import { icon } from "../lib/icons";
import { cardHead } from "../lib/ui";
import type { View } from "./view";

// Copies kept on this server when storage was freed with "delete the downloaded copy" turned off.

let report: DownloadsReport | null = null;
let account = "";

async function load(): Promise<void> {
  report = await get<DownloadsReport>(`downloads?account=${encodeURIComponent(account)}`).catch(() => null);
  render();
}

function render(): void {
  const r = report;
  if (!r) return html($("#dl-body"), `<div class="card empty">${icon("warn")}Couldn't load Downloads</div>`);
  const accs = Object.entries(r.accounts);
  if (!accs.length)
    return html(
      $("#dl-body"),
      `<section class="card p-6 text-center"><div class="mx-auto max-w-md space-y-2">${icon("download", "mx-auto size-8 text-ink-3")}
        <div class="text-base font-medium">Nothing kept here</div>
        <p class="text-sm text-ink-3">When you free storage with “Delete the downloaded copy after the upload” turned off, the copies land here, per account.</p>
        <a class="btn mt-2" href="#/storage">${icon("cloud")}Free storage</a></div></section>`,
    );
  html(
    $("#dl-body"),
    `<div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">${accs
      .map(
        ([a, t]) => `<section class="card flex flex-col">
        <div class="flex items-center gap-3 p-4">${avatar(a, "size-9")}<div class="min-w-0 flex-1"><div class="truncate text-sm font-medium">${esc(a)}</div>
          <div class="text-xs text-ink-3">${num(t.photos)} photos · ${num(t.videos)} videos · ${bytes(t.bytes)}</div></div></div>
        <div class="mt-auto flex gap-2 border-t border-line p-3">
          <button class="btn sm flex-1 justify-center" data-show="${esc(a)}" aria-pressed="${a === account}">${icon("layers")}${a === account ? "Showing" : "Show"}</button>
          <button class="btn sm danger flex-1 justify-center" data-clear="${esc(a)}">${icon("trash")}Delete all</button></div></section>`,
      )
      .join("")}</div>
    <section class="card mt-4 min-w-0 overflow-hidden">${cardHead(account ? `Kept from ${account}` : "Newest first", "download", account ? `<button class="link-btn" data-show="">All accounts</button>` : "")}
      <div class="divide-y divide-line">${r.items
        .map(
          (
            i,
          ) => `<div class="row flex-wrap py-3"><span class="grid size-10 shrink-0 place-items-center rounded-lg bg-panel-2 text-ink-3">${icon(i.kind === "video" ? "video" : "photo")}</span>
          <div class="min-w-0 flex-1"><div class="truncate text-sm font-medium">${esc(i.name)}</div>
            <div class="truncate text-xs text-ink-3">${i.kind === "video" ? "Video" : "Photo"} · ${i.taken ? date(i.taken, true) : "no date"} · ${bytes(i.size)}${account ? "" : ` · ${esc(i.account)}`}</div></div>
          <div class="row-actions flex items-center gap-1.5"><a class="btn sm" href="api/downloads/file?id=${i.id}" download>${icon("download")}Save</a>
            <button class="btn icon sm danger" data-del="${i.id}" aria-label="Delete ${esc(i.name)}">${icon("trash")}</button></div></div>`,
        )
        .join("")}</div>
      <p class="border-t border-line px-4 py-2.5 text-xs text-ink-3">Stored in GP Sync's data folder (${esc(r.folder)}), not in your photo folders, so they aren't backed up again. Deleting here never touches Google Photos.</p>
    </section>`,
  );
}

async function onClick(e: Event): Promise<void> {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-show],[data-clear],[data-del]");
  if (!b) return;
  if (b.dataset.show !== undefined) {
    account = b.dataset.show;
    void load();
  } else if (b.dataset.clear) {
    const a = b.dataset.clear;
    const ok = await confirmDialog({
      title: "Delete all kept copies?",
      icon: "trash",
      body: [`Every copy kept from ${a} is deleted from this server.`, "Google Photos isn't touched."],
      confirm: "Delete all",
      danger: true,
    });
    if (!ok) return;
    const r = await post<{ deleted: number }>("downloads/delete", { account: a });
    toast(`Deleted ${num(r.deleted)} copies`, "good");
    void load();
  } else if (b.dataset.del) {
    await post("downloads/delete", { ids: [Number(b.dataset.del)] });
    void load();
  }
}

const downloads: View = {
  subtitle: "Copies kept on this server",
  mount(el) {
    account = "";
    el.innerHTML = `<div id="dl-body"><div class="card skeleton h-40"></div></div>`;
    el.addEventListener("click", (e) => void onClick(e));
    void load();
  },
};

export default downloads;
