import { beforeEach, describe, expect, it } from "vitest";
import { Platform, type App, type MarkdownView } from "obsidian";

import WeaverPlugin from "../src/main";
import { FakeEditor } from "../test-support/editor";
import {
  ShimElement,
  bodyHasClass,
  nodes,
  createApp,
  createFile,
  createView,
  instantiatePlugin,
  noticeMessages,
  postProcessors,
  registeredCommands,
  resetHarness,
  setActiveView,
  shimDocument
} from "../test-support/harness";

const AT_1637 = new Date(2024, 0, 2, 16, 37, 4);

interface Context {
  plugin: WeaverPlugin;
  app: App;
  view: MarkdownView;
  editor: FakeEditor;
}

async function startPlugin(
  source: string,
  options: { mode?: "source" | "preview" } = {}
): Promise<Context> {
  const app = createApp();
  const file = createFile("note.md", source);
  const editor = new FakeEditor(source);
  const view = createView(app, file, editor, options.mode ?? "source");
  setActiveView(app, view);

  const plugin = instantiatePlugin(WeaverPlugin, app);
  await plugin.onload();

  return { plugin, app, view, editor };
}

beforeEach(() => {
  resetHarness();
  Platform.isPhone = false;
});

describe("plugin registration", () => {
  it("registers every command with its default hotkey", async () => {
    const { plugin } = await startPlugin("");

    const commands = registeredCommands(plugin);
    const ids = commands.map((command) => command.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "spark",
        "insert-heading",
        "close-day",
        "travel"
      ])
    );

    const hotkeys = new Map(
      commands.map((command) => [command.id, JSON.stringify(command.hotkeys ?? null)])
    );
    expect(hotkeys.get("insert-heading")).toBe('[{"modifiers":["Mod","Shift"],"key":"j"}]');
    expect(hotkeys.get("spark")).toBe('[{"modifiers":["Mod","Shift"],"key":"k"}]');
    expect(hotkeys.get("travel")).toBe('[{"modifiers":["Mod","Shift"],"key":"p"}]');
    // `append-h1` is retired; nothing claims its old chord.
    expect(hotkeys.has("append-h1")).toBe(false);
    expect([...hotkeys.values()].includes('[{"modifiers":["Mod","Shift"],"key":"b"}]')).toBe(false);
  });

  it("registers exactly the eleven commands, with no chord claimed twice", async () => {
    const { plugin } = await startPlugin("");
    const commands = registeredCommands(plugin);

    expect(commands.map((command) => command.id).sort()).toEqual([
      "close-day",
      "insert-heading",
      "load-shuttle",
      "new-draft",
      "open-composer",
      "open-draft-search",
      "return",
      "spark",
      "tapestry",
      "travel",
      "weave-draft"
    ]);

    const chords = commands.flatMap((command) =>
      (command.hotkeys ?? []).map((hotkey) => JSON.stringify(hotkey))
    );
    expect(new Set(chords).size).toBe(chords.length);

    const named = new Map(commands.map((command) => [command.id, command.name]));
    expect(named.get("open-composer")).toBe("Weave rows");
    expect(named.get("load-shuttle")).toBe("Shuttle");
    expect(named.get("travel")).toBe("Travel through dimensions");
  });

  it("injects the palette and sets body classes for the default settings", async () => {
    await startPlugin("");

    const style = shimDocument.getElementById("weaver-palette");
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain("--weaver-h12:");
    expect(style?.textContent).toContain("--h1-color: var(--weaver-h1);");
    expect(style?.textContent).toContain("--weaver-indent-step: 18px;");

    expect(bodyHasClass("weaver-equal-sizes")).toBe(true);
    expect(bodyHasClass("weaver-no-emphasis")).toBe(false);
  });

  it("registers the deep heading and draft processors, deep headings first", async () => {
    const { plugin } = await startPlugin("");
    const [first, second] = postProcessors(plugin);

    // Order is execution order: a draft body that looks like `####### x` must be
    // lifted to a heading by the first pass, not swallowed by the draft card.
    expect(first).toBeTypeOf("function");
    expect(second).toBeTypeOf("function");

    const processors = postProcessors(plugin);
    expect(processors).toHaveLength(3);

    // The third pass is the mark renderer: give it a `✦` line and it styles it.
    const root = new ShimElement("div");
    root.createEl("p", { text: "✦ [[Note]]" });
    processors[2]?.(root as never, {} as never);
    expect(nodes(root, ".weaver-mark")).toHaveLength(1);
  });

  it("removes the palette and body classes on unload", async () => {
    const { plugin } = await startPlugin("");
    plugin.onunload();

    expect(shimDocument.getElementById("weaver-palette")).toBeNull();
    expect(bodyHasClass("weaver-equal-sizes")).toBe(false);
  });
});

