import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { editorInfoField, type MarkdownFileInfo, type TFile } from "obsidian";
import type { EditorView } from "@codemirror/view";

import { entryIndexField } from "../src/editor/entry-field";
import {
  ENTRY_KEYS,
  enterableEntry,
  handleEnterKey,
  handleEscapeKey,
  handleStartKey,
  shouldPinStopwatch,
  type EntryKeyHost
} from "../src/editor/entry-keys";
import { clearTravelTarget } from "../src/editor/travel-target";
import { EntrySession } from "../src/entries/session";
import { createFile } from "../test-support/harness";

const PATH = "Chronomancer/2026-10-27.md";
const DOC = ["{ 1.1.1 } - 10:00:00", "prose here", "- 00:01:00"].join("\n");
const PAUSED = ["{ 1.1.1 } - 10:00:00", "prose here", "= 00:01:00"].join("\n");
const SETTLED = ["{ 1.1.1 } - 10:00:00", "prose here", "+ 00:01:00"].join("\n");
const TWO_LINES = ["{ 1.1.1 } - 10:00:00", "first line", "second line", "- 00:00:00"].join("\n");

/** The field's real type is `MarkdownFileInfo`; this double carries only a file. */
function info(file: TFile): MarkdownFileInfo {
  return { file } as unknown as MarkdownFileInfo;
}

interface Harness {
  view: EditorView;
  settled: number[];
  descended: number[];
  deleted: number[];
  starts: number;
  pauses: number;
  dispatched: unknown[];
  host: EntryKeyHost;
}

function harness(
  anchor: number,
  travelTarget: EntryKeyHost["travelTarget"] = null,
  active = false,
  doc = DOC
): Harness {
  const state = EditorState.create({
    doc,
    selection: { anchor },
    extensions: [entryIndexField, editorInfoField.init(() => info(createFile(PATH, "")))]
  });

  const settled: number[] = [];
  const descended: number[] = [];
  const deleted: number[] = [];
  const dispatched: unknown[] = [];
  const session = new EntrySession();
  if (active) session.start(PATH, 1, 90_000, Date.now());

  let starts = 0;
  let pauses = 0;
  const host: EntryKeyHost = {
    session,
    travelTarget,
    entries: {
      startToday: () => {
        starts += 1;
        return Promise.resolve();
      },
      settle: (_view, entry) => {
        settled.push(entry.n);
      },
      descend: (_view, entry) => {
        descended.push(entry.n);
      },
      deleteEntry: (_view, entry) => {
        deleted.push(entry.n);
      },
      pause: () => {
        pauses += 1;
      }
    }
  };

  // A test double: only `state`, `dispatch` and `focus` are read on this path.
  const view = {
    state,
    dispatch: (spec: unknown) => {
      dispatched.push(spec);
    },
    focus: () => {}
  } as unknown as EditorView;

  return {
    view,
    settled,
    descended,
    deleted,
    dispatched,
    host,
    get starts(): number {
      return starts;
    },
    get pauses(): number {
      return pauses;
    }
  } as Harness;
}

const PROSE = DOC.indexOf("prose");

describe("Enter", () => {
  it("binds Mod-Shift-E, Enter and Escape, and nothing else", () => {
    expect(ENTRY_KEYS).toEqual(["Mod-Shift-E", "Enter", "Escape"]);
  });

  it("settles the open entry the live session is writing", () => {
    const run = harness(PROSE, null, true);

    expect(enterableEntry(run.view, run.host)?.n).toBe(1);
    expect(handleEnterKey(run.view, run.host)).toBe(true);
    expect(run.settled).toEqual([1]);
    expect(run.descended).toEqual([]);
  });

  it("settles an open entry with no session, travel target or caret condition", () => {
    const run = harness(PROSE);

    expect(handleEnterKey(run.view, run.host)).toBe(true);
    expect(run.settled).toEqual([1]);
  });

  it("settles an entry the writer paused at `=`", () => {
    const run = harness(PAUSED.indexOf("prose"), null, false, PAUSED);

    expect(handleEnterKey(run.view, run.host)).toBe(true);
    expect(run.settled).toEqual([1]);
  });

  it("descends from a settled entry, opening a child instead of a newline", () => {
    const run = harness(SETTLED.indexOf("prose"), null, false, SETTLED);

    expect(enterableEntry(run.view, run.host)?.n).toBe(1);
    expect(handleEnterKey(run.view, run.host)).toBe(true);
    expect(run.descended).toEqual([1]);
    expect(run.settled).toEqual([]);
  });

  it("settles from any line of an open entry, on every platform", () => {
    const first = harness(TWO_LINES.indexOf("first"), null, false, TWO_LINES);
    const second = harness(TWO_LINES.indexOf("second"), null, false, TWO_LINES);

    for (const run of [first, second]) {
      expect(handleEnterKey(run.view, run.host)).toBe(true);
      expect(run.settled).toEqual([1]);
    }
  });

  it("is not handled where there is no entry", () => {
    const run = harness(PROSE);

    // Prose that is not an entry.
    const prose = EditorState.create({
      doc: "just prose",
      selection: { anchor: 2 },
      extensions: [entryIndexField, editorInfoField.init(() => info(createFile(PATH, "")))]
    });
    const none = { state: prose, dispatch: () => {}, focus: () => {} } as unknown as EditorView;
    expect(enterableEntry(none, run.host)).toBeNull();
    expect(handleEnterKey(none, run.host)).toBe(false);

    // A view that is not showing a note at all, so there is no path to write to.
    const bare = EditorState.create({
      doc: DOC,
      selection: { anchor: PROSE },
      extensions: [entryIndexField]
    });
    const noPath = { state: bare, dispatch: () => {}, focus: () => {} } as unknown as EditorView;
    expect(enterableEntry(noPath, run.host)).toBeNull();
    expect(handleEnterKey(noPath, run.host)).toBe(false);
    expect(run.settled).toEqual([]);
    expect(run.descended).toEqual([]);
  });
});

describe("Mod-Enter", () => {
  it("starts an entry and claims the chord", () => {
    const run = harness(PROSE);

    expect(handleStartKey(run.view, run.host)).toBe(true);
    expect(run.starts).toBe(1);
  });
});

describe("Escape", () => {
  it("clears an existing target and pauses", () => {
    const run = harness(PROSE, { path: PATH, seq: 1 });

    expect(handleEscapeKey(run.view, run.host)).toBe(true);
    expect(run.pauses).toBe(1);
    expect(run.dispatched.length).toBe(1);

    const spec = run.dispatched[0] as { effects?: unknown };
    const effects = Array.isArray(spec.effects) ? spec.effects : [spec.effects];
    expect(
      effects.some((effect) => (effect as { is: (other: unknown) => boolean }).is(clearTravelTarget))
    ).toBe(true);
  });

  it("is not handled when there is nothing to clear", () => {
    const run = harness(PROSE);

    expect(handleEscapeKey(run.view, run.host)).toBe(false);
    expect(run.dispatched).toEqual([]);
  });
});

describe("shouldPinStopwatch", () => {
  const all = { phone: true, active: true, caretOnLastProseLine: true, hasDuration: true };

  it("pins only when all four hold", () => {
    expect(shouldPinStopwatch(all)).toBe(true);

    expect(shouldPinStopwatch({ ...all, phone: false })).toBe(false);
    expect(shouldPinStopwatch({ ...all, active: false })).toBe(false);
    expect(shouldPinStopwatch({ ...all, caretOnLastProseLine: false })).toBe(false);
    expect(shouldPinStopwatch({ ...all, hasDuration: false })).toBe(false);
  });
});
