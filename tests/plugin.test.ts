import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import WeaverPlugin from "../src/main";
import { entryIndexField } from "../src/editor/entry-field";
import {
  addLeafWithView,
  createApp,
  createFile,
  createView,
  editorExtensions,
  instantiatePlugin,
  liveEditor,
  postProcessors,
  registeredCommands,
  rerenderCount,
  resetHarness
} from "../test-support/harness";
import { registerEditorView, unregisterEditorView } from "../src/editor/view-registry";

async function start(): Promise<WeaverPlugin> {
  const plugin = instantiatePlugin(WeaverPlugin, createApp());
  await plugin.onload();
  return plugin;
}

beforeEach(() => {
  resetHarness();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the command surface", () => {
  it("registers its commands with the chords that matter", async () => {
    const plugin = await start();
    const byId = new Map(registeredCommands(plugin).map((command) => [command.id, command]));

    // `Mod+Enter` is the core "open link" chord and never reaches a plugin, so
    // starting an entry owns `Mod+Shift+Enter`.
    expect(byId.get("start-entry")?.hotkeys).toEqual([{ modifiers: ["Mod", "Shift"], key: "Enter" }]);
    expect(byId.get("navigate")?.hotkeys).toEqual([{ modifiers: ["Mod", "Shift"], key: "P" }]);
    expect(byId.get("view-today")?.hotkeys).toEqual([{ modifiers: ["Mod", "Alt"], key: "t" }]);
    // History has no default chord: a global binding would shadow the writer's
    // own Vim motions, so it is bindable but unbound.
    expect(byId.get("back")?.hotkeys ?? []).toEqual([]);
    expect(byId.get("forward")?.hotkeys ?? []).toEqual([]);

    // Every command carries an icon, so the phone's toolbar can draw it.
    for (const command of byId.values()) expect(command.icon).toBeTypeOf("string");

    plugin.onunload();
  });

  it("registers no ribbon item and no Tapestry view", async () => {
    const plugin = await start();

    expect((plugin as unknown as { ribbonIcons: unknown[] }).ribbonIcons).toEqual([]);
    expect((plugin as unknown as { views: Map<string, unknown> }).views.size).toBe(0);

    plugin.onunload();
  });
});

describe("the editor layer", () => {
  it("registers the entry field, so every surface shares one parse", async () => {
    const plugin = await start();

    expect(editorExtensions(plugin)).toContain(entryIndexField);

    plugin.onunload();
  });

  it("writes its own stylesheet and takes it away again", async () => {
    const plugin = await start();

    const style = document.getElementById("weaver-style");
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain("--weaver-entry-size: calc(1 * var(--font-text-size, 16px));");
    expect(style?.textContent).toContain("--weaver-indent-step: 18px;");
    expect(style?.textContent).toContain("--weaver-indent-max-level: 8;");
    expect(style?.textContent).toContain("--weaver-thread-space: 0px;");
    expect(style?.textContent).toContain("--weaver-branch-space: 0px;");

    plugin.onunload();
    expect(document.getElementById("weaver-style")).toBeNull();
  });

  it("registers the entry and close post processors", async () => {
    const plugin = await start();

    expect(postProcessors(plugin).length).toBe(2);

    plugin.onunload();
  });

  it("refreshes open entry dates at the local-day boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 5, 23, 59, 59, 900));
    const file = createFile("Projects/Idea.md", "{ 1.1.1 }\nprose\n2026-11-05 23:00:00");
    const app = createApp([file]);
    const preview = createView(app, file, {}, "preview");
    const editor = liveEditor(file, "{ 1.1.1 }\nprose\n2026-11-05 23:00:00");
    addLeafWithView(app, preview);
    registerEditorView(editor);
    const plugin = instantiatePlugin(WeaverPlugin, app);

    await plugin.onload();
    const beforeEditor = editor.dispatches;
    const beforePreview = rerenderCount(preview);
    await vi.advanceTimersByTimeAsync(100);

    expect(editor.dispatches).toBe(beforeEditor + 1);
    expect(rerenderCount(preview)).toBe(beforePreview + 1);

    plugin.onunload();
    unregisterEditorView(editor);
  });
});
