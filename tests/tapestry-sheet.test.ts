import { beforeEach, describe, expect, it } from "vitest";
import { MarkdownView, Platform, type App } from "obsidian";

import { dayNotePath } from "../src/core/day-note";
import WeaverPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";
import { TapestrySheet } from "../src/ui/tapestry-sheet";
import { FakeEditor } from "../test-support/editor";
import {
  addLeafWithView,
  createApp,
  createFile,
  createView,
  instantiatePlugin,
  lastModal,
  node,
  nodes,
  resetHarness,
  setActiveView,
  textOf,
  click
} from "../test-support/harness";

const DAY_SOURCE = [
  "---",
  "date: 2026-10-27",
  "sparks: 2",
  "dimensions: 3",
  "sources: 1",
  "---",
  "",
  "# 09:12:01 - first",
  "✦ [[Note#^abc123|first source]]",
  "## 10:00:00 - deeper",
  "# 16:37:04 - second"
].join("\n");

function todayPath(): string {
  return dayNotePath(new Date(), {
    folder: DEFAULT_SETTINGS.dayNoteFolder,
    format: DEFAULT_SETTINGS.dayNoteFormat
  });
}

async function start(): Promise<{ plugin: WeaverPlugin; app: App }> {
  const day = createFile(todayPath(), DAY_SOURCE);
  const note = createFile("a.md", "# Root\nbody\n");
  const app = createApp([day, note]);

  const editor = new FakeEditor("# Root\nbody\n");
  const view = createView(app, note, editor);
  setActiveView(app, view);
  addLeafWithView(app, view);

  const plugin = instantiatePlugin(WeaverPlugin, app);
  await plugin.onload();
  return { plugin, app };
}

beforeEach(() => {
  resetHarness();
  Platform.isPhone = true;
  Platform.isMobile = true;
});

describe("TapestrySheet", () => {
  it("opens as a sheet with the same sections and no filters or cursors", async () => {
    const { plugin } = await start();

    plugin.openTapestry();
    const sheet = lastModal(TapestrySheet);
    await sheet?.ready();
    expect(sheet).not.toBeNull();
    expect(sheet?.modalEl.hasClass("weaver-sheet")).toBe(true);
    expect(sheet?.contentEl.hasClass("weaver-tapestry-touch")).toBe(true);

    // Same four scope chips as the sidebar view.
    expect(nodes(sheet?.contentEl, ".weaver-tapestry-scope")).toHaveLength(4);
    // Touch mode renders no filter fields and no list cursors.
    expect(nodes(sheet?.contentEl, ".weaver-panel-filter")).toHaveLength(0);
    expect(nodes(sheet?.contentEl, "[data-list-section]")[0]?.getAttr("tabindex")).toBeNull();
  });

  it("switches scope inside the sheet", async () => {
    const { plugin } = await start();
    plugin.openTapestry("day");
    const sheet = lastModal(TapestrySheet);
    await sheet?.ready();
    expect(nodes(sheet?.contentEl, ".weaver-threads")).toHaveLength(1);
    expect(nodes(sheet?.contentEl, ".weaver-census")).toHaveLength(1);

    const month = nodes(sheet?.contentEl, ".weaver-tapestry-scope").find(
      (chip) => textOf(chip) === "Month"
    );
    click(month ?? null);
    await sheet?.ready();

    expect(nodes(sheet?.contentEl, ".weaver-cal")).toHaveLength(1);
  });

  it("draws one row per thread and per draft on a phone", async () => {
    const { plugin } = await start();
    plugin.openTapestry("day");
    const sheet = lastModal(TapestrySheet);
    await sheet?.ready();
    const threads = nodes(sheet?.contentEl, ".weaver-thread");
    expect(threads).toHaveLength(2);
    expect(textOf(node(threads[0] ?? null, ".weaver-thread-count"))).toBe("1");
    expect(textOf(node(sheet?.contentEl, ".weaver-review-close"))).toBe("Close the day");
  });

  it("is what the strip opens on a phone", async () => {
    const { plugin } = await start();
    await plugin.strip?.update();

    const strip = node(
      plugin.app.workspace.getActiveViewOfType(MarkdownView)?.containerEl ?? null,
      ".weaver-strip"
    );
    click(strip);
    const sheet = lastModal(TapestrySheet);
    await sheet?.ready();

    expect(sheet).not.toBeNull();
    // The sidebar view is never created on a phone.
    expect(plugin.app.workspace.getLeavesOfType("weaver-tapestry")).toHaveLength(0);
  });
});
