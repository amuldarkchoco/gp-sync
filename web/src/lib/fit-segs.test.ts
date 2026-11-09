import { describe, expect, it } from "vite-plus/test";
import { overflows } from "./fit-segs";

describe("fit segmented controls", () => {
  it("wraps only when the choices are wider than their box", () => {
    expect(overflows(320, 324)).toBe(false);
    expect(overflows(325, 324)).toBe(false); // rounding
    expect(overflows(400, 324)).toBe(true);
  });
});
