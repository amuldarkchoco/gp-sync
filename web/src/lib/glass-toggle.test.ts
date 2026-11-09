import { describe, expect, it } from "vite-plus/test";
import { moonPixels, pairPixels, revealRadius, sunPixels } from "./glass-toggle";

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

describe("theme reveal", () => {
  it("grows with the knob and reaches the farthest corner at the end", () => {
    // Knob near the top right of a 1000x800 page: the farthest corner is bottom left.
    const full = Math.hypot(900, 760);
    expect(revealRadius(0, 900, 40, 1000, 800)).toBe(0);
    expect(revealRadius(0.5, 900, 40, 1000, 800)).toBeCloseTo(full / 2);
    expect(revealRadius(1, 900, 40, 1000, 800)).toBeCloseTo(full);
    expect(revealRadius(1.4, 900, 40, 1000, 800)).toBeCloseTo(full);
  });
});
