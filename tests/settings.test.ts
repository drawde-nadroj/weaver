import { describe, expect, it } from "vitest";

import {
  DEFAULT_DATA,
  DEFAULT_SETTINGS,
  MAX_MAX_DEPTH,
  MIN_MAX_DEPTH,
  clamp,
  isValidHeadingSize,
  normalizeData,
  normalizeLevelSizes,
  normalizeSettings
} from "../src/settings";

describe("DEFAULT_SETTINGS", () => {
  it("matches the product contract", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      timestampFormat: "HH:mm:ss",
      timestampSeparator: " - ",
      maxDepth: 12,
      sparkTarget: "today",
      writeDayCounters: true,
      dayNoteFolder: "Chronomancer",
      dayNoteFormat: "YYYY.MM.DD",
      equalizeHeadingSizes: true,
      headingSize: "1em",
      headingWeight: 600,
      indentStep: 18,
      mobileIndentStep: 12,
      indentMaxLevel: 8,
      colorMode: "vault-stretch",
      paletteTransitionMs: 200,
      inPageDrafts: true,
      travelDefaultLevel: "all",
      travelWrap: false,
      deepHeadingLivePreview: true,
      deepHeadingReadingView: true,
      portEmphasisColors: true,
      debug: false
    });
  });

  it("carries exactly the 23 keys the settings tab renders", () => {
    expect(Object.keys(DEFAULT_SETTINGS)).toHaveLength(23);
  });
});

describe("clamp", () => {
  it("clamps into the inclusive range", () => {
    expect(clamp(5, 1, 10)).toBe(5);
    expect(clamp(0, 1, 10)).toBe(1);
    expect(clamp(11, 1, 10)).toBe(10);
  });

  it("falls back to the minimum for non-finite input", () => {
    expect(clamp(Number.NaN, 3, 9)).toBe(3);
    expect(clamp(Number.POSITIVE_INFINITY, 3, 9)).toBe(3);
  });
});

