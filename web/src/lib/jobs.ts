import type { Job } from "./api";

// Background work across accounts (library reads, freeing storage, fixing dates, copies), shown on
// Overview so it is clear what runs side by side.

const STEP: Record<string, string> = {
  downloading: "Downloading",
  deleting: "Replacing in Google",
  uploading: "Uploading",
};

/** "Free storage · a@x.com" or "Copy · a@x.com → b@x.com". */
export function jobTitle(j: Job): string {
  const what = { library: "Reading library", storage: "Free storage", dates: "Fix dates", copy: "Copy" }[
    j.kind
  ];
  return `${what} · ${j.account}${j.kind === "copy" && j.to ? ` → ${j.to}` : ""}`;
}

/** What it is doing: "Uploading IMG_1.jpg", or "" for a library read. */
export function jobStep(j: Job): string {
  if (j.kind === "library" || !j.step) return "";
  const name = (j.name ?? "").split("/").pop() ?? "";
  return `${STEP[j.step] ?? j.step}${name ? ` ${name}` : ""}`;
}

/** Where its page is. */
export function jobLink(j: Job): string {
  return { library: "#/storage", storage: "#/storage", dates: "#/dates", copy: "#/copy" }[j.kind];
}
