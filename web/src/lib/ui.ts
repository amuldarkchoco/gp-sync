// Shared bits of markup: phase badges, stat tiles, card headers.

import type { Status } from "./api";
import { esc } from "./dom";
import { ago, duration, hour, speed, until } from "./format";
import { icon, type IconName } from "./icons";

export type Tone = "good" | "warn" | "bad" | "info" | "";

export interface PhaseInfo {
  label: string;
  tone: Tone;
  icon: IconName;
  detail: string;
}

export function phaseInfo(s: Status): PhaseInfo {
  const left = s.library.files - s.library.synced_files;
  switch (s.phase) {
    case "uploading":
      return {
        label: s.total ? `Uploading ${Math.min(s.done + 1, s.total)}/${s.total}` : "Uploading",
        tone: "info",
        icon: "cloudUp",
        detail: s.current
          ? `Sending ${s.current.name.split("/").pop()}`
          : `${s.done} of ${s.total} this round`,
      };
    case "scanning":
      return { label: "Scanning", tone: "info", icon: "loader", detail: "Looking for new photos and videos" };
    case "paused":
      return {
        label: "Paused",
        tone: "warn",
        icon: "pause",
        detail: left > 0 ? `${left} file(s) wait until you resume` : "Nothing is waiting",
      };
    case "scheduled":
      return {
        label: "Waiting",
        tone: "warn",
        icon: "clock",
        detail: `Upload hours start ${until(s.schedule.next_window, s.now)}`,
      };
    case "setup":
      return { label: "Set up", tone: "warn", icon: "key", detail: "Connect a Google account in Settings" };
    case "error":
      return { label: "Error", tone: "bad", icon: "error", detail: s.error || "Something went wrong" };
    case "starting":
      return { label: "Starting", tone: "info", icon: "loader", detail: "Starting up" };
    default:
      return left > 0
        ? { label: `${left} waiting`, tone: "", icon: "hourglass", detail: "Uploading at the next scan" }
        : { label: "Up to date", tone: "good", icon: "ok", detail: "Everything is backed up" };
  }
}

export function badge(label: string, tone: Tone = "", ic?: IconName, tip?: string): string {
  return `<span class="badge ${tone}"${tip ? ` data-tip="${esc(tip)}"` : ""}>${ic ? icon(ic) : ""}${esc(label)}</span>`;
}

/** The one badge that says what the app is doing. Moving icons while it works. */
export function phaseBadge(s: Status): string {
  const p = phaseInfo(s);
  const motion =
    s.phase === "scanning" || s.phase === "starting" ? "spin" : s.phase === "uploading" ? "bob" : "";
  return `<span class="badge ${p.tone} phase" data-tip="${esc(p.detail)}">${icon(p.icon, motion)}${esc(p.label)}</span>`;
}

/** A file row or tile that opens the viewer (see main.ts). */
export function openAttrs(name: string, info = false): string {
  return `data-open="${esc(name)}"${info ? ' data-info="1"' : ""} tabindex="0" role="button"`;
}

/** Seconds until the next automatic scan. */
export function nextScan(s: Status): number {
  return Math.max(0, s.last_scan + s.interval * 60 - s.now);
}

/** Only what matters right now: problems, limits that are on, the next scan. Defaults stay quiet. */
export function syncChips(s: Status): string {
  const sch = s.schedule;
  const out: string[] = [];
  if (s.login_failed.length) out.push(badge("Login rejected", "bad", "warn", s.login_failed.join(", ")));
  if (s.counts.failed) out.push(badge(`${s.counts.failed} failed`, "bad", "error", "See Activity → Failed"));
  if (s.phase === "uploading" && s.net.up_avg > 1000)
    out.push(badge(speed(s.net.up_avg), "info", "up", "Upload speed (last 30 s)"));
  if (sch.enabled)
    out.push(
      badge(
        `${hour(sch.start)}–${hour(sch.end)}`,
        sch.allowed ? "good" : "warn",
        "clock",
        sch.allowed ? "Inside upload hours" : "Outside upload hours",
      ),
    );
  if (s.speed_limit_mbps)
    out.push(badge(`${s.speed_limit_mbps} Mbps`, "info", "gauge", "Upload speed limit"));
  if (s.phase !== "scanning" && s.phase !== "uploading" && s.last_scan) {
    const n = nextScan(s);
    out.push(
      badge(
        n > 30 ? `Next scan ${until(s.now + n, s.now)}` : "Scanning soon",
        "",
        "search",
        `Last scan ${ago(s.last_scan, s.now)} · every ${s.interval} min`,
      ),
    );
  }
  return out.join("");
}

