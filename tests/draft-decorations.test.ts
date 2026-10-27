import { EditorState } from "@codemirror/state";
import { editorLivePreviewField } from "obsidian";
import { beforeEach, describe, expect, it } from "vitest";

import { draftDecorationSet } from "../src/editor/draft-decorations";
import { headingIndexExtension } from "../src/editor/index-field";
import { DEFAULT_SETTINGS, type WeaverSettings } from "../src/settings";
import type { DraftBadgeHandlers } from "../src/ui/draft-badge";
import { resetHarness } from "../test-support/harness";

const OPENED = "2026-10-26 16:37:04";

const SOURCE = [
  "# 09:00 Root",
  `⟪draft 2.1 ${OPENED}⟫`,
  "Half-formed thought",
  "body text",
  "⟪/draft 2.1⟫",
  "tail"
].join("\n");

const HANDLERS: DraftBadgeHandlers = {
  maxDepth: 12,
  onWeave: () => undefined,
  onDiscard: () => undefined,
  onLevel: () => undefined
};

function settings(patch: Partial<WeaverSettings> = {}): WeaverSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

function stateAt(source: string, cursor: number, livePreview = true): EditorState {
  return EditorState.create({
    doc: source,
    selection: { anchor: cursor },
    extensions: [
      headingIndexExtension(() => 12),
      // The stub field is a plain StateField, so a value can be supplied here.
      livePreview ? editorLivePreviewField : []
    ]
  });
}

interface Collected {
  from: number;
  to: number;
  block: boolean;
  classes: string[];
  widget: string | null;
}

function collect(state: EditorState, config: WeaverSettings): Collected[] {
  const set = draftDecorationSet(state, config, HANDLERS);
  const found: Collected[] = [];

  for (const cursor = set.iter(); cursor.value !== null; cursor.next()) {
    const spec = cursor.value.spec as {
      block?: boolean;
      class?: string;
      widget?: { constructor: { name: string } };
    };
    found.push({
      from: cursor.from,
      to: cursor.to,
      block: spec.block === true,
      classes: typeof spec.class === "string" ? spec.class.split(/\s+/) : [],
      widget: spec.widget?.constructor.name ?? null
    });
  }

  return found;
}

beforeEach(() => {
  resetHarness();
});

describe("draftDecorationSet", () => {
  it("replaces both marker lines with block widgets and marks the text lines", () => {
    const state = stateAt(SOURCE, 0);
    const found = collect(state, settings());

    const blocks = found.filter((entry) => entry.block);
    expect(blocks.map((entry) => entry.widget)).toEqual(["DraftBadgeWidget", "DraftEndWidget"]);

    const titles = found.filter((entry) => entry.classes.includes("weaver-draft-title"));
    expect(titles).toHaveLength(1);
    expect(titles[0]?.from).toBe(SOURCE.indexOf("Half-formed thought"));

    const bodies = found.filter((entry) => entry.classes.includes("weaver-draft-body"));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.from).toBe(SOURCE.indexOf("body text"));
  });

  it("keeps a marker line raw while the caret sits inside it", () => {
    const openLine = SOURCE.indexOf("⟪draft");
    const found = collect(stateAt(SOURCE, openLine + 2), settings());

    const blocks = found.filter((entry) => entry.block);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.widget).toBe("DraftEndWidget");

    const raw = found.filter((entry) => entry.classes.includes("weaver-draft-marker"));
    expect(raw).toHaveLength(1);
    expect(raw[0]?.from).toBe(openLine);
  });

  it("keeps the close marker raw while the caret sits inside it", () => {
    const closeLine = SOURCE.indexOf("⟪/draft");
    const found = collect(stateAt(SOURCE, closeLine + 1), settings());

    const blocks = found.filter((entry) => entry.block);
    expect(blocks.map((entry) => entry.widget)).toEqual(["DraftBadgeWidget"]);
    expect(found.filter((entry) => entry.classes.includes("weaver-draft-marker"))).toHaveLength(1);
  });

  it("emits nothing when in-page drafts are turned off", () => {
    expect(collect(stateAt(SOURCE, 0), settings({ inPageDrafts: false }))).toEqual([]);
  });

  it("emits nothing in Source mode", () => {
    expect(collect(stateAt(SOURCE, 0, false), settings())).toEqual([]);
  });

  it("emits nothing for a note without drafts", () => {
    expect(collect(stateAt("# 09:00 Root\nbody", 0), settings())).toEqual([]);
  });

  it("covers a draft at the end of the document", () => {
    const source = ["# Root", `⟪draft 2.1 ${OPENED}⟫`, "", "⟪/draft 2.1⟫"].join("\n");
    const found = collect(stateAt(source, 0), settings());

    expect(found.filter((entry) => entry.block).map((entry) => entry.widget)).toEqual([
      "DraftBadgeWidget",
      "DraftEndWidget"
    ]);
  });
});
