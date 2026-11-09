// Light/dark theme, saved per browser. "system" follows the device.

function apply(t: string): void {
  const dark = t === "dark" || (t === "system" && !matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0b0c0e" : "#ecebe7");
  window.dispatchEvent(new Event("themechange"));
}

/** The saved choice: "dark", "light" or "system". */
export function theme(): string {
  return localStorage.getItem("theme") ?? "dark";
}

/** The theme on screen right now. */
export function resolvedTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function setTheme(t: string): void {
  localStorage.setItem("theme", t);
  apply(t);
}

export function initTheme(): void {
  apply(theme());
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => apply(theme()));
}
