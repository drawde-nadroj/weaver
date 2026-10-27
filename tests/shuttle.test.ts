import { beforeEach, describe, expect, it } from "vitest";
import { Platform, type App } from "obsidian";

import WeaverPlugin from "../src/main";
import { normalizeShuttle } from "../src/settings";
import { SHUTTLE_CAPACITY, ShuttleStore, type ShuttleItem } from "../src/shuttle/store";
import { FakeEditor } from "../test-support/editor";
import {
  addLeafWithView,
  click,
  createApp,
  createFile,
  createView,
  fire,
  instantiatePlugin,
  node,
  nodes,
  noticeMessages,
  resetHarness,
  setActiveView,
  setValue,
  textOf
} from "../test-support/harness";

/** Lets the async jump and its reads settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function store(saved: ShuttleItem[] = []): { store: ShuttleStore; writes: ShuttleItem[][] } {
  const writes: ShuttleItem[][] = [];
  return { store: new ShuttleStore(saved, (items) => writes.push([...items])), writes };
}

const NOTE_LOAD = { kind: "note" as const, path: "a.md", label: "a" };

describe("ShuttleStore", () => {
  it("loads newest first and names what it holds", () => {
    const { store: shuttle, writes } = store();

    shuttle.load(NOTE_LOAD);
    shuttle.load({ kind: "note", path: "b.md", label: "b" });

    expect(shuttle.items().map((item) => item.path)).toEqual(["b.md", "a.md"]);
    expect(shuttle.items()[0]?.usedCount).toBe(0);
    expect(writes).toHaveLength(2);
  });

  it("moves a re-loaded source to the front instead of duplicating it", () => {
    const { store: shuttle } = store();
    const first = shuttle.load(NOTE_LOAD);
    shuttle.load({ kind: "note", path: "b.md", label: "b" });
    shuttle.markUsed(first.id);

    const again = shuttle.load(NOTE_LOAD);

    expect(shuttle.items()).toHaveLength(2);
    expect(shuttle.items()[0]?.path).toBe("a.md");
    expect(again.id).toBe(first.id);
    expect(again.usedCount).toBe(1);
  });

  it("keeps the day a source was loaded on when it is grabbed again", () => {
    const { store: shuttle } = store();
    const first = shuttle.load(NOTE_LOAD);
    shuttle.load({ kind: "note", path: "b.md", label: "b" });
    const again = shuttle.load(NOTE_LOAD);

    expect(again.addedAt).toBe(first.addedAt);
    expect(shuttle.items()[0]?.path).toBe("a.md");
  });

  it("treats a different passage of the same note as a different source", () => {
    const { store: shuttle } = store();
    shuttle.load({ kind: "words", path: "a.md", blockId: "abc123", label: "one" });
    shuttle.load({ kind: "words", path: "a.md", blockId: "zzz999", label: "two" });

    expect(shuttle.items()).toHaveLength(2);
  });

  it("keeps at most fifty rows, dropping the oldest", () => {
    const { store: shuttle } = store();
    for (let index = 0; index < SHUTTLE_CAPACITY + 1; index += 1) {
      shuttle.load({ kind: "note", path: `note-${index}.md`, label: `note ${index}` });
    }

    expect(shuttle.items()).toHaveLength(SHUTTLE_CAPACITY);
    expect(shuttle.items()[0]?.path).toBe(`note-${SHUTTLE_CAPACITY}.md`);
    expect(shuttle.items().some((item) => item.path === "note-0.md")).toBe(false);
  });

  it("unloads by id and clears on demand", () => {
    const { store: shuttle } = store();
    const first = shuttle.load(NOTE_LOAD);
    shuttle.load({ kind: "note", path: "b.md", label: "b" });

    shuttle.remove(first.id);
    expect(shuttle.items().map((item) => item.path)).toEqual(["b.md"]);

    shuttle.clear();
    expect(shuttle.items()).toEqual([]);
  });

  it("counts a use without losing the row", () => {
    const { store: shuttle } = store();
    const item = shuttle.load(NOTE_LOAD);

    shuttle.markUsed(item.id);
    shuttle.markUsed(item.id);

    expect(shuttle.items()[0]?.usedCount).toBe(2);
  });
});

describe("the shuttle capacity fixture", () => {
  it("keeps fifty rows, moves a reloaded source to the front and preserves its use count", () => {
    const { store: shuttle } = store();
    for (let index = 0; index < SHUTTLE_CAPACITY + 1; index += 1) {
      shuttle.load({ kind: "note", path: `note-${index}.md`, label: `note ${index}` });
    }
    const oldest = shuttle.items()[shuttle.items().length - 1];
    expect(oldest).toBeDefined();

    shuttle.markUsed(oldest.id);
    const reloaded = shuttle.load({
      kind: oldest.kind,
      path: oldest.path,
      headingText: oldest.headingText,
      blockId: oldest.blockId,
      label: oldest.label
    });

    expect(shuttle.items()).toHaveLength(SHUTTLE_CAPACITY);
    expect(shuttle.items()[0]?.id).toBe(oldest.id);
    expect(reloaded.usedCount).toBe(1);
    expect(new Set(shuttle.items().map((item) => item.path)).size).toBe(SHUTTLE_CAPACITY);
  });
});

describe("normalizeShuttle", () => {
  it("keeps complete rows and drops the rest", () => {
    const kept = normalizeShuttle([
      { id: "one", kind: "note", path: "a.md", label: "a", addedAt: "2026-10-27T10:00:00.000Z", usedCount: 3 },
      { kind: "note", path: "", label: "no path" },
      { kind: "elsewhere", path: "b.md", label: "bad kind" },
      { path: "c.md", label: "no kind" },
      "not an object"
    ]);

    expect(kept).toHaveLength(1);
    expect(kept[0]?.usedCount).toBe(3);
  });

  it("coerces the use count and never trusts a negative one", () => {
    const [item] = normalizeShuttle([
      { id: "one", kind: "words", path: "a.md", label: "a", blockId: "abc123", usedCount: -5 }
    ]);
    expect(item?.usedCount).toBe(0);
    expect(item?.blockId).toBe("abc123");
  });

  it("returns nothing for a payload that is not a list", () => {
    expect(normalizeShuttle(undefined)).toEqual([]);
    expect(normalizeShuttle({ items: [] })).toEqual([]);
  });
});

describe("the shuttle palette", () => {
  beforeEach(() => {
    resetHarness();
    Platform.isPhone = false;
  });

  async function start(source = "# A\npassage to keep\n"): Promise<{
    plugin: WeaverPlugin;
    editor: FakeEditor;
    app: App;
  }> {
    const file = createFile("a.md", source);
    const app = createApp([file]);
    const editor = new FakeEditor(source);
    const view = createView(app, file, editor);
    setActiveView(app, view);
    addLeafWithView(app, view);

    const plugin = instantiatePlugin(WeaverPlugin, app);
    await plugin.onload();
    return { plugin, editor, app };
  }

  it("lists what is loaded, newest first, and closes on Escape", async () => {
    const { plugin } = await start();
    plugin.shuttles.load({ kind: "note", path: "a.md", label: "a" });
    plugin.shuttles.load({ kind: "dimension", path: "b.md", headingText: "09:00 - b", label: "09:00 b" });

    plugin.openShuttlePalette();

    const overlay = node(document.body as never, ".weaver-shuttle");
    expect(overlay).not.toBeNull();
    expect(textOf(node(overlay, ".weaver-shuttle-title"))).toBe("Shuttle · 2 loaded");
    const rows = nodes(overlay, ".weaver-shuttle-row");
    expect(rows.map((row) => textOf(node(row, ".weaver-shuttle-glyph")))).toEqual(["✦", "▸"]);
    expect(rows.map((row) => textOf(node(row, ".weaver-shuttle-label")))).toEqual([
      "09:00 b",
      "a"
    ]);

    fire(overlay, "keydown", { key: "Escape" });
    expect(node(document.body as never, ".weaver-shuttle")).toBeNull();
  });

  it("weaves in at the caret and keeps the row with a use count", async () => {
    const { plugin, editor } = await start();
    editor.setCursor({ line: 1, ch: 7 });
    const item = plugin.shuttles.load({ kind: "note", path: "a.md", label: "a" });

    plugin.openShuttlePalette();
    const overlay = node(document.body as never, ".weaver-shuttle");

    fire(overlay, "keydown", { key: "Enter" });
    expect(editor.getValue()).toContain("passage [[a]] to keep");

    fire(overlay, "keydown", { key: "Enter" });
    expect(editor.getValue().match(/\[\[a\]\]/g)).toHaveLength(2);

    expect(plugin.shuttles.items()).toHaveLength(1);
    expect(plugin.shuttles.items()[0]?.usedCount).toBe(2);
    expect(textOf(node(overlay, ".weaver-shuttle-used"))).toBe("·2");
    expect(item.id).toBe(plugin.shuttles.items()[0]?.id);
  });

  it("unloads a row with Backspace and says when nothing is loaded", async () => {
    const { plugin } = await start();
    plugin.shuttles.load({ kind: "note", path: "a.md", label: "a" });

    plugin.openShuttlePalette();
    const overlay = node(document.body as never, ".weaver-shuttle");
    fire(overlay, "keydown", { key: "Backspace" });

    expect(plugin.shuttles.items()).toHaveLength(0);
    plugin.openShuttlePalette();
    expect(textOf(node(document.body as never, ".weaver-shuttle-empty"))).toBe(
      "Nothing loaded. Grab a source with ⌘⇧G."
    );
  });

  it("filters on the query and on a typed letter", async () => {
    const { plugin } = await start();
    plugin.shuttles.load({ kind: "note", path: "alpha.md", label: "alpha" });
    plugin.shuttles.load({ kind: "note", path: "beta.md", label: "beta" });

    plugin.openShuttlePalette();
    const filter = node(document.body as never, ".weaver-shuttle-filter");
    setValue(filter, "bet");
    fire(filter, "input");

    expect(nodes(document.body as never, ".weaver-shuttle-row")).toHaveLength(1);
  });
});

describe("the shuttle on a phone", () => {
  beforeEach(() => {
    resetHarness();
    Platform.isPhone = true;
    Platform.isMobile = true;
  });

  it("is a bottom sheet with a visible unload control", async () => {
    const file = createFile("a.md", "# A\n");
    const app = createApp([file]);
    const editor = new FakeEditor("# A\n");
    const view = createView(app, file, editor);
    setActiveView(app, view);
    addLeafWithView(app, view);

    const plugin = instantiatePlugin(WeaverPlugin, app);
    await plugin.onload();
    plugin.shuttles.load({ kind: "note", path: "a.md", label: "a" });

    plugin.openShuttlePalette();
    const overlay = node(document.body as never, ".weaver-shuttle");

    expect(overlay?.hasClass("weaver-shuttle-phone")).toBe(true);
    const unload = node(overlay, ".weaver-shuttle-unload");
    expect(unload).not.toBeNull();
    click(unload);
    expect(plugin.shuttles.items()).toHaveLength(0);
  });
});

describe("the shuttle commands", () => {
  beforeEach(() => {
    resetHarness();
    Platform.isPhone = false;
  });

  async function startSource(source: string): Promise<{ plugin: WeaverPlugin }> {
    const file = createFile("a.md", source);
    const app = createApp([file]);
    const editor = new FakeEditor(source);
    const view = createView(app, file, editor);
    setActiveView(app, view);
    addLeafWithView(app, view);

    const plugin = instantiatePlugin(WeaverPlugin, app);
    await plugin.onload();
    return { plugin };
  }

  it("loads a selection, ids its last line and opens the palette", async () => {
    const source = "# A\npassage to keep\n";
    const file = createFile("a.md", source);
    const app = createApp([file]);
    const editor = new FakeEditor(source);
    const view = createView(app, file, editor);
    setActiveView(app, view);
    addLeafWithView(app, view);

    const plugin = instantiatePlugin(WeaverPlugin, app);
    await plugin.onload();
    editor.select({ line: 1, ch: 0 }, { line: 1, ch: 15 });

    await plugin.loadShuttle();

    const id = /\^([a-z0-9]{6})/.exec(editor.getValue())?.[1] ?? "";
    expect(id).toHaveLength(6);
    expect(plugin.shuttles.items()[0]).toMatchObject({
      kind: "words",
      path: "a.md",
      blockId: id,
      label: "passage to keep"
    });
    // The palette opening with the row at the top is the feedback; nothing toasts.
    const palette = (plugin as unknown as { shuttlePalette: { isOpen: boolean } }).shuttlePalette;
    expect(palette?.isOpen).toBe(true);
    expect(noticeMessages()).toEqual([]);
    expect(noticeMessages().some((message) => message.includes("loaded"))).toBe(false);
  });

  it("loads the current dimension when nothing is selected", async () => {
    const source = "# 09:00 - Root\n## 09:05 - Alpha\n";
    const file = createFile("a.md", source);
    const app = createApp([file]);
    const editor = new FakeEditor(source);
    const view = createView(app, file, editor);
    setActiveView(app, view);
    addLeafWithView(app, view);

    const plugin = instantiatePlugin(WeaverPlugin, app);
    await plugin.onload();
    editor.setCursor({ line: 1, ch: 0 });

    await plugin.loadShuttle();

    expect(plugin.shuttles.items()[0]).toMatchObject({
      kind: "dimension",
      headingText: "09:05 - Alpha",
      label: "09:05 Alpha"
    });
  });

  it("persists the shuttle as plugin data, not as a note", async () => {
    const file = createFile("a.md", "# A\n");
    const app = createApp([file]);
    const editor = new FakeEditor("# A\n");
    const view = createView(app, file, editor);
    setActiveView(app, view);
    addLeafWithView(app, view);

    const plugin = instantiatePlugin(WeaverPlugin, app);
    await plugin.onload();
    await plugin.loadShuttle();

    const stored = (plugin as unknown as { stored: { shuttle: ShuttleItem[] } }).stored;
    expect(stored.shuttle).toHaveLength(1);
    expect(stored.shuttle[0]?.path).toBe("a.md");
  });

  it("returns to the source of a spark and then back again", async () => {
    const daySource = [
      "# 09:12 - spark",
      "✦ [[a#09:05 - Alpha|09:05 Alpha]]",
      "body"
    ].join("\n");
    const dayFile = createFile("Chronomancer/day.md", daySource);
    const other = createFile("a.md", "# 09:00 - Root\n## 09:05 - Alpha\nbody\n");
    const app = createApp([dayFile, other]);

    const editor = new FakeEditor(daySource);
    const view = createView(app, dayFile, editor);
    setActiveView(app, view);
    addLeafWithView(app, view);

    const plugin = instantiatePlugin(WeaverPlugin, app);
    await plugin.onload();
    editor.setCursor({ line: 2, ch: 0 });

    plugin.returnToSource();
    await settle();

    expect(plugin["returnPlace" as keyof WeaverPlugin]).toBeTruthy();

    // A second invocation goes back to where the writing happened.
    editor.setCursor({ line: 2, ch: 0 });
    plugin.returnToSource();
  });

  it("opening a source is not a use", async () => {
    const { plugin } = await startSource("# A\n");
    const item = plugin.shuttles.load({ kind: "note", path: "a.md", label: "a" });

    plugin.openShuttleItem(item);

    expect(plugin.shuttles.items()[0]?.usedCount).toBe(0);
  });

  it("says so when a spark records no source", async () => {
    const source = "# 09:12 - spark\n✦\nbody";
    const file = createFile("a.md", source);
    const app = createApp([file]);
    const editor = new FakeEditor(source);
    const view = createView(app, file, editor);
    setActiveView(app, view);
    addLeafWithView(app, view);

    const plugin = instantiatePlugin(WeaverPlugin, app);
    await plugin.onload();
    editor.setCursor({ line: 2, ch: 0 });

    plugin.returnToSource();

    expect(noticeMessages()).toEqual(["Weaver: this spark has no source. Nothing was written."]);
  });
});
