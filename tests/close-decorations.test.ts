import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { editorLivePreviewField } from "obsidian";

import { closeDecorations } from "../src/editor/close-decorations";
import { entryIndexField } from "../src/editor/entry-field";

const DOC = ["{ 1.1.1 } - 10:00:00", "prose", "+ 00:00:00", "", "✓ 17:30:00"].join("\n");

function classes(state: EditorState): string[] {
  const set = closeDecorations(state);
  const found: string[] = [];

  for (let iterator = set.iter(); iterator.value !== null; iterator.next()) {
    found.push(String((iterator.value as { spec?: { class?: string } }).spec?.class ?? ""));
  }
  return found;
}

function stateIn(mode: "live" | "source", anchor = 0): EditorState {
  return EditorState.create({
    doc: DOC,
    selection: { anchor },
    extensions: [entryIndexField, editorLivePreviewField.init(() => mode === "live")]
  });
}

describe("the close-line band", () => {
  it("bands a ✓ line in Live Preview", () => {
    expect(classes(stateIn("live"))).toEqual(["weaver-close-mark-line"]);
  });

  it("never touches Source mode", () => {
    expect(classes(stateIn("source"))).toEqual([]);
  });

  it("keeps the line raw while the caret is on it", () => {
    // The ✓ line is the last one, at offset DOC.length - DOC.split("\n").pop()!.length.
    expect(classes(stateIn("live", DOC.length - 1))).toEqual([]);
  });

  it("ignores a ✓ that sits inside frontmatter or code", () => {
    const source = EditorState.create({
      doc: ["---", "✓ 09:00:00", "---", "```", "✓ 10:00:00", "```"].join("\n"),
      extensions: [entryIndexField, editorLivePreviewField.init(() => true)]
    });

    expect(classes(source)).toEqual([]);
  });
});
