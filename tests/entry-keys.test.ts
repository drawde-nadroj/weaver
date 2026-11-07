import { describe, expect, it, vi } from "vitest";
import { EditorState, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField, type MarkdownFileInfo, type TFile } from "obsidian";

import { parseEntries } from "../src/core/entries";
import { capturedInput, entryIndexField } from "../src/editor/entry-field";
import {
  ENTRY_KEYS,
  InputLedger,
  compositionCommit,
  enterableEntry,
  entryEditExtension,
  handleEnterKey,
  handleStartKey,
  inputObservation,
  replacedDocument,
  shouldPinStopwatch,
  type EntryEditHost,
  type EntryKeyHost
} from "../src/editor/entry-keys";
import { registerEditorView, unregisterEditorView } from "../src/editor/view-registry";
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
  opened: number;
  pauses: number;
  host: EntryKeyHost;
}

function harness(anchor: number, active = false, doc = DOC): Harness {
  const state = EditorState.create({
    doc,
    selection: { anchor },
    extensions: [entryIndexField, editorInfoField.init(() => info(createFile(PATH, "")))]
  });

  const settled: number[] = [];
  const descended: number[] = [];
  const deleted: number[] = [];
  const session = new EntrySession();
  if (active) session.start(PATH, 1, 90_000, Date.now());

  let starts = 0;
  let pauses = 0;
  const host: EntryKeyHost = {
    session,
    openLoom: () => {
      starts += 1;
    },
    entries: {
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
        return Promise.resolve({ kind: "idle" as const });
      }
    }
  };

  // A test double: only `state`, `dispatch` and `focus` are read on this path.
  const view = { state, dispatch: () => {}, focus: () => {} } as unknown as EditorView;

  return {
    view,
    settled,
    descended,
    deleted,
    host,
    get opened(): number {
      return starts;
    },
    get pauses(): number {
      return pauses;
    }
  } as Harness;
}

const PROSE = DOC.indexOf("prose");

