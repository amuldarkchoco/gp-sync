// Account picker used by pages that work on one Google account at a time (Fix dates, Free storage):
// a button showing the current account, opening a menu of every connected account with its state.

import { esc } from "./dom";
import { icon } from "./icons";
import { status } from "./store";

/** First letter of an address, for the round avatar. */
export function initial(email: string): string {
  return (email.trim()[0] ?? "?").toUpperCase();
}

/** The account's state, for menus and lists. */
export function accountState(email: string, failed: string[] = status()?.login_failed ?? []): "ok" | "bad" {
  return failed.includes(email) ? "bad" : "ok";
}

export function avatar(email: string, size = "size-7"): string {
  return `<span class="acc-av ${size}" aria-hidden="true">${esc(initial(email))}</span>`;
}

/** Markup: the button (current account) and its menu. `note(account)` adds a short line per account. */
export function accountMenu(id: string, current: string, note?: (account: string) => string): string {
  const s = status();
  // Before the first status arrives, show the page's account on its own.
  const accs = s?.accounts?.length ? s.accounts : current ? [current] : [];
  if (!accs.length) return `<span class="text-sm text-ink-3">No account connected</span>`;
  const items = accs
    .map((a, i) => {
      const extra = [
        i === 0 && accs.length > 1 ? "Main" : "",
        accountState(a) === "bad" ? "Login rejected" : "",
      ]
        .concat(note ? [note(a)] : [])
        .filter(Boolean)
        .join(" · ");
      return `<button type="button" role="menuitemradio" class="acc-item" data-account="${esc(a)}" aria-checked="${a === current}">
        ${avatar(a)}<span class="min-w-0 flex-1 text-left"><span class="block truncate text-sm font-medium">${esc(a)}</span>${extra ? `<span class="block truncate text-xs ${accountState(a) === "bad" ? "text-bad" : "text-ink-3"}">${esc(extra)}</span>` : ""}</span>
        ${icon("check", "acc-tick size-4")}</button>`;
    })
    .join("");
  return `<div class="acc-pick" id="${id}">
    <button type="button" class="acc-btn" aria-haspopup="menu" aria-expanded="false" ${accs.length < 2 ? "disabled" : ""}>
      ${avatar(current)}<span class="min-w-0 truncate text-sm font-medium">${esc(current)}</span>${accs.length > 1 ? icon("chevron", "size-4 shrink-0 rotate-90 text-ink-3") : ""}
    </button>
    <div class="acc-menu" role="menu" hidden>${items}</div>
  </div>`;
}

/** Open and close the menu; `onPick` runs when another account is chosen. */
export function wireAccountMenu(id: string, onPick: (account: string) => void): void {
  const root = document.getElementById(id);
  if (!root || root.dataset.wired) return;
  root.dataset.wired = "";
  const btn = root.querySelector<HTMLButtonElement>(".acc-btn")!;
  const menu = root.querySelector<HTMLElement>(".acc-menu")!;
  const close = () => {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const outside = (e: Event) => {
    if (!root.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      close();
      btn.focus();
    }
  };
  btn.addEventListener("click", () => {
    if (!menu.hidden) return close();
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", onKey, true);
    menu.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  });
  menu.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-account]");
    if (!item) return;
    close();
    if (item.getAttribute("aria-checked") !== "true") onPick(item.dataset.account ?? "");
  });
}
