import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { editorLivePreviewField } from "obsidian";
import type { Decoration } from "@codemirror/view";

import { entryDecorationSet } from "../src/editor/entry-decorations";
import { entryIndexField } from "../src/editor/entry-field";
import { DurationWidget } from "../src/editor/stopwatch-widget";
import { EntrySession } from "../src/entries/session";


const DOC = ["{ 2.1.1 }", "prose here", "10:00:00 + 00:01:00"].join("\n");
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
  session = new EntrySession(),
  path = PATH
): Found[] {
  const set = entryDecorationSet(state, session, path, NOW);
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
function stateAt(anchor = DOC.indexOf("prose"), doc = DOC): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor },
    extensions: [entryIndexField, editorLivePreviewField]
  });
}

function texts(root: unknown, selector: string): string[] {
  const node = root as { querySelectorAll: (q: string) => Array<{ textContent: string }> };
  return Array.from(node.querySelectorAll(selector)).map((each) => each.textContent);
}

function clockWidget(found: Found[]): DurationWidget | undefined {
  return found.find((range) => range.spec.widget instanceof DurationWidget)?.spec.widget as
    | DurationWidget
    | undefined;
}

describe("the entry decorations", () => {
  it("carries the depth and the colour on every line of the entry", () => {
    const found = collect(stateAt());
    const head = found.find((range) => range.spec.class?.startsWith("weaver-entry-head"));
    const prose = found.find((range) => range.spec.class === "weaver-entry-prose");

    expect(head?.spec.attributes?.style).toBe("--weaver-dcolor:#f97316;--weaver-d:2");
    expect(prose?.spec.attributes?.style).toBe("--weaver-dcolor:#f97316;--weaver-d:2");
  });

  it("keeps the marker's digits white and its punctuation coloured", () => {
    const found = collect(stateAt());
    const digits = found.filter((range) => range.spec.class === "weaver-dcn-num");
    const ink = found.filter((range) => range.spec.class === "weaver-dcn-ink");

    expect(digits.map((range) => range.text)).toEqual(["2", "1", "1"]);
    // The braces and the dots are punctuation: the whole marker is the top
    // rail's label, so no character of it belongs to the box instead.
    expect(ink.map((range) => range.text).join("|")).toBe("{ |.|.| }");
  });

  it("marks a whisper row without giving it the dimension's colour", () => {
    const doc = ["{ 2.1.1 }", "~ a pricing decision", "prose here", "10:00:00 + 00:01:00"].join("\n");
    const whisper = collect(stateAt(doc.indexOf("prose"), doc)).find(
      (range) => range.spec.class === "weaver-entry-whisper"
    );

    // No `--weaver-dcolor` and no `data-weaver-n`: the stylesheet's colour rule is
    // the whole provenance, and the frame finds the marker row only.
    expect(whisper?.from).toBe(doc.indexOf("~ a pricing decision"));
    expect(whisper?.spec.attributes).toBeUndefined();
  });

  it("labels the marker row as the top rail's label", () => {
    const label = collect(stateAt()).find((range) => range.spec.class === "weaver-frame-label");

    // One mark over the file's own marker: the rail is cut behind these
    // characters, and no character is added, moved or hidden.
    expect(label?.text).toBe("{ 2.1.1 }");
  });

  it("stamps each row with the entry it belongs to", () => {
    const found = collect(stateAt());
    const head = found.find((range) => range.spec.class === "weaver-entry-head");

    // The frame layer finds the rows by these stamps, never by a DOM position.
    expect(head?.spec.attributes?.["data-weaver-n"]).toBe("1");
    expect(clockWidget(found)?.input.n).toBe(1);
  });

  it("replaces the clock row while the caret is elsewhere", () => {
    const found = collect(stateAt());
    const replaced = found.find((range) => range.spec.widget instanceof DurationWidget);

    expect(replaced?.to).toBe(DOC.length);
    expect(replaced?.spec.block).toBe(true);
  });

  it("gives the row both clocks, from the file's own text", () => {
    const widget = clockWidget(collect(stateAt()));

    expect(widget?.input.time).toBe("10:00:00");
    expect(widget?.input.sigil).toBe("+");
    expect(widget?.input.ms).toBe(60_000);
  });

  it("draws no duration half for a row that carries only a moment", () => {
    const doc = ["{ 1.1.1 }", "prose here", "10:00:00"].join("\n");
    const widget = clockWidget(collect(stateAt(doc.indexOf("prose"), doc)));

    // The file has no duration half, so the row must not label its right corner
    // with one: the frame shows what the note holds.
    expect(widget?.input.time).toBe("10:00:00");
    expect(widget?.input.sigil).toBeNull();
    const root = widget?.toDOM();
    expect(root?.querySelector(".weaver-duration-moment")?.textContent).toBe("10:00:00");
    expect(root?.querySelector(".weaver-duration-clock")).toBeNull();
  });

  it("goes back to raw text while the caret is on the clock row", () => {
    const state = stateAt(DOC.length - 1);
    const found = collect(state);
    const raw = found.find((range) => range.spec.class === "weaver-duration-raw");

    expect(clockWidget(found)).toBeUndefined();
    expect(raw?.spec.attributes?.["data-weaver-n"]).toBe("1");
    // The bottom rail's label is the same row, in the file's own characters.
    const label = found.find(
      (range) => range.spec.class === "weaver-frame-label" && range.text.startsWith("10:")
    );
    expect(label?.text).toBe("10:00:00 + 00:01:00");
  });

  it("keeps the marker's own text on the line whatever the caret does", () => {
    const headClass = (state: EditorState): string =>
      collect(state).find((range) => range.spec.class?.startsWith("weaver-entry-head"))?.spec
        .class ?? "";

    // Caret in the prose and caret on the marker row: one class, because nothing
    // swaps the line's text for a drawn label any more.
    expect(headClass(stateAt())).toBe("weaver-entry-head");
    expect(headClass(stateAt(2))).toBe("weaver-entry-head");
  });

  it("ticks a live session instead of showing the stored time", () => {
    const session = new EntrySession();
    session.start(PATH, 1, 65_000, NOW - 1000);

    const widget = clockWidget(collect(stateAt(), session));

    // Writing is always a draft, whatever sigil the file holds.
    expect(widget?.input.sigil).toBe("-");
    expect(widget?.input.active).toBe(true);
    expect(widget?.input.ms).toBe(66_000);
    expect(widget?.input.time).toBe("10:00:00");
    widget?.destroy();
  });

  it("shows the sigil the file kept once nothing is running", () => {
    const settled = ["{ 2.1.1 }", "prose here", "10:00:00 = 00:01:00"].join("\n");
    const widget = clockWidget(collect(stateAt(settled.indexOf("prose"), settled)));

    expect(widget?.input.sigil).toBe("=");
    expect(widget?.input.active).toBe(false);
    widget?.destroy();
  });

  it("draws two coloured colons between three white digit spans", () => {
    const widget = new DurationWidget({
      n: 1,
      time: "10:00:00",
      sigil: "-",
      ms: 66_000,
      active: false,
      color: "#f97316",
      d: 2
    });
    const root = widget.toDOM() as unknown as {
      querySelectorAll: (selector: string) => Array<{ textContent: string }>;
    };

    // Scoped to the clock half: the moment carries the same grammar beside it.
    expect(texts(root, ".weaver-duration-clock .weaver-duration-num")).toEqual([
      "00",
      "01",
      "06"
    ]);
    expect(texts(root, ".weaver-duration-clock .weaver-duration-ink")).toEqual([":", ":"]);
    widget.destroy();
  });

  it("decorates nothing when the note has no entries", () => {
    const state = EditorState.create({
      doc: "just prose",
      extensions: [entryIndexField]
    });
    expect(collect(state)).toEqual([]);
  });
});
