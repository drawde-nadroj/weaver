import { beforeEach, describe, expect, it } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { history, redo, undo } from "@codemirror/commands";
import { editorInfoField, TFile, type MarkdownFileInfo } from "obsidian";

import WeaverPlugin from "../src/main";
import { parseEntries } from "../src/core/entries";
import { dayNotePath } from "../src/core/day";
import { capturedInput, entryIndexField } from "../src/editor/entry-field";
import { inputObservation } from "../src/editor/entry-keys";
import { registerEditorView, unregisterEditorView } from "../src/editor/view-registry";
import { NOTICE_NEEDS_EDITING, NOTICE_NEEDS_ENTRY, NOTICE_STOP_FAILED, noticeLegacyFormat } from "../src/notices";
import { DEFAULT_SETTINGS } from "../src/settings";
import { FakeEditor } from "../test-support/editor";
import {
  addLeafWithView,
  clearNotices,
  createApp,
  createFile,
  createView,
  fileContent,
  instantiatePlugin,
  liveEditor,
  noticeMessages,
  resetHarness
} from "../test-support/harness";

const AT_1337 = new Date(2026, 9, 27, 13, 27, 43);
// The default day-note format is dotted, so the day note is not the day key.
const DAY = "Chronomancer/2026.10.27.md";

async function start(files: TFile[]): Promise<{ plugin: WeaverPlugin; app: ReturnType<typeof createApp> }> {
  const app = createApp(files);
  const plugin = instantiatePlugin(WeaverPlugin, app);
  await plugin.onload();

  // A portal invitation is a real notice, and one is always within its lead
  // window; this suite is about what the entry itself earns, so portals are off.
  plugin.settings.portalsEnabled = false;
  plugin.portals.reconcile();
  clearNotices();

  return { plugin, app };
}

/** The stub vault writes synchronously, so the read is the assertion. */
function reading(app: ReturnType<typeof createApp>, path: string): string {
  const file = app.vault.getAbstractFileByPath(path);
  return file instanceof TFile ? fileContent(file) : "";
}

/** A CodeMirror view double over `doc`: `afterEdit` reads the state, nothing else. */
function viewOf(path: string, doc: string, anchor = 0): EditorView {
  const state = EditorState.create({
    doc,
    selection: { anchor },
    extensions: [
      entryIndexField,
      editorInfoField.init(() => ({ file: createFile(path, "") }) as unknown as MarkdownFileInfo)
    ]
  });
  return { state, dispatch: () => {}, focus: () => {} } as unknown as EditorView;
}

/**
 * A view double carrying CodeMirror's real history extension, so undo and redo
 * run through the machinery an editor uses. `dispatch` accepts both a spec and
 * the transaction a command returns.
 */
function historyView(
  file: TFile,
  doc: string,
  anchor: number
): EditorView & { state: EditorState } {
  const state = EditorState.create({
    doc,
    selection: { anchor },
    extensions: [
      entryIndexField,
      editorInfoField.init(() => ({ file }) as unknown as MarkdownFileInfo),
      history()
    ]
  });

  const view = {
    state,
    dispatch(
      this: { state: EditorState },
      spec: Transaction | Parameters<EditorState["update"]>[0]
    ): void {
      this.state = spec instanceof Transaction ? spec.state : this.state.update(spec).state;
    },
    focus(): void {},
    scrollDOM: { scrollTop: 0 }
  };

  return view as unknown as EditorView & { state: EditorState };
}

/**
 * A stop releases its session after the write settles, so a test that triggered
 * one indirectly waits for the promise chain instead of for a duration.
 */
