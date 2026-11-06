import { beforeEach, describe, expect, it } from "vitest";

import { WeaverSettingTab } from "../src/settings-tab";
import WeaverPlugin from "../src/main";
import { createApp, instantiatePlugin, resetHarness, uiSetting, uiSettings } from "../test-support/harness";

async function start(): Promise<{ plugin: WeaverPlugin; tab: WeaverSettingTab }> {
  const plugin = instantiatePlugin(WeaverPlugin, createApp());
  await plugin.onload();

  const tab = new WeaverSettingTab(plugin.app, plugin);
  tab.display();
  return { plugin, tab };
}

beforeEach(() => {
  resetHarness();
});

describe("the settings tab", () => {
  it("offers four groups and the controls that write them", async () => {
    const { plugin } = await start();
    const names = uiSettings().map((setting) => setting.name);

    expect(names).toContain("Write day counters");
    expect(names).toContain("Portals");
    expect(names).toContain("Day note folder");
    expect(names).toContain("Day note format");
    expect(names).toContain("Equalize entry sizes");
    expect(names).toContain("Entry size");
    expect(names).toContain("Indent step (desktop)");
    expect(names).toContain("Indent step (mobile)");
    expect(names).toContain("Indent maximum level");
    expect(names).toContain("Port em/strong colours");
    expect(names).toContain("Frame follows the indent");
    expect(names).toContain("Debug logging");

    plugin.onunload();
  });

  it("no longer offers the controls whose model is gone", async () => {
    const { plugin } = await start();
    const names = uiSettings().map((setting) => setting.name);

    for (const gone of [
      "Timestamp format",
      "Separator",
      "Maximum dimension depth",
      "Spark target",
      "Colour mode",
      "Current palette",
      "Travel default level",
      "Travel wraps around",
      "Render drafts in the note",
      "Entry weight",
      "Entry date"
    ]) {
      expect(names).not.toContain(gone);
    }

    plugin.onunload();
  });

  it("turns portal invitations off and on from the Writing group", async () => {
    const { plugin } = await start();

    expect(plugin.settings.portalsEnabled).toBe(true);
    uiSetting("Portals")?.controls[0]?.change(false);
    expect(plugin.settings.portalsEnabled).toBe(false);

    uiSetting("Portals")?.controls[0]?.change(true);
    expect(plugin.settings.portalsEnabled).toBe(true);

    plugin.onunload();
  });

  it("writes a change through to the settings and the stylesheet", async () => {
    const { plugin } = await start();

    uiSetting("Equalize entry sizes")?.controls[0]?.change(false);
    expect(plugin.settings.equalizeEntrySizes).toBe(false);
    expect(document.body.classList.contains("weaver-unequal")).toBe(true);

    uiSetting("Frame follows the indent")?.controls[0]?.change(false);
    expect(plugin.settings.frameFollowsIndent).toBe(false);
    expect(document.body.classList.contains("weaver-frame-fixed")).toBe(true);

    plugin.onunload();
  });

  it("ignores an entry size that is not a CSS length", async () => {
    const { plugin } = await start();
    const before = plugin.settings.entrySize;

    uiSetting("Entry size")?.controls[0]?.change("enormous");
    expect(plugin.settings.entrySize).toBe(before);

    uiSetting("Entry size")?.controls[0]?.change("18px");
    expect(plugin.settings.entrySize).toBe("18px");

    plugin.onunload();
  });
});
