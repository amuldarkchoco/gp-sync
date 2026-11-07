// Light/dark theme, saved per browser. "system" follows the device.

function apply(t: string): void {
  const dark = t === "dark" || (t === "system" && !matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0b101a" : "#edf2f9");
}

export function theme(): string {
  return localStorage.getItem("theme") ?? "dark";
}

export function setTheme(t: string): void {
  localStorage.setItem("theme", t);
  apply(t);
}

export function initTheme(): void {
  apply(theme());
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => apply(theme()));
}