describe("normalizeSettings", () => {
  it("returns defaults for non-objects", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("nope")).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings([1, 2, 3])).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it("clamps maxDepth and rounds it", () => {
    expect(normalizeSettings({ maxDepth: 99 }).maxDepth).toBe(MAX_MAX_DEPTH);
    expect(normalizeSettings({ maxDepth: 1 }).maxDepth).toBe(MIN_MAX_DEPTH);
    expect(normalizeSettings({ maxDepth: 9.6 }).maxDepth).toBe(10);
    expect(normalizeSettings({ maxDepth: "12" }).maxDepth).toBe(DEFAULT_SETTINGS.maxDepth);
  });

  it("normalises the draft switch as a boolean", () => {
    expect(normalizeSettings({ inPageDrafts: false }).inPageDrafts).toBe(false);
    expect(normalizeSettings({ inPageDrafts: "no" }).inPageDrafts).toBe(true);
  });

  it("drops a setting the plugin no longer has", () => {
    // A key from an older build is dropped rather than carried, so a retired
    // surface cannot resurrect itself from data.json.
    const normalized = normalizeSettings({ retiredSetting: true, debug: true });
    expect(normalized).not.toHaveProperty("retiredSetting");
    expect(normalized.debug).toBe(true);
    expect(Object.keys(normalized)).toHaveLength(Object.keys(DEFAULT_SETTINGS).length);
  });

  it("clamps every numeric range", () => {
    expect(normalizeSettings({ headingWeight: 100 }).headingWeight).toBe(300);
    expect(normalizeSettings({ headingWeight: 1000 }).headingWeight).toBe(800);
    expect(normalizeSettings({ indentStep: -4 }).indentStep).toBe(0);
    expect(normalizeSettings({ indentStep: 100 }).indentStep).toBe(48);
    expect(normalizeSettings({ mobileIndentStep: 100 }).mobileIndentStep).toBe(32);
    expect(normalizeSettings({ paletteTransitionMs: -20 }).paletteTransitionMs).toBe(0);
    expect(normalizeSettings({ paletteTransitionMs: 5000 }).paletteTransitionMs).toBe(1000);
  });

  it("keeps indentMaxLevel inside 1..maxDepth", () => {
    expect(normalizeSettings({ maxDepth: 10, indentMaxLevel: 40 }).indentMaxLevel).toBe(10);
    expect(normalizeSettings({ maxDepth: 10, indentMaxLevel: 0 }).indentMaxLevel).toBe(1);
    expect(normalizeSettings({ maxDepth: 8, indentMaxLevel: 8 }).indentMaxLevel).toBe(8);
  });

  it("validates the heading size syntax", () => {
    expect(normalizeSettings({ headingSize: "1.2em" }).headingSize).toBe("1.2em");
    expect(normalizeSettings({ headingSize: "18px" }).headingSize).toBe("18px");
    expect(normalizeSettings({ headingSize: "1rem" }).headingSize).toBe("1rem");
    expect(normalizeSettings({ headingSize: "large" }).headingSize).toBe("1em");
    expect(normalizeSettings({ headingSize: "12pt" }).headingSize).toBe("1em");
    expect(normalizeSettings({ headingSize: "1.4" }).headingSize).toBe("1em");
    expect(normalizeSettings({ headingSize: 14 }).headingSize).toBe("1em");
  });

  it("keeps valid per-level sizes and drops the rest", () => {
    const normalized = normalizeSettings({
      maxDepth: 8,
      headingLevelSizes: {
        1: "2em",
        2: " 1.5rem ",
        3: "huge",
        9: "3em",
        0: "1em",
        x: "1em"
      }
    });

    expect(normalized.headingLevelSizes).toEqual({ 1: "2em", 2: "1.5rem" });
  });

  it("defaults per-level sizes to none", () => {
    expect(normalizeSettings({}).headingLevelSizes).toEqual({});
    expect(normalizeLevelSizes(null, 12)).toEqual({});
    expect(normalizeLevelSizes(["1em"], 12)).toEqual({});
  });

  it("validates heading size strings", () => {
    expect(isValidHeadingSize("1em")).toBe(true);
    expect(isValidHeadingSize(" 18px ")).toBe(true);
    expect(isValidHeadingSize("1.25rem")).toBe(true);
    expect(isValidHeadingSize("large")).toBe(false);
    expect(isValidHeadingSize("1e")).toBe(false);
  });

  it("falls back to defaults for unknown enum values", () => {
    expect(normalizeSettings({ timestampFormat: "HH:mm:ss.SSS" }).timestampFormat).toBe("HH:mm:ss");
    expect(normalizeSettings({ colorMode: "rainbow" }).colorMode).toBe("vault-stretch");
    expect(normalizeSettings({ sparkTarget: "somewhere" }).sparkTarget).toBe("today");
    expect(normalizeSettings({ timestampFormat: "HH:mm" }).timestampFormat).toBe("HH:mm");
    expect(normalizeSettings({ colorMode: "fixed-anchor" }).colorMode).toBe("fixed-anchor");
    expect(normalizeSettings({ sparkTarget: "note" }).sparkTarget).toBe("note");
  });

  it("coerces booleans only from booleans", () => {
    expect(normalizeSettings({ travelWrap: true }).travelWrap).toBe(true);
    expect(normalizeSettings({ travelWrap: "true" }).travelWrap).toBe(false);
    expect(normalizeSettings({ travelWrap: 1 }).travelWrap).toBe(false);
    expect(normalizeSettings({ debug: true }).debug).toBe(true);
    expect(normalizeSettings({ writeDayCounters: "yes" }).writeDayCounters).toBe(true);
  });

  it("normalizes the travel default level", () => {
    expect(normalizeSettings({ travelDefaultLevel: "all" }).travelDefaultLevel).toBe("all");
    expect(normalizeSettings({ travelDefaultLevel: 3 }).travelDefaultLevel).toBe(3);
    expect(normalizeSettings({ travelDefaultLevel: 2.6 }).travelDefaultLevel).toBe(3);
    expect(normalizeSettings({ maxDepth: 8, travelDefaultLevel: 20 }).travelDefaultLevel).toBe(8);
    expect(normalizeSettings({ travelDefaultLevel: 0 }).travelDefaultLevel).toBe(1);
    expect(normalizeSettings({ travelDefaultLevel: "second" }).travelDefaultLevel).toBe("all");
  });

  it("keeps any string separator, including an empty one", () => {
    expect(normalizeSettings({ timestampSeparator: " • " }).timestampSeparator).toBe(" • ");
    expect(normalizeSettings({ timestampSeparator: "" }).timestampSeparator).toBe("");
    expect(normalizeSettings({ timestampSeparator: 7 }).timestampSeparator).toBe(" - ");
  });

  it("ignores unknown fields", () => {
    const normalized = normalizeSettings({ nope: true, maxDepth: 9 });
    expect(normalized).not.toHaveProperty("nope");
    expect(normalized.maxDepth).toBe(9);
  });
});

