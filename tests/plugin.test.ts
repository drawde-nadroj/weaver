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
  it("registers exactly the six commands, with their chords", async () => {
    const plugin = await start();
    const commands = registeredCommands(plugin);

    expect(commands.map((command) => command.id)).toEqual([
      "start-entry",
      "insert-entry",
      "travel",
      "palette",
      "line-break",
      "close-day"
    ]);

    const chords = commands.map((command) =>
      (command.hotkeys ?? []).map((hotkey) => `${hotkey.modifiers.join("+")}+${hotkey.key}`)
    );
    // `Mod+Enter` is the core "open link" chord and never reaches a plugin, so
    // starting an entry owns `Mod+Shift+E` instead.
    expect(chords[0]).toEqual(["Mod+Shift+E"]);
    expect(chords[1]).toEqual(["Mod+Shift+J"]);
    expect(chords[2]).toEqual(["Mod+Shift+Enter"]);
    expect(chords[3]).toEqual(["Mod+Shift+P"]);
    expect(chords[4]).toEqual([]);
    expect(chords[5]).toEqual([]);

    // The toolbar's newline carries the icon the phone's toolbar draws.
    expect(commands.find((command) => command.id === "line-break")?.icon).toBe("corner-down-left");

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
    expect(style?.textContent).toContain("--weaver-entry-size: 1em;");
    expect(style?.textContent).toContain("--weaver-indent-step: 18px;");
    expect(style?.textContent).toContain("--weaver-indent-max-level: 8;");

    plugin.onunload();
    expect(document.getElementById("weaver-style")).toBeNull();
  });

  it("registers the entry and close post processors", async () => {
    const plugin = await start();

    expect(postProcessors(plugin).length).toBe(2);

    plugin.onunload();
  });
});
