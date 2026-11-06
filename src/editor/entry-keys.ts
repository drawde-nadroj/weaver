/**
 * The two keys an entry owns, and the two edit events that keep the stopwatch
 * honest.
 *
 * `Mod-Shift-Enter` opens the composer from inside any editor as well as from
 * the app: writing a thought no longer starts an entry in a note, so the chord
 * belongs to the surface that holds the draft. It replaces the old
 * `Mod-Shift-E`, which started an entry at the note's tip and revealed it.
 *
 * `Enter` is two-way and stateless: on an open entry — `-` being written or `=`
 * paused — it settles the duration to `+` and stops the clock; on a settled
 * entry it opens a child one dimension deeper under it. `Shift-Enter` is the
 * newline, on a desk; `Enter` settles everywhere, so a phone's soft keyboard has
 * no newline gesture and an entry's prose is one paragraph there.
 *
 * On a phone the clock row is pinned to the bottom of the writing band after
 * every keystroke, so the stopwatch stays visible above the soft keyboard
 * without the writer ever scrolling to find it.
 */

import { Prec, Transaction, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

import {
  entryBySeq,
  findEntryAtOffset,
  parseEntries,
  type Entry,
  type EntryIndex
} from "../core/entries";
import type { EntrySession } from "../entries/session";
import { isPhone } from "../ui/platform";
import { editorPathOf } from "./editor-path";
import {
  capturedInput,
  entryIndexField,
  programmaticWrite,
  type InputObservation
} from "./entry-field";
import { registeredEditorViews } from "./view-registry";

/**
 * Every chord an entry claims, for review; `entryKeysExtension` binds each one.
 *
 * `Mod-Shift-Enter`, not `Mod-Enter`: Obsidian's core "Open link under cursor in
 * new tab" owns `Mod+Enter` and its scope runs in the document's capture phase,
 * so neither a `Prec.highest` editor binding nor a command hotkey ever sees that
 * chord. The shifted chord belongs to no core command.
 */
export const ENTRY_KEYS = ["Mod-Shift-Enter", "Enter"] as const;

/** What a key handler may ask for: the session, the edits, and the composer. */
export interface EntryKeyHost {
  session: EntrySession;
  /** Opens the one composer: from a note, from a view, or from nowhere. */
  openComposer(options?: { contextId?: string; invitationId?: string }): void;
  entries: {
    settle(view: EditorView, entry: Entry): void;
    descend(view: EditorView, entry: Entry): void;
    deleteEntry(view: EditorView, entry: Entry): void;
    pause(): Promise<void>;
  };
}

/**
 * The same host plus the two edit hooks: `captureInput` decides whether this
 * input is the first text of an awaiting entry and, when it is, writes the text
 * and the entry's beginning in one transaction; `captureComposition` finishes
 * that beginning after an IME commits, or resumes an entry that already has
 * one; `afterEdit` starts and pauses the clock from the input the editor
 * observed, not from a later caret.
 */
export interface EntryEditHost extends EntryKeyHost {
  entries: EntryKeyHost["entries"] & {
    afterEdit(view: EditorView, input: InputObservation | null): void;
    captureInput(
      view: EditorView,
      from: number,
      to: number,
      text: string,
      beganAt: number,
      userEvent?: string
    ): boolean;
    captureComposition(view: EditorView, input: InputObservation): boolean;
  };
}

/**
 * The entry the caret is in.
 *
 * One rule on every platform: the caret is inside an entry and the view can
 * write to it. What `Enter` then does depends on the entry's own state, not on
 * where the caret sits inside it — `Enter` settles an open entry and descends
 * from a settled one, and `Shift-Enter` remains the newline.
 */
export function enterableEntry(view: EditorView, _host: EntryKeyHost): Entry | null {
  const path = editorPathOf(view);
  const index = view.state.field(entryIndexField, false);
  if (path === null || index === undefined) return null;
  return findEntryAtOffset(index, view.state.selection.main.head);
}

/** `true` when the key was handled, which stops Obsidian's own binding. */
export function handleEnterKey(view: EditorView, host: EntryKeyHost): boolean {
  const entry = enterableEntry(view, host);
  if (entry === null) return false;

  if (entry.state === "draft") host.entries.settle(view, entry);
  else host.entries.descend(view, entry);
  return true;
}

/**
 * Opens the composer, from inside the editor too.
 *
 * Always handled: the chord is `Mod-Shift-Enter`, which no other command claims,
 * so claiming it here cannot take anything away from the writer. Opening it does
 * not write a byte, and the note the caret is in is untouched.
 */
export function handleStartKey(_view: EditorView, host: EntryKeyHost): boolean {
  host.openComposer();
  return true;
}

/**
 * All four must hold: a phone, the live session, the caret on the entry's last
 * prose line, and a clock row to pin. Each one alone is not enough, which is
 * what keeps the view still while reading the middle of a long entry.
 */
export function shouldPinStopwatch(input: {
  phone: boolean;
  active: boolean;
  caretOnLastProseLine: boolean;
  hasClockRow: boolean;
}): boolean {
  return input.phone && input.active && input.caretOnLastProseLine && input.hasClockRow;
}

/** Pins the stopwatch under the caret on a phone; returns true when it did. */
export function maybePinStopwatch(view: EditorView, host: EntryEditHost, phone = isPhone()): boolean {
  if (!phone) return false;

  const path = editorPathOf(view);
  const index = view.state.field(entryIndexField, false);
  if (path === null || index === undefined) return false;

  const head = view.state.selection.main.head;
  const entry = findEntryAtOffset(index, head);
  if (entry === null) return false;

  const lastProseLine = entry.proseLines[entry.proseLines.length - 1];
  const caretLine = view.state.doc.lineAt(head).number - 1;

  const pin = shouldPinStopwatch({
    phone,
    active: host.session.activeFor(path, entry.n),
    caretOnLastProseLine: lastProseLine !== undefined && lastProseLine === caretLine,
    hasClockRow: entry.clockLine !== null
  });
  if (!pin) return false;

  const seq = entry.n;
  const clockTo = entry.clockTo;
  requestAnimationFrame(() => {
    if (!view.dom.isConnected) return;
    if (!host.session.activeFor(path, seq)) return;
    view.dispatch({ effects: EditorView.scrollIntoView(clockTo, { y: "end" }) });
  });

  return true;
}

/** Binds `Mod-Shift-Enter` and `Enter` at the highest precedence. */
export function entryKeysExtension(host: EntryKeyHost): Extension {
  // Highest, not high: Obsidian's editor keymap is registered at `high`, and a
  // chord it owns there would take precedence over ours inside the editor.
  return Prec.highest(
    keymap.of([
      { key: "Mod-Shift-Enter", run: (view) => handleStartKey(view, host) },
      { key: "Enter", run: (view) => handleEnterKey(view, host) }
    ])
  );
}

/**
 * What the writer's input was, read from the transactions themselves.
 *
 * A capture transaction carries its own observation, so the clock starts from
 * the same path, entry and timestamp the beginning was written from. Any other
 * input is observed at the transaction's own selection — never the caret as it
 * is when the deferred listener finally runs — with the moment of the input.
 *
 * `null` means this edit was not the writer's text: a `delete`, selection
 * repair, undo, redo, the vault reloading the note, or a preedit composition
 * change. None of those may start a clock or be mistaken for a first keystroke.
 */
export function inputObservation(
  transactions: readonly Transaction[],
  context: {
    path: string | null;
    index: EntryIndex;
    composing: boolean;
    now: () => number;
  }
): InputObservation | null {
  for (const transaction of transactions) {
    const captured = transaction.annotation(capturedInput);
    if (captured !== undefined) return captured;

    const path = context.path;
    if (context.composing || path === null) continue;
    const event = transaction.annotation(Transaction.userEvent);
    if (event === undefined || !event.startsWith("input.")) continue;

    const entry = findEntryAtOffset(context.index, transaction.newSelection.main.head);
    return entry === null ? null : { path, seq: entry.n, at: context.now() };
  }
  return null;
}

/**
 * The composition commit, as a pair of DOM handlers.
 *
 * An IME composition's text reaches the document natively — CodeMirror applies
 * the preedit, and the commit often arrives with no further document change at
 * all — so the beginning cannot come from the text input handler alone. These
 * handlers observe the composition's end and finish the beginning afterwards:
 * metadata only (the text is already the writer's), timestamped at the commit,
 * named `input.type.compose` so history joins it into the composition's own undo
 * group. A cancelled composition leaves the document as it was, which is why the
 * committed text has to still be there before anything is stamped.
 *
 * Everything the commit is about is captured when the composition *starts*: the
 * note, the replaced range, and the entry that range belongs to. A deferred
 * callback then cannot be retargeted by a caret that moved in the meantime —
 * the committed text must sit exactly where the composition was, in that same
 * entry, or nothing is stamped. Identical prose elsewhere in the note is not
 * evidence that this composition committed it.
 *
 * Exported so a test can drive it without a browser's IME.
 */
export function compositionCommit(host: Pick<EntryEditHost, "entries">): {
  compositionstart(event: CompositionEvent, view: EditorView): boolean;
  compositionend(event: CompositionEvent, view: EditorView): boolean;
} {
  /** What each live composition began from, keyed by the view it started in. */
  interface ComposedFrom {
    path: string;
    /** The document before the preedit, to tell a commit from a cancellation. */
    before: string;
    /** The range the preedit — and then the committed text — replaces. */
    from: number;
    /** The entry that range belongs to, pinned when the composition starts. */
    seq: number | null;
  }
  const composedFrom = new WeakMap<EditorView, ComposedFrom>();

  return {
    compositionstart(_event, view) {
      const path = editorPathOf(view);
      if (path === null) {
        composedFrom.delete(view);
        return false;
      }

      const doc = view.state.doc.toString();
      const index = view.state.field(entryIndexField, false) ?? parseEntries(doc);
      const range = view.state.selection.main;
      composedFrom.set(view, {
        path,
        before: doc,
        from: range.from,
        seq: findEntryAtOffset(index, range.from)?.n ?? null
      });
      return false;
    },
    compositionend(event, view) {
      const start = composedFrom.get(view);
      composedFrom.delete(view);
      const committedAt = Date.now();
      const committed = event.data;
      if (start === undefined || committed === "") return false;

      window.setTimeout(() => {
        if (!registeredEditorViews().includes(view)) return;
        // The same view still showing the same note: a replaced view, or one
        // repurposed to another file, is not where this composition happened.
        if (editorPathOf(view) !== start.path) return;
        // A cancelled composition leaves the document exactly as it was before
        // the preedit started, even when the entry already had prose of its own.
        const after = view.state.doc.toString();
        if (after === start.before) return;

        // The committed text must be *there* — at the range the composition
        // began from — not merely somewhere in the document. The committed text
        // replaced the preedit, which replaced that range.
        const insertedTo = start.from + committed.length;
        if (view.state.doc.sliceString(start.from, insertedTo) !== committed) return;

        const index = view.state.field(entryIndexField, false) ?? parseEntries(after);
        const entry = start.seq === null ? null : entryBySeq(index, start.seq);
        if (entry === null) return;
        // Outside the entry's prose — the clock row, a whisper row — is not its
        // first text, and the plan would append metadata under it.
        if (start.from < entry.proseFrom || insertedTo > entry.proseTo) return;

        host.entries.captureComposition(view, { path: start.path, seq: entry.n, at: committedAt });
      }, 0);
      return false;
    }
  };
}

/**
 * True when this update replaced the document without the writer typing: an
 * undo, a redo, or a write that carries no input event of its own (a reload, a
 * rewrite from another surface). A deletion and an in-progress composition are
 * the writer's own editing, and are not replacements.
 */
export function replacedDocument(transactions: readonly Transaction[]): boolean {
  return transactions.some((transaction) => {
    if (transaction.changes.empty) return false;
    const event = transaction.annotation(Transaction.userEvent);
    return (
      event === undefined ||
      event === "undo" ||
      event === "redo" ||
      event.startsWith("undo.") ||
      event.startsWith("redo.")
    );
  });
}

/**
 * What one document update observed, and the generation of the document it was
 * observed in.
 */
export interface PendingInput {
  observation: InputObservation | null;
  generation: number;
}

/**
 * The input observations waiting to be acted on after the update finishes.
 *
 * A deferred callback runs after the document may have moved on — an undo, a
 * redo, a reload, another view's write. Those are document replacements without
 * input, so they end the generation: a captured observation still in flight
 * cannot start a clock on the text that replaced its own. A later input starts
 * a new generation with its own timestamp, so typing that follows an undo is
 * still honored.
 */
export class InputLedger {
  private generation = 0;

  /**
   * Files what this update observed.
   *
   * `replaced` is the update's own fact: the document was replaced without the
   * writer typing — an undo, a redo, or a write from outside the editor. That
   * ends the generation, so a callback scheduled before it cannot act on the
   * replacement. A deletion or an in-progress composition is still the writer's
   * own editing and leaves pending observations valid.
   */
  record(observation: InputObservation | null, replaced: boolean): PendingInput {
    if (replaced) this.generation += 1;
    return { observation, generation: this.generation };
  }

  /** The observation this callback may act on, or `null` if the document moved on. */
  resolve(pending: PendingInput): InputObservation | null {
    return pending.generation === this.generation ? pending.observation : null;
  }
}

/** Turns edits and interruptions into session starts and pauses. */
export function entryEditExtension(host: EntryEditHost): Extension {
  /**
   * Pausing writes a duration through this same editor, and a dispatch may not
   * happen inside an update listener. One microtask is enough: the write lands
   * before the browser paints the raw clock row the caret just exposed, so the
   * source the writer sees already carries the stopped second. The caller holds
   * the painted second first, so nothing can advance while this waits.
   */
  const pauseSoon = (view: EditorView): void => {
    if (host.session.active() === null) return;
    queueMicrotask(() => {
      if (!registeredEditorViews().includes(view)) return;
      void host.entries.pause();
    });
  };

  /**
   * The pending input observations for this editor. A document replacement
   * without input — an undo, a redo, a reload — ends the generation, so a
   * callback scheduled before it cannot start a clock on the replacement.
   */
  const ledger = new InputLedger();

  return [
    /**
     * The first text of an awaiting entry is the one input the engine has to
     * write itself: the entry's beginning goes into the clock row in the same
     * transaction as the text, so the pair is one undo and one redo.
     *
     * Returning `false` leaves everything else — ordinary typing, Vim normal
     * mode (no text at all), a caret that is not in an awaiting entry — to
     * CodeMirror. Preedit is not captured either: composing text is not the
     * writer's text yet, and the committed change arrives as input of its own
     * with the composition's name on it, which is carried through unchanged.
     */
    EditorView.inputHandler.of((view, from, to, text, insert) => {
      if (text === "" || view.composing) return false;
      // The default transaction already knows which kind of input this is; the
      // merged transaction names itself the same way so history groups it as
      // the paste or composition it was.
      const userEvent = insert().annotation(Transaction.userEvent) ?? "input.type";
      return host.entries.captureInput(view, from, to, text, Date.now(), userEvent);
    }),
    EditorView.updateListener.of((update) => {
      const view = update.view;

      // A caret move that is not a document change is the writer leaving the
      // entry — an arrow key, a click, a tap. Weaver's own writes are not, and
      // neither is a dispatch that carries only effects: a refresh rebuilds the
      // decorations without the caret having moved anywhere.
      if (!update.docChanged) {
        if (update.selectionSet !== true) return;

        const ours = update.transactions.some(
          (transaction) => transaction.annotation(programmaticWrite) === true
        );
        if (!ours) {
          // A caret that moves into the clock row exposes it as source text. Hold
          // the second that is on screen now: the write that follows must carry
          // those digits, not one sampled after the row is revealed.
          const caret = update.state.selection.main.head;
          const index =
            update.state.field(entryIndexField, false) ?? parseEntries(update.state.doc.toString());
          const at = findEntryAtOffset(index, caret);
          const onClockRow =
            at !== null && at.clockLine !== null && caret >= at.clockFrom && caret <= at.clockTo;
          if (onClockRow) host.session.freezeDisplay();
          pauseSoon(update.view);
        }
        return;
      }

      const programmatic = update.transactions.some(
        (transaction) => transaction.annotation(programmaticWrite) === true
      );

      // The identity and the time are read now, from the transaction's own
      // selection and this instant: a caret that moves before the clock starts
      // cannot retarget the keystroke, and a timed-out listener cannot make it
      // late. A document replacement without input ends the generation, so an
      // earlier callback cannot restart a clock on the text that replaced its
      // own; fresh typing afterwards records a new generation and its own time.
      const pending = ledger.record(
        inputObservation(update.transactions, {
          path: editorPathOf(view),
          index:
            update.state.field(entryIndexField, false) ?? parseEntries(update.state.doc.toString()),
          composing: view.composing,
          now: () => Date.now()
        }),
        replacedDocument(update.transactions)
      );
      // Deferred: settling the session writes its duration through this same
      // editor, which a dispatch may not do from inside an update listener.
      window.setTimeout(() => {
        if (!registeredEditorViews().includes(view)) return;
        // Weaver's own writes are not the writer typing: starting an entry must
        // not start its clock before the first keystroke.
        if (!programmatic) host.entries.afterEdit(view, ledger.resolve(pending));
        maybePinStopwatch(view, host);
      }, 0);
    }),
    EditorView.domEventHandlers({
      ...compositionCommit(host),
      blur: () => {
        void host.entries.pause();
      },
      // `wheel` and `touchmove`, never `scroll`: a caret-driven `scrollIntoView`
      // is programmatic, while a wheel or a finger is the writer reading instead
      // of writing.
      wheel: () => {
        void host.entries.pause();
      },
      touchmove: () => {
        void host.entries.pause();
      }
    })
  ];
}