async function stopLanded(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

beforeEach(() => {
  resetHarness();
  clearNotices();
});

describe("deleting the entry being written", () => {
  it("settles the session, writes nothing, and starts the next entry clean", async () => {
    // The editor's deletion already reached the vault: the note no longer holds
    // the entry the clock was running on.
    const file = createFile(DAY, "");
    const { plugin, app } = await start([file]);

    plugin.session.start(DAY, 1, 65_000, AT_1337.getTime());
    plugin.entries.afterEdit(viewOf(DAY, ""), null);
    await stopLanded();

    expect(plugin.session.active()).toBeNull();
    expect(reading(app, DAY)).toBe("");

    // Nothing was written by the settle, and no session survives the entry it
    // was measuring: the next thought starts clean, in the composer.
    expect(reading(app, DAY)).toBe("");
    expect(plugin.session.active()).toBeNull();

    plugin.onunload();
  });

  it("leaves the file alone when the entry it would settle is gone", async () => {
    const survived = ["{ 1.1.1 }", "first", "+ 00:01:00 09:00:00"].join("\n");
    const file = createFile(DAY, survived);
    const { plugin, app } = await start([file]);

    plugin.session.start(DAY, 2, 65_000, AT_1337.getTime());
    plugin.entries.afterEdit(viewOf(DAY, survived, survived.indexOf("first")), null);
    await stopLanded();

    expect(plugin.session.active()).toBeNull();
    expect(reading(app, DAY)).toBe(survived);

    plugin.onunload();
  });
});

describe("when the clock may start", () => {
  const DRAFT = ["{ 1.1.1 }", "prose", "- 00:01:00 10:00:00"].join("\n");

  it("starts on the writer's own typing, at the file's stored time", async () => {
    const { plugin } = await start([createFile(DAY, DRAFT)]);
    const typedAt = AT_1337.getTime();

    plugin.entries.afterEdit(viewOf(DAY, DRAFT, DRAFT.indexOf("prose")), {
      path: DAY,
      seq: 1,
      at: typedAt
    });

    expect(plugin.session.active()?.seq).toBe(1);
    expect(plugin.session.active()?.baselineMs).toBe(60_000);
    // The baseline is the moment of the keystroke, not when the deferred
    // listener got around to running.
    expect(plugin.session.active()?.resumedAt).toBe(typedAt);

    plugin.onunload();
  });

  it("keeps the input's entry even when the caret has moved on", async () => {
    const two = [DRAFT, "", "{ 2.1.2 }", "other", "- 00:00:00 10:05:00"].join("\n");
    const { plugin } = await start([createFile(DAY, two)]);

    // The input landed in entry 1; the deferred callback runs with the caret
    // already sitting in entry 2.
    plugin.entries.afterEdit(viewOf(DAY, two, two.indexOf("other")), {
      path: DAY,
      seq: 1,
      at: AT_1337.getTime()
    });

    expect(plugin.session.active()?.seq).toBe(1);

    plugin.onunload();
  });

  it("starts nothing on an entry that has no recorded beginning", async () => {
    // The shape left by an undo of the first text: a duration-only row. A
    // deferred observation can still arrive for it, and it must not start.
    const awaiting = ["{ 1.1.1 }", "", "- 00:00:00"].join("\n");
    const { plugin } = await start([createFile(DAY, awaiting)]);
    const view = viewOf(DAY, awaiting, awaiting.indexOf("- 00:00:00") - 1);

    plugin.entries.afterEdit(view, { path: DAY, seq: 1, at: AT_1337.getTime() });

    expect(plugin.session.active()).toBeNull();

    plugin.onunload();
  });

  it("does not start from an observation whose beginning was undone", async () => {
    const awaiting = ["{ 1.1.1 }", "", "- 00:00:00"].join("\n");
    const file = createFile(DAY, awaiting);
    const { plugin } = await start([file]);
    const caret = awaiting.indexOf("- 00:00:00") - 1;
    const view = historyView(file, awaiting, caret);

    expect(plugin.entries.captureInput(view, caret, caret, "a", AT_1337.getTime())).toBe(true);
    expect(undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) })).toBe(true);
    expect(view.state.doc.toString()).toBe(awaiting);

    // The capture's deferred callback arrives after the undo: the entry has no
    // beginning to measure, so it starts nothing.
    plugin.entries.afterEdit(view, { path: DAY, seq: 1, at: AT_1337.getTime() });

    expect(plugin.session.active()).toBeNull();
    expect(view.state.doc.toString()).toBe(awaiting);

    plugin.onunload();
  });

  it("starts nothing when the vault reloads a draft nobody typed into", async () => {
    const { plugin, app } = await start([createFile(DAY, DRAFT)]);

    plugin.entries.afterEdit(viewOf(DAY, DRAFT, DRAFT.indexOf("prose")), null);

    expect(plugin.session.active()).toBeNull();
    // Nothing running means nothing written, however long the window is open.
    await plugin.entries.pause();
    expect(reading(app, DAY)).toBe(DRAFT);

    plugin.onunload();
  });
});

