/**
 * One thought being written outside its note: the facts a capture is made of.
 *
 * The composer owns a draft for as long as it is being written, so the note
 * gains nothing until the moment it is settled. That delay is why the beginning
 * is frozen this early: the day a thought belongs to, and the moment it began,
 * are facts about the first committed input — not about when a save finally
 * lands, and not about when a blank form appeared.
 *
 * A `ThoughtRef` is a reference *back into* a note, and `N` alone is not enough
 * to hold one: `N` is reused after a deletion, so the evidence that identifies a
 * thought is its whole recorded shape — its note, its `N`, its branch and depth,
 * its root, its recorded day and moment, and its own prose. A reference either
 * matches all of that in the current source or it is stale, and a stale
 * reference is refused rather than retargeted at whatever now carries the
 * number. That is the rule that keeps a deletion from adopting a stranger's
 * branch.
 *
 * The draft's clock is here too, and it is deliberately not the note's clock: a
 * composer measures the time spent writing while the writer is in the composer,
 * pauses when they leave it, and resumes on real input. It never runs inside the
 * note's own session, and nothing here can start that one.
 *
 * Pure: no DOM, no `obsidian`, no filesystem, no timers. `now` is always passed
 * in, so a test can hold the clock still.
 */

import { formatLocalTimestamp } from "./alignments";
import { formatClock, pad2 } from "./clock";
import { dayKey } from "./day";
import { formatAddress, type Entry, type EntryIndex } from "./entries";
import type { PortalInstant } from "./portals";

/** The first committed input of a thread root, frozen at the instant it arrived. */
export interface CaptureBeginning {
  /** Epoch milliseconds of that input. */
  at: number;
  /** The day the thought began, canonical `YYYY-MM-DD`. */
  day: string;
  /** The moment it began, `HH:MM:SS`, local at the time. */
  time: string;
  /** The same instant with its numeric offset, `YYYY-MM-DDTHH:MM:SS±HH:MM`. */
  localTimestamp: string;
}

/**
 * An opening a root's first committed input qualified for, frozen with it.
 *
 * It is the occurrence, not the minute: two schedules may offer the same epoch
 * minute, and each of them is answered through its own identity and the
 * generation of its activation. A draft carries every invitation it qualified
 * for, so a coincident second schedule is acknowledged too — but the note gets
 * one alignment record, because there is one beginning.
 */
export interface CaptureInvitation {
  /** `${scheduleId}@${portal.id}`: the occurrence, not just the minute. */
  occurrenceId: string;
  /** The schedule it came from, so an answer can be attributed to it. */
  scheduleId: string;
  /** The schedule's own name, for a label after the list has moved on. */
  name: string;
  /** The schedule activation this occurrence belongs to. */
  generation: number;
  portal: PortalInstant;
  /** The destination it points at, which must still match the draft's. */
  contextId: string;
}

/**
 * What an open draft would become, once the writer confirms the move.
 *
 * Choosing a Realm or a parent is a proposal, never an edit: the same draft has
 * one text, one beginning and one running clock, and moving it must not cost
 * any of them. Keeping the request as a value is what lets the surface show the
 * old and the new parent side by side while cancelling stays free.
 */
export type DraftTarget =
  | { kind: "root"; contextId: string }
  | { kind: "branch"; parent: ThoughtRef };

/**
 * A reference to one written thought, in the note that holds it.
 *
 * `b`, `d` and `rootN` are the address the reference was taken under: `b` is the
 * branch id, `d` the dimension, and `rootN` the `N` of the depth-1 entry this
 * thought sits under (itself, for a root). They are carried so a later read can
 * tell a moved thought from a merely renumbered one.
 */
export interface ThoughtRef {
  /** The note path. */
  path: string;
  /** The entry's own day sequence, `N`. */
  n: number;
  b: number;
  d: number;
  /** The `N` of the depth-1 ancestor; this thought's own `N` for a root. */
  rootN: number;
  /** The recorded day, `YYYY-MM-DD`, or null for an undated historical row. */
  day: string | null;
  /** The recorded moment, `HH:MM:SS`, or null. */
  time: string | null;
  /** The thought's own prose, as written. */
  prose: string;
}

