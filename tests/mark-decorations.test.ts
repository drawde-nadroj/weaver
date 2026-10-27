import { EditorState } from "@codemirror/state";
import { editorLivePreviewField } from "obsidian";
import { beforeEach, describe, expect, it } from "vitest";

import { headingIndexExtension } from "../src/editor/index-field";
import { markLineDecorations } from "../src/editor/mark-decorations";
import { resetHarness } from "../test-support/harness";

const SOURCE = [
  "# 09:12:01 - first",
  "✦ [[Note#^abc123|first source]]",
  "## 10:00:00 - deeper",
  "✦",
  "✓ 21:29",
  "plain prose"
].join("\n");

function stateAt(source: string, cursor = 0, livePreview = true): EditorState {
  return EditorState.create({
    doc: source,
    selection: { anchor: cursor },
    extensions: [headingIndexExtension(() => 12), livePreview ? editorLivePreviewField : []]
  });
}

interface Collected {
  from: number;
  classes: string[];
}

function collect(state: EditorState): Collected[] {
  const found: Collected[] = [];
  for (const cursor = markLineDecorations(state).iter(); cursor.value !== null; cursor.next()) {
    const spec = cursor.value.spec as { class?: string };
    found.push({
      from: cursor.from,
      classes: typeof spec.class === "string" ? spec.class.split(/\s+/) : []
    });
  }
  return found;
}

beforeEach(() => {
  resetHarness();
});

describe("markLineDecorations", () => {
  it("bands the ✦ and ✓ lines and nothing else", () => {
    const found = collect(stateAt(SOURCE));

    expect(found).toHaveLength(3);
    expect(found.map((entry) => entry.classes)).toEqual([
      ["weaver-mark-line"],
      ["weaver-mark-line"],
      ["weaver-close-mark-line"]
    ]);
    // The line decoration sits at the start of its own line.
    expect(found[0]?.from).toBe(SOURCE.indexOf("✦ [[Note"));
    expect(found[1]?.from).toBe(SOURCE.indexOf("\n✦\n") + 1);
    expect(found[2]?.from).toBe(SOURCE.indexOf("✓ 21:29"));
  });

  it("drops the band while the caret sits on the mark line", () => {
    const caret = SOURCE.indexOf("✓ 21:29") + 3;
    const found = collect(stateAt(SOURCE, caret));

    expect(found.map((entry) => entry.classes)).toEqual([
      ["weaver-mark-line"],
      ["weaver-mark-line"]
    ]);
  });

  it("emits nothing at all in Source mode", () => {
    expect(collect(stateAt(SOURCE, 0, false))).toEqual([]);
  });

  it("leaves a mark alone when it sits in code, frontmatter or a draft body", () => {
    const source = [
      "---",
      "title: ✦ not a mark",
      "---",
      "",
      "```",
      "✦ inside code",
      "✓ 10:00",
      "```",
      "⟪draft 1.1 2026-10-26 16:37:04⟫",
      "✦ in a draft",
      "⟪/draft 1.1⟫"
    ].join("\n");

    expect(collect(stateAt(source))).toEqual([]);
  });
});