describe("capturing an entry's beginning", () => {
  // A newly started entry: an address, a blank prose line, and a duration-only
  // clock row. This shape is the durable "awaiting first input" state.
  const AWAIT = ["{ 1.1.1 }", "", "- 00:00:00"].join("\n");
  const CARET = AWAIT.indexOf("- 00:00:00") - 1;
  const BEGUN = AT_1337.getTime();

  it("writes the first text and the date/moment in one transaction", async () => {
    const file = createFile(DAY, AWAIT);
    const { plugin, app } = await start([file]);
    const view = liveEditor(file, AWAIT, CARET);

    expect(plugin.entries.captureInput(view, CARET, CARET, "h", BEGUN)).toBe(true);

    expect(view.state.doc.toString()).toBe(
      ["{ 1.1.1 }", "h", "- 00:00:00 2026-10-27 13:27:43"].join("\n")
    );
    // The caret follows the text the writer just typed.
    expect(view.state.selection.main.head).toBe(CARET + 1);
    // Nothing was written through the vault: this is the editor's transaction.
    expect(reading(app, DAY)).toBe(AWAIT);

    plugin.onunload();
  });

  it("captures once: later input in the same entry stays native", async () => {
    const captured = ["{ 1.1.1 }", "h", "- 00:00:00 2026-10-27 13:27:43"].join("\n");
    const file = createFile(DAY, captured);
    const { plugin } = await start([file]);
    const view = liveEditor(file, captured, captured.indexOf("h") + 1);

    const caret = view.state.selection.main.head;
    expect(plugin.entries.captureInput(view, caret, caret, "i", BEGUN)).toBe(false);
    expect(view.state.doc.toString()).toBe(captured);

    plugin.onunload();
  });

  it("leaves prose that already has a moment alone", async () => {
    const written = ["{ 1.1.1 }", "first", "- 00:01:00 2026-10-27 09:00:00"].join("\n");
    const file = createFile(DAY, written);
    const { plugin } = await start([file]);
    const view = liveEditor(file, written, written.indexOf("first"));

    const caret = written.indexOf("first") + 5;
    expect(plugin.entries.captureInput(view, caret, caret, "!", BEGUN)).toBe(false);
    expect(view.state.doc.toString()).toBe(written);

    plugin.onunload();
  });

  it("maps the beginning back through a longer replacement", async () => {
    // A historical awaiting draft: it already has prose, and the first input
    // replaces a selection with text of a different length. The plan's offsets
    // are post-input; the transaction is applied to the pre-input document, so
    // they have to be mapped back across a gap of +14 characters.
    const awaiting = ["{ 1.1.1 }", "first", "- 00:01:00"].join("\n");
    const file = createFile(DAY, awaiting);
    const { plugin } = await start([file]);
    const view = liveEditor(file, awaiting, awaiting.indexOf("first"));
    const from = awaiting.indexOf("first");
    const to = from + "first".length;

    expect(
      plugin.entries.captureInput(view, from, to, "a much longer first", BEGUN)
    ).toBe(true);

    expect(view.state.doc.toString()).toBe(
      ["{ 1.1.1 }", "a much longer first", "- 00:01:00 2026-10-27 13:27:43"].join("\n")
    );
    expect(view.state.selection.main.head).toBe(from + "a much longer first".length);

    plugin.onunload();
  });

  it("never stamps a settled entry", async () => {
    const settled = ["{ 1.1.1 }", "first", "+ 00:01:00 10:00:00"].join("\n");
    const file = createFile(DAY, settled);
    const { plugin } = await start([file]);
    const view = liveEditor(file, settled, settled.indexOf("first"));

    expect(plugin.entries.captureInput(view, 0, 0, "x", BEGUN)).toBe(false);
    expect(view.state.doc.toString()).toBe(settled);

    plugin.onunload();
  });

  it("leaves an input aimed at the clock row native", async () => {
    const file = createFile(DAY, AWAIT);
    const { plugin } = await start([file]);
    const view = liveEditor(file, AWAIT, AWAIT.indexOf("- 00:00:00"));

    // Typing from inside the row would land on the metadata being appended.
    expect(plugin.entries.captureInput(view, CARET + 1, CARET + 1, "x", BEGUN)).toBe(false);
    expect(view.state.doc.toString()).toBe(AWAIT);

    plugin.onunload();
  });

  it("ignores an empty input", async () => {
    const file = createFile(DAY, AWAIT);
    const { plugin } = await start([file]);
    const view = liveEditor(file, AWAIT, CARET);

    expect(plugin.entries.captureInput(view, CARET, CARET, "", BEGUN)).toBe(false);
    expect(view.state.doc.toString()).toBe(AWAIT);

    plugin.onunload();
  });

  it("records the day of the input, not the day the note was made", async () => {
    // Created at 23:59:58, typed just after midnight: the row carries the new
    // day and the moment, and the note stays where it is.
    const file = createFile(DAY, AWAIT);
    const { plugin } = await start([file]);
    const view = liveEditor(file, AWAIT, CARET);
    const afterMidnight = new Date(2026, 9, 28, 0, 0, 3).getTime();

    expect(plugin.entries.captureInput(view, CARET, CARET, "late", afterMidnight)).toBe(true);

    expect(view.state.doc.toString()).toBe(
      ["{ 1.1.1 }", "late", "- 00:00:00 2026-10-28 00:00:03"].join("\n")
    );

    // The clock starts from the same input, at zero, never from the block's
    // creation time.
    plugin.entries.afterEdit(view, { path: DAY, seq: 1, at: afterMidnight });
    expect(plugin.session.active()?.baselineMs).toBe(0);
    expect(plugin.session.active()?.resumedAt).toBe(afterMidnight);

    plugin.onunload();
  });

  it("carries a paste's input type into the merged transaction", async () => {
    const file = createFile(DAY, AWAIT);
    const { plugin } = await start([file]);
    const dispatched: Transaction[] = [];
    const view = {
      state: EditorState.create({
        doc: AWAIT,
        selection: { anchor: CARET },
        extensions: [
          editorInfoField.init(() => ({ file }) as unknown as MarkdownFileInfo)
        ]
      }),
      dispatch(this: { state: EditorState }, spec: Parameters<EditorState["update"]>[0]): void {
        const transaction = this.state.update(spec);
        dispatched.push(transaction);
        this.state = transaction.state;
      },
      focus(): void {},
      scrollDOM: { scrollTop: 0 }
    } as unknown as EditorView;

    expect(plugin.entries.captureInput(view, CARET, CARET, "pasted", BEGUN, "input.paste")).toBe(
      true
    );

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.annotation(Transaction.userEvent)).toBe("input.paste");
    expect(dispatched[0]?.annotation(capturedInput)).toEqual({
      path: DAY,
      seq: 1,
      at: BEGUN
    });
    // The pasted text lands exactly once, next to the recorded beginning.
    expect((view.state.doc.toString().match(/pasted/g) ?? []).length).toBe(1);
    expect(view.state.doc.toString()).toBe(
      ["{ 1.1.1 }", "pasted", "- 00:00:00 2026-10-27 13:27:43"].join("\n")
    );
    expect(view.state.selection.main.head).toBe(CARET + "pasted".length);

    plugin.onunload();
  });

  it("undoes the first text and its beginning together, and a redo does not restart a clock", async () => {
    const file = createFile(DAY, AWAIT);
    const { plugin } = await start([file]);
    const view = historyView(file, AWAIT, CARET);

    expect(plugin.entries.captureInput(view, CARET, CARET, "hello", BEGUN)).toBe(true);
    const captured = view.state.doc.toString();
    expect(captured).toContain("hello");
    expect(captured).toContain("- 00:00:00 2026-10-27 13:27:43");

    // Real CodeMirror history: one undo takes the text and the recorded
    // beginning back together, leaving the awaiting row it started from.
    expect(undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) })).toBe(true);
    expect(view.state.doc.toString()).toBe(AWAIT);

    const redone: Transaction[] = [];
    expect(
      redo({
        state: view.state,
        dispatch: (tr) => {
          redone.push(tr);
          view.dispatch(tr);
        }
      })
    ).toBe(true);

    expect(view.state.doc.toString()).toBe(captured);
    // Redo is not input: it carries no captured observation, so replaying the
    // beginning cannot silently start a session.
    if (redone.length === 0) throw new Error("expected a redo transaction");
    const redoTransaction = redone[0]!;
    expect(redoTransaction.annotation(capturedInput)).toBeUndefined();
    const observation = inputObservation([redoTransaction], {
      path: DAY,
      index: parseEntries(view.state.doc.toString()),
      composing: false,
      now: () => Date.now()
    });
    expect(observation).toBeNull();
    plugin.entries.afterEdit(view, observation);
    expect(plugin.session.active()).toBeNull();

    plugin.onunload();
  });

  it("ends a running session when undo removes the beginning, and redo does not revive it", async () => {
    const file = createFile(DAY, AWAIT);
    const { plugin, app } = await start([file]);
    const view = historyView(file, AWAIT, CARET);

    // The runtime path: the capture's own transaction starts the clock through
    // the observer, with no manual clearing anywhere.
    expect(plugin.entries.captureInput(view, CARET, CARET, "a", BEGUN)).toBe(true);
    plugin.entries.afterEdit(view, { path: DAY, seq: 1, at: BEGUN });
    expect(plugin.session.active()?.seq).toBe(1);
    const captured = view.state.doc.toString();

    // Undo takes the text and the moment together; the entry is awaiting again.
    expect(undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) })).toBe(true);
    plugin.entries.afterEdit(view, null);

    expect(view.state.doc.toString()).toBe(AWAIT);
    // The clock ends without writing: the duration-only row is the evidence,
    // and the vault still holds exactly the awaiting entry.
    expect(plugin.session.active()).toBeNull();
    expect(reading(app, DAY)).toBe(AWAIT);
    expect(noticeMessages()).toEqual([]);

    // Redo restores the beginning, but replaying it is not input: no clock.
    expect(redo({ state: view.state, dispatch: (tr) => view.dispatch(tr) })).toBe(true);
    plugin.entries.afterEdit(view, null);

    expect(view.state.doc.toString()).toBe(captured);
    expect(plugin.session.active()).toBeNull();

    plugin.onunload();
  });
});

