import { describe, expect, it } from "vitest";

import {
  ANCHORS,
  dimensionColor,
  dimensionColorVars,
  hexToOklab,
  oklabToHex
} from "../src/core/color";
import { parseEntries } from "../src/core/entries";

/** Pinned: the value level 7 has, and keeps having. */
const LEVEL_7 = "#b082f7";

describe("dimensionColor", () => {
  it("returns the anchors untouched for levels 1 to 6", () => {
    expect([1, 2, 3, 4, 5, 6].map(dimensionColor)).toEqual([...ANCHORS]);
  });

  it("is the same value whether or not a deeper level exists anywhere", () => {
    expect(dimensionColor(7)).toBe(LEVEL_7);

    // The old ramp re-spread itself whenever the vault found a deeper level, and
    // the colour visibly jumped. Reading a note with a level 9 entry in it must
    // change nothing.
    parseEntries(["{ 9.1.1 } - 10:00:00", "prose", "+ 00:00:00"].join("\n"));
    expect(dimensionColor(7)).toBe(LEVEL_7);
  });

  it("keeps the spiral distinguishable past its first turn", () => {
    const levels = Array.from({ length: 18 }, (_, index) => index + 7);
    const colors = levels.map(dimensionColor);

    expect(new Set(colors).size).toBe(colors.length);
    for (const level of levels) {
      expect(dimensionColor(level)).not.toBe(dimensionColor(level + 9));
    }
  });

  it("always answers with a seven-character hex colour", () => {
    for (let level = 1; level <= 64; level += 1) {
      expect(dimensionColor(level)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("round-trips through OKLab, which is what the spiral is built on", () => {
    for (const anchor of ANCHORS) {
      const [l, a, b] = hexToOklab(anchor);
      expect(oklabToHex(l, a, b)).toBe(anchor);
    }
  });

  it("carries both custom properties in one style string", () => {
    expect(dimensionColorVars(7)).toBe(`--weaver-dcolor:${LEVEL_7};--weaver-d:7`);
  });
});
