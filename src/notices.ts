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
export const NOTICE_DAY_CLOSED = (time: string): string => `Weaver: day closed at ${time}.`;
export const NOTICE_DAY_ALREADY_CLOSED = `Weaver: this day is already closed. ${NOTICE_NOTHING_WRITTEN}`;
export const NOTICE_NO_DAY_NOTE = `Weaver: today's day note could not be found. ${NOTICE_NOTHING_WRITTEN}`;

/** The navigator's footer on a desk: the whole key map, where it is pressed. */
export const NAVIGATOR_HINT_KEYS =
  "↑↓ move · ⏎ jump · ⇧⏎ descend · n append · x delete · ⌘[ back · esc close";

/** The navigator's footer on a phone: the same three gestures, as taps. */
export const NAVIGATOR_HINT_TOUCH = "tap to jump · tap the caret row to descend · ✕ twice deletes";

export function noticeCloseFrontmatter(action: string): string {
  return `Weaver: close the frontmatter before ${action}. ${NOTICE_NOTHING_WRITTEN}`;
}

export function noticeCloseCodeBlock(action: string): string {
  return `Weaver: close the code block before ${action}. ${NOTICE_NOTHING_WRITTEN}`;
}