describe("a committed composition", () => {
  const AWAIT = ["{ 1.1.1 }", "", "- 00:00:00"].join("\n");
  const CARET = AWAIT.indexOf("- 00:00:00") - 1;

  it("stamps nothing while the composition is still preedit", async () => {
    const file = createFile(DAY, AWAIT);
    const { plugin } = await start([file]);
    const view = historyView(file, AWAIT, CARET);

    // The IME's preedit reaches the document exactly as CodeMirror names it:
    // input, but not text the writer has committed.
    view.dispatch({
      changes: { from: CARET, insert: "に" },
      selection: { anchor: CARET + 1 },
      userEvent: "input.type.compose.start"
    });

    expect(view.state.doc.toString()).toContain("に");
    expect(parseEntries(view.state.doc.toString()).entries[0]?.time).toBeNull();
    expect(parseEntries(view.state.doc.toString()).entries[0]?.day).toBeNull();

    plugin.onunload();
  });

  it("records the beginning in the composition's own undo group", async () => {
    const file = createFile(DAY, AWAIT);
    const { plugin } = await start([file]);
    const view = historyView(file, AWAIT, CARET);
    const committedAt = AT_1337.getTime();

    view.dispatch({
      changes: { from: CARET, insert: "に" },
      selection: { anchor: CARET + 1 },
      userEvent: "input.type.compose.start"
    });

    // The commit adds metadata only: the text is already the writer's.
    expect(
      plugin.entries.captureComposition(view, { path: DAY, seq: 1, at: committedAt })
    ).toBe(true);

    const captured = view.state.doc.toString();
    expect(captured).toBe(
      ["{ 1.1.1 }", "に", "- 00:00:00 2026-10-27 13:27:43"].join("\n")
    );

    // One undo takes the composed text and its recorded beginning back together.
    expect(undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) })).toBe(true);
    expect(view.state.doc.toString()).toBe(AWAIT);

    expect(redo({ state: view.state, dispatch: (tr) => view.dispatch(tr) })).toBe(true);
    expect(view.state.doc.toString()).toBe(captured);

    plugin.onunload();
  });

  it("stamps only the entry the composition committed into", async () => {
    const two = ["{ 1.1.1 }", "", "- 00:00:00", "{ 1.2.1 }", "", "- 00:00:00"].join("\n");
    const file = createFile(DAY, two);
    const { plugin } = await start([file]);
    const view = historyView(file, two, two.indexOf("- 00:00:00") - 1);

    expect(
      plugin.entries.captureComposition(view, { path: DAY, seq: 1, at: AT_1337.getTime() })
    ).toBe(true);

    const text = view.state.doc.toString();
    const lines = text.split("\n");
    expect(lines[2]).toBe("- 00:00:00 2026-10-27 13:27:43");
    expect(lines[5]).toBe("- 00:00:00");
    expect(parseEntries(text).entries.map((entry) => entry.time)).toEqual(["13:27:43", null]);

    plugin.onunload();
  });

  it("keeps a recorded beginning as it is, and resumes the clock from the commit", async () => {
    const captured = ["{ 1.1.1 }", "に", "- 00:00:00 2026-10-27 13:27:43"].join("\n");
    const file = createFile(DAY, captured);
    const { plugin } = await start([file]);
    const view = liveEditor(file, captured, captured.indexOf("に") + 1);
    const committedAt = AT_1337.getTime();

    // No metadata is needed: the entry already recorded its beginning, and the
    // committed text is already in the document. The commit is still real input.
    expect(plugin.entries.captureComposition(view, { path: DAY, seq: 1, at: committedAt })).toBe(
      true
    );
    expect(view.state.doc.toString()).toBe(captured);
    expect(plugin.session.active()?.seq).toBe(1);
    expect(plugin.session.active()?.resumedAt).toBe(committedAt);

    plugin.onunload();
  });

  it("resumes a paused draft from its own second when the commit changed no document", async () => {
    const paused = ["{ 1.1.1 }", "に", "= 00:00:04 2026-10-27 13:27:43"].join("\n");
    const file = createFile(DAY, paused);
    const { plugin } = await start([file]);
    const view = historyView(file, paused, paused.indexOf("に") + 1);
    const committedAt = AT_1337.getTime();

    expect(plugin.session.active()).toBeNull();

    // The composition's text is already the writer's, and `=` says the writer
    // stopped at four seconds. The commit is nonetheless the fresh input that
    // resumes the clock; there is no further document change to observe it by.
    expect(plugin.entries.captureComposition(view, { path: DAY, seq: 1, at: committedAt })).toBe(
      true
    );

    expect(view.state.doc.toString()).toBe(paused);
    expect(plugin.session.active()?.seq).toBe(1);
    expect(plugin.session.active()?.baselineMs).toBe(4000);
    expect(plugin.session.active()?.resumedAt).toBe(committedAt);

    // No metadata was rewritten, so the commit added no undo step of its own.
    expect(undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) })).toBe(false);

    plugin.onunload();
  });

  it("resumes a held stopwatch when the committed composition is the fresh input", async () => {
    const open = ["{ 1.1.1 }", "prose", "- 00:00:00 2026-10-27 13:27:43"].join("\n");
    const file = createFile(DAY, open);
    const { plugin, app } = await start([file]);
    const view = historyView(file, open, open.indexOf("prose") + 3);

    plugin.session.start(DAY, 1, 0, Date.now() - 9400);
    plugin.session.commitDisplay(7000);

    // A stop whose write failed: the row still holds the draft, and the session
    // is held at the second on screen.
    const vault = app.vault as unknown as { process: unknown };
    const real = vault.process;
    vault.process = () => {
      throw new Error("disk full");
    };
    try {
      await plugin.entries.pause();
    } finally {
      vault.process = real;
    }
    expect(plugin.session.frozen()).toBe(true);
    const committedAt = AT_1337.getTime();

    expect(plugin.entries.captureComposition(view, { path: DAY, seq: 1, at: committedAt })).toBe(
      true
    );

    // Resumed from the held second, at the commit's own instant, and nothing was
    // rewritten: the row is still the draft it was.
    expect(view.state.doc.toString()).toBe(open);
    expect(plugin.session.frozen()).toBe(false);
    expect(plugin.session.active()?.baselineMs).toBe(7000);
    expect(plugin.session.active()?.resumedAt).toBe(committedAt);

    // The commit added no history of its own: there is nothing to undo.
    expect(undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) })).toBe(false);

    plugin.onunload();
  });

  it("never starts a clock on a settled entry's committed composition", async () => {
    const settled = ["{ 1.1.1 }", "に", "+ 00:00:09 2026-10-27 13:27:43"].join("\n");
    const file = createFile(DAY, settled);
    const { plugin } = await start([file]);
    const view = liveEditor(file, settled, settled.indexOf("に") + 1);

    expect(
      plugin.entries.captureComposition(view, { path: DAY, seq: 1, at: AT_1337.getTime() })
    ).toBe(false);
    expect(view.state.doc.toString()).toBe(settled);
    expect(plugin.session.active()).toBeNull();

    plugin.onunload();
  });
});

