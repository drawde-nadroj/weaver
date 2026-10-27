/**
 * The inline insert model: what the control row holds, and what it commits.
 *
 * The row is one job — weaving rows — so the model is one row shape: a level and
 * a title. Nothing is written until the commit, and the commit is a single
 * transaction, so one undo reverts the whole block.
 */

import { planComposerInsert, type DraftRow } from "./composer";
import type { HeadingIndex } from "./headings";
import type { InsertOptions, InsertPlan } from "./insert";

export interface InsertRowState {
  id: string;
  level: number;
  title: string;
}

export interface InsertState {
  /** Document offset the widget is anchored to. */
  at: number;
  /** The active row's level, mirrored here so the key handler needs no lookup. */
  level: number;
  focus: "row" | "level";
  activeRow: string;
  rows: InsertRowState[];
}

export interface BeginInsertInput {
  at: number;
  level: number;
  maxDepth: number;
}

function clampLevel(level: number, maxDepth: number): number {
  return Math.min(Math.max(Math.round(level), 1), Math.max(1, maxDepth));
}

function rowId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject !== undefined && typeof cryptoObject.randomUUID === "function") {
    return cryptoObject.randomUUID();
  }
  return `insert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function emptyRow(level: number): InsertRowState {
  return { id: rowId(), level, title: "" };
}

export function beginInsert(input: BeginInsertInput): InsertState {
  const level = clampLevel(input.level, input.maxDepth);
  const first = emptyRow(level);

  return {
    at: Math.max(0, input.at),
    level,
    focus: "row",
    activeRow: first.id,
    rows: [first]
  };
}

/** The row the controls act on. */
export function activeRowOf(state: InsertState): InsertRowState {
  return state.rows.find((row) => row.id === state.activeRow) ?? state.rows[0] ?? emptyRow(state.level);
}

/** Steps the active row's level, clamped to the configured depth. */
export function setLevel(state: InsertState, delta: number, maxDepth: number): InsertState {
  const active = activeRowOf(state);
  const level = clampLevel(active.level + delta, maxDepth);
  if (level === active.level) return state;

  return {
    ...state,
    level,
    rows: state.rows.map((row) => (row.id === active.id ? { ...row, level } : row))
  };
}

export function setTitle(state: InsertState, rowIdValue: string, value: string): InsertState {
  return {
    ...state,
    rows: state.rows.map((row) => (row.id === rowIdValue ? { ...row, title: value } : row))
  };
}

export function focusField(
  state: InsertState,
  focus: "row" | "level",
  rowIdValue?: string
): InsertState {
  return {
    ...state,
    focus,
    activeRow: rowIdValue ?? state.activeRow
  };
}

/** Adds a row after the active one, at the same level, and focuses it. */
export function addRow(state: InsertState, maxDepth: number): InsertState {
  const active = activeRowOf(state);
  const row = emptyRow(clampLevel(active.level, maxDepth));
  const position = state.rows.findIndex((candidate) => candidate.id === active.id) + 1;

  return {
    ...state,
    focus: "row",
    activeRow: row.id,
    rows: [...state.rows.slice(0, position), row, ...state.rows.slice(position)]
  };
}

/** True when no row would write anything. */
export function everyRowEmpty(state: InsertState): boolean {
  return state.rows.every((row) => row.title.trim() === "");
}

/**
 * The single transaction the row commits, or null when every row is empty.
 * Weave commits every non-empty row at once, so two rows cost one undo.
 */
export function commitPlan(
  state: InsertState,
  source: string,
  index: HeadingIndex,
  cursorLine: number,
  now: Date,
  options: InsertOptions
): InsertPlan | null {
  const rows: DraftRow[] = state.rows.map((row) => ({
    id: row.id,
    level: row.level,
    title: row.title,
    body: "",
    time: null,
    pinned: false
  }));

  return planComposerInsert(source, index, cursorLine, rows, now, options);
}
