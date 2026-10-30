import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, normalizeData, normalizeSettings } from "../src/settings";

describe("normalizeSettings", () => {
  it("fills every field for an empty payload", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it("starts a frame at the entry's own indent unless the vault says otherwise", () => {
    expect(DEFAULT_SETTINGS.frameFollowsIndent).toBe(true);
    expect(normalizeSettings({ debug: true }).frameFollowsIndent).toBe(true);
    expect(normalizeSettings({ frameFollowsIndent: false }).frameFollowsIndent).toBe(false);
    expect(normalizeSettings({ frameFollowsIndent: "no" }).frameFollowsIndent).toBe(true);
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
      headingLevelSizes: { 3: "2em" },
      entryWeight: 700,
      entryDate: true,
      entryDayLink: false
    });

    for (const key of [
      "colorMode",
      "maxDepth",
      "timestampFormat",
      "travelWrap",
      "sparkTarget",
      "inPageDrafts",
      "headingLevelSizes",
      "entryWeight",
      "entryDate",
      "entryDayLink"
    ]) {
      expect(key in normalized).toBe(false);
    }
  });

  it("clamps and rejects values it cannot use", () => {
    expect(normalizeSettings({ entrySize: "1em" }).entrySize).toBe("1em");
    expect(normalizeSettings({ entrySize: "huge" }).entrySize).toBe(DEFAULT_SETTINGS.entrySize);
    expect(normalizeSettings({ indentStep: 900 }).indentStep).toBe(48);
    expect(normalizeSettings({ indintStep: 4 }).indentStep).toBe(DEFAULT_SETTINGS.indentStep);
    expect(normalizeSettings({ indentMaxLevel: 400 }).indentMaxLevel).toBe(24);
  });
});

describe("normalizeData", () => {
  it("wraps a bare v2 settings object and keeps its values under the current names", () => {
    const data = normalizeData({ headingSize: "18px", equalizeHeadingSizes: false, debug: true });

    expect(data.version).toBe(3);
    expect(data.settings.entrySize).toBe("18px");
    expect(data.settings.equalizeEntrySizes).toBe(false);
    expect(data.settings.debug).toBe(true);
    // The weight slider is gone from the model, so a stored weight is dropped.
    expect("entryWeight" in data.settings).toBe(false);
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
    expect("entryWeight" in data.settings).toBe(false);
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