describe("writing a duration", () => {
  it("rewrites the clock row through the vault", async () => {
    const file = createFile(DAY, ["{ 1.1.1 }", "prose", "- 00:01:00 10:00:00"].join("\n"));
    const { plugin, app } = await start([file]);

    await plugin.entries.publish(DAY, 1, "+", 342_000, true);

    expect(reading(app, DAY)).toContain("+ 00:05:42");

    plugin.onunload();
  });

  it("skips the write when the entry it aimed at is gone", async () => {
    const source = ["{ 1.1.1 }", "prose", "- 00:01:00 10:00:00"].join("\n");
    const file = createFile(DAY, source);
    const { plugin, app } = await start([file]);

    await plugin.entries.publish(DAY, 9, "+", 1000, true);

    expect(reading(app, DAY)).toBe(source);

    plugin.onunload();
  });

  it("pauses the live session onto the draft's own line", async () => {
    const file = createFile(DAY, ["{ 1.1.1 }", "prose", "- 00:00:00 10:00:00"].join("\n"));
    const { plugin, app } = await start([file]);

    plugin.session.start(DAY, 1, 4000, AT_1337.getTime());
    await plugin.entries.pause();

    expect(plugin.session.active()).toBeNull();
    expect(reading(app, DAY)).toContain("= 00:00:04");

    plugin.onunload();
  });

  // The writer sees whole seconds; the stop keeps exactly those. A raw clock
  // sample taken at the keystroke could already be almost a second further on,
  // so these fixtures commit the painted second and leave the raw reading past it.
  it("settles with the painted second, not a late raw sample", async () => {
    const open = ["{ 1.1.1 }", "prose", "- 00:00:00 10:00:00"].join("\n");
    const file = createFile(DAY, open);
    const { plugin } = await start([file]);
    const view = liveEditor(file, open, open.indexOf("prose"));

    plugin.session.start(DAY, 1, 0, AT_1337.getTime());
    // 7.9 seconds of raw reading, 7 seconds painted.
    plugin.session.commitDisplay(7900);

    const entry = parseEntries(open).entries[0];
    if (entry === undefined) throw new Error("expected an entry");
    plugin.entries.settle(view, entry);

    expect(view.state.doc.toString()).toContain("+ 00:00:07");
    expect(plugin.session.active()).toBeNull();

    plugin.onunload();
  });

  it("settles at the painted second when a delayed tick left raw elapsed ahead", async () => {
    const open = ["{ 1.1.1 }", "prose", "- 00:00:00 10:00:00"].join("\n");
    const file = createFile(DAY, open);
    const { plugin } = await start([file]);
    const view = liveEditor(file, open, open.indexOf("prose"));

    // The timer missed a turn: raw elapsed is 9.4 seconds while the screen
    // still shows 7.
    plugin.session.start(DAY, 1, 0, Date.now() - 9400);
    plugin.session.commitDisplay(7000);

    const entry = parseEntries(open).entries[0];
    if (entry === undefined) throw new Error("expected an entry");
    plugin.entries.settle(view, entry);

    expect(view.state.doc.toString()).toContain("+ 00:00:07");

    plugin.onunload();
  });

  it("pauses at the painted second, not a fresh sample", async () => {
    const open = ["{ 1.1.1 }", "prose", "- 00:00:00 10:00:00"].join("\n");
    const file = createFile(DAY, open);
    const { plugin, app } = await start([file]);

    plugin.session.start(DAY, 1, 0, Date.now() - 9400);
    plugin.session.commitDisplay(7000);
    await plugin.entries.pause();

    expect(plugin.session.active()).toBeNull();
    expect(reading(app, DAY)).toContain("= 00:00:07");

    plugin.onunload();
  });

  it("holds the stopped snapshot when the write fails", async () => {
    const open = ["{ 1.1.1 }", "prose", "- 00:00:00 10:00:00"].join("\n");
    const file = createFile(DAY, open);
    const { plugin, app } = await start([file]);

    plugin.session.start(DAY, 1, 0, Date.now() - 9400);
    plugin.session.commitDisplay(7000);

    const vault = app.vault as unknown as { process: unknown };
    const real = vault.process;
    vault.process = () => {
      throw new Error("disk full");
    };
    try {
      await plugin.entries.pause();
    } finally {
      vault.process = real;
    }

    // No write landed, so the stop is held, not resumed: the session survives at
    // the painted second, and time passing while it is held changes nothing.
    expect(plugin.session.active()?.seq).toBe(1);
    expect(plugin.session.frozen()).toBe(true);
    expect(plugin.session.displayed()).toBe(7000);
    expect(plugin.session.elapsed(Date.now() + 60_000)).toBe(7000);
    expect(reading(app, DAY)).toBe(open);
    expect(noticeMessages()).toEqual([NOTICE_STOP_FAILED]);

    // A retry writes exactly the held second, however long the failure lasted.
    await plugin.entries.pause();

    expect(reading(app, DAY)).toContain("= 00:00:07");
    expect(plugin.session.active()).toBeNull();

    plugin.onunload();
  });

  it("resumes a held stopwatch from its held second on fresh input", async () => {
    const open = ["{ 1.1.1 }", "prose", "- 00:00:00 10:00:00"].join("\n");
    const file = createFile(DAY, open);
    const { plugin, app } = await start([file]);

    plugin.session.start(DAY, 1, 0, Date.now() - 9400);
    plugin.session.commitDisplay(7000);

    const vault = app.vault as unknown as { process: unknown };
    const real = vault.process;
    vault.process = () => {
      throw new Error("disk full");
    };
    try {
      await plugin.entries.pause();
    } finally {
      vault.process = real;
    }

    plugin.entries.afterEdit(viewOf(DAY, open, open.indexOf("prose")), {
      path: DAY,
      seq: 1,
      at: Date.now()
    });

    expect(plugin.session.frozen()).toBe(false);
    expect(plugin.session.active()?.baselineMs).toBe(7000);
    expect(plugin.session.displayed()).toBe(7000);

    plugin.onunload();
  });

  it("does not let a clock tick advance a held stop", async () => {
    const open = ["{ 1.1.1 }", "prose", "- 00:00:00 10:00:00"].join("\n");
    const file = createFile(DAY, open);
    const { plugin, app } = await start([file]);

    plugin.session.start(DAY, 1, 0, Date.now() - 9400);
    plugin.session.commitDisplay(7000);
    // The caret entered the clock row: hold the second, then let the clock
    // sample as it will — the timer keeps running, but the number cannot move.
    plugin.session.freezeDisplay();
    plugin.clock.refresh();

    expect(plugin.session.displayed()).toBe(7000);

    await plugin.entries.pause();

    expect(reading(app, DAY)).toContain("= 00:00:07");
    expect(plugin.session.active()).toBeNull();

    plugin.onunload();
  });

});

