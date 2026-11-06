/**
 * Where you have been: a real history, with a cursor, not a stack that eats itself.
 *
 * The old return stack was destructive — walking back popped the place it left,
 * so going back twice and then forward once was impossible. A history with a
 * cursor is the ordinary browser shape, and it is the only one that lets a writer
 * move A → B → C, back to B, forward to C, and back again, without the path
 * dissolving behind them.
 *
 * Two kinds of place are remembered. A `NoteStop` is a position inside one note:
 * the thought it was in, the caret relative to that thought's own prose, and the
 * scroll offset — captured *before* departure, restored only after the note is on
 * screen. A `WorkspaceStop` is a whole screen: the layout and each pane's own
 * state, for a move between destinations rather than between thoughts.
 *
 * The rule that matters most is the commit rule: a stop is recorded, and the
 * cursor moved, only after the navigation it belongs to succeeded. A failed jump
 * changes neither the history nor the screen, so "back" never walks into a place
 * that was never reached.
 *
 * Pure: no editor, no DOM, no vault.
 */

import type { ThoughtRef } from "./capture";

/** A position inside one note. */
export interface NoteStop {
  kind: "note";
  path: string;
  /** The destination the note belongs to, when it is one. */
  contextId: string | null;
  /** The thought the caret was in, or null outside every entry. */
  n: number | null;
  /** The thought's whole recorded shape, so a moved or edited thought is refused. */
  thought: ThoughtRef | null;
  /** Which pane it was: two panes can show one note. */
  leafId: string | null;
  /** Caret offset relative to the thought's prose, or null when outside one. */
  caretInProse: number | null;
  /** The line the caret was on, for a note that is not an entry. */
  lineText: string | null;
  /** The nearest non-empty line above it, which must also match. */
  lineBefore: string | null;
  /** The nearest non-empty line below it, which must also match. */
  lineAfter: string | null;
  /** The first line of content visible, and how far the viewport sat into it. */
  scrollTop: number;
  /** Which view the note was in. */
  mode: "source" | "preview";
}

/** A whole screen: a destination's layout and its panes. */
export interface WorkspaceStop {
  kind: "workspace";
  /** The destination this screen was, when it is one. */
  contextId: string | null;
  /** The layout and per-pane state, cloned by the caller. */
  layout: unknown;
  panes: { path: string; state: unknown; leafId: string | null; mode: "source" | "preview" }[];
  activePath: string | null;
  /** The leaf that held focus, so returning lands in the same pane. */
  activeLeafId: string | null;
}

/** One place in the history. */
export type Stop = NoteStop | WorkspaceStop;

/** A history and where in it the writer is. */
export interface NavigationHistory {
  visits: Stop[];
  /** Index of the current visit; -1 when nothing has been visited. */
  cursor: number;
}

/** How many places are remembered. */
export const HISTORY_LIMIT = 64;

/** The empty history: nothing visited, cursor before the start. */
export function initialHistory(): NavigationHistory {
  return { visits: [], cursor: -1 };
}

/**
 * Records arriving at `stop`.
 *
 * Arriving somewhere new truncates the forward branch — the future that was
 * undone is no longer reachable — and the oldest visit falls off past the limit.
 * Recording the place the cursor already is does not duplicate it, because
 * "back" through two identical stops would look broken.
 */
export function record(history: NavigationHistory, stop: Stop, limit = HISTORY_LIMIT): NavigationHistory {
  const current = history.visits[history.cursor];
  if (current !== undefined && sameStop(current, stop)) return history;

  const kept = history.visits.slice(0, history.cursor + 1);
  const visits = [...kept, stop];
  return {
    visits: visits.length > limit ? visits.slice(visits.length - limit) : visits,
    cursor: Math.min(visits.length, limit) - 1
  };
}

/**
 * The previous visit, and the history with the cursor moved onto it.
 *
 * Nothing is discarded: forward can return to where "back" came from.
 */
export function back(history: NavigationHistory): { history: NavigationHistory; stop: Stop | null } {
  if (history.cursor <= 0) return { history, stop: null };
  const cursor = history.cursor - 1;
  return { history: { ...history, cursor }, stop: history.visits[cursor] ?? null };
}

/** The next visit forward, and the history with the cursor moved onto it. */
export function forward(history: NavigationHistory): { history: NavigationHistory; stop: Stop | null } {
  if (history.cursor < 0 || history.cursor >= history.visits.length - 1) {
    return { history, stop: null };
  }
  const cursor = history.cursor + 1;
  return { history: { ...history, cursor }, stop: history.visits[cursor] ?? null };
}

/** True when a history can go back. */
export function canGoBack(history: NavigationHistory): boolean {
  return history.cursor > 0;
}

/** True when a history can go forward again. */
export function canGoForward(history: NavigationHistory): boolean {
  return history.cursor >= 0 && history.cursor < history.visits.length - 1;
}

/**
 * Two stops are the same place.
 *
 * A note stop is the same when its note, its thought and its caret agree; a
 * workspace stop when it is the same destination. Comparing the layout itself
 * would make every unrelated pane resize look like a new place.
 */
export function sameStop(left: Stop, right: Stop): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "note" && right.kind === "note") {
    return left.path === right.path && left.n === right.n && left.caretInProse === right.caretInProse;
  }
  if (left.kind === "workspace" && right.kind === "workspace") {
    return left.contextId === right.contextId && left.activePath === right.activePath;
  }
  return false;
}
