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
export const NOTICE_NO_ENTRY = `Weaver: put the cursor in an entry first. ${NOTICE_NOTHING_WRITTEN}`;
export const NOTICE_NO_DRAFTS = "Weaver: no drafts to travel to.";
export const NOTICE_DAY_CLOSED = (time: string): string => `Weaver: day closed at ${time}.`;
export const NOTICE_DAY_ALREADY_CLOSED = `Weaver: this day is already closed. ${NOTICE_NOTHING_WRITTEN}`;
export const NOTICE_NO_DAY_NOTE = `Weaver: today's day note could not be found. ${NOTICE_NOTHING_WRITTEN}`;

/** The modal's footer: the whole key map, where the keys are being pressed. */
export const TRAVEL_HINT =
  "←→ day · ↑↓ draft · 1 / 1.2 / .14 then ↵ to lock · ↵ travel · esc close";

/** The palette's footer, in the same voice and order. */
export const PALETTE_HINT = "↑↓ select · 1 / .14 then ↵ to lock · ↵ settle and descend · n new · x delete · esc caret";

export function noticeCloseFrontmatter(action: string): string {
  return `Weaver: close the frontmatter before ${action}. ${NOTICE_NOTHING_WRITTEN}`;
}

export function noticeCloseCodeBlock(action: string): string {
  return `Weaver: close the code block before ${action}. ${NOTICE_NOTHING_WRITTEN}`;
}
