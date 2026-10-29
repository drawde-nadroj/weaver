import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { editorLivePreviewField } from "obsidian";
import type { Decoration } from "@codemirror/view";

import { entryDecorationSet } from "../src/editor/entry-decorations";
import { entryIndexField } from "../src/editor/entry-field";
import { DurationWidget } from "../src/editor/stopwatch-widget";
import { EntrySession } from "../src/entries/session";
import { DEFAULT_SETTINGS, type WeaverSettings } from "../src/settings";

const DOC = ["{ 2.1.1 } - 10:00:00", "prose here", "+ 00:01:00"].join("\n");
// Not today: the run below is dated 27 October 2026.
const PATH = "Chronomancer/2026-10-26.md";
const NOW = new Date(2026, 9, 27, 12, 0, 0).getTime();

interface Found {
  from: number;
  to: number;
  spec: {
    class?: string;
    attributes?: Record<string, string>;
    widget?: { toDOM?: () => ShimNode };
    block?: boolean;
  };
  text: string;
}

interface ShimNode {
  className: string;
  textContent: string;
}

function collect(
  state: EditorState,
  settings: WeaverSettings = DEFAULT_SETTINGS,
  session = new EntrySession(),
  path = PATH
): Found[] {
  const set = entryDecorationSet(state, settings, session, path, NOW);
  const found: Found[] = [];

  for (let iterator = set.iter(); iterator.value !== null; iterator.next()) {
    found.push({
      from: iterator.from,
      to: iterator.to,
      spec: (iterator.value as Decoration).spec,
      text: state.doc.sliceString(iterator.from, iterator.to)
    });
  }
  return found;
}

/** The caret sits in the prose unless a test says otherwise. */
function stateAt(anchor = DOC.indexOf("prose")): EditorState {
  return EditorState.create({
    doc: DOC,
    selection: { anchor },
    extensions: [entryIndexField, editorLivePreviewField]
  });
}

describe("the entry decorations", () => {
  it("carries the depth and the colour on every line of the entry", () => {
    const found = collect(stateAt());
    const head = found.find((range) => range.spec.class?.startsWith("weaver-entry-head"));
    const prose = found.find((range) => range.spec.class === "weaver-entry-prose");

    expect(head?.spec.attributes?.style).toBe("--weaver-dcolor:#f97316;--weaver-d:2");
    expect(prose?.spec.attributes?.style).toBe("--weaver-dcolor:#f97316;--weaver-d:2");
  });

  it("keeps the digits white and the punctuation coloured", () => {
    const found = collect(stateAt());
    const digits = found.filter((range) => range.spec.class === "weaver-dcn-num");
    const ink = found.filter((range) => range.spec.class === "weaver-dcn-ink");

    expect(digits.map((range) => range.text)).toEqual(["2", "1", "1", "10", "00", "00"]);
    expect(ink.map((range) => range.text).join("|")).toBe("{ |.|.| } - |:|:");
  });

  it("replaces the duration line while the caret is elsewhere", () => {
    const found = collect(stateAt());
    const replaced = found.find((range) => range.spec.widget instanceof DurationWidget);

    expect(replaced?.to).toBe(DOC.length);
    expect(replaced?.spec.block).toBe(true);
  });

  it("goes back to raw text while the caret is on the duration line", () => {
    const state = stateAt(DOC.length - 1);
    const found = collect(state);

    expect(found.some((range) => range.spec.widget instanceof DurationWidget)).toBe(false);
    expect(found.some((range) => range.spec.class === "weaver-duration-raw")).toBe(true);
    expect(found.some((range) => range.spec.class === "weaver-entry-head-raw")).toBe(false);
  });

  it("marks the head raw while the caret is on the marker line", () => {
    const found = collect(stateAt(2));

    expect(found.some((range) => range.spec.class === "weaver-entry-head weaver-entry-head-raw")).toBe(
      true
    );
  });

  it("takes the marker's paint away while the frame draws it", () => {
    const head = collect(stateAt()).find((range) =>
      range.spec.class?.startsWith("weaver-entry-head")
    );
    expect(head?.spec.class).toBe("weaver-entry-head weaver-entry-head-framed");

    // The caret on the row always wins: the file's own text comes back.
    const raw = collect(stateAt(2)).find((range) =>
      range.spec.class?.startsWith("weaver-entry-head")
    );
    expect(raw?.spec.class).toBe("weaver-entry-head weaver-entry-head-raw");
  });

  it("never removes the marker's paint with framing turned off", () => {
    const off: WeaverSettings = { ...DEFAULT_SETTINGS, entryFrames: false };
    const head = collect(stateAt(), off).find((range) =>
      range.spec.class?.startsWith("weaver-entry-head")
    );

    expect(head?.spec.class).toBe("weaver-entry-head");
  });

  it("ticks a live session instead of showing the stored time", () => {
    const session = new EntrySession();
    session.start(PATH, 1, 65_000, NOW - 1000);

    const widget = collect(stateAt(), DEFAULT_SETTINGS, session).find(
      (range) => range.spec.widget instanceof DurationWidget
    )?.spec.widget as DurationWidget | undefined;

    // Writing is always a draft, whatever sigil the file holds.
    expect(widget?.input.sigil).toBe("-");
    expect(widget?.input.active).toBe(true);
    expect(widget?.input.ms).toBe(66_000);
    widget?.destroy();
  });

  it("shows the sigil the file kept once nothing is running", () => {
    const settled = ["{ 2.1.1 } - 10:00:00", "prose here", "= 00:01:00"].join("\n");
    const state = EditorState.create({
      doc: settled,
      selection: { anchor: settled.indexOf("prose") },
      extensions: [entryIndexField]
    });

    const widget = collect(state).find(
      (range) => range.spec.widget instanceof DurationWidget
    )?.spec.widget as DurationWidget | undefined;

    expect(widget?.input.sigil).toBe("=");
    expect(widget?.input.active).toBe(false);
    widget?.destroy();
  });

  it("draws two coloured colons between three white digit spans", () => {
    const widget = new DurationWidget({ sigil: "-", ms: 66_000, active: false, color: "#f97316", d: 2 });
    const root = widget.toDOM() as unknown as {
      querySelectorAll: (selector: string) => Array<{ textContent: string }>;
    };

    expect(root.querySelectorAll(".weaver-duration-num").map((node) => node.textContent)).toEqual([
      "00",
      "01",
      "06"
    ]);
    expect(root.querySelectorAll(".weaver-duration-ink").map((node) => node.textContent)).toEqual([
      ":",
      ":"
    ]);
    widget.destroy();
  });

  it("links a past day and leaves today alone", () => {
    const past = collect(stateAt()).find(
      (range) => range.spec.widget !== undefined && !range.spec.block
    );
    expect(past?.spec.widget?.toDOM?.().className).toBe("weaver-entry-daylink");

    const today = collect(
      stateAt(),
      DEFAULT_SETTINGS,
      new EntrySession(),
      "Chronomancer/2026-10-27.md"
    );
    expect(today.some((range) => range.spec.widget !== undefined && !range.spec.block)).toBe(false);
  });

  it("honours the setting that turns the day link off", () => {
    const off: WeaverSettings = { ...DEFAULT_SETTINGS, entryDayLink: false };
    const found = collect(stateAt(), off);
    expect(found.some((range) => !range.spec.block && range.spec.widget !== undefined)).toBe(false);
  });

  it("decorates nothing when the note has no entries", () => {
    const state = EditorState.create({
      doc: "just prose",
      extensions: [entryIndexField]
    });
    expect(collect(state)).toEqual([]);
  });
});
