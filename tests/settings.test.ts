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
    expect(normalizeSettings({ headingSize: "1em" }).headingSize).toBe("1em");
    expect(normalizeSettings({ headingSize: "huge" }).headingSize).toBe(DEFAULT_SETTINGS.headingSize);
    expect(normalizeSettings({ indentStep: 900 }).indentStep).toBe(48);
    expect(normalizeSettings({ indintStep: 4 }).indentStep).toBe(DEFAULT_SETTINGS.indentStep);
    expect(normalizeSettings({ headingWeight: 12 }).headingWeight).toBe(300);
    expect(normalizeSettings({ indentMaxLevel: 400 }).indentMaxLevel).toBe(24);
  });
});

describe("normalizeData", () => {
  it("wraps a bare settings object written by an earlier build", () => {
    const data = normalizeData({ headingWeight: 700, debug: true });

    expect(data.version).toBe(2);
    expect(data.settings.headingWeight).toBe(700);
    expect(data.settings.debug).toBe(true);
  });

  it("keeps the settings and drops the two fields the model lost", () => {
    const data = normalizeData({
      version: 1,
      settings: { writeDayCounters: false },
      lastVaultMaxLevel: 9,
      shuttle: [{ kind: "note", path: "a.md", label: "a" }]
    });

    expect(data.version).toBe(2);
    expect(data.settings.writeDayCounters).toBe(false);
    expect("lastVaultMaxLevel" in data).toBe(false);
    expect("shuttle" in data).toBe(false);
  });

  it("falls back to the defaults for anything else", () => {
    expect(normalizeData("nonsense").settings).toEqual(DEFAULT_SETTINGS);
    expect(normalizeData(null).settings).toEqual(DEFAULT_SETTINGS);
  });
});
