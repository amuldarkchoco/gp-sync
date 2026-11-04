// Small DOM helpers: escaping, querying and a toast.

export function esc(s: string | number | null | undefined): string {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

export function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error("Missing element " + sel);
  return el;
}

export function $$<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] {
  return [...root.querySelectorAll<T>(sel)];
}

/** Set innerHTML only when it changed, so hover states and focus survive live updates. */
export function html(el: Element, markup: string): void {
  if ((el as HTMLElement).dataset.html !== markup) {
    el.innerHTML = markup;
    (el as HTMLElement).dataset.html = markup;
  }
}

export function text(el: Element, value: string): void {
  if (el.textContent !== value) el.textContent = value;
}

let toastTimer = 0;
const TOAST_ICONS = {
  good: '<path d="M20 6 9 17l-5-5"/>',
  bad: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
};

/** A short message at the bottom (above the phone tab bar). Errors stay longer; tap to close. */
export function toast(message: string, kind: "good" | "bad" | "info" = "info"): void {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    el.addEventListener("click", () => el?.classList.remove("show"));
    document.body.append(el);
  }
  el.setAttribute("role", kind === "bad" ? "alert" : "status");
  el.dataset.kind = kind;
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TOAST_ICONS[kind]}</svg><span>${esc(message)}</span>`;
  el.classList.remove("show");
  void el.offsetWidth; // restart the entrance animation
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el?.classList.remove("show"), kind === "bad" ? 7000 : 3500);
}

export async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const t = document.createElement("textarea");
    t.value = value;
    document.body.append(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
  toast("Copied", "good");
}
