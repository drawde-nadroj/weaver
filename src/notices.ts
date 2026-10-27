/** Every user-facing string Weaver shows, so wording stays consistent. */

/**
 * How long a notice stays up, by what it is telling you: a refusal you must act
 * on, a plain no-op, or a warning that something was only half done.
 */
export const NOTICE_REFUSAL_MS = 6000;
export const NOTICE_NOOP_MS = 3000;
export const NOTICE_PARTIAL_MS = 8000;

/** The sentence every refusal ends with: nothing reached the vault. */
export const NOTICE_NOTHING_WRITTEN = "Nothing was written.";

export const NOTICE_NEEDS_EDITING = `Weaver: this needs an editable note. ${NOTICE_NOTHING_WRITTEN}`;
export const NOTICE_TRAVEL_EDITING_ONLY = `Weaver: travel mode needs an editable note. ${NOTICE_NOTHING_WRITTEN}`;
export const NOTICE_NO_DIMENSIONS = "Weaver: no dimensions in this note.";
export const NOTICE_NO_DRAFTS = "Weaver: no drafts in this note.";
export const NOTICE_NOTE_CHANGED = `Weaver: the note changed while the row was open. Reopen it. ${NOTICE_NOTHING_WRITTEN}`;
export const NOTICE_SCAN_FAILED =
  "Weaver: vault palette scan failed; keeping the last known palette.";
export const NOTICE_TRAVEL_KEYS =
  "Weaver travel — 1-9 level, 0/a all, ←↓↑→ or h/j/k/l move, Tab dimensions/drafts, g/G or Home/End first/last, Enter/Esc/q exit.";
export const NOTICE_DRAFT_EMPTY = `Weaver: type something before weaving this draft. ${NOTICE_NOTHING_WRITTEN}`;
export const NOTICE_DAY_CLOSED = (time: string): string => `Weaver: day closed at ${time}.`;
export const NOTICE_DAY_ALREADY_CLOSED = `Weaver: this day is already closed. ${NOTICE_NOTHING_WRITTEN}`;
export const NOTICE_NO_DAY_NOTE = `Weaver: today's day note could not be found. ${NOTICE_NOTHING_WRITTEN}`;
/** Deliberately not a refusal: the spark was written, only its link was not. */
export const NOTICE_SPARK_NO_SOURCE =
  "Weaver: spark recorded; its source link could not be written.";
export const NOTICE_SHUTTLE_EMPTY = "Weaver: nothing to load.";
export const NOTICE_NO_SOURCE = `Weaver: this spark has no source. ${NOTICE_NOTHING_WRITTEN}`;
export const noticeNoDraftAtCursor = "Weaver: no draft at the cursor.";

export function noticeDraftCopied(id: string): string {
  return `Weaver: copied draft ${id}.`;
}

export function noticeCloseFrontmatter(action: string): string {
  return `Weaver: close the frontmatter before ${action}. ${NOTICE_NOTHING_WRITTEN}`;
}

export function noticeCloseCodeBlock(action: string): string {
  return `Weaver: close the code block before ${action}. ${NOTICE_NOTHING_WRITTEN}`;
}
