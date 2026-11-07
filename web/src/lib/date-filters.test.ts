import { describe, expect, it } from "vite-plus/test";
import type { DateItem } from "./api";
import { dateFixable, dateWaiting, filterDates } from "./date-filters";

const item = (name: string, fix: DateItem["fix"], wrong: boolean): DateItem => ({
  name,
  kind: "photo",
  size: 1,
  google: null,
  google_source: "unknown",
  previous_google: null,
  previous_google_source: "unknown",
  best: 1,
  source: "file",
  manual: null,
  wrong,
  fix,
  error: "",
  google_url: "",
});

describe("date status filters", () => {
  const items = [
    item("wrong", "", true),
    item("waiting", "waiting", true),
    item("trash", "in_google", false),
    item("fixed", "done", false),
    item("wrong again", "done", true),
    item("failed", "failed", false),
    item("unknown", "", false),
  ];

  it("groups each step without hiding failures or incorrect fixes", () => {
    expect(filterDates(items, "wrong").map((i) => i.name)).toEqual([
      "wrong",
      "wrong again",
      "failed",
      "unknown",
    ]);
    expect(filterDates(items, "waiting").map((i) => i.name)).toEqual(["waiting", "trash"]);
    expect(filterDates(items, "fixed").map((i) => i.name)).toEqual(["fixed"]);
    expect(filterDates(items, "all")).toHaveLength(7);
  });

  it("only enables bulk actions for suitable items", () => {
    expect(items.filter(dateFixable).map((i) => i.name)).toEqual(["wrong", "wrong again"]);
    expect(items.filter(dateWaiting).map((i) => i.name)).toEqual(["waiting", "trash"]);
  });
});
