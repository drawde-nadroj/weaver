import { beforeEach, describe, expect, it } from "vitest";
import { MarkdownView, Platform, type App } from "obsidian";

import { ANCHORS } from "../src/core/palette";
import { DEFAULT_SETTINGS } from "../src/settings";
import WeaverPlugin from "../src/main";
import { WeaverSettingTab } from "../src/settings-tab";
import { FakeEditor } from "../test-support/editor";
import {
  ShimElement,
  addLeafWithView,
  bodyHasClass,
  createApp,
  createFile,
  createView,
  instantiatePlugin,
  node,
  nodes,
  fire,
  rerenderCount,
  resetHarness,
  setValue,
  valueOf,
  setActiveView,
  shimDocument,
  uiSetting
} from "../test-support/harness";

interface Context {
  plugin: WeaverPlugin;
  app: App;
  tab: WeaverSettingTab;
  view: MarkdownView;
  editor: FakeEditor;
}

async function start(): Promise<Context> {
  const app = createApp();
  const file = createFile("note.md", "# Root\n\nbody");
  const editor = new FakeEditor("# Root\n\nbody");
  const view = createView(app, file, editor);
  setActiveView(app, view);
  addLeafWithView(app, view);

  const plugin = instantiatePlugin(WeaverPlugin, app);
  await plugin.onload();

  const tab = new WeaverSettingTab(app, plugin);
  tab.containerEl = new ShimElement("div") as never;
  tab.display();

  return { plugin, app, tab, view, editor };
}

function paletteStyle(): string {
  return shimDocument.getElementById("weaver-palette")?.textContent ?? "";
}

beforeEach(() => {
  resetHarness();
  Platform.isMobile = false;
  Platform.isPhone = false;
});

