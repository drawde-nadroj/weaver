import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { editorLivePreviewField } from "obsidian";
import type { Decoration } from "@codemirror/view";

import { dayKey } from "../src/core/day";
import { entryDecorationSet } from "../src/editor/entry-decorations";
import { entryIndexField } from "../src/editor/entry-field";
import { DurationWidget } from "../src/editor/stopwatch-widget";
import { EntryClock } from "../src/entries/clock";
import { EntrySession } from "../src/entries/session";


const DOC = ["{ 1.2.1 }", "prose here", "+ 00:01:00 10:00:00"].join("\n");
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
  path = PATH,
  openDayLink?: (target: string, sourcePath: string) => void,
  at = NOW
): Found[] {
  // One shared clock, sampled at a fixed instant: the decoration reads the last
  // painted snapshot, so a test never advances a real stopwatch to see digits.
  const clock = new EntryClock(session, () => at);
  const set = entryDecorationSet(state, session, path, clock, [], openDayLink, dayKey(new Date(at)));
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
function stateAt(anchor = DOC.indexOf("prose"), doc = DOC, live = true): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor },
    extensions: [entryIndexField, editorLivePreviewField.init(() => live)]
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

/** The one non-block widget: the day link. */
function dayLinkWidget(found: Found[]): Found | undefined {
  return found.find(
    (range) => range.spec.widget !== undefined && !(range.spec.widget instanceof DurationWidget)
  );
}

/** Every day link, in document order, for a note holding several entries. */
function dayLinkWidgets(found: Found[]): Found[] {
  return found.filter(
    (range) => range.spec.widget !== undefined && !(range.spec.widget instanceof DurationWidget)
  );
}

