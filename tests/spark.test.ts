import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";

import WeaverPlugin from "../src/main";
import { dayNotePath } from "../src/core/day-note";
import { DEFAULT_SETTINGS } from "../src/settings";
import { FakeEditor } from "../test-support/editor";
import {
  addLeafWithView,
  createApp,
  createFile,
  createView,
  fileContent,
  instantiatePlugin,
  noticeMessages,
  node,
  resetHarness,
  setActiveView,
  textOf
} from "../test-support/harness";
import type { App, MarkdownView, TFile } from "obsidian";

interface Context {
  plugin: WeaverPlugin;
  app: App;
  view: MarkdownView | null;
  editor: FakeEditor | null;
  dayPath: string;
  dayFile(): TFile | null;
}

async function start(
  source = "# A\npassage to think about\n",
  options: { mode?: "source" | "preview"; noView?: boolean } = {}
): Promise<Context> {
  const noteFile = options.noView === true ? null : createFile("note.md", source);
  const app = createApp(noteFile === null ? [] : [noteFile]);
  let view: MarkdownView | null = null;
  let editor: FakeEditor | null = null;

  if (noteFile !== null) {
    editor = new FakeEditor(source);
    view = createView(app, noteFile, editor, options.mode ?? "source");
    setActiveView(app, view);
    addLeafWithView(app, view);
  }

  const plugin = instantiatePlugin(WeaverPlugin, app);
  await plugin.onload();

  const dayPath = dayNotePath(new Date(), {
    folder: DEFAULT_SETTINGS.dayNoteFolder,
    format: DEFAULT_SETTINGS.dayNoteFormat
  });
  return {
    plugin,
    app,
    view,
    editor,
    dayPath,
    dayFile: () => app.vault.getAbstractFileByPath(dayPath) as TFile | null
  };
}

beforeEach(() => {
  resetHarness();
  Platform.isPhone = false;
});