describe("a note in the old format", () => {
  // The old duration line still parses as a clock row, so the parser would
  // happily read this note as an entry — and settle would rewrite one field of
  // it. The flag exists to refuse the note whole.
  const LEGACY = ["{ 1.1.1 } - 10:00:00", "prose", "- 00:01:00"].join("\n");

  it("refuses a settle and says why, leaving every byte alone", () => {
    const file = createFile(DAY, LEGACY);
    return start([file]).then(({ plugin }) => {
      const view = liveEditor(file, LEGACY, LEGACY.indexOf("prose"));
      const entry = parseEntries(LEGACY).entries[0];
      if (entry === undefined) throw new Error("expected an entry");

      plugin.entries.settle(view, entry);

      expect(view.state.doc.toString()).toBe(LEGACY);
      expect(noticeMessages()).toEqual([noticeLegacyFormat("settling this entry")]);
      plugin.onunload();
    });
  });

  it("keeps a running session when the settle is refused", () => {
    const file = createFile(DAY, LEGACY);
    return start([file]).then(({ plugin }) => {
      const view = liveEditor(file, LEGACY, LEGACY.indexOf("prose"));
      const entry = parseEntries(LEGACY).entries[0];
      if (entry === undefined) throw new Error("expected an entry");

      plugin.session.start(DAY, 1, 4000, AT_1337.getTime());
      plugin.entries.settle(view, entry);

      // A refusal wrote nothing, so the stopwatch is still the writer's.
      expect(plugin.session.active()?.seq).toBe(1);
      expect(plugin.session.displayed()).toBe(4000);
      expect(view.state.doc.toString()).toBe(LEGACY);

      plugin.onunload();
    });
  });

  });

