/**
 * The two keys an entry owns, and the two edit events that keep the stopwatch
 * honest.
 *
 * `Mod-Shift-E` starts an entry from inside any editor as well as from the app.
 * It is not `Mod-Enter`: Obsidian's core "Open link under cursor in new tab"
 * owns that chord, and its scope runs before every plugin keymap.
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

import { findEntryAtOffset, type Entry } from "../core/entries";
import type { EntrySession } from "../entries/session";
import { isPhone } from "../ui/platform";
import { editorPathOf } from "./editor-path";
import { entryIndexField, programmaticWrite } from "./entry-field";
import { registeredEditorViews } from "./view-registry";

/**
 * Every chord an entry claims, for review; `entryKeysExtension` binds each one.
 *
 * `Mod-Shift-E`, not `Mod-Enter`: Obsidian's core "Open link under cursor in new
 * tab" owns `Mod+Enter` and its scope runs in the document's capture phase, so
 * neither a `Prec.highest` editor binding nor a command hotkey ever sees that
 * chord. `Mod+Shift+E` belongs to no other command, so it reaches us.
 */
export const ENTRY_KEYS = ["Mod-Shift-E", "Enter"] as const;

/** What a key handler may ask for: the session and the five entry edits. */
export interface EntryKeyHost {
  session: EntrySession;
  entries: {
    startEntry(now: Date): Promise<void>;
    settle(view: EditorView, entry: Entry): void;
    descend(view: EditorView, entry: Entry): void;
    deleteEntry(view: EditorView, entry: Entry): void;
    pause(now: Date): void;
  };
}

/** The same host plus `afterEdit`, for the listeners that start and pause a clock. */
export interface EntryEditHost extends EntryKeyHost {
  entries: EntryKeyHost["entries"] & {
    afterEdit(view: EditorView, typed: boolean): void;
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
 * Starts an entry at the tip of today's note, from inside the editor too.
 *
 * Always handled: the chord is `Mod-Shift-E`, which no other command claims, so
 * claiming it here cannot take anything away from the writer.
 */
export function handleStartKey(_view: EditorView, host: EntryKeyHost): boolean {
  void host.entries.startEntry(new Date());
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

/** Binds `Mod-Shift-E` and `Enter` at the highest precedence. */
export function entryKeysExtension(host: EntryKeyHost): Extension {
  // Highest, not high: Obsidian's editor keymap is registered at `high`, and a
  // chord it owns there would take precedence over ours inside the editor.
  return Prec.highest(
    keymap.of([
      { key: "Mod-Shift-e", run: (view) => handleStartKey(view, host) },
      { key: "Enter", run: (view) => handleEnterKey(view, host) }
    ])
  );
}

/** Turns edits and interruptions into session starts and pauses. */
export function entryEditExtension(host: EntryEditHost): Extension {
  /**
   * Pausing writes a duration through this same editor, and a dispatch may not
   * happen inside an update listener: every pause is deferred one turn.
   */
  const pauseSoon = (view: EditorView): void => {
    if (host.session.active() === null) return;
    window.setTimeout(() => {
      if (!registeredEditorViews().includes(view)) return;
      host.entries.pause(new Date());
    }, 0);
  };

  return [
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
        if (!ours) pauseSoon(update.view);
        return;
      }

      const programmatic = update.transactions.some(
        (transaction) => transaction.annotation(programmaticWrite) === true
      );
      // The writer's own input, named by CodeMirror: a paste and a typed
      // character both start a clock, a `delete` and the vault reloading the
      // note from disk do not.
      const typed = update.transactions.some((transaction) => {
        const event = transaction.annotation(Transaction.userEvent);
        return event !== undefined && event.startsWith("input.");
      });
      // Deferred: settling the session writes its duration through this same
      // editor, which a dispatch may not do from inside an update listener.
      window.setTimeout(() => {
        if (!registeredEditorViews().includes(view)) return;
        // Weaver's own writes are not the writer typing: starting an entry must
        // not start its clock before the first keystroke.
        if (!programmatic) host.entries.afterEdit(view, typed);
        maybePinStopwatch(view, host);
      }, 0);
    }),
    EditorView.domEventHandlers({
      blur: () => {
        host.entries.pause(new Date());
      },
      // `wheel` and `touchmove`, never `scroll`: a caret-driven `scrollIntoView`
      // is programmatic, while a wheel or a finger is the writer reading instead
      // of writing.
      wheel: () => {
        host.entries.pause(new Date());
      },
      touchmove: () => {
        host.entries.pause(new Date());
      }
    })
  ];
}
