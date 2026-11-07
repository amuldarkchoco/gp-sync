import type { AppSourceId, SourceId, SourceItem, SourceSettings } from "./api";

// Helpers for the Sources page: what each source means, and how an estimate is shown.

/** One line on the evidence behind each source, shown in the explainer and on the tabs. */
export const SOURCE_HELP: Record<SourceId, string> = {
  camera: "The file names the camera or phone that took it.",
  snapchat:
    "Snapchat left a record inside the file (app version, phone, iOS version), or the file name starts with Snapchat-.",
  instagram: "Instagram set itself as the software that saved the file.",
  tiktok: "TikTok left its name in the video's metadata.",
  whatsapp: "The file name follows WhatsApp's pattern (IMG-20240504-WA0001).",
  telegram: "The file name follows Telegram's pattern.",
  screenshot: "The phone marked it as a screenshot, or the file name says so.",
  app_export:
    "No camera data inside: it was saved from an app or the web, but no app name survives. GP Sync never guesses which one.",
  unknown: "The file could not be read.",
};

/** Tabs in display order: app sources first (the ones with actions), then camera and unknown. */
export function sourceTabs(order: SourceId[], counts: Record<SourceId, number>): SourceId[] {
  const apps = order.filter((s) => s !== "camera" && s !== "unknown");
  return [...apps, "camera" as SourceId, "unknown" as SourceId].filter(
    (s) => order.includes(s) && (counts[s] ?? 0) > 0,
  );
}

/** Half the estimate window, in whole days (at least 1). */
export function spreadDays(e: NonNullable<SourceItem["estimate"]>): number {
  return Math.max(1, Math.round((e.hi - e.lo) / 2 / 86400));
}

/** "around 3 Aug 2026 ± 4 days" (UTC date, like the caption written to Google). */
export function estimateLabel(e: NonNullable<SourceItem["estimate"]>): string {
  const day = new Date(e.date * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  const n = spreadDays(e);
  return `around ${day} ± ${n} day${n === 1 ? "" : "s"}`;
}

/** What GP Sync does in Google for a source, in a few words ("Album Snapchat · caption"). */
export function actionSummary(s: SourceSettings, id: AppSourceId): string {
  const a = s[id];
  if (!a) return "";
  const parts = [
    a.album ? `Album “${a.album_name}”` : "",
    a.caption ? "caption" : "",
    a.archive ? "archived" : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Nothing in Google";
}

/** Items whose estimated date can be accepted (Snapchat items with an estimate). */
export function acceptable(items: SourceItem[]): SourceItem[] {
  return items.filter((i) => i.source === "snapchat" && i.estimate);
}
