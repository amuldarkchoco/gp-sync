import { esc } from "./dom";
import { icon, type IconName } from "./icons";

// A small confirm dialog, with an optional checkbox (for example "delete the copy afterwards").

export interface ConfirmOptions {
  title: string;
  icon?: IconName;
  /** Paragraphs of plain text. */
  body: string[];
  confirm: string;
  danger?: boolean;
  checkbox?: { label: string; hint?: string; checked: boolean };
}

/** Resolves with the checkbox state when confirmed, or null when cancelled. */
export function confirmDialog(o: ConfirmOptions): Promise<{ checked: boolean } | null> {
  return new Promise((resolve) => {
    const box = document.createElement("div");
    box.className = "fixed inset-0 z-[60] grid place-items-center bg-black/60 p-4";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "cd-title");
    box.innerHTML = `<div class="card w-full max-w-md p-5 shadow-2xl">
      <div class="flex items-center gap-3"><span class="grid size-10 shrink-0 place-items-center rounded-xl bg-panel-2 text-ink-2">${icon(o.icon ?? "info", "size-5")}</span>
        <h2 id="cd-title" class="text-lg font-semibold tracking-tight">${esc(o.title)}</h2></div>
      ${o.body.map((p, i) => `<p class="${i ? "mt-2 text-ink-3" : "mt-3 text-ink-2"} text-sm">${esc(p)}</p>`).join("")}
      ${
        o.checkbox
          ? `<label class="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3">
          <input type="checkbox" id="cd-check" class="mt-0.5 size-4 accent-[var(--accent)]" ${o.checkbox.checked ? "checked" : ""}>
          <span><span class="block text-sm font-medium">${esc(o.checkbox.label)}</span>${o.checkbox.hint ? `<span class="block text-xs text-ink-3">${esc(o.checkbox.hint)}</span>` : ""}</span></label>`
          : ""
      }
      <div class="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button class="btn" data-cd="no">Cancel</button>
        <button class="btn ${o.danger ? "danger" : "primary"}" data-cd="yes">${icon("ok")}${esc(o.confirm)}</button>
      </div></div>`;
    const done = (ok: boolean) => {
      const checked = !!box.querySelector<HTMLInputElement>("#cd-check")?.checked;
      box.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(ok ? { checked } : null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") done(false);
    };
    box.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-cd]");
      if (b) done(b.dataset.cd === "yes");
      else if (e.target === box) done(false);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.append(box);
    box.querySelector<HTMLButtonElement>('[data-cd="yes"]')?.focus();
  });
}
