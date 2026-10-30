import { beforeEach, describe, expect, it } from "vitest";
import { Platform } from "obsidian";

import WeaverPlugin from "../src/main";
import {
  bodyHasClass,
  createApp,
  instantiatePlugin,
  resetHarness
} from "../test-support/harness";

/**
 * The platform body classes are set by the plugin, from Obsidian's own flags, so
 * every phone rule in the stylesheet hangs off one owner.
 */
async function start(): Promise<WeaverPlugin> {
  const plugin = instantiatePlugin(WeaverPlugin, createApp());
  await plugin.onload();
  return plugin;
}

beforeEach(() => {
  resetHarness();
  Platform.isMobile = false;
  Platform.isPhone = false;
  Platform.isTablet = false;
});

describe("platform body classes", () => {
  it("marks a desktop as no platform at all", async () => {
    const plugin = await start();

    expect(bodyHasClass("weaver-platform-mobile")).toBe(false);
    expect(bodyHasClass("weaver-phone")).toBe(false);
    expect(bodyHasClass("weaver-tablet")).toBe(false);
    // The default frame sits at the entry's own indent, so the fixed-frame mode
    // is off until the setting says otherwise.
    expect(bodyHasClass("weaver-frame-fixed")).toBe(false);

    plugin.onunload();
  });

  it("marks a phone, and clears it again when the flag goes away", async () => {
    Platform.isMobile = true;
    Platform.isPhone = true;

    const plugin = await start();
    expect(bodyHasClass("weaver-platform-mobile")).toBe(true);
    expect(bodyHasClass("weaver-phone")).toBe(true);
    expect(bodyHasClass("weaver-tablet")).toBe(false);

    Platform.isPhone = false;
    plugin.syncBodyClasses();
    expect(bodyHasClass("weaver-phone")).toBe(false);
    expect(bodyHasClass("weaver-platform-mobile")).toBe(true);

    plugin.onunload();
    expect(bodyHasClass("weaver-platform-mobile")).toBe(false);
  });

  it("marks a tablet without claiming it is a phone", async () => {
    Platform.isMobile = true;
    Platform.isTablet = true;

    const plugin = await start();
    expect(bodyHasClass("weaver-platform-mobile")).toBe(true);
    expect(bodyHasClass("weaver-tablet")).toBe(true);
    expect(bodyHasClass("weaver-phone")).toBe(false);

    plugin.onunload();
  });
});
