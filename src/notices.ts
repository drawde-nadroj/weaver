/** Every user-facing string Weaver shows, so wording stays consistent. */

import type { WhisperFailure } from "./model/whisper-model";

/**
 * How long a notice stays up, by what it is telling you: a refusal you must act
 * on, a plain no-op, or a warning that something was only half done.
 */
export const NOTICE_REFUSAL_MS = 6000;
/** How long a plain confirmation stays up. */
export const NOTICE_NOOP_MS = 3000;
/** How long a warning that something was only half done stays up. */
export const NOTICE_PARTIAL_MS = 8000;

/** The sentence every refusal ends with: nothing reached the vault. */
export const NOTICE_NOTHING_WRITTEN = "Nothing was written.";

/** The refusal for a command that needs an editable note and has none. */
export const NOTICE_NEEDS_EDITING = `Weaver: this needs an editable note. ${NOTICE_NOTHING_WRITTEN}`;
/** The refusal when a command needs the caret inside an entry and it is not. */
export const NOTICE_NEEDS_ENTRY = `Weaver: put the caret in an entry. ${NOTICE_NOTHING_WRITTEN}`;
/** The confirmation a close earns. */
export const NOTICE_DAY_CLOSED = (time: string): string => `Weaver: day closed at ${time}.`;
/** The refusal a second close earns. */
export const NOTICE_DAY_ALREADY_CLOSED = `Weaver: this day is already closed. ${NOTICE_NOTHING_WRITTEN}`;
/** The refusal when today's note cannot be found, created or opened. */
export const NOTICE_NO_DAY_NOTE = `Weaver: today's day note could not be found. ${NOTICE_NOTHING_WRITTEN}`;

/**
 * A portal's one invitation. It usually arrives at the eleven-minute boundary,
 * but an app that was asleep may wake later; the remaining time is then spoken
 * as what is actually left rather than as the time that has passed.
 */
export function noticePortal(time: string, remainingSeconds: number): string {
  const seconds = Math.ceil(remainingSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return `Portal · ${time} is open`;
  if (seconds < 60) return `Portal · ${time} opens in ${seconds} second${seconds === 1 ? "" : "s"}`;

  const minutes = Math.ceil(seconds / 60);
  return `Portal · ${time} opens in ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * A portal's first text could not become an entry: the note's own history could
 * not be read, or the write had nowhere to land. The receptacle keeps the text,
 * so nothing the writer typed is lost while the cause is repaired.
 */
export function noticePortalRefused(reason: string): string {
  return `Weaver: this portal was not entered — ${reason}. Your text is kept.`;
}

/** The refusal when an explicit Prepare names an opening that is no longer live. */
export const NOTICE_PORTAL_UNAVAILABLE = `Weaver: that portal is no longer open. ${NOTICE_NOTHING_WRITTEN}`;

/**
 * A stop could not be written. The clock is held at the second it stopped on,
 * so nothing is lost: check the vault is writable, then stop again.
 */
export const NOTICE_STOP_FAILED =
  "Weaver: the stopped time could not be saved; the clock is held where it stopped. Check the vault is writable, then stop again.";

/** The moment a whole-day whisper pass begins. */
export const NOTICE_WHISPERING = "Whispering the day…";

/** The refusal when this device cannot reach a whisper endpoint at all. */
export const NOTICE_WHISPER_UNREACHABLE = "No whisper endpoint is reachable from this device.";

/** What a whole-day whisper pass had to work with, and what became of it. */
export interface WhisperPass {
  /** Settled entries that were candidates: no whisper, no name typed after the marker, and prose to read. */
  targets: number;
  /** How many of them got their whisper in this pass. */
  written: number;
  /** Entered answers the register refused: the endpoint answered, the register was not met. */
  rejected: number;
  /** The request that produced nothing, when one did — it is the thing to fix. */
  failure: WhisperFailure | null;
  /** Threads added to readings, which place an entry in its day. */
  threads: number;
}

/** A status as the thing it actually says, so a 507 is not reported as a 401. */
function statusVerdict(status: number): string {
  if (status === 401 || status === 403) return "refused this device";
  if (status === 404) return "has no such model";
  if (status === 429) return "is rate-limiting";
  if (status >= 500) return "failed";
  return "rejected the request";
}

/** A failure as one clause, so the log and the notice cannot disagree. */
export function whisperFailurePhrase(failure: WhisperFailure): string {
  switch (failure.kind) {
    case "refused": {
      const head = `the endpoint ${statusVerdict(failure.status)} (HTTP ${failure.status})`;
      if (failure.detail === null) return head;
      // The notice supplies the sentence's full stop, so the server's own does
      // not get to become a second one.
      return `${head}: ${failure.detail.replace(/\.$/, "")}`;
    }
    case "empty":
      // A thinking model that spends the whole answer budget reasoning looks
      // like silence; `finish: length` is what tells the writer what to change.
      if (failure.finish === "length") {
        return "the model used the whole answer on its reasoning (finish: length) — turn thinking off for that model, or use a non-thinking one";
      }
      return failure.finish === null
        ? "the model returned no text"
        : `the model returned no text (finish: ${failure.finish})`;
    case "unreachable":
      return "the endpoint did not answer";
  }
}

/**
 * What a whole-day pass earned.
 *
 * The count alone was not enough: "nothing to whisper" is a claim about the note,
 * and a pass whose every request was refused was saying it about 21 unwhispered
 * entries. A pass now names what it wrote, out of what it tried, and why the rest
 * did not land.
 */
export function noticeWhispered(pass: WhisperPass): string {
  if (pass.targets === 0) {
    return "Nothing to whisper: every settled entry already has one, or a name.";
  }
  if (pass.written === pass.targets) {
    return `Whispered ${pass.written} ${pass.written === 1 ? "entry" : "entries"}.`;
  }

  const tail = pass.threads > 0 ? ` ${pass.threads} placed in the day.` : "";

  const reason =
    pass.failure !== null
      ? whisperFailurePhrase(pass.failure)
      : pass.rejected > 0
        ? `${pass.rejected} ${pass.rejected === 1 ? "answer" : "answers"} did not fit the register`
        : "the entries changed while they were being read";

  return (pass.written === 0
    ? `No whisper was written: ${reason}.`
    : `Whispered ${pass.written} of ${pass.targets} entries: ${reason}.`) + tail;
}

/** The navigator's footer on a desk: the whole key map, where it is pressed. */
export const NAVIGATOR_HINT_KEYS =
  "↑↓ move · ⏎ jump · ⇧⏎ descend · n start · x delete · ⌘[ back · esc close";

/** The navigator's footer on a phone: the same three gestures, as taps. */
export const NAVIGATOR_HINT_TOUCH = "tap to jump · tap the caret row to descend · ✕ twice deletes";

/** The refusal for a write aimed at a note with an unclosed frontmatter block. */
export function noticeCloseFrontmatter(action: string): string {
  return `Weaver: close the frontmatter before ${action}. ${NOTICE_NOTHING_WRITTEN}`;
}

/** The same refusal for an unclosed code block. */
export function noticeCloseCodeBlock(action: string): string {
  return `Weaver: close the code block before ${action}. ${NOTICE_NOTHING_WRITTEN}`;
}

/** The refusal for a note that still carries the old marker's clock. */
export function noticeLegacyFormat(action: string): string {
  return `Weaver: this note still uses the old entry format; migrate it before ${action}. ${NOTICE_NOTHING_WRITTEN}`;
}
