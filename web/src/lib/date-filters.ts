import type { DateItem } from "./api";

export type DateFilter = "wrong" | "waiting" | "fixed" | "all";

export function dateWaiting(i: DateItem): boolean {
  return i.fix === "waiting" || i.fix === "in_google";
}

export function dateFixable(i: DateItem): boolean {
  return i.wrong && (i.fix === "" || i.fix === "failed" || i.fix === "done");
}

export function filterDates(items: DateItem[], filter: DateFilter): DateItem[] {
  switch (filter) {
    case "wrong":
      return items.filter(
        (i) => !dateWaiting(i) && (i.wrong || i.fix === "failed" || (i.google == null && i.fix !== "done")),
      );
    case "waiting":
      return items.filter(dateWaiting);
    case "fixed":
      return items.filter((i) => i.fix === "done" && !i.wrong);
    case "all":
      return items;
  }
}
