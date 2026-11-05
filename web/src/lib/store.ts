// Live status. Pushed by the app over server-sent events (/api/stream) the moment something
// happens; if the stream can't be used, the page asks every 2 seconds instead.

import { get, type Status } from "./api";

type Listener = (s: Status) => void;

let current: Status | null = null;
const listeners = new Set<Listener>();
const modeListeners = new Set<(live: boolean) => void>();
let timer = 0;
let failures = 0;
let source: EventSource | null = null;
let lastPush = 0;

export function status(): Status | null {
  return current;
}

/** The machine's name for messages: "Umbrel" on Umbrel, otherwise "this server". */
export function host(): string {
  return current?.host || "this server";
}

export function onStatus(fn: Listener): () => void {
  listeners.add(fn);
  if (current) fn(current);
  return () => listeners.delete(fn);
}

/** Called with true while updates are pushed live, false while polling. */
export function onMode(fn: (live: boolean) => void): void {
  modeListeners.add(fn);
  fn(isLive());
}

export function isLive(): boolean {
  return Date.now() - lastPush < 6000;
}

let pageVersion = "";

/** The app was updated while this page was open: load the new page (once per version). */
function reloadIfUpdated(s: Status): boolean {
  if (!pageVersion) pageVersion = s.version;
  if (!s.version || s.version === pageVersion) return false;
  if (sessionStorage.getItem("reloaded-for") === s.version) return false; // tried already
  sessionStorage.setItem("reloaded-for", s.version);
  location.reload();
  return true;
}

function publish(s: Status): void {
  if (reloadIfUpdated(s)) return;
  current = s;
  failures = 0;
  document.documentElement.dataset.offline = "";
  listeners.forEach((fn) => {
    try {
      fn(s);
    } catch (e) {
      console.error(e);
    }
  });
}

export async function refresh(): Promise<void> {
  try {
    publish(await get<Status>("status"));
  } catch {
    failures++;
    if (failures > 2) document.documentElement.dataset.offline = "1";
  }
}

function connect(): void {
  if (!("EventSource" in window) || source) return;
  source = new EventSource("api/stream");
  source.onmessage = (e: MessageEvent<string>) => {
    const wasLive = isLive();
    lastPush = Date.now();
    if (!wasLive) modeListeners.forEach((fn) => fn(true));
    try {
      publish(JSON.parse(e.data) as Status);
    } catch {
      /* ignore a broken message */
    }
  };
  source.onerror = () => {
    // The browser reconnects by itself; polling covers the gap.
    modeListeners.forEach((fn) => fn(false));
  };
}

function disconnect(): void {
  source?.close();
  source = null;
  lastPush = 0;
}

export function startPolling(): void {
  const tick = async () => {
    if (!document.hidden && !isLive()) await refresh();
    timer = window.setTimeout(tick, 2000);
  };
  clearTimeout(timer);
  void tick();
  connect();
  document.addEventListener("visibilitychange", () => {
    // No live connection in the background: saves battery on phones.
    if (document.hidden) disconnect();
    else {
      connect();
      void refresh();
    }
  });
}
