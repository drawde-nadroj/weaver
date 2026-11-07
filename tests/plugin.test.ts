import { beforeEach, describe, expect, it } from "vitest";

import WeaverPlugin from "../src/main";
import { entryIndexField } from "../src/editor/entry-field";
import {
  createApp,
  editorExtensions,
  instantiatePlugin,
  postProcessors,
  registeredCommands,
  resetHarness
} from "../test-support/harness";

async function start(): Promise<WeaverPlugin> {
  const plugin = instantiatePlugin(WeaverPlugin, createApp());
  await plugin.onload();
  return plugin;
}

beforeEach(() => {
  resetHarness();
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
});
