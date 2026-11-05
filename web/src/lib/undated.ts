import { get, post, type Settings, type Status } from "./api";
import { esc, toast } from "./dom";
import { icon } from "./icons";
import { refresh } from "./store";

// Asked once, right after the first Google account is connected (and once after updating):
// should photos and videos with no date of their own go into an album of their own?

let open = false;

export function askUndated(s: Status): void {
  if (open || s.undated_asked !== false || !s.accounts.length) return;
  open = true;
  void get<Settings>("settings")
    .then((cfg) => show(cfg.undated?.name || "Date unknown"))
    .catch(() => (open = false));
}

function show(name: string): void {
  const box = document.createElement("div");
  box.className = "fixed inset-0 z-[60] grid place-items-center bg-black/60 p-4";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-labelledby", "und-title");
  box.innerHTML = `<div class="card w-full max-w-md p-5 shadow-2xl">
    <div class="flex items-center gap-3"><span class="grid size-10 place-items-center rounded-xl bg-panel-2 text-ink-2">${icon("calendar", "size-5")}</span>
      <h2 id="und-title" class="text-lg font-semibold tracking-tight">Photos without a date</h2></div>
    <p class="mt-3 text-sm text-ink-2">Some photos and videos have no date saved inside them: Snapchat saves, screenshots, pictures from chats. Google Photos then dates them by the upload, so they can end up on the wrong day.</p>
    <p class="mt-2 text-sm text-ink-3">GP Sync sends the best date it knows. It can also keep all of them in one album so they're easy to find and check.</p>
    <label class="mt-4 block"><span class="mb-1.5 block text-sm font-medium">Album name</span>
      <input class="input" id="und-name" maxlength="80" value="${esc(name)}"></label>
    <div class="mt-5 flex flex-wrap justify-end gap-2">
      <button class="btn" data-und="off">No album</button>
      <button class="btn primary" data-und="on">${icon("ok")}Use an album</button>
    </div>
    <p class="mt-3 text-xs text-ink-3">You can change this later in Settings › Albums &amp; duplicates.</p>
  </div>`;
  document.body.append(box);
  const input = box.querySelector<HTMLInputElement>("#und-name");
  input?.focus();
  const answer = async (album: boolean) => {
    try {
      await post("settings", { undated: { album, name: input?.value.trim() ?? "", asked: true } });
      toast(
        album ? "Photos without a date go into their own album" : "No album for photos without a date",
        "good",
      );
      box.remove();
      open = false;
      void refresh();
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  };
  box.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-und]");
    if (b) void answer(b.dataset.und === "on");
  });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target === input) void answer(true);
  });
}
