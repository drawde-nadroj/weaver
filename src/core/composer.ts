import { formatClock, type TimestampFormat } from "./clock";
import type { HeadingIndex } from "./headings";
import { resolveInsertSite, type InsertOptions, type InsertPlan } from "./insert";

export interface DraftRow {
  id: string;
  level: number;
  title: string;
  body: string;
  /** Resolved clock text while pinned; null means "follow the live clock". */
  time: string | null;
  pinned: boolean;
}

export function makeId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject !== undefined && typeof cryptoObject.randomUUID === "function") {
    return cryptoObject.randomUUID();
  }
  return `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createDraftRow(level: number): DraftRow {
  return { id: makeId(), level, title: "", body: "", time: null, pinned: false };
}

export function rowIsEmpty(row: DraftRow): boolean {
  return row.title.trim() === "" && row.body.trim() === "";
}

/** Copies rows, stamping a fresh time into every row that is not pinned. */
export function resolveRowTimes(
  rows: readonly DraftRow[],
  now: Date,
  format: TimestampFormat
): DraftRow[] {
  const stamp = formatClock(now, format);
  return rows.map((row) => (row.pinned ? { ...row } : { ...row, time: stamp }));
}

/**
 * Renders the exact Markdown block the composer will insert. Rows must already
 * have resolved times; empty rows are skipped and rows are separated by one
 * blank line.
 */
export function renderComposerBlock(rows: readonly DraftRow[], options: InsertOptions): string {
  const blocks: string[] = [];

  for (const row of rows) {
    if (rowIsEmpty(row)) continue;

    const level = Math.min(Math.max(1, Math.round(row.level)), options.maxDepth);
    const title = row.title.trim();
    const body = row.body.replace(/\s+$/, "");
    const lines = [`${"#".repeat(level)} ${row.time ?? ""}${title.length > 0 ? options.separator + title : " "}`];
    if (body !== "") lines.push(body);
    blocks.push(lines.join("\n"));
  }

  return blocks.join("\n\n");
}

/** Plans a single transaction that inserts every non-empty composer row. */
export function planComposerInsert(
  source: string,
  index: HeadingIndex,
  cursorLine: number,
  rows: readonly DraftRow[],
  now: Date,
  options: InsertOptions
): InsertPlan | null {
  const resolved = resolveRowTimes(rows, now, options.format).filter((row) => !rowIsEmpty(row));
  if (resolved.length === 0) return null;

  const site = resolveInsertSite(source, index, cursorLine);
  if (site === null) return null;

  const inserted = site.prefix + renderComposerBlock(resolved, options);

  return {
    changes: [{ from: site.from, to: site.to, text: inserted }],
    selection: { from: site.from + inserted.length, to: site.from + inserted.length }
  };
}
