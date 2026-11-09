import { describe, expect, it } from "vite-plus/test";
import { moonPixels, pairPixels, sunPixels } from "./glass-toggle";

const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;

describe("glass toggle pixel morph", () => {
  const moon = moonPixels();
  const sun = sunPixels();
  const pairs = pairPixels(moon, sun, () => 0.5);

  it("uses every pixel of both icons", () => {
    expect(new Set(pairs.map((p) => key(p.from)))).toEqual(new Set(moon.map(key)));
    expect(new Set(pairs.map((p) => key(p.to)))).toEqual(new Set(sun.map(key)));
  });

  it("lights each shared partner once, so no pixel doubles up", () => {
    const lit = pairs.filter((p) => p.to.b > 0).map((p) => key(p.to));
    expect(new Set(lit).size).toBe(lit.length);
  });

  it("keeps delays short enough that every pixel lands", () => {
    for (const p of pairs) {
      expect(p.delay).toBeGreaterThanOrEqual(0);
      expect(p.delay).toBeLessThanOrEqual(0.3);
    }
  });
});
