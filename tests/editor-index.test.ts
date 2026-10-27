import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { headingLineField } from "../src/editor/heading-decorations";

import {
  headingIndexExtension,
  headingIndexField,
  refreshHeadingsEffect
} from "../src/editor/index-field";

function makeState(doc: string, maxDepth = 12): EditorState {
  return EditorState.create({
    doc,
    extensions: [headingIndexExtension(() => maxDepth), headingLineField]
  });
}

describe("headingIndexField", () => {
  it("parses the document on creation", () => {
    const state = makeState("# A\n## B\n### C");
    const index = state.field(headingIndexField);
    expect(index.headings.map((h) => h.level)).toEqual([1, 2, 3]);
    expect(index.maxLevel).toBe(3);
  });

  it("reparses after a document change", () => {
    let state = makeState("# A");
    state = state.update({ changes: { from: 3, insert: "\n## B" } }).state;
    const index = state.field(headingIndexField);
    expect(index.headings).toHaveLength(2);
    expect(index.headings[1]?.title).toBe("B");
  });

  it("reuses the index when nothing relevant changed", () => {
    const state = makeState("# A");
    const next = state.update({ selection: { anchor: 1 } }).state;
    expect(next.field(headingIndexField)).toBe(state.field(headingIndexField));
  });

  it("reparses when the refresh effect is dispatched", () => {
    let state = makeState("# A");
    state = state.update({ effects: refreshHeadingsEffect.of(undefined) }).state;
    expect(state.field(headingIndexField).headings).toHaveLength(1);
  });

  it("applies a changed maxDepth on refresh", () => {
    let depth = 5;
    let state = EditorState.create({
      doc: "##### e\n####### g",
      extensions: [headingIndexExtension(() => depth)]
    });
    expect(state.field(headingIndexField).headings.map((h) => h.level)).toEqual([5]);

    depth = 12;
    state = state.update({ effects: refreshHeadingsEffect.of(undefined) }).state;
    expect(state.field(headingIndexField).headings.map((h) => h.level)).toEqual([5, 7]);
  });

  it("falls back to a sane depth for invalid settings", () => {
    const state = EditorState.create({
      doc: "# a",
      extensions: [headingIndexExtension(() => Number.NaN)]
    });
    expect(state.field(headingIndexField).headings).toHaveLength(1);
  });
});

describe("heading line decorations", () => {
  interface LineDecoration {
    from: number;
    classes: string;
  }

  function lineDecorations(state: ReturnType<typeof makeState>): LineDecoration[] {
    const set = state.field(headingLineField);
    const found: LineDecoration[] = [];
    set.between(0, state.doc.length, (from, _to, value) => {
      const spec = value.spec as { class?: string };
      found.push({ from, classes: spec.class ?? "" });
    });
    return found;
  }

  it("marks every heading line with its level classes", () => {
    const state = makeState("# A\nbody\n## B\n####### deep");
    const decorations = lineDecorations(state);

    expect(decorations).toEqual([
      { from: 0, classes: "weaver-dimension-line weaver-h1" },
      { from: 9, classes: "weaver-dimension-line weaver-h2" },
      { from: 14, classes: "weaver-dimension-line weaver-h7 weaver-deep" }
    ]);
  });

  it("updates after a document change", () => {
    let state = makeState("# A");
    expect(lineDecorations(state)).toHaveLength(1);

    state = state.update({ changes: { from: 3, insert: "\n### C" } }).state;
    expect(lineDecorations(state).map((decoration) => decoration.classes)).toEqual([
      "weaver-dimension-line weaver-h1",
      "weaver-dimension-line weaver-h3"
    ]);
  });

  it("updates when the refresh effect is dispatched", () => {
    let depth = 6;
    let state = EditorState.create({
      doc: "####### deep",
      extensions: [
        headingIndexExtension(() => depth),
        headingLineField,
        EditorView.decorations.from(headingLineField)
      ]
    });
    expect(lineDecorations(state)).toHaveLength(0);

    depth = 12;
    state = state.update({ effects: refreshHeadingsEffect.of(undefined) }).state;
    expect(lineDecorations(state)).toHaveLength(1);
  });

  it("produces no decorations for a note without headings", () => {
    expect(lineDecorations(makeState("just text"))).toEqual([]);
  });
});