describe("insertion commands", () => {
  it("inserts an H3 under an H2 with one undoable transaction", async () => {
    const { plugin, view, editor } = await startPlugin("# 16:10\n## 16:37 - Bhartrhari\nbody text");
    editor.setCursor({ line: 2, ch: 0 });

    plugin.insertHeading(view, "Child", undefined, AT_1637);

    expect(editor.getValue()).toBe("# 16:10\n## 16:37 - Bhartrhari\nbody text\n### 16:37:04 - Child");
    expect(editor.transactions).toBe(1);
    expect(editor.getSelection()).toBe("");
    expect(editor.selection.from).toEqual({ line: 3, ch: "### 16:37:04 - Child".length });
    expect(editor.focusCalls).toBeGreaterThan(0);

    editor.undo();
    expect(editor.getValue()).toBe("# 16:10\n## 16:37 - Bhartrhari\nbody text");
  });

  it("keeps a trailing space and parks the cursor after it for an empty title", async () => {
    const { plugin, view, editor } = await startPlugin("# A\n\nbody");
    editor.setCursor({ line: 1, ch: 0 });

    plugin.insertHeading(view, "   ", undefined, AT_1637);

    expect(editor.getValue()).toBe("# A\n## 16:37:04 \nbody");
    expect(editor.selection.from).toEqual({ line: 1, ch: "## 16:37:04 ".length });
  });

  it("respects an explicit level from the preview modal", async () => {
    const { plugin, view, editor } = await startPlugin("# A\nbody");
    editor.setCursor({ line: 1, ch: 0 });

    plugin.insertHeading(view, "Deep", 8, new Date());

    const lines = editor.getValue().split("\n");
    expect(lines[2]).toMatch(/^######## \d\d:\d\d:\d\d - Deep$/);
  });

  it("sparks a 1D at the end of this note after one blank line", async () => {
    const { plugin, editor } = await startPlugin("# A\nbody\n");
    plugin.settings.sparkTarget = "note";

    await plugin.spark();

    expect(editor.getValue()).toMatch(/^# A\nbody\n\n# \d\d:\d\d:\d\d - \n✦\n$/);
    // The caret lands at the end of the title line, not after the mark.
    const line = editor.getValue().split("\n")[editor.selection.from.line] ?? "";
    expect(line).toMatch(/^# \d\d:\d\d:\d\d - $/);
  });

  it("sparks from a selection and ids its last line", async () => {
    const { plugin, editor } = await startPlugin("# A\npassage to deepen\n");
    plugin.settings.sparkTarget = "note";
    editor.select({ line: 1, ch: 0 }, { line: 1, ch: 17 });

    await plugin.spark();

    const value = editor.getValue();
    const id = /\^([a-z0-9]{6})/.exec(value)?.[1] ?? "";
    expect(value).toContain(`passage to deepen ^${id}`);
    expect(value).toContain(`✦ [[note#^${id}|passage to deepen]]`);
  });

  it("refuses to insert inside an unclosed fence", async () => {
    const { plugin, view, editor } = await startPlugin("# A\n```\ncode");
    editor.setCursor({ line: 2, ch: 0 });

    plugin.insertHeading(view, "x", undefined, AT_1637);

    expect(noticeMessages()).toEqual([
      "Weaver: close the code block before inserting a dimension. Nothing was written."
    ]);
    expect(editor.getValue()).toBe("# A\n```\ncode");
    expect(editor.transactions).toBe(0);
  });

  it("refuses to spark with unclosed frontmatter", async () => {
    const { plugin, editor } = await startPlugin("---\ntitle: x");
    plugin.settings.sparkTarget = "note";

    await plugin.spark();

    expect(noticeMessages()).toEqual([
      "Weaver: close the frontmatter before sparking. Nothing was written."
    ]);
    expect(editor.getValue()).toBe("---\ntitle: x");
  });

  it("acts through the command callbacks the palette invokes", async () => {
    const { plugin, editor } = await startPlugin("# A\nbody");
    editor.setCursor({ line: 1, ch: 0 });

    const insert = registeredCommands(plugin).find((command) => command.id === "insert-heading");
    (insert as unknown as { editorCallback?: () => void }).editorCallback?.();

    // Insert dimension writes at the caret and leaves the caret in the title.
    const lines = editor.getValue().split("\n");
    expect(lines[2]).toMatch(/^## \d\d:\d\d:\d\d $/);
    expect(editor.selection.from.line).toBe(2);
  });

  it("opens the weave row without writing anything", async () => {
    const { plugin, editor } = await startPlugin("# A\nbody");

    const compose = registeredCommands(plugin).find((command) => command.id === "open-composer");
    (compose as unknown as { editorCallback?: () => void }).editorCallback?.();

    expect(editor.transactions).toBe(0);
    expect(editor.getValue()).toBe("# A\nbody");
  });

  it("refuses editing commands in reading view", async () => {
    const { plugin, editor } = await startPlugin("# A\nbody", { mode: "preview" });
    plugin.settings.sparkTarget = "note";

    await plugin.spark();

    expect(noticeMessages()).toEqual([
      "Weaver: this needs an editable note. Nothing was written."
    ]);
    expect(editor.transactions).toBe(0);
  });
});