describe("WeaverSettingTab", () => {
  it("registers itself and renders every section", async () => {
    const { plugin, tab } = await start();
    const tabs = (plugin as unknown as { settingTabs: unknown[] }).settingTabs;
    expect(tabs).toHaveLength(1);

    const headings = nodes(tab.containerEl, "h3").map((heading) => heading.textContent);
    expect(headings).toEqual(["Writing", "Day", "Look", "Advanced"]);
    // One live control per remaining setting, and no others.
    expect(Object.keys(DEFAULT_SETTINGS)).toHaveLength(23);
  });

  it("exposes the drafts switch", async () => {
    const { plugin } = await start();

    expect(uiSetting("Render drafts in the note")?.controls[0]?.value).toBe(true);
    uiSetting("Render drafts in the note")?.controls[0]?.change(false);
    expect(plugin.settings.inPageDrafts).toBe(false);
  });

  it("writes a toggle, saves it, and applies it live", async () => {
    const { plugin, tab } = await start();
    expect(bodyHasClass("weaver-equal-sizes")).toBe(true);

    uiSetting("Equalize dimension sizes")?.controls[0]?.change(false);

    expect(plugin.settings.equalizeHeadingSizes).toBe(false);
    expect(bodyHasClass("weaver-equal-sizes")).toBe(false);
    expect(paletteStyle()).toContain("--weaver-dimension-size: 1em;");
    void tab;
  });

  it("applies typography, indent and transition settings to the stylesheet", async () => {
    const { plugin } = await start();

    uiSetting("Dimension size")?.controls[0]?.change("1.4em");
    uiSetting("Dimension weight")?.controls[0]?.change(700);
    uiSetting("Indent step (desktop)")?.controls[0]?.change(24);
    uiSetting("Indent maximum level")?.controls[0]?.change(3);
    uiSetting("Transition")?.controls[0]?.change(500);

    expect(plugin.settings.headingSize).toBe("1.4em");
    expect(plugin.settings.headingWeight).toBe(700);
    expect(plugin.settings.indentStep).toBe(24);
    expect(plugin.settings.indentMaxLevel).toBe(3);
    expect(plugin.settings.paletteTransitionMs).toBe(500);

    const css = paletteStyle();
    expect(css).toContain("--weaver-dimension-size: 1.4em;");
    expect(css).toContain("--weaver-dimension-weight: 700;");
    expect(css).toContain("--weaver-indent-step: 24px;");
    expect(css).toContain("--weaver-indent-max-level: 3;");
    expect(css).toContain("--weaver-palette-transition: 500ms;");
  });

  it("ignores an invalid heading size instead of writing bad CSS", async () => {
    const { plugin } = await start();
    uiSetting("Dimension size")?.controls[0]?.change("huge");

    expect(plugin.settings.headingSize).toBe("1em");
    expect(paletteStyle()).toContain("--weaver-dimension-size: 1em;");

    uiSetting("Dimension size")?.controls[0]?.change(" 20px ");
    expect(plugin.settings.headingSize).toBe("20px");
    expect(paletteStyle()).toContain("--weaver-dimension-size: 20px;");
  });

  it("rebuilds level-dependent controls when the depth changes", async () => {
    const { plugin, tab } = await start();
    plugin.settings.indentMaxLevel = 12;
    plugin.settings.travelDefaultLevel = 12;
    tab.display();

    uiSetting("Maximum dimension depth")?.controls[0]?.change(8);

    expect(plugin.settings.maxDepth).toBe(8);
    expect(plugin.settings.indentMaxLevel).toBe(8);

    const levelOptions = [...(uiSetting("Travel default level")?.controls[0]?.options.keys() ?? [])];
    expect(levelOptions).toEqual(["all", "1", "2", "3", "4", "5", "6", "7", "8"]);
  });

  it("clamps a travel default level past the new cap to all", async () => {
    const { plugin, tab } = await start();
    plugin.settings.travelDefaultLevel = 10;
    tab.display();

    uiSetting("Maximum dimension depth")?.controls[0]?.change(9);

    expect(plugin.settings.maxDepth).toBe(9);
    expect(plugin.settings.travelDefaultLevel).toBe("all");
  });

  it("renders one swatch per level with the current palette", async () => {
    const { plugin, tab } = await start();

    const swatches = nodes(tab.containerEl, ".weaver-swatch");
    expect(swatches).toHaveLength(plugin.settings.maxDepth);
    expect(swatches[0]?.style.backgroundColor).toBe(ANCHORS[0]);
    expect(swatches[5]?.style.backgroundColor).toBe(ANCHORS[5]);
    expect(swatches[0]?.textContent).toBe("1D");
  });

  it("switches the palette to fixed anchors", async () => {
    const { plugin, tab } = await start();

    uiSetting("Colour mode")?.controls[0]?.change("fixed-anchor");

    expect(plugin.settings.colorMode).toBe("fixed-anchor");
    expect(plugin.palette.slice(0, 6)).toEqual([...ANCHORS]);
    expect(plugin.palette[6]).toBe("#ca24f7");
    expect(nodes(tab.containerEl, ".weaver-swatch")[6]?.style.backgroundColor).toBe("#ca24f7");
  });

  it("renders a size field per level, disabled while sizes are equalized", async () => {
    const { plugin, tab } = await start();
    const inputs = nodes(tab.containerEl, ".weaver-level-size-input");

    expect(inputs).toHaveLength(plugin.settings.maxDepth);
    expect(inputs.every((input) => input.disabled)).toBe(true);
    expect(inputs[0]?.getAttr("aria-label")).toBe("1D size");

    uiSetting("Equalize dimension sizes")?.controls[0]?.change(false);
    const enabled = nodes(tab.containerEl, ".weaver-level-size-input");
    expect(enabled.every((input) => input.disabled)).toBe(false);
  });

  it("writes per-level sizes into the stylesheet", async () => {
    const { plugin, tab } = await start();
    uiSetting("Equalize dimension sizes")?.controls[0]?.change(false);

    const inputs = nodes(tab.containerEl, ".weaver-level-size-input");
    setValue(inputs[1] ?? null, "1.6em");
    fire(inputs[1] ?? null, "change");

    expect(plugin.settings.headingLevelSizes[2]).toBe("1.6em");
    expect(paletteStyle()).toContain("font-size: 1.6em;");

    setValue(inputs[1] ?? null, "");
    fire(inputs[1] ?? null, "change");
    expect(plugin.settings.headingLevelSizes[2]).toBeUndefined();
    expect(paletteStyle()).not.toContain("font-size: 1.6em;");
  });

  it("rejects an invalid per-level size and restores the field", async () => {
    const { plugin, tab } = await start();
    uiSetting("Equalize dimension sizes")?.controls[0]?.change(false);

    const inputs = nodes(tab.containerEl, ".weaver-level-size-input");
    const target = inputs[2] ?? null;
    setValue(target, "1.25em");
    fire(target, "change");
    expect(plugin.settings.headingLevelSizes[3]).toBe("1.25em");

    setValue(target, "gigantic");
    fire(target, "change");
    expect(plugin.settings.headingLevelSizes[3]).toBe("1.25em");
    expect(valueOf(target)).toBe("1.25em");
  });

  it("resets every per-level size", async () => {
    const { plugin, tab } = await start();
    uiSetting("Equalize dimension sizes")?.controls[0]?.change(false);
    const inputs = nodes(tab.containerEl, ".weaver-level-size-input");
    setValue(inputs[0] ?? null, "2em");
    fire(inputs[0] ?? null, "change");
    expect(plugin.settings.headingLevelSizes[1]).toBe("2em");

    uiSetting("Reset level sizes")?.controls[0]?.click();
    expect(plugin.settings.headingLevelSizes).toEqual({});
    expect(nodes(tab.containerEl, ".weaver-level-size-input")[0]?.value).toBe("");
  });

  it("reports the vault depth and palette span", async () => {
    const { plugin, tab } = await start();
    plugin.data.lastVaultMaxLevel = 10;
    plugin.onSettingsChange();
    tab.display();

    const depth = uiSetting("Vault depth");
    expect(depth?.desc).toContain("10D");
    expect(depth?.desc).toContain("1D–10D");
  });

  it("rescans the vault from the Rescan button", async () => {
    const { plugin, tab } = await start();
    let scans = 0;
    const scanner = (plugin as unknown as { scanner: { rescan(force?: boolean): Promise<void> } }).scanner;
    scanner.rescan = async () => {
      scans += 1;
    };

    uiSetting("Vault depth")?.controls[0]?.click();
    await Promise.resolve();

    expect(scans).toBe(1);
    void tab;
  });
});