describe("moving the caret", () => {
  const TWO = [
    "{ 1.1.1 }",
    "first",
    "+ 00:01:00 10:00:00",
    "",
    "{ 2.1.2 }",
    "second",
    "+ 00:02:00 10:05:00",
    ""
  ].join("\n");

  it("jumps without writing and without starting a clock", async () => {
    // `jumpTo` names the note it moves to, so the fixture path is the path.
    const today = dayNotePath(new Date(), {
      folder: DEFAULT_SETTINGS.dayNoteFolder,
      format: DEFAULT_SETTINGS.dayNoteFormat
    });
    const file = createFile(today, TWO);
    const { plugin, app } = await start([file]);
    // The note is on screen, and the editor holding it is the writer's own.
    addLeafWithView(app, createView(app, file, new FakeEditor(TWO)));
    const view = liveEditor(file, TWO, 0);
    registerEditorView(view);

    try {
      plugin.session.start(today, 1, 60_000, AT_1337.getTime());
      expect(await plugin.entries.jumpTo(today, 2)).toBe(true);

      expect(plugin.session.active()).toBeNull();
      expect(view.state.selection.main.head).toBe(TWO.indexOf("second"));
      expect(reading(app, today)).toBe(TWO);
    } finally {
      unregisterEditorView(view);
      plugin.onunload();
    }
  });

  it("descends without starting a clock, on the parent's branch", () => {
    const source = ["{ 1.1.1 }", "first", "+ 00:01:00 10:00:00"].join("\n");
    const file = createFile(DAY, source);
    return start([file]).then(({ plugin }) => {
      const view = liveEditor(file, source, source.indexOf("first"));
      const parent = parseEntries(source).entries[0];
      if (parent === undefined) throw new Error("expected an entry");

      plugin.entries.descend(view, parent);

      expect(plugin.session.active()).toBeNull();
      expect(view.state.doc.toString()).toContain("{ 1.2.2 }");

      plugin.onunload();
    });
  });
});