describe("the entry decorations", () => {
  it("carries the depth and the colour on every line of the entry", () => {
    const found = collect(stateAt());
    const head = found.find((range) => range.spec.class?.startsWith("weaver-entry-head"));
    const prose = found.find((range) => range.spec.class === "weaver-entry-prose");

    expect(head?.spec.attributes?.style).toBe("--weaver-dcolor:#f97316;--weaver-d:2");
    expect(prose?.spec.attributes?.style).toBe("--weaver-dcolor:#f97316;--weaver-d:2");
  });

  it("keeps the address's digits white and its punctuation coloured", () => {
    const found = collect(stateAt());
    const digits = found.filter((range) => range.spec.class === "weaver-dcn-num");
    const ink = found.filter((range) => range.spec.class === "weaver-dcn-ink");

    expect(digits.map((range) => range.text)).toEqual(["1", "2", "1"]);
    // The braces and the dots are punctuation: the whole address is the top
    // rail's label, so no character of it belongs to the box instead.
    expect(ink.map((range) => range.text).join("|")).toBe("{ |.|.| }");
  });

  it("marks a whisper row without giving it the dimension's colour", () => {
    const doc = ["{ 1.2.1 }", "~ a pricing decision", "prose here", "+ 00:01:00 10:00:00"].join("\n");
    const whisper = collect(stateAt(doc.indexOf("prose"), doc)).find(
      (range) => range.spec.class === "weaver-entry-whisper"
    );

    // No `--weaver-dcolor` and no `data-weaver-n`: the stylesheet's colour rule is
    // the whole provenance, and the frame finds the address row only.
    expect(whisper?.from).toBe(doc.indexOf("~ a pricing decision"));
    expect(whisper?.spec.attributes).toBeUndefined();
  });

  it("labels the address row as the top rail's label", () => {
    const label = collect(stateAt()).find((range) => range.spec.class === "weaver-frame-label");

    // One mark over the file's own address: the rail is cut behind these
    // characters, and no character is added, moved or hidden.
    expect(label?.text).toBe("{ 1.2.1 }");
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
      (range) => range.spec.class === "weaver-frame-label" && range.text.startsWith("+ ")
    );
    expect(label?.text).toBe("+ 00:01:00 10:00:00");
  });

  it("keeps the address's own text on the line whatever the caret does", () => {
    const headClass = (state: EditorState): string =>
      collect(state).find((range) => range.spec.class?.startsWith("weaver-entry-head"))?.spec
        .class ?? "";

    // Caret in the prose and caret on the address row: one class, because nothing
    // swaps the line's text for a drawn label any more.
    expect(headClass(stateAt())).toBe("weaver-entry-head");
    expect(headClass(stateAt(2))).toBe("weaver-entry-head");
  });

  it("stamps only the Thread and branch starts whose gap belongs above them", () => {
    const doc = [
      "{ 1.1.1 }", "root", "+ 00:01:00 10:00:00",
      "{ 1.2.2 }", "first branch", "+ 00:01:00 10:01:00",
      "{ 1.2.3 }", "second branch", "+ 00:01:00 10:02:00",
      "{ 1.1.4 }", "second Thread", "+ 00:01:00 10:03:00"
    ].join("\n");
    const heads = collect(stateAt(doc.indexOf("root"), doc)).filter(
      (range) => range.spec.class?.startsWith("weaver-entry-head") === true
    );

    expect(heads.map((range) => range.spec.class)).toEqual([
      "weaver-entry-head",
      "weaver-entry-head",
      "weaver-entry-head weaver-branch-start",
      "weaver-entry-head weaver-thread-start"
    ]);
  });

  it("ticks a live session instead of showing the stored time", () => {
    const session = new EntrySession();
    session.start(PATH, 1, 65_000, NOW - 1000);

    const widget = clockWidget(collect(stateAt(), session));

    // Writing is always a draft, whatever sigil the file holds, and the left
    // corner is the session's last painted second — not a sample taken here.
    expect(widget?.input.durationMode).toBe("session");
    expect(widget?.input.sigil).toBe("-");
    expect(widget?.input.ms).toBe(65_000);
    expect(widget?.input.time).toBe("10:00:00");
    widget?.destroy();
  });

  it("never rounds the live row above the second it painted", () => {
    const session = new EntrySession();
    session.start(PATH, 1, 0, NOW);
    session.commitDisplay(7_000);

    // 7.9 seconds of wall clock have passed, but the writer has only seen 7.
    const widget = clockWidget(collect(stateAt(), session));

    expect(widget?.input.ms).toBe(7_000);
    widget?.destroy();
  });

  it("draws a draft that has not been written into yet as a live wall clock", () => {
    const doc = ["{ 1.1.1 }", "prose here", "- 00:00:00"].join("\n");
    const found = collect(stateAt(doc.indexOf("prose"), doc));
    const widget = clockWidget(found);
    const root = widget?.toDOM();

    // The row holds a duration and nothing else: no recorded moment to paint and
    // no day to link, because the first input is what records both.
    expect(widget?.input.momentMode).toBe("wall");
    expect(widget?.input.time).toBeNull();
    expect(widget?.input.sigil).toBe("-");
    expect(widget?.input.ms).toBe(0);
    expect(root?.querySelector(".weaver-duration-moment")?.textContent).not.toBe("");
    expect(dayLinkWidget(found)).toBeUndefined();
    widget?.destroy();
  });

  it("keeps the time a draft held before its first input, beside the wall clock", () => {
    // Paused before any moment was captured: the row still awaits its beginning,
    // but the duration it already accumulated is real and must not read zero.
    const doc = ["{ 1.1.1 }", "prose here", "= 00:04:12"].join("\n");
    const widget = clockWidget(collect(stateAt(doc.indexOf("prose"), doc)));

    expect(widget?.input.momentMode).toBe("wall");
    expect(widget?.input.sigil).toBe("=");
    expect(widget?.input.ms).toBe(252_000);
    expect(widget?.input.time).toBeNull();
    widget?.destroy();
  });

  it("shows the sigil the file kept once nothing is running", () => {
    const settled = ["{ 1.2.1 }", "prose here", "= 00:01:00 10:00:00"].join("\n");
    const widget = clockWidget(collect(stateAt(settled.indexOf("prose"), settled)));

    expect(widget?.input.sigil).toBe("=");
    expect(widget?.input.durationMode).toBe("fixed");
    widget?.destroy();
  });

  it("draws two coloured colons between three white digit spans", () => {
    const widget = new DurationWidget({
      n: 1,
      time: "10:00:00",
      sigil: "-",
      ms: 66_000,
      durationMode: "fixed",
      momentMode: "fixed",
      path: PATH,
      clock: new EntryClock(new EntrySession(), () => NOW),
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

  it("labels a different-day entry with its recorded creation day", () => {
    const doc = DOC.replace("10:00:00", "2026-11-05 10:00:00");
    const link = dayLinkWidget(collect(stateAt(doc.indexOf("prose"), doc)));
    const dom = link?.spec.widget?.toDOM?.() as
      | (ShimNode & { click: () => void })
      | undefined;

    // Non-block, at the end of the address row: the widget is the corner label,
    // not a second line.
    expect(link?.spec.block).toBeUndefined();
    expect(link?.from).toBe(DOC.indexOf("\n"));
    expect(dom?.textContent).toBe("[[2026-11-05]]");
  });

  it("opens the daily note from the day link", () => {
    const opened: [string, string][] = [];
    const doc = DOC.replace("10:00:00", "2026-11-05 10:00:00");
    const link = dayLinkWidget(
      collect(stateAt(doc.indexOf("prose"), doc), new EntrySession(), PATH, (target, source) => {
        opened.push([target, source]);
      })
    );
    const dom = link?.spec.widget?.toDOM?.() as { click: () => void } | undefined;

    dom?.click();
    expect(opened).toEqual([["2026-11-05", PATH]]);
  });

  it("keeps different-day links present regardless of caret position", () => {
    const doc = `${DOC}\n\n{ 2.1.2 }\nsecond prose\n+ 00:00:02 2026-11-05 11:00:00\n\noutside`;
    for (const anchor of [0, doc.indexOf("second prose"), doc.length]) {
      const links = dayLinkWidgets(collect(stateAt(anchor, doc)));
      expect(links.map((link) => link.spec.widget?.toDOM?.().textContent)).toEqual([
        "[[2026-11-05]]"
      ]);
    }
  });

  it.each(["2026.10.26", "2026-10-26"])("omits same-day and historical dates in %s", (name) => {
    for (const doc of [DOC, DOC.replace("10:00:00", "2026-10-26 10:00:00")]) {
      expect(dayLinkWidget(collect(
        stateAt(doc.indexOf("prose"), doc), new EntrySession(), `Chronomancer/${name}.md`
      ))).toBeUndefined();
    }
  });

  it.each([
    ["2026.11.02", "2026.11.05"],
    ["2026-11-02", "2026-11-05"]
  ])("uses the day written into the clock row in %s, not the filename", (name, expected) => {
    // A row written on 5 November inside a note named for 2 November keeps its
    // own day, in the note's own dotted or dashed style.
    const doc = ["{ 1.2.1 }", "prose here", "+ 00:01:00 2026-11-05 10:00:00"].join("\n");
    const link = dayLinkWidget(
      collect(stateAt(doc.indexOf("prose"), doc), new EntrySession(), `Chronomancer/${name}.md`)
    );

    expect(link?.spec.widget?.toDOM?.().textContent).toBe(`[[${expected}]]`);
  });

  it("keeps a historical undated row on the note's day beside a newly dated one", () => {
    const doc = [
      "{ 1.2.1 }",
      "old prose",
      "+ 00:01:00 10:00:00",
      "",
      "{ 1.2.2 }",
      "new prose",
      "+ 00:02:00 2026-11-05 10:00:00"
    ].join("\n");
    const links = dayLinkWidgets(
      collect(stateAt(doc.indexOf("old prose"), doc), new EntrySession(), "Chronomancer/2026.11.02.md")
    );

    expect(links.map((link) => link.spec.widget?.toDOM?.().textContent)).toEqual([
      "[[2026.11.05]]"
    ]);
  });

  it("never draws the date twice into the clock widget", () => {
    const doc = ["{ 1.2.1 }", "prose here", "+ 00:01:00 2026-11-05 10:00:00"].join("\n");
    const found = collect(stateAt(doc.indexOf("prose"), doc));
    const widget = clockWidget(found);
    const root = widget?.toDOM();

    // The date labels the top-right corner only; the bottom row stays time.
    expect(widget?.input.time).toBe("10:00:00");
    expect(root?.textContent).not.toContain("2026-11-05");
    widget?.destroy();
  });

  it("keeps a different-day link stable across midnight", () => {
    const doc = DOC.replace("10:00:00", "2026-11-05 10:00:00");
    for (const now of [NOW, NOW + 86_400_000 * 10]) {
      const link = dayLinkWidget(collect(
        stateAt(doc.indexOf("prose"), doc), new EntrySession(), PATH, undefined, now
      ));
      expect(link?.spec.widget?.toDOM?.().textContent).toBe("[[2026-11-05]]");
    }
  });

  it("shows a past recorded day as a static label in an ordinary note", () => {
    const doc = ["{ 1.2.1 }", "prose here", "+ 00:01:00 2026-11-05 10:00:00"].join("\n");
    const label = dayLinkWidget(collect(
      stateAt(doc.indexOf("prose"), doc),
      new EntrySession(),
      "Chronomancer/notes.md"
    ));

    const dom = label?.spec.widget?.toDOM?.();
    expect(dom?.className).toBe("weaver-entry-daylabel weaver-frame-label");
    expect(dom?.textContent).toBe("2026-11-05");
  });

  it("omits an ordinary note's entry date when it is today", () => {
    const doc = ["{ 1.2.1 }", "prose here", "+ 00:01:00 2026-11-05 10:00:00"].join("\n");
    const today = new Date(2026, 10, 5, 12, 0, 0).getTime();

    expect(dayLinkWidget(collect(
      stateAt(doc.indexOf("prose"), doc),
      new EntrySession(),
      "Chronomancer/notes.md",
      undefined,
      today
    ))).toBeUndefined();
  });

  it("keeps a different-day link on a legacy inline-prose entry", () => {
    const doc = ["{ 1.1.1 } a title", "prose", "+ 00:01:00 2026-11-05 10:00:00"].join("\n");
    const found = collect(stateAt(doc.indexOf("prose"), doc));

    expect(dayLinkWidget(found)?.spec.widget?.toDOM?.().textContent).toBe("[[2026-11-05]]");
  });

  it("decorates nothing when the note has no entries", () => {
    const state = EditorState.create({
      doc: "just prose",
      extensions: [entryIndexField]
    });
    expect(collect(state)).toEqual([]);
  });
});