describe("onSettingsChange", () => {
  it("keeps the inline title variables untouched", async () => {
    await start();
    expect(paletteStyle()).not.toContain("--h1-size");
  });

  it("rerenders Reading views only when deep heading settings change", async () => {
    const { plugin, view } = await start();
    (view as unknown as { mode: string }).mode = "preview";

    plugin.settings.deepHeadingReadingView = false;
    plugin.onSettingsChange();
    expect(rerenderCount(view)).toBe(1);

    plugin.onSettingsChange();
    expect(rerenderCount(view)).toBe(1);

    plugin.settings.maxDepth = 10;
    plugin.onSettingsChange();
    expect(rerenderCount(view)).toBe(2);
  });

  it("keeps the emphasis class in step with its setting", async () => {
    const { plugin } = await start();
    expect(bodyHasClass("weaver-no-emphasis")).toBe(false);

    plugin.settings.portEmphasisColors = false;
    plugin.onSettingsChange();
    expect(bodyHasClass("weaver-no-emphasis")).toBe(true);

    plugin.settings.portEmphasisColors = true;
    plugin.onSettingsChange();
    expect(bodyHasClass("weaver-no-emphasis")).toBe(false);
  });

  it("leaves travel when settings change", async () => {
    const { plugin } = await start();
    let exits = 0;
    plugin.travel = {
      active: true,
      exit: () => {
        exits += 1;
      }
    } as unknown as typeof plugin.travel;

    plugin.onSettingsChange();
    expect(exits).toBe(1);
    plugin.travel = null;
  });

  it("keeps the swatch row in sync after a palette change", async () => {
    const { plugin, tab } = await start();
    plugin.data.lastVaultMaxLevel = 9;
    plugin.onSettingsChange();
    tab.display();

    expect(plugin.palette[8]).not.toBe(plugin.palette[11]);
    expect(nodes(tab.containerEl, ".weaver-swatch")).toHaveLength(plugin.settings.maxDepth);
    expect(node(tab.containerEl, ".weaver-swatch", 8)?.style.backgroundColor).toBe(plugin.palette[8]);
  });
});
