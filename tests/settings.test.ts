import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, normalizeData, normalizeSettings } from "../src/settings";

describe("normalizeSettings", () => {
  it("fills every field for an empty payload", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it("defaults the past-day link on", () => {
    expect(DEFAULT_SETTINGS.entryDayLink).toBe(true);
    expect(normalizeSettings({ debug: true }).entryDayLink).toBe(true);
    expect(normalizeSettings({ entryDayLink: false }).entryDayLink).toBe(false);
  });

  it("frames every entry unless the vault says otherwise", () => {
    expect(DEFAULT_SETTINGS.entryFrames).toBe(true);
    expect(normalizeSettings(null).entryFrames).toBe(true);
    expect(normalizeSettings({ entryFrames: false }).entryFrames).toBe(false);
    expect(normalizeSettings({ entryFrames: "no" }).entryFrames).toBe(true);
  });

  it("drops every key the entry model no longer has", () => {
    const normalized = normalizeSettings({
      colorMode: "vault-stretch",
      maxDepth: 24,
      timestampFormat: "HH:mm",
      travelWrap: true,
      sparkTarget: "note",
      inPageDrafts: false,
      headingLevelSizes: { 3: "2em" }
    });

    for (const key of [
      "colorMode",
      "maxDepth",
      "timestampFormat",
      "travelWrap",
      "sparkTarget",
      "inPageDrafts",
      "headingLevelSizes"
    ]) {
      expect(key in normalized).toBe(false);
    }
  });

  it("clamps and rejects values it cannot use", () => {
    expect(normalizeSettings({ entrySize: "1em" }).entrySize).toBe("1em");
    expect(normalizeSettings({ entrySize: "huge" }).entrySize).toBe(DEFAULT_SETTINGS.entrySize);
    expect(normalizeSettings({ indentStep: 900 }).indentStep).toBe(48);
    expect(normalizeSettings({ indintStep: 4 }).indentStep).toBe(DEFAULT_SETTINGS.indentStep);
    expect(normalizeSettings({ entryWeight: 12 }).entryWeight).toBe(300);
    expect(normalizeSettings({ indentMaxLevel: 400 }).indentMaxLevel).toBe(24);
  });
});

describe("normalizeData", () => {
  it("wraps a bare v2 settings object and keeps its values under the current names", () => {
    const data = normalizeData({ headingWeight: 700, debug: true });

    expect(data.version).toBe(3);
    expect(data.settings.entryWeight).toBe(700);
    expect(data.settings.debug).toBe(true);
  });

  it("carries every renamed v2 field across without losing it", () => {
    const data = normalizeData({
      version: 2,
      settings: {
        equalizeHeadingSizes: false,
        headingSize: "18px",
        headingWeight: 400
      }
    });

    expect(data.settings.equalizeEntrySizes).toBe(false);
    expect(data.settings.entrySize).toBe("18px");
    expect(data.settings.entryWeight).toBe(400);
    expect("headingSize" in data.settings).toBe(false);
    expect("headingWeight" in data.settings).toBe(false);
  });

  it("keeps the settings and drops the two fields the model lost", () => {
    const data = normalizeData({
      version: 1,
      settings: { writeDayCounters: false },
      lastVaultMaxLevel: 9,
      shuttle: [{ kind: "note", path: "a.md", label: "a" }]
    });

    expect(data.version).toBe(3);
    expect(data.settings.writeDayCounters).toBe(false);
    expect("lastVaultMaxLevel" in data).toBe(false);
    expect("shuttle" in data).toBe(false);
  });

  it("falls back to the defaults for anything else", () => {
    expect(normalizeData("nonsense").settings).toEqual(DEFAULT_SETTINGS);
    expect(normalizeData(null).settings).toEqual(DEFAULT_SETTINGS);
  });
});
