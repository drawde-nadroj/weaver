import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, MarkdownView, TFile } from "obsidian";

import WeaverPlugin from "../src/main";
import { formatLocalTimestamp } from "../src/core/alignments";
import { dayNotePath } from "../src/core/day";
import { DEFAULT_SETTINGS } from "../src/settings";
import { FakeEditor } from "../test-support/editor";
import {
  addLeafWithView,
  clearNotices,
  createApp,
  createFile,
  createView,
  fileContent,
  instantiatePlugin,
  node,
  nodes,
  resetHarness,
  ShimElement
} from "../test-support/harness";

/**
 * The reading tray is a lifecycle component of the view, not of a paragraph:
 * one tray at the end of a whole daily note, drawn from the same surfaces the
 * editor uses, and removed when the view leaves or the plugin unloads.
 */

const NOW = new Date(2026, 10, 5, 22, 54, 50).getTime();
const OPENED = new Date(2026, 10, 5, 22, 55, 0).getTime();
const PORTAL = new Date(OPENED).toISOString();
const NEXT = new Date(2026, 10, 5, 23, 0, 0).toISOString();

/** Five microtask turns are enough for the tray's `cachedRead` + render. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
}

function previewView(app: App, file: TFile, content: string): MarkdownView {
  const view = createView(app, file, new FakeEditor(content), "preview");
  // Real Obsidian's preview root owns the rendered note; the stub only has the
  // rerender hook, so the tray's container is supplied here.
  const container = new ShimElement("div");
  const preview = view.previewMode as unknown as { containerEl: unknown };
  preview.containerEl = container;
  return view;
}

function containerOf(view: MarkdownView): ShimElement {
  const preview = view.previewMode as unknown as { containerEl: ShimElement };
  return preview.containerEl;
}

/** The stub's mode is a mutable field; MarkdownView only exposes `getMode`. */
interface ModeSwitch {
  mode: "source" | "preview";
}

function setMode(view: MarkdownView, mode: "source" | "preview"): void {
  const target = view as unknown as ModeSwitch;
  target.mode = mode;
}

/** The stub workspace's event bus, to drive the lifecycle signals a test needs. */
interface Triggerable {
  trigger(name: string): void;
}

function syncLayout(app: App): void {
  const workspace = app.workspace as unknown as Triggerable;
  workspace.trigger("layout-change");
}

beforeEach(() => {
  resetHarness();
  clearNotices();
});

describe("portals in Reading view", () => {
  const PATH = dayNotePath(new Date(NOW), {
    folder: DEFAULT_SETTINGS.dayNoteFolder,
    format: DEFAULT_SETTINGS.dayNoteFormat
  });

  async function ready(content = "", rendered = false, path = PATH) {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const file = createFile(path, content);
    const app = createApp([file]);
    const plugin = instantiatePlugin(WeaverPlugin, app);
    await plugin.onload();
    clearNotices();
    const view = previewView(app, file, content);
    // What the Markdown renderer has already produced when the tray mounts.
    if (rendered) containerOf(view).createDiv({ cls: "rendered-note" });
    addLeafWithView(app, view);
    syncLayout(app);
    await flush();
    return { plugin, app, file, view };
  }

  it("appends one tray after the rendered note, even when it has no entries", async () => {
    const { plugin, file, view } = await ready("", true);
    try {
      const container = containerOf(view);

      // One tray for the whole view, holding one surface per live candidate —
      // here the opening and the next approaching one.
      expect(nodes(container, ".weaver-portal-tray")).toHaveLength(1);
      const surfaces = nodes(container, ".weaver-portal");
      expect(surfaces).toHaveLength(plugin.portals.candidates(PATH, "").length);
      expect(surfaces.map((each) => each.getAttribute("data-weaver-portal"))).toContain(PORTAL);
      // Appended after everything the renderer produced, never before it.
      const last = container.children[container.children.length - 1];
      expect(last?.className).toBe("weaver-portal-tray");
      // Reading never writes: the note's bytes are exactly what they were.
      expect(fileContent(file)).toBe("");
    } finally {
      plugin.onunload();
      vi.restoreAllMocks();
    }
  });

  it("uses the configured daily path even when its filename is not a bare date", async () => {
    const { plugin, app, file, view } = await ready("", false, "Daily/Today-2026.11.05.md");
    try {
      plugin.settings.dayNoteFolder = "Daily";
      plugin.settings.dayNoteFormat = "Today-YYYY.MM.DD";
      plugin.onSettingsChange();
      syncLayout(app);
      await flush();
      expect(nodes(containerOf(view), ".weaver-portal").map(surface =>
        surface.getAttribute("data-weaver-portal"))).toContain(PORTAL);
      expect(fileContent(file)).toBe("");
    } finally {
      plugin.onunload();
      vi.restoreAllMocks();
    }
  });

  it("shows no tray when the note earns no portal", async () => {
    // A note whose history records every opening in the window has nothing
    // pending: the tray is not mounted at all.
    const opened = formatLocalTimestamp(new Date(OPENED));
    const next = formatLocalTimestamp(new Date(NEXT));
    const recorded = [
      "---",
      "weaver-alignments:",
      `  - {"portal":"${PORTAL}","opened":"${opened}","began":"${opened}","entry":null}`,
      `  - {"portal":"${NEXT}","opened":"${next}","began":"${next}","entry":null}`,
      "---",
      "",
      "{ 1.1.1 }",
      "first",
      "- 00:00:00 2026-11-05 22:55:00"
    ].join("\n");
    const { plugin, view } = await ready(recorded);
    try {
      expect(nodes(containerOf(view), ".weaver-portal-tray")).toHaveLength(0);
    } finally {
      plugin.onunload();
      vi.restoreAllMocks();
    }
  });

  it("removes the tray when the view leaves preview, and on unload", async () => {
    const { plugin, app, view } = await ready("");
    const container = containerOf(view);
    try {
      expect(nodes(container, ".weaver-portal-tray")).toHaveLength(1);

      // Reading → source: the editor draws its own pending block, so the
      // reading tray has nothing to do and must go.
      setMode(view, "source");
      syncLayout(app);
      expect(nodes(container, ".weaver-portal-tray")).toHaveLength(0);

      setMode(view, "preview");
      syncLayout(app);
      await flush();
      expect(nodes(container, ".weaver-portal-tray")).toHaveLength(1);
    } finally {
      plugin.onunload();
      expect(nodes(container, ".weaver-portal-tray")).toHaveLength(0);
      vi.restoreAllMocks();
    }
  });

  it("Prepare is an explicit act that creates no note bytes", async () => {
    const { plugin, file, view } = await ready("");
    try {
      const container = containerOf(view);
      const surface = nodes(container, ".weaver-portal").find(
        (each) => each.getAttribute("data-weaver-portal") === PORTAL
      );
      const prepare = surface === undefined ? null : node(surface, ".weaver-portal-prepare");
      expect(prepare).not.toBeNull();
      prepare?.click();
      await flush();

      // The opening is prepared (and pinned to today's note) without an entry:
      // switching surfaces is not writing.
      expect(plugin.portals.held()?.portal.id).toBe(PORTAL);
      expect(fileContent(file)).toBe("");
    } finally {
      plugin.onunload();
      vi.restoreAllMocks();
    }
  });
});
