import { describe, expect, test } from "vite-plus/test";
import { ago, bytes, compact, duration, fileName, folderOf, hour, ms, pct, speed } from "./format";

describe("format", () => {
  test("bytes", () => {
    expect(bytes(0)).toBe("0 B");
    expect(bytes(1536)).toBe("1.5 KB");
    expect(bytes(5 * 1024 ** 3)).toBe("5.0 GB");
    expect(bytes(250 * 1024 ** 2)).toBe("250 MB");
  });
  test("speed is in bits", () => {
    expect(speed(125_000)).toBe("1.0 Mbps");
    expect(speed(12_500_000)).toBe("100 Mbps");
    expect(speed(0)).toBe("0 bps");
  });
  test("duration", () => {
    expect(duration(42)).toBe("42 s");
    expect(duration(200)).toBe("3 min 20 s");
    expect(duration(7500)).toBe("2 h 5 min");
    expect(duration(90000)).toBe("1 d 1 h");
    expect(ms(250)).toBe("250 ms");
    expect(ms(61_000)).toBe("1 min 1 s");
  });
  test("relative time", () => {
    expect(ago(0)).toBe("never");
    expect(ago(1000, 1010)).toBe("just now");
    expect(ago(1000, 1000 + 7200)).toBe("2 h ago");
  });
  test("misc", () => {
    expect(compact(15300)).toBe("15k");
    expect(pct(1, 4)).toBe(25);
    expect(pct(1, 0)).toBe(0);
    expect(hour(25)).toBe("01:00");
    expect(fileName("Photos/Trip/a.jpg")).toBe("a.jpg");
    expect(folderOf("Photos/Trip/a.jpg")).toBe("Photos/Trip");
  });
});
