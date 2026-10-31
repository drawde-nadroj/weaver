import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";

import { entryIndexField, refreshEntriesEffect } from "../src/editor/entry-field";

const DOC = ["{ 1.1.1 } - 10:00:00", "prose", "- 00:00:00"].join("\n");

describe("the entry field", () => {
  it("parses the document when it is created", () => {
    const state = EditorState.create({ doc: DOC, extensions: [entryIndexField] });
    const index = state.field(entryIndexField);

    expect(index.entries.length).toBe(1);
    expect(index.entries[0]?.b).toBe(1);
  });

  it("re-parses on every document change", () => {
    const state = EditorState.create({ doc: DOC, extensions: [entryIndexField] });
    const next = state.update({
      changes: { from: state.doc.length, insert: "\n\n{ 1.2.2 } - 11:00:00" }
    }).state;

    expect(next.field(entryIndexField).entries.length).toBe(2);
    expect(next.field(entryIndexField).maxN).toBe(2);
  });

  it("keeps the same value for a selection change, and rebuilds on refresh", () => {
    const state = EditorState.create({ doc: DOC, extensions: [entryIndexField] });
    const before = state.field(entryIndexField);

    const moved = state.update({ selection: { anchor: 3 } }).state;
    expect(moved.field(entryIndexField)).toBe(before);

    const refreshed = state.update({ effects: refreshEntriesEffect.of(undefined) }).state;
    expect(refreshed.field(entryIndexField)).not.toBe(before);
    expect(refreshed.field(entryIndexField).entries.length).toBe(1);
  });
});