describe("the descent command", () => {
  const SETTLED = ["{ 1.1.1 }", "first", "+ 00:01:00 10:00:00"].join("\n");
  const OPEN = ["{ 1.1.1 }", "first", "- 00:00:00 10:00:00"].join("\n");

  it("opens a child under the caret's settled entry, and starts no clock", async () => {
    const file = createFile(DAY, SETTLED);
    const { plugin } = await start([file]);
    const view = liveEditor(file, SETTLED, SETTLED.indexOf("first"));
    registerEditorView(view);

    try {
      plugin.entries.descendAtCaret();

      expect(view.state.doc.toString()).toContain("{ 1.2.2 }");
      expect(plugin.session.active()).toBeNull();
    } finally {
      unregisterEditorView(view);
      plugin.onunload();
    }
  });

  it("settles an open entry first, then opens the child under it", async () => {
    const file = createFile(DAY, OPEN);
    const { plugin } = await start([file]);
    const view = liveEditor(file, OPEN, OPEN.indexOf("first"));
    registerEditorView(view);

    try {
      plugin.entries.descendAtCaret();

      const text = view.state.doc.toString();
      // The parent's own row settled; the child's row is a fresh draft.
      expect(text.split("\n")[2]).toBe("+ 00:00:00 10:00:00");
      expect(text).toContain("{ 1.2.2 }");
      expect(plugin.session.active()).toBeNull();
    } finally {
      unregisterEditorView(view);
      plugin.onunload();
    }
  });

  it("refuses outside every entry, and writes nothing", async () => {
    // The caret sits on the blank line above the note's first address, so no
    // entry's subtree holds it.
    const source = ["", "{ 1.1.1 }", "first", "+ 00:01:00 10:00:00"].join("\n");
    const file = createFile(DAY, source);
    const { plugin } = await start([file]);
    const view = liveEditor(file, source, 0);
    registerEditorView(view);

    try {
      plugin.entries.descendAtCaret();

      expect(view.state.doc.toString()).toBe(source);
      expect(noticeMessages()).toEqual([NOTICE_NEEDS_ENTRY]);
    } finally {
      unregisterEditorView(view);
      plugin.onunload();
    }
  });

  it("refuses with no editor open, and writes nothing", async () => {
    const { plugin, app } = await start([createFile(DAY, SETTLED)]);

    plugin.entries.descendAtCaret();

    expect(reading(app, DAY)).toBe(SETTLED);
    expect(noticeMessages()).toEqual([NOTICE_NEEDS_EDITING]);

    plugin.onunload();
  });
});