/** One thought, ready to be written: where it goes and what it says. */
export interface CaptureRequest {
  /** The destination context for a new root; ignored for a child. */
  contextId: string;
  /** The thought this one branches from, or null for a new thread root. */
  parent: ThoughtRef | null;
  /** The submitted prose, exactly as typed, newlines included. */
  text: string;
  /** The frozen first-input facts of the root. */
  beginning: CaptureBeginning;
  /** The duration to record, in milliseconds. */
  durationMs: number;
  /** The invitation this root was written into, when one applies. */
  portal: PortalInstant | null;
}

/** The written thought and the root it belongs to, or why nothing was written. */
export type CaptureResult =
  | { ok: true; thought: ThoughtRef; root: ThoughtRef }
  | { ok: false; error: string };

/** What the composer is doing, as one of five states. */
export type CapturePhase = "closed" | "editing" | "submitting" | "uncertain" | "resting";

/**
 * The draft's own stopwatch.
 *
 * `baselineMs` is what earlier spans of writing accumulated, `resumedAt` when the
 * current span started (null while paused), and `shownMs` the last whole second
 * a surface painted — which is the value a save writes, so a late tick can never
 * file a second the writer did not see.
 */
export interface DraftClock {
  baselineMs: number;
  resumedAt: number | null;
  shownMs: number;
}

/** What a draft is, as it is stored between sessions. */
export interface DraftRecord {
  /** The destination a new root would be written into. */
  contextId: string;
  /** The thought this draft branches from, or null for a new Thread. */
  parent: ThoughtRef | null;
  /** The saved Thread being continued, when there is one. */
  root: ThoughtRef | null;
  /** The prose exactly as typed. */
  text: string;
  selection: { from: number; to: number };
  /** The frozen beginning, or null before the first committed character. */
  beginning: CaptureBeginning | null;
  /** Whole milliseconds already counted, at the moment it was stored. */
  durationMs: number;
  /** Whether the composer was folded when it was stored. */
  collapsed: boolean;
  /**
   * The openings this draft's first input qualified for, frozen when it landed.
   *
   * Stored so a draft written inside a portal's minute and saved long afterwards
   * still keeps its association: the qualification is a fact about the beginning,
   * not about the moment the writer got back to it.
   */
  invitations: CaptureInvitation[];
}

/**
 * The receipt of one submission, held only until its persistence is confirmed.
 *
 * It carries the exact source before and after the write, so recovery can tell
 * "this landed" from "this did not" without appending anything twice, and it is
 * the only place a whole note is ever copied. It is deleted the moment the answer
 * is known.
 */
export interface CaptureReceipt {
  /** Identity of this one submission. */
  id: string;
  /** The immutable request it was made from. */
  request: CaptureRequest;
  /** The note the write targeted. */
  path: string;
  /** The thought the write allocated. */
  thought: ThoughtRef;
  /** The root it belongs to. */
  root: ThoughtRef;
  /** The note exactly as it was before the write. */
  before: string;
  /** The note exactly as it should be after it. */
  expected: string;
  /** The openings this submission was qualified by, acknowledged once confirmed. */
  invitations: CaptureInvitation[];
}

/** Whole seconds, never negative and never a fraction a screen cannot show. */
export function wholeSeconds(ms: number): number {
  return Math.max(0, Math.floor(ms / 1000) * 1000);
}