export function cardHead(title: string, ic: IconName, extra = ""): string {
  return `<div class="card-h">${icon(ic, "size-4 text-ink-3")}<span>${esc(title)}</span><div class="sub">${extra}</div></div>`;
}

export function tile(opts: {
  label: string;
  value: string;
  ic: IconName;
  sub?: string;
  chart?: string;
  id?: string;
  tone?: Tone;
}): string {
  return `<div class="card lift flex min-w-0 flex-col p-4"${opts.id ? ` id="${opts.id}"` : ""}>
    <div class="flex items-center gap-2"><span class="grid size-7 place-items-center rounded-lg bg-panel-2 text-ink-2">${icon(opts.ic, "size-4")}</span><span class="label">${esc(opts.label)}</span></div>
    <div class="num mt-2 truncate text-xl sm:text-2xl" data-v>${opts.value}</div>
    <div class="mt-0.5 truncate text-xs text-ink-3" data-s>${opts.sub ?? ""}</div>
    ${opts.chart !== undefined ? `<div class="mt-auto pt-2" data-c>${opts.chart}</div>` : ""}
  </div>`;
}

export function etaText(s: Status): string {
  const left = s.library.bytes - s.library.synced_bytes;
  if (left <= 0) return "";
  const rate = s.net.up_avg;
  if (s.phase !== "uploading" || rate < 10_000) return "";
  return duration(left / rate);
}

export function kindIcon(name: string): IconName {
  return /\.(mp4|mov|m4v|3gp|3g2|avi|mkv|webm|mts|m2ts|wmv|mpg|mpeg)$/i.test(name) ? "video" : "photo";
}

export const eventMeta: Record<string, { tone: Tone; icon: IconName; label: string }> = {
  uploaded: { tone: "good", icon: "cloudUp", label: "Uploaded" },
  exists: { tone: "info", icon: "verified", label: "Already in Google" },
  failed: { tone: "bad", icon: "error", label: "Failed" },
  error: { tone: "bad", icon: "warn", label: "Error" },
  scan: { tone: "", icon: "search", label: "Scan" },
  pause: { tone: "warn", icon: "pause", label: "Paused" },
  resume: { tone: "good", icon: "play", label: "Resumed" },
  account: { tone: "", icon: "users", label: "Account" },
  album: { tone: "", icon: "library", label: "Album" },
  received: { tone: "info", icon: "phone", label: "From phone" },
  info: { tone: "", icon: "info", label: "Info" },
};

/** Thumbnail with a photo/video icon if it can't be shown (see the error handler in main.ts).
 *  With the file's time (`v`) the picture can be kept by the browser for good. */
export function thumb(name: string, cls = "thumb", v?: number): string {
  const ver = v ? `&v=${v}` : "";
  return `<img class="${cls}" loading="lazy" decoding="async" src="api/thumb?path=${encodeURIComponent(name)}${ver}" alt="" data-kind="${kindIcon(name)}">`;
}

export function thumbFallback(img: HTMLImageElement): void {
  img.parentElement?.classList.add("done");
  const span = document.createElement("span");
  span.className = `${img.className} loaded grid place-items-center text-ink-3`;
  span.innerHTML = icon(img.dataset.kind === "video" ? "video" : "photo", "size-1/2 max-h-6 max-w-6");
  img.replaceWith(span);
}