describe("normalizeData", () => {
  it("wraps a legacy bare settings object", () => {
    const data = normalizeData({ maxDepth: 9, colorMode: "fixed-anchor", lastVaultMaxLevel: 5 });
    expect(data.version).toBe(1);
    expect(data.settings.maxDepth).toBe(9);
    expect(data.settings.colorMode).toBe("fixed-anchor");
    expect(data.lastVaultMaxLevel).toBe(5);
  });

  it("reads a wrapped payload", () => {
    const data = normalizeData({
      version: 1,
      settings: { maxDepth: 10, indentMaxLevel: 4 },
      lastVaultMaxLevel: 7
    });
    expect(data.version).toBe(1);
    expect(data.settings.maxDepth).toBe(10);
    expect(data.settings.indentMaxLevel).toBe(4);
    expect(data.lastVaultMaxLevel).toBe(7);
  });

  it("clamps lastVaultMaxLevel to 0..24", () => {
    expect(normalizeData({ settings: {}, lastVaultMaxLevel: 99 }).lastVaultMaxLevel).toBe(MAX_MAX_DEPTH);
    expect(normalizeData({ settings: {}, lastVaultMaxLevel: -3 }).lastVaultMaxLevel).toBe(0);
    expect(normalizeData({ settings: {}, lastVaultMaxLevel: 7.4 }).lastVaultMaxLevel).toBe(7);
  });

  it("falls back to defaults for unusable payloads", () => {
    expect(normalizeData(null)).toEqual({ ...DEFAULT_DATA });
    expect(normalizeData("garbage")).toEqual({ ...DEFAULT_DATA });
    expect(normalizeData({ lastVaultMaxLevel: 6 })).toEqual({
      ...DEFAULT_DATA,
      lastVaultMaxLevel: 6
    });
  });

  it("round-trips the day settings and rejects a bad spark target", () => {
    const kept = normalizeSettings({
      sparkTarget: "note",
      writeDayCounters: false,
      dayNoteFolder: "Journal",
      dayNoteFormat: "YYYY-MM-DD"
    });
    expect(kept).toMatchObject({
      sparkTarget: "note",
      writeDayCounters: false,
      dayNoteFolder: "Journal",
      dayNoteFormat: "YYYY-MM-DD"
    });

    const rejected = normalizeSettings({ sparkTarget: "elsewhere", dayNoteFolder: 42 });
    expect(rejected.sparkTarget).toBe("today");
    expect(rejected.dayNoteFolder).toBe("Chronomancer");

    const wrapped = normalizeData({ settings: { sparkTarget: "note" } });
    expect(wrapped.settings.sparkTarget).toBe("note");
  });

  it("round-trips the shuttle as plugin data", () => {
    const data = normalizeData({
      settings: {},
      shuttle: [
        { id: "one", kind: "words", path: "a.md", label: "passage", blockId: "abc123", addedAt: "2026-10-27T10:00:00.000Z", usedCount: 2 },
        { kind: "note", path: "b.md", label: "b" },
        { kind: "note" }
      ]
    });

    expect(data.shuttle).toHaveLength(2);
    expect(data.shuttle[0]).toMatchObject({ kind: "words", blockId: "abc123", usedCount: 2 });
    // A missing id is restored deterministically rather than dropping the row.
    expect(data.shuttle[1]?.id).toBe("restored-1");
  });

  it("starts with an empty shuttle and never drops the field", () => {
    expect(DEFAULT_DATA.shuttle).toEqual([]);
    expect(normalizeData(null).shuttle).toEqual([]);
    expect(normalizeData({ lastVaultMaxLevel: 3 }).shuttle).toEqual([]);
  });

  it("does not mutate the shared defaults", () => {
    const data = normalizeData({ settings: { maxDepth: 8 } });
    data.settings.maxDepth = 20;
    expect(DEFAULT_SETTINGS.maxDepth).toBe(12);
  });
});