/** A fresh identity for one receipt, unique for this device's session. */
export function freshReceiptId(): string {
  const source = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof source?.randomUUID === "function") return source.randomUUID();
  return `receipt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The beginning of a root, from the instant of its first committed input.
 *
 * One `Date` produces every field, so the day, the moment and the recorded
 * timestamp can never describe different instants — including on the two sides of
 * a daylight-saving fold, which differ by their offset alone.
 */
export function captureBeginningAt(at: number): CaptureBeginning {
  const date = new Date(at);
  return {
    at,
    day: dayKey(date),
    time: formatClock(date),
    localTimestamp: formatLocalTimestamp(date)
  };
}

/** A draft that has not started counting: nothing banked, nothing running. */
export function idleClock(): DraftClock {
  return { baselineMs: 0, resumedAt: null, shownMs: 0 };
}

/** The raw milliseconds a draft has accrued, counting the span in progress. */
export function elapsedOf(clock: DraftClock, now: number): number {
  if (clock.resumedAt === null) return wholeSeconds(clock.baselineMs);
  return Math.max(0, clock.baselineMs + (now - clock.resumedAt));
}

/** The whole second a surface should paint: the last one, while paused. */
export function shownOf(clock: DraftClock, now: number): number {
  return clock.resumedAt === null ? wholeSeconds(clock.shownMs) : wholeSeconds(elapsedOf(clock, now));
}

/**
 * Counting begins, from what was already banked.
 *
 * A paused draft resumes from its own stopped second; a fresh one starts at zero.
 * The shown second is kept so a resume never redraws a smaller number than the
 * one that was already on screen.
 */
export function resumeClock(clock: DraftClock, at: number): DraftClock {
  if (clock.resumedAt !== null) return clock;
  return { baselineMs: clock.baselineMs, resumedAt: at, shownMs: clock.shownMs };
}

/**
 * Counting stops and banks the whole second that was on screen.
 *
 * The painted second is the one a save writes, never a fresh sample taken while
 * a write is in flight: a surface that painted `00:00:07` and then stalled for
 * two seconds must file seven, not nine. That is why the clock takes no instant
 * at all — pausing is a decision about the digits already drawn.
 */
export function pauseClock(clock: DraftClock): DraftClock {
  const painted = wholeSeconds(clock.shownMs);
  return { baselineMs: painted, resumedAt: null, shownMs: painted };
}

/** Records a painted second; a paused draft ignores it, because it is frozen. */
export function commitShown(clock: DraftClock, ms: number): DraftClock {
  if (clock.resumedAt === null) return clock;
  return { ...clock, shownMs: wholeSeconds(ms) };
}

/** The prose of an entry, as written: its non-whisper lines, joined. */
export function proseOf(index: EntryIndex, entry: Entry): string {
  return entry.proseLines.map((line) => index.lines[line] ?? "").join("\n").trim();
}

/**
 * The depth-1 entry a thought sits under.
 *
 * A root is its own; every descendant walks up `parent` until it reaches one, so
 * a thought's Thread is always the entry the walk lands on. That walk is what
 * makes "the Thread includes its descendants" a fact about the note rather than a
 * convention a surface has to remember.
 */
export function rootEntryOf(index: EntryIndex, entry: Entry): Entry {
  let current = entry;
  while (current.parent !== null) {
    const parent = index.entries[current.parent];
    if (parent === undefined) break;
    current = parent;
  }
  return current;
}

/** A reference to `entry` as the note holds it right now. */
export function thoughtRefOf(index: EntryIndex, entry: Entry, path: string): ThoughtRef {
  return {
    path,
    n: entry.n,
    b: entry.b,
    d: entry.d,
    rootN: rootEntryOf(index, entry).n,
    day: entry.day,
    time: entry.time,
    prose: proseOf(index, entry)
  };
}

/**
 * The entry a reference still truthfully names, or null once it does not.
 *
 * Every recorded fact has to match: the `N`, the branch and depth, the recorded
 * day and moment, the prose, and the root it sits under. A deletion can reuse an
 * `N` and a later edit can change prose; either makes this reference stale for
 * good, which is what stops a branch from landing under a stranger.
 */
export function resolveThought(index: EntryIndex, ref: ThoughtRef): Entry | null {
  const entry = index.entries.find((candidate) => candidate.n === ref.n);
  if (entry === undefined) return null;
  if (entry.b !== ref.b || entry.d !== ref.d) return null;
  if (entry.day !== ref.day || entry.time !== ref.time) return null;
  if (rootEntryOf(index, entry).n !== ref.rootN) return null;
  return proseOf(index, entry) === ref.prose ? entry : null;
}

/** A short excerpt of prose, for naming a thought in a picker or a label. */
export function excerptOf(prose: string, words = 6): string {
  const flat = prose.replace(/\s+/g, " ").trim();
  if (flat === "") return "";
  return flat.split(" ").slice(0, words).join(" ");
}

/**
 * One thought in a Thread, and the thought it hangs under.
 *
 * `parentN` is the parent's `N` inside the same note, which is what makes the
 * list a tree a surface can walk without holding an entry index of its own.
 */
export interface ThreadNode {
  thought: ThoughtRef;
  /** The parent's `N`, or null for the root. */
  parentN: number | null;
  /**
   * The duration the entry's own clock row records, or null when it has none.
   *
   * The composer's bottom rail is the entry's clock row, so the number it paints
   * has to come from the record rather than from a draft clock that no longer
   * exists.
   */
  durationMs: number | null;
}

/**
 * One saved Thread as a surface reads it: its root, the path down to the thought
 * in hand, and every thought in the root's subtree.
 *
 * A Thread *includes* its descendants, so "view the thread" is the root's own
 * subtree rather than a second navigation surface: `nodes` is the whole of it in
 * document preorder, which is the same order the note draws and therefore the
 * only order a "next thought" can mean.
 */
export interface ThreadView {
  root: ThoughtRef;
  /** Root first, the selected thought last; one element when the root is selected. */
  ancestry: ThoughtRef[];
  /** The thought in hand, once its reference still matches the note. */
  selected: ThoughtRef | null;
  /** Every thought in the root's subtree, in document preorder. */
  nodes: ThreadNode[];
}

/** The direction a structural motion moves the selection. */
export type ThreadMove = "previous" | "next" | "parent" | "child";

/**
 * The view of the Thread `target` belongs to, or null when it is stale.
 *
 * Staleness is decided by {@link resolveThought}: a reference whose entry was
 * deleted, renumbered or edited no longer describes a thought, and no surface may
 * draw one from it.
 */
export function threadViewOf(
  index: EntryIndex,
  path: string,
  target: ThoughtRef | null
): ThreadView | null {
  if (target === null) return null;
  const entry = resolveThought(index, target);
  if (entry === null) return null;

  const root = rootEntryOf(index, entry);
  const ancestry: ThoughtRef[] = [];
  let current: Entry = entry;
  while (current !== root) {
    ancestry.unshift(thoughtRefOf(index, current, path));
    const parent = current.parent === null ? undefined : index.entries[current.parent];
    if (parent === undefined) break;
    current = parent;
  }
  ancestry.unshift(thoughtRefOf(index, root, path));

  return {
    root: thoughtRefOf(index, root, path),
    ancestry,
    selected: thoughtRefOf(index, entry, path),
    nodes: subtreeOf(index, path, root)
  };
}

/**
 * Every thought under `root`, in document preorder.
 *
 * The walk is breadth-free on purpose: children are visited in the order the note
 * holds them, one level at a time, so a descendant always follows its parent and
 * two siblings never separate. That is the order `j` and `k` move in.
 */
function subtreeOf(index: EntryIndex, path: string, root: Entry): ThreadNode[] {
  const children = new Map<number, number[]>();
  index.entries.forEach((candidate, at) => {
    if (candidate.parent === null) return;
    const siblings = children.get(candidate.parent);
    if (siblings === undefined) children.set(candidate.parent, [at]);
    else siblings.push(at);
  });

  const nodes: ThreadNode[] = [];
  const walk = (at: number): void => {
    const node = index.entries[at];
    if (node === undefined) return;
    nodes.push({
      thought: thoughtRefOf(index, node, path),
      parentN: node.parent === null ? null : (index.entries[node.parent]?.n ?? null),
      durationMs: node.duration === null ? null : node.duration.ms
    });
    for (const child of children.get(at) ?? []) walk(child);
  };
  walk(index.entries.indexOf(root));
  return nodes;
}

/**
 * The thought a structural motion selects, or null when it cannot move.
 *
 * Previous and next are neighbours in the visible Thread; parent and child are
 * the tree's own edges, with "child" meaning the first direct child. Nothing
 * wraps around and nothing is written: a motion past an end keeps the selection
 * where it is, because a jump from the last thought to the first is not what a
 * writer reaching for `j` meant.
 */
export function moveThreadSelection(view: ThreadView, direction: ThreadMove): ThoughtRef | null {
  const selected = view.selected;
  const nodes = view.nodes;
  if (nodes.length === 0) return null;
  const at = selected === null ? -1 : nodes.findIndex((node) => node.thought.n === selected.n);
  if (at < 0) return nodes[0]?.thought ?? null;

  switch (direction) {
    case "previous":
      return nodes[at - 1]?.thought ?? null;
    case "next":
      return nodes[at + 1]?.thought ?? null;
    case "parent": {
      const parentN = nodes[at]?.parentN ?? null;
      if (parentN === null) return null;
      return nodes.find((node) => node.thought.n === parentN)?.thought ?? null;
    }
    case "child":
      return nodes.find((node) => node.parentN === nodes[at]?.thought.n)?.thought ?? null;
  }
}

/** The accessible name of a branch action: what it branches from, and from where. */
export function branchLabel(parent: ThoughtRef): string {
  const excerpt = excerptOf(parent.prose);
  const address = formatAddress(parent.b, parent.d, parent.n);
  return `Branch under ${excerpt === "" ? address : excerpt} · ${address}`;
}

/** The local hour and minute of a recorded opening, `HH:MM`. */
export function openingLabel(portal: PortalInstant): string {
  return `${pad2(portal.hour)}:${pad2(portal.minute)}`;
}
