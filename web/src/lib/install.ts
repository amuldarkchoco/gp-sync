// Installing the dashboard as an app (PWA): the browser's install prompt where it exists,
// and clear steps where it doesn't (iPhone, or a plain-http address).

import { esc, toast } from "./dom";
import { icon } from "./icons";

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let prompt: InstallPrompt | null = null;
const listeners = new Set<() => void>();

export type InstallState = "installed" | "ready" | "ios" | "insecure" | "manual";

export function installState(): InstallState {
  const standalone =
    matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (standalone) return "installed";
  if (prompt) return "ready";
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) return "ios";
  if (!isSecureContext) return "insecure";
  return "manual";
}

export function onInstallChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const changed = () => listeners.forEach((fn) => fn());

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // show our own button instead of the browser's mini bar
  prompt = e as InstallPrompt;
  changed();
});
window.addEventListener("appinstalled", () => {
  prompt = null;
  toast("Installed. Open GP Sync from your home screen", "good");
  changed();
});

/** Steps for the current device, as HTML. */
export function installHelp(state = installState()): string {
  const host = esc(location.host);
  switch (state) {
    case "installed":
      return `<p>You're using the installed app.</p>`;
    case "ready":
      return `<p>Your browser can install this dashboard as an app. Tap <b>Install</b>.</p>`;
    case "ios":
      return `<ol class="list-decimal space-y-1 pl-5"><li>Open this page in <b>Safari</b>.</li><li>Tap <b>Share</b> ${icon("upload", "inline size-3.5 -mt-0.5")}.</li><li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li></ol>`;
    case "insecure":
      return `<p>Browsers only install apps from secure (HTTPS) pages, and <code class="rounded bg-panel-2 px-1">${host}</code> is plain http. Choose one:</p>
        <ol class="list-decimal space-y-1.5 pl-5">
          <li><b>Tailscale HTTPS</b> (recommended): turn on HTTPS certificates in the Tailscale admin console, then open the app at its <code class="rounded bg-panel-2 px-1">https://…ts.net</code> address.</li>
          <li><b>Android Chrome</b>: open <code class="rounded bg-panel-2 px-1">chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>, add <code class="rounded bg-panel-2 px-1">http://${host}</code>, enable it and restart Chrome.</li>
          <li>Or use Chrome menu <b>⋮</b> → <b>Add to Home screen</b> for a shortcut (opens in the browser).</li>
        </ol>`;
    default:
      return `<p>Use your browser's menu: <b>Install app</b> (Chrome, Edge) or <b>Add to Home screen</b>.</p>`;
  }
}

/** Show the browser's install dialog, or the steps when there isn't one. */
export async function install(): Promise<void> {
  if (prompt) {
    const p = prompt;
    await p.prompt();
    const { outcome } = await p.userChoice;
    if (outcome === "accepted") prompt = null;
    changed();
    return;
  }
  location.hash = "#/settings/app";
}

export interface Capability {
  label: string;
  ok: boolean;
  note: string;
}

/** What this phone or computer can do with the dashboard, checked live (shown in Settings › App). */
export function capabilities(): Capability[] {
  const ua = navigator.userAgent;
  const android = /android/i.test(ua);
  const ios = /iphone|ipad|ipod/i.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  const secure = isSecureContext;
  const touch = matchMedia("(pointer: coarse)").matches;
  const state = installState();
  return [
    {
      label: "Upload from this device",
      ok: true,
      note: touch
        ? "Choose files, or take a photo or video with the camera"
        : "Choose files or drop them on the Upload page",
    },
    {
      label: "Install as an app",
      ok: state === "installed" || state === "ready" || ios || secure,
      note:
        state === "installed"
          ? "Installed"
          : ios
            ? "Safari › Share › Add to Home Screen"
            : secure
              ? "Browser menu › Install app"
              : "Needs HTTPS (only a home-screen shortcut on http)",
    },
    {
      label: "Share photos to GP Sync from the gallery",
      ok: android && secure,
      note: android
        ? secure
          ? "Install the app, then use Share in the gallery"
          : "Needs HTTPS"
        : "Android only",
    },
    {
      label: "Open without a connection",
      ok: secure && "serviceWorker" in navigator,
      note: secure ? "The app shell and seen thumbnails are kept" : "Needs HTTPS",
    },
    {
      label: "Keep the screen on while uploading",
      ok: secure && "wakeLock" in navigator,
      note:
        "wakeLock" in navigator
          ? secure
            ? "Automatic during uploads"
            : "Needs HTTPS"
          : "Not supported by this browser",
    },
    {
      label: "Upload while the app is in the background",
      ok: false,
      note: "Phones pause web apps in the background; uploads continue where they stopped when you come back",
    },
    {
      label: "Vibration on taps",
      ok: android && "vibrate" in navigator,
      note: android ? "Light tap feedback" : "Not available on this device",
    },
  ];
}