describe("spark into today", () => {
  it("creates the day note and writes a 1D dimension, its mark and the counters", async () => {
    const context = await start();

    await context.plugin.spark();

    const day = context.dayFile();
    expect(day).not.toBeNull();
    const content = fileContent(day);

    expect(content.startsWith("---\ndate: ")).toBe(true);
    expect(content).toMatch(/\n# \d\d:\d\d:\d\d - \n✦\n$/);
    expect(content).toContain("sparks: 1");
    expect(content).toContain("dimensions: 1");
    expect(content).toContain("sources: 0");
  });

  it("counts a second spark without needing a second command shape", async () => {
    const context = await start();

    await context.plugin.spark();
    await context.plugin.spark();

    const content = fileContent(context.dayFile());
    expect(content.match(/✦/g)).toHaveLength(2);
    expect(content).toContain("sparks: 2");
    expect(content).toContain("dimensions: 2");
  });

  it("ids the selection's last line in its own note and links to it", async () => {
    const context = await start();
    context.editor?.select({ line: 1, ch: 0 }, { line: 1, ch: 22 });

    await context.plugin.spark();

    const source = context.app.vault.getAbstractFileByPath("note.md") as TFile;
    const id = /\^([a-z0-9]{6})/.exec(fileContent(source))?.[1] ?? "";
    expect(id).toHaveLength(6);
    // The id goes at the end of the referenced line, never on a line of its own.
    expect(fileContent(source)).toBe(`# A\npassage to think about ^${id}\n`);

    const content = fileContent(context.dayFile());
    expect(content).toContain(`✦ [[note#^${id}|passage to think about]]`);
    expect(content).toMatch(/\n# \d\d:\d\d:\d\d - passage to think about\n/);
    expect(content).toContain("sources: 1");
  });

  it("works with no note open and in Reading view, because it needs no editor", async () => {
    const reading = await start("# A\nbody\n", { mode: "preview" });
    await reading.plugin.spark();
    expect(fileContent(reading.dayFile())).toContain("\n✦");

    const empty = await start("", { noView: true });
    await empty.plugin.spark();
    expect(fileContent(empty.dayFile())).toContain("\n✦");
  });

  it("writes through the vault, not the editor, when the target is Today", async () => {
    const context = await start();
    const before = fileContent(context.dayFile());

    await context.plugin.spark();

    // The day note changed and the open editor was never touched: that is the
    // difference between the Today path and the This-note path.
    expect(fileContent(context.dayFile())).not.toBe(before);
    expect(context.editor?.transactions).toBe(0);
    expect(context.editor?.getValue()).toBe("# A\npassage to think about\n");
  });

  it("opens the day note in a tab of its own, never in the tab being written", async () => {
    const context = await start();

    await context.plugin.spark();

    const workspace = context.app.workspace as unknown as {
      leafRequests: Array<string | boolean | undefined>;
      openedLeaves: Array<{ openedFile: TFile | null }>;
      rightLeaf: { openedFile: TFile | null };
    };
    // `getLeaf(false)` would have replaced the writer's tab; `"tab"` adds one.
    expect(workspace.leafRequests).toContain("tab");
    expect(workspace.openedLeaves.at(-1)?.openedFile?.path).toBe(context.dayPath);
    expect(workspace.rightLeaf.openedFile).toBeNull();

    // The note the writer was in is still the note the writer is in.
    expect(context.view?.file?.path).toBe("note.md");
  });

  it("reveals the tab that already holds the day note and puts the caret in it", async () => {
    const context = await start();
    await context.plugin.spark();
    const day = context.dayFile();
    if (day === null) throw new Error("the day note was not written");

    // The writer already has the day note open in a tab of its own.
    const dayEditor = new FakeEditor(fileContent(day));
    const dayView = createView(context.app, day, dayEditor);
    addLeafWithView(context.app, dayView);

    const workspace = context.app.workspace as unknown as {
      leafRequests: Array<string | boolean | undefined>;
      activeLeafCalls: Array<{ view: unknown }>;
      getActiveViewOfType<T>(type: abstract new (...args: never[]) => T): T | null;
    };
    const requestsBefore = workspace.leafRequests.length;

    await context.plugin.spark();

    // The existing tab is revealed, not duplicated, and it becomes the active one.
    expect(workspace.leafRequests).toHaveLength(requestsBefore);
    expect(workspace.activeLeafCalls.some((leaf) => leaf.view === dayView)).toBe(true);

    // The caret sits at the end of the title line of the spark just written.
    const written = fileContent(day);
    const lines = written.split("\n");
    const titleLine = lines.findLastIndex((line) => /^# \d\d:\d\d:\d\d - $/.test(line));
    expect(titleLine).toBeGreaterThanOrEqual(0);
    expect(dayEditor.getCursor()).toEqual({ line: titleLine, ch: (lines[titleLine] ?? "").length });
  });

  it("leaves the strip able to name the spark it just wrote", async () => {
    const context = await start();
    await context.plugin.spark();
    const day = context.dayFile();
    if (day === null) throw new Error("the day note was not written");

    // The day note on screen, caret in the spark the command just wrote.
    const written = fileContent(day);
    const dayEditor = new FakeEditor(written);
    const dayView = createView(context.app, day, dayEditor);
    addLeafWithView(context.app, dayView);
    dayEditor.setCursor({ line: written.split("\n").findLastIndex((line) => line.startsWith("# ")), ch: 0 });

    // The revealed day tab is the active one.
    (context.app.workspace as unknown as { activeView: unknown }).activeView = dayView;
    context.plugin.strip?.attach(dayView);
    await context.plugin.strip?.update();

    // An untitled spark is legal evidence: the strip names it and flags it.
    expect(textOf(node(dayView.containerEl, ".weaver-strip"))).toBe(
      "1D Untitled · 1 untitled"
    );
  });

  it("fails loudly and writes nothing when the day note cannot be created", async () => {
    const context = await start();
    (context.app.vault as unknown as { create: () => Promise<TFile> }).create = async () => {
      throw new Error("read-only vault");
    };

    await context.plugin.spark();

    expect(noticeMessages()).toEqual([
      "Weaver: today's day note could not be found. Nothing was written."
    ]);
    expect(context.editor?.getValue()).toBe("# A\npassage to think about\n");
  });

  it("records the spark without a source when the selection went stale", async () => {
    const context = await start();
    // The editor still holds the selection, but the file on disk was rewritten.
    context.editor?.select({ line: 1, ch: 0 }, { line: 1, ch: 22 });
    const source = context.app.vault.getAbstractFileByPath("note.md") as TFile;
    await context.app.vault.process(source, () => "# A\nsomething else entirely\n");

    await context.plugin.spark();

    expect(noticeMessages()).toEqual([
      "Weaver: spark recorded; its source link could not be written."
    ]);
    expect(fileContent(context.dayFile())).toContain("\n✦");
  });
});

describe("the empty-day fixture", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fills a 0-byte day note with frontmatter, a dimension, a mark and counters", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 27, 16, 37, 4));

    const day = createFile("Chronomancer/2026.10.27.md", "");
    const app = createApp([day]);
    const plugin = instantiatePlugin(WeaverPlugin, app);
    await plugin.onload();

    await plugin.spark();

    expect(fileContent(day).startsWith("---\ndate: 2026-10-27\n")).toBe(true);
    expect(fileContent(day)).toContain("sparks: 1");
    expect(fileContent(day)).toMatch(/\n# 16:37:04 - \n✦\n$/);

    await plugin.spark();

    expect(fileContent(day)).toContain("sparks: 2");
    expect(fileContent(day).match(/✦/g)).toHaveLength(2);
  });
});

describe("spark into this note", () => {
  it("commits one transaction that lands the dimension and the mark", async () => {
    const context = await start("# A\nbody\n");
    context.plugin.settings.sparkTarget = "note";

    await context.plugin.spark();

    expect(context.editor?.transactions).toBe(1);
    expect(context.editor?.getValue()).toMatch(/\n# \d\d:\d\d:\d\d - \n✦\n$/);
  });
});