describe("Enter", () => {
  it("binds Mod-Shift-Enter and Enter, and nothing else", () => {
    expect(ENTRY_KEYS).toEqual(["Mod-Shift-Enter", "Enter"]);
  });

  it("settles the open entry the live session is writing", () => {
    const run = harness(PROSE, true);

    expect(enterableEntry(run.view, run.host)?.n).toBe(1);
    expect(handleEnterKey(run.view, run.host)).toBe(true);
    expect(run.settled).toEqual([1]);
    expect(run.descended).toEqual([]);
  });

  it("settles an open entry with no session and no caret condition", () => {
    const run = harness(PROSE);

    expect(handleEnterKey(run.view, run.host)).toBe(true);
    expect(run.settled).toEqual([1]);
  });

  it("settles an entry the writer paused at `=`", () => {
    const run = harness(PAUSED.indexOf("prose"), false, PAUSED);

    expect(handleEnterKey(run.view, run.host)).toBe(true);
    expect(run.settled).toEqual([1]);
  });

  it("descends from a settled entry, opening a child instead of a newline", () => {
    const run = harness(SETTLED.indexOf("prose"), false, SETTLED);

    expect(enterableEntry(run.view, run.host)?.n).toBe(1);
    expect(handleEnterKey(run.view, run.host)).toBe(true);
    expect(run.descended).toEqual([1]);
    expect(run.settled).toEqual([]);
  });

  it("settles from any line of an open entry, on every platform", () => {
    const first = harness(TWO_LINES.indexOf("first"), false, TWO_LINES);
    const second = harness(TWO_LINES.indexOf("second"), false, TWO_LINES);

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

describe("Mod-Shift-Enter", () => {
  it("opens the composer and claims the chord", () => {
    const run = harness(PROSE);

    expect(handleStartKey(run.view, run.host)).toBe(true);
    expect(run.opened).toBe(1);
  });
});

describe("shouldPinStopwatch", () => {
  const all = { phone: true, active: true, caretOnLastProseLine: true, hasClockRow: true };

  it("pins only when all four hold", () => {
    expect(shouldPinStopwatch(all)).toBe(true);

    expect(shouldPinStopwatch({ ...all, phone: false })).toBe(false);
    expect(shouldPinStopwatch({ ...all, active: false })).toBe(false);
    expect(shouldPinStopwatch({ ...all, caretOnLastProseLine: false })).toBe(false);
    expect(shouldPinStopwatch({ ...all, hasClockRow: false })).toBe(false);
  });
});

/**
 * The input handler and the observation it produces. The engine is a double:
 * these tests are about what the editor extension asks for, not about what the
 * engine writes.
 */
const AWAIT = ["{ 1.1.1 }", "", "- 00:00:00"].join("\n");
const AWAIT_CARET = AWAIT.indexOf("- 00:00:00") - 1;

interface CaptureCall {
  from: number;
  to: number;
  text: string;
  beganAt: number;
  userEvent: string | undefined;
}

interface EditHarness {
  handler: (
    view: EditorView,
    from: number,
    to: number,
    text: string,
    insert: () => Transaction
  ) => boolean;
  calls: CaptureCall[];
  view: EditorView;
}

function editHarness(
  options: { doc?: string; anchor?: number; composing?: boolean; accepted?: boolean } = {}
): EditHarness {
  const doc = options.doc ?? AWAIT;
  const anchor = options.anchor ?? AWAIT_CARET;
  const calls: CaptureCall[] = [];
  const verdict = options.accepted !== false;

  const host = {
    session: new EntrySession(),
    openLoom: () => undefined,
    entries: {
      settle: () => undefined,
      descend: () => undefined,
      deleteEntry: () => undefined,
      pause: () => Promise.resolve(),
      afterEdit: () => undefined,
      captureInput: (
        _view: EditorView,
        from: number,
        to: number,
        text: string,
        beganAt: number,
        userEvent?: string
      ) => {
        calls.push({ from, to, text, beganAt, userEvent });
        return verdict && text !== "";
      },
      captureComposition: () => verdict
    }
  } as unknown as EntryEditHost;

  const state = EditorState.create({
    doc,
    selection: { anchor },
    extensions: [
      entryIndexField,
      editorInfoField.init(() => info(createFile(PATH, ""))),
      entryEditExtension(host)
    ]
  });

  const view = {
    state,
    dispatch: () => undefined,
    focus: () => undefined,
    composing: options.composing === true
  } as unknown as EditorView;

  return { handler: state.facet(EditorView.inputHandler)[0]!, calls, view };
}

describe("the first-input handler", () => {
  const insertNothing = (): Transaction => {
    throw new Error("the default transaction must not be built for a refused input");
  };

  const insertText = (state: EditorState, text: string, from = AWAIT_CARET): (() => Transaction) => {
    return () => state.update({ changes: { from, insert: text }, userEvent: "input.type" });
  };

  it("leaves an empty input — a Vim normal-mode command — to the editor", () => {
    const run = editHarness();

    expect(run.handler(run.view, AWAIT_CARET, AWAIT_CARET, "", insertNothing)).toBe(false);
    expect(run.calls).toEqual([]);
  });

  it("leaves preedit composition text native", () => {
    const run = editHarness({ composing: true });

    expect(run.handler(run.view, AWAIT_CARET, AWAIT_CARET, "に", insertNothing)).toBe(false);
    expect(run.calls).toEqual([]);
  });

  it("delegates a committed character, with the input's own timestamp", () => {
    const run = editHarness();
    const before = Date.now();

    expect(
      run.handler(run.view, AWAIT_CARET, AWAIT_CARET, "h", insertText(run.view.state, "h"))
    ).toBe(true);

    expect(run.calls).toHaveLength(1);
    const call = run.calls[0]!;
    expect(call.from).toBe(AWAIT_CARET);
    expect(call.text).toBe("h");
    expect(call.userEvent).toBe("input.type");
    expect(call.beganAt).toBeGreaterThanOrEqual(before);
  });

  it("carries a paste's event name through unchanged", () => {
    const run = editHarness();

    run.handler(run.view, AWAIT_CARET, AWAIT_CARET, "pasted", () =>
      run.view.state.update({
        changes: { from: AWAIT_CARET, insert: "pasted" },
        userEvent: "input.paste"
      })
    );

    expect(run.calls[0]?.userEvent).toBe("input.paste");
  });

  it("takes the engine's refusal, so the editor keeps the input", () => {
    const run = editHarness({ accepted: false });

    // Not an awaiting entry: the engine refuses, and returning `false` lets
    // CodeMirror write the text itself.
    expect(run.handler(run.view, 0, 0, "x", insertText(run.view.state, "x", 0))).toBe(false);
    expect(run.calls).toHaveLength(1);
  });
});

describe("input observation", () => {
  const index = parseEntries(DOC);

  function transaction(at: number, userEvent?: string) {
    const state = EditorState.create({ doc: DOC, selection: { anchor: at } });
    return state.update({
      changes: { from: at, insert: "x" },
      selection: { anchor: at + 1 },
      userEvent
    });
  }

  it("records the transaction's own entry and its own instant", () => {
    const observed = inputObservation([transaction(PROSE, "input.type")], {
      path: PATH,
      index,
      composing: false,
      now: () => 1234
    });

    expect(observed).toEqual({ path: PATH, seq: 1, at: 1234 });
  });

  it("prefers the observation a capture transaction carries", () => {
    const captured = { path: PATH, seq: 1, at: 99 };
    const state = EditorState.create({ doc: DOC, selection: { anchor: PROSE } });
    const transaction = state.update({
      changes: { from: PROSE, insert: "x" },
      annotations: capturedInput.of(captured)
    });

    expect(
      inputObservation([transaction], { path: PATH, index, composing: true, now: () => 0 })
    ).toEqual(captured);
  });

  it("is null for an undo, a redo, a delete, a selection, or a reload", () => {
    for (const event of ["undo", "redo", "delete", "select.pointer", undefined]) {
      const observed = inputObservation([transaction(PROSE, event)], {
        path: PATH,
        index,
        composing: false,
        now: () => 1234
      });
      expect(observed).toBeNull();
    }
  });

  it("is null for preedit composition changes", () => {
    expect(
      inputObservation([transaction(PROSE, "input.type.compose")], {
        path: PATH,
        index,
        composing: true,
        now: () => 1234
      })
    ).toBeNull();
  });

  it("is null when the editor is not showing a note", () => {
    expect(
      inputObservation([transaction(PROSE, "input.type")], {
        path: null,
        index,
        composing: false,
        now: () => 1234
      })
    ).toBeNull();
  });
});

/**
 * The composition commit. CodeMirror applies a composition's text natively and
 * often ends it with no further document change, so the extension has to finish
 * the beginning itself — after the committed text has landed, and only when the
 * text survived the end of the composition.
 */
describe("a composition commit", () => {
  interface ComposeRun {
    view: EditorView;
    start: () => void;
    end: (data: string) => void;
    calls: Array<{ path: string; seq: number; at: number }>;
  }

  function composeRun(doc = AWAIT, anchor = AWAIT_CARET): ComposeRun {
    const calls: Array<{ path: string; seq: number; at: number }> = [];
    const entries = {
      captureComposition: (_view: EditorView, input: { path: string; seq: number; at: number }) => {
        calls.push(input);
        return true;
      }
    };
    const handlers = compositionCommit({
      entries: entries as unknown as EntryEditHost["entries"]
    });

    const view = {
      state: EditorState.create({
        doc,
        selection: { anchor },
        extensions: [
          entryIndexField,
          editorInfoField.init(() => info(createFile(PATH, "")))
        ]
      }),
      dispatch(this: { state: EditorState }, spec: Parameters<EditorState["update"]>[0]): void {
        this.state = this.state.update(spec).state;
      },
      focus: () => undefined,
      composing: false,
      scrollDOM: { scrollTop: 0 }
    } as unknown as EditorView & { state: EditorState };

    return {
      view,
      calls,
      start: () => {
        handlers.compositionstart({ data: "" } as CompositionEvent, view);
      },
      end: (data: string) => {
        handlers.compositionend({ data } as CompositionEvent, view);
      }
    };
  }

  it("records the beginning after the committed text has landed", () => {
    vi.useFakeTimers();
    const run = composeRun();
    registerEditorView(run.view);

    try {
      run.start();
      // Preedit: native text, nothing stamped, nothing captured.
      run.view.dispatch({
        changes: { from: AWAIT_CARET, insert: "に" },
        selection: { anchor: AWAIT_CARET + 1 },
        userEvent: "input.type.compose.start"
      });
      expect(run.calls).toEqual([]);

      run.end("に");
      // Nothing happens until CodeMirror has had its chance to flush.
      expect(run.calls).toEqual([]);
      vi.runAllTimers();

      expect(run.calls).toHaveLength(1);
      expect(run.calls[0]?.path).toBe(PATH);
      expect(run.calls[0]?.seq).toBe(1);
      expect(typeof run.calls[0]?.at).toBe("number");
    } finally {
      unregisterEditorView(run.view);
      vi.useRealTimers();
    }
  });

  it("stamps the entry the composition began in, not the one the caret moved to", () => {
    vi.useFakeTimers();
    const doc = ["{ 1.1.1 }", "", "- 00:00:00", "{ 1.2.1 }", "", "- 00:00:00"].join("\n");
    const run = composeRun(doc, doc.indexOf("- 00:00:00") - 1);
    registerEditorView(run.view);

    try {
      run.start();
      run.view.dispatch({
        changes: { from: AWAIT_CARET, insert: "に" },
        selection: { anchor: AWAIT_CARET + 1 },
        userEvent: "input.type.compose.start"
      });

      // The writer clicks into the second entry before the commit is observed.
      // The caret is not evidence of where the composition happened.
      const secondClock = run.view.state.doc.toString().lastIndexOf("- 00:00:00");
      run.view.dispatch({ selection: { anchor: secondClock + 3 } });

      run.end("に");
      vi.runAllTimers();

      expect(run.calls).toHaveLength(1);
      expect(run.calls[0]?.seq).toBe(1);
    } finally {
      unregisterEditorView(run.view);
      vi.useRealTimers();
    }
  });

  it("does not stamp text that is only elsewhere in the note", () => {
    vi.useFakeTimers();
    const doc = ["{ 1.1.1 }", "", "- 00:00:00", "{ 1.2.1 }", "", "- 00:00:00"].join("\n");
    const run = composeRun(doc, doc.indexOf("- 00:00:00") - 1);
    registerEditorView(run.view);

    try {
      run.start();
      // The preedit was cancelled at the composition's own range, while an
      // identical character landed in the other entry. The document contains
      // the committed text, but not where this composition was.
      const secondProse = doc.lastIndexOf("- 00:00:00") - 1;
      run.view.dispatch({
        changes: { from: secondProse, insert: "に" },
        selection: { anchor: secondProse + 1 },
        userEvent: "input.type"
      });

      run.end("に");
      vi.runAllTimers();

      expect(run.view.state.doc.toString()).toContain("に");
      expect(run.calls).toEqual([]);
    } finally {
      unregisterEditorView(run.view);
      vi.useRealTimers();
    }
  });

  it("treats a cancelled composition as no input, even with prose already there", () => {
    vi.useFakeTimers();
    // An awaiting draft that already carries prose: a cancelled composition
    // must not stamp a beginning just because there is text in the entry.
    const doc = ["{ 1.1.1 }", "existing prose", "- 00:00:00"].join("\n");
    const run = composeRun(doc, doc.indexOf("existing prose") + 3);
    registerEditorView(run.view);

    try {
      run.start();
      // The browser removes the preedit: the document is exactly as it was.
      run.end("に");
      vi.runAllTimers();

      expect(run.calls).toEqual([]);
    } finally {
      unregisterEditorView(run.view);
      vi.useRealTimers();
    }
  });

  it("ignores a composition that committed no text", () => {
    vi.useFakeTimers();
    const run = composeRun();
    registerEditorView(run.view);

    try {
      run.start();
      run.end("");
      vi.runAllTimers();

      expect(run.calls).toEqual([]);
    } finally {
      unregisterEditorView(run.view);
      vi.useRealTimers();
    }
  });
});

/**
 * Deferred observations and the document they belong to. An undo, a redo, or a
 * reload replaces the document without input; a callback still waiting from
 * before may not act on the replacement.
 */
describe("pending input invalidation", () => {
  const input = { path: PATH, seq: 1, at: 1234 };

  it("drops a pending observation when the document is replaced without input", () => {
    const ledger = new InputLedger();
    const pending = ledger.record(input, false);

    // Before the replacement the observation is exactly what was typed.
    expect(ledger.resolve(pending)).toEqual(input);

    // An undo, a redo or a reload: no input, and the old callback is stale.
    ledger.record(null, true);
    expect(ledger.resolve(pending)).toBeNull();
  });

  it("keeps pending input across the writer's own deletion or preedit", () => {
    const ledger = new InputLedger();
    const pending = ledger.record(input, false);

    // A deletion and an in-progress composition are edits, not replacements.
    ledger.record(null, false);
    ledger.record(null, false);

    expect(ledger.resolve(pending)).toEqual(input);
  });

  it("keeps typing that follows an undo, with its own timestamp", () => {
    const ledger = new InputLedger();
    ledger.record(null, true); // the undo

    const later = { path: PATH, seq: 2, at: 4321 };
    const pending = ledger.record(later, false);

    expect(ledger.resolve(pending)).toEqual(later);
  });

  it("does not invalidate across plain successive typing", () => {
    const ledger = new InputLedger();
    const first = ledger.record(input, false);
    const second = ledger.record({ path: PATH, seq: 1, at: 1240 }, false);

    expect(ledger.resolve(first)).toEqual(input);
    expect(ledger.resolve(second)).toEqual({ path: PATH, seq: 1, at: 1240 });
  });

  it("classifies undo, redo and external writes as replacements — not input or delete", () => {
    const state = EditorState.create({ doc: DOC });
    const transaction = (userEvent?: string) =>
      state.update({ changes: { from: 0, insert: "x" }, userEvent });

    expect(replacedDocument([transaction("undo")])).toBe(true);
    expect(replacedDocument([transaction("redo")])).toBe(true);
    // A write from outside the editor, or the vault reloading the note.
    expect(replacedDocument([transaction()])).toBe(true);

    expect(replacedDocument([transaction("input.type")])).toBe(false);
    expect(replacedDocument([transaction("input.paste")])).toBe(false);
    expect(replacedDocument([transaction("input.type.compose")])).toBe(false);
    expect(replacedDocument([transaction("delete")])).toBe(false);
  });
});
