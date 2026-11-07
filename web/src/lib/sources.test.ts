import { describe, expect, it } from "vite-plus/test";
import type { SourceItem, SourceSettings } from "./api";
import { acceptable, actionSummary, estimateLabel, sourceTabs, spreadDays } from "./sources";

const DAY = 86400;
const AUG3 = Date.UTC(2026, 7, 3, 12) / 1000;

const item = (source: SourceItem["source"], estimate: SourceItem["estimate"]): SourceItem => ({
  name: "Photos/a.jpg",
  kind: "photo",
  size: 1,
  mtime: 0,
  source,
  detected: source,
  decided: false,
  app: "",
  device: "",
  app_version: "",
  os_version: "",
  taken: null,
  confidence: "marker",
  reasons: [],
  estimate,
  uploaded: true,
  google_url: "",
  album: "",
  archived: false,
  captioned: "",
});

describe("sources helpers", () => {
  it("formats an estimate with its window", () => {
    const e = { date: AUG3, lo: AUG3 - 4 * DAY, hi: AUG3 + 4 * DAY, reason: "" };
    expect(spreadDays(e)).toBe(4);
    expect(estimateLabel(e)).toBe("around 3 Aug 2026 ± 4 days");
    expect(estimateLabel({ ...e, lo: AUG3, hi: AUG3 })).toBe("around 3 Aug 2026 ± 1 day");
  });

  it("orders tabs app sources first and hides empty ones", () => {
    const order = ["camera", "snapchat", "screenshot", "app_export", "unknown"] as const;
    const counts = { camera: 5, snapchat: 2, screenshot: 0, app_export: 1, unknown: 1 } as never;
    expect(sourceTabs([...order], counts)).toEqual(["snapchat", "app_export", "camera", "unknown"]);
  });

  it("summarises the actions for a source", () => {
    const s = {
      snapchat: { album: true, album_name: "Snapchat", caption: true, archive: true },
      screenshot: { album: false, album_name: "Screenshots", caption: false, archive: false },
    } as unknown as SourceSettings;
    expect(actionSummary(s, "snapchat")).toBe("Album “Snapchat” · caption · archived");
    expect(actionSummary(s, "screenshot")).toBe("Nothing in Google");
  });

  it("only offers estimates of Snapchat items", () => {
    const e = { date: AUG3, lo: AUG3, hi: AUG3, reason: "" };
    const items = [item("snapchat", e), item("snapchat", null), item("app_export", e)];
    expect(acceptable(items)).toHaveLength(1);
  });
});
