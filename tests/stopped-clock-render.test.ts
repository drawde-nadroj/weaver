import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField, type MarkdownFileInfo } from "obsidian";
import WeaverPlugin from "../src/main";
import { parseEntries } from "../src/core/entries";
import { entryDecorationsExtension } from "../src/editor/entry-decorations";
import { entryIndexField } from "../src/editor/entry-field";
import { DurationWidget } from "../src/editor/stopwatch-widget";
import { registerEditorView, unregisterEditorView } from "../src/editor/view-registry";
import { createApp, createFile, instantiatePlugin, resetHarness } from "../test-support/harness";

function clockWidget(state: EditorState): DurationWidget {
  let found: DurationWidget | null = null;
  for (const decorations of state.facet(EditorView.decorations)) {
    if (typeof decorations === "function") continue;
    decorations.between(0, state.doc.length, (_from, _to, decoration) => {
      if (decoration.spec.widget instanceof DurationWidget) found = decoration.spec.widget;
    });
  }
  if (found === null) throw new Error("No rendered clock");
  return found;
}

beforeEach(() => { resetHarness(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("successful stop rendering", () => {
  it.each(["settle", "pause"] as const)("%s keeps the painted digits after the shared clock wakes again", async (action) => {
    const file = createFile("Chronomancer/2026.11.05.md", "");
    const plugin = instantiatePlugin(WeaverPlugin, createApp([file]));
    await plugin.onload();
    plugin.settings.portalsEnabled = false;
    plugin.portals.reconcile();
    plugin.session.start(file.path, 1, 0, Date.now());
    plugin.session.commitDisplay(7000);
    const state = EditorState.create({
      doc: "{ 1.1.1 }\nprose\n- 00:00:00 2026-11-05 22:55:00\n",
      selection: { anchor: 10 },
      extensions: [
        editorInfoField.init(() => ({ file }) as MarkdownFileInfo),
        entryIndexField,
        entryDecorationsExtension(() => plugin.session, () => file.path, () => plugin.clock)
      ]
    });
    const holder = { state };
    const view = {
      get state() { return holder.state; },
      dispatch(spec: TransactionSpec | Transaction) {
        holder.state = spec instanceof Transaction ? spec.state : holder.state.update(spec).state;
      },
      focus() {}
    } as unknown as EditorView;
    registerEditorView(view);
    try {
      expect(clockWidget(view.state).input.mode).toBe("running");
      if (action === "pause") await plugin.entries.pause();
      else {
        const entry = parseEntries(view.state.doc.toString()).entries[0];
        if (entry === undefined) throw new Error("No entry");
        plugin.entries.settle(view, entry);
      }
      expect(plugin.session.active()).toBeNull();
      const stopped = clockWidget(view.state);
      expect(stopped.input.mode).toBe("fixed");
      const root = stopped.toDOM();
      vi.advanceTimersByTime(2500);
      plugin.clock.refresh();
      expect(root.querySelector(".weaver-duration-clock")?.textContent).toBe(`${action === "pause" ? "=" : "+"} 00:00:07`);
      stopped.destroy();
    } finally {
      unregisterEditorView(view);
      plugin.onunload();
    }
  });
});
