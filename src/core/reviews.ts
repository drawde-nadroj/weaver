/**
 * Reviews as shared data: a named selection of thoughts, with an independently
 * stamped definition and cursor, a deletion tombstone, and the merge rule that
 * lets two devices converge without a server.
 *
 * A Review is not a destination and not a draft. Its *definition* — name, scope,
 * dates, order, where to begin — and its *reading cursor* are separate registers,
 * so renaming a Review on one device and moving its place on another both
 * survive. Only deleted Reviews are special: a tombstone wins for that UUID, and
 * a re-created Review gets a new one.
 *
 * The stamps are a hybrid logical clock: `wallMs`, a `counter` that breaks ties on
 * one device, and the device's own id as the final order. A device advances its
 * stamp past the highest it has seen, so a clock that runs backwards cannot make a
 * newer change look older.
 *
 * Pure: no storage, no sync, no timers. A store injects the current instant.
 */

import type { ThoughtRef } from "./capture";
import type { ReadingOrder, ReferenceQuery, ReferenceScope } from "./reference";
import { isPlainObject } from "./value";

/** One device's place in the hybrid clock, used to order competing writes. */
export interface ReviewStamp {
  readonly wallMs: number;
  readonly counter: number;
  readonly deviceId: string;
}

/** A Review's whole definition: what it selects and how it is read. */
export interface ReviewDefinition {
  readonly name: string;
  /** The Tapestry it is scoped to, or null for All Tapestries. */
  readonly tapestryId: string | null;
  /** First recorded day, inclusive, canonical `YYYY-MM-DD`. */
  readonly from: string;
  /** Last recorded day, inclusive. */
  readonly through: string;
  readonly order: ReadingOrder;
  /** Where an initial opening lands: the first or the last thought. */
  readonly beginAt: "first" | "last";
}

/** Where a Review's reader was: a thought (or none) and its prose offset. */
export interface ReviewCursor {
  readonly thought: ThoughtRef | null;
  readonly textOffset: number;
}

/** A definition with the stamp that orders it against another device's copy. */
export interface StampedDefinition {
  readonly definition: ReviewDefinition;
  readonly stamp: ReviewStamp;
}

/** A cursor with its own stamp, independent of the definition's. */
export interface StampedCursor {
  readonly cursor: ReviewCursor;
  readonly stamp: ReviewStamp;
}

/** One Review as stored: its two stamped registers and a nullable tombstone. */
export interface ReviewRecord {
  readonly id: string;
  readonly definition: StampedDefinition;
  readonly cursor: StampedCursor;
  /** The deletion stamp, or null while the Review exists. */
  readonly tombstone: ReviewStamp | null;
}

/** Every Review, keyed by its UUID. */
export type ReviewMap = Readonly<Record<string, ReviewRecord>>;

/** One explicit save: create or update, with the resulting place. */
export interface ReviewSave {
  readonly id: string;
  readonly mode: "create" | "update";
  readonly definition: ReviewDefinition;
  readonly cursor: ReviewCursor;
}

/** Orders two stamps: wall time, then counter, then device id. */
export function compareStamps(left: ReviewStamp, right: ReviewStamp): number {
  if (left.wallMs !== right.wallMs) return left.wallMs < right.wallMs ? -1 : 1;
  if (left.counter !== right.counter) return left.counter < right.counter ? -1 : 1;
  if (left.deviceId === right.deviceId) return 0;
  return left.deviceId < right.deviceId ? -1 : 1;
}

/**
 * The next stamp for this device, strictly after every stamp it has seen.
 *
 * When the wall clock has advanced, the counter resets; when it has not (or has
 * run backwards), the counter increments at the observed wall time. That is what
 * keeps a corrected clock from making a later write look earlier.
 */
export function advanceStamp(
  observed: ReviewStamp | null,
  deviceId: string,
  wallMs: number
): ReviewStamp {
  if (observed === null || wallMs > observed.wallMs) {
    return { wallMs, counter: 0, deviceId };
  }
  return { wallMs: observed.wallMs, counter: observed.counter + 1, deviceId };
}

/** True for a whole, real calendar day, canonical `YYYY-MM-DD`. */
function isCalendarDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number.parseInt(match[1] ?? "0", 10);
  const month = Number.parseInt(match[2] ?? "0", 10);
  const day = Number.parseInt(match[3] ?? "0", 10);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Field errors for a Review definition, keyed by field name.
 *
 * Both days must be real calendar days and `from` must not follow `through`.
 * An empty object means the definition may be saved.
 */
export function validateReviewDefinition(definition: ReviewDefinition): Readonly<Record<string, string>> {
  const errors: Record<string, string> = {};
  if (!isCalendarDay(definition.from)) errors["from"] = "Enter a real start day (YYYY-MM-DD).";
  if (!isCalendarDay(definition.through)) errors["through"] = "Enter a real end day (YYYY-MM-DD).";
  if (errors["from"] === undefined && errors["through"] === undefined && definition.from > definition.through) {
    errors["through"] = "The end day cannot come before the start day.";
  }
  return errors;
}

/** The reading scope a Review definition selects. */
export function reviewScopeOf(definition: ReviewDefinition): ReferenceScope {
  return {
    kind: "range",
    tapestryId: definition.tapestryId,
    from: definition.from,
    through: definition.through
  };
}

/** The plain query a Review's definition resolves to. */
export function reviewQueryOf(definition: ReviewDefinition): ReferenceQuery {
  return { scope: reviewScopeOf(definition), order: definition.order, search: { kind: "none" } };
}

/** A suggested name for a Review from its dates, which the writer may replace. */
export function reviewNameSuggestion(from: string, through: string): string {
  return from === through ? from : `${from} – ${through}`;
}

/** The newer of two same-register records, or the left one on an exact tie. */
function newer<T>(left: { readonly stamp: ReviewStamp } & T, right: { readonly stamp: ReviewStamp } & T): T {
  return compareStamps(left.stamp, right.stamp) >= 0 ? left : right;
}

/**
 * Merges two maps of Reviews register by register.
 *
 * The definition and cursor each take their newer stamp independently, so a
 * rename on one device and a moved cursor on another both survive. A tombstone
 * wins outright for that UUID: a deletion is never undone by a stale definition
 * or cursor, and an external deletion cannot resurrect itself.
 */
export function mergeReviewMaps(local: ReviewMap, remote: ReviewMap): ReviewMap {
  const merged: Record<string, ReviewRecord> = {};
  const ids = new Set([...Object.keys(local), ...Object.keys(remote)]);

  for (const id of ids) {
    const left = local[id];
    const right = remote[id];
    if (left === undefined) {
      if (right !== undefined) merged[id] = right;
      continue;
    }
    if (right === undefined) {
      merged[id] = left;
      continue;
    }

    if (left.tombstone !== null || right.tombstone !== null) {
      const tombstone =
        left.tombstone === null
          ? right.tombstone
          : right.tombstone === null
            ? left.tombstone
            : compareStamps(left.tombstone, right.tombstone) >= 0
              ? left.tombstone
              : right.tombstone;
      merged[id] = {
        id,
        definition: newer(left.definition, right.definition),
        cursor: newer(left.cursor, right.cursor),
        tombstone
      };
      continue;
    }

    merged[id] = {
      id,
      definition: newer(left.definition, right.definition),
      cursor: newer(left.cursor, right.cursor),
      tombstone: null
    };
  }

  return merged;
}

/** Every Review that is not tombstoned, in id order. */
export function liveReviews(reviews: ReviewMap): ReviewRecord[] {
  return Object.values(reviews)
    .filter((record) => record.tombstone === null)
    .sort((left, right) => (left.id < right.id ? -1 : 1));
}

/** The tombstoned record for an id, or null when the id is free to create. */
export function tombstoneOf(reviews: ReviewMap, id: string): ReviewStamp | null {
  return reviews[id]?.tombstone ?? null;
}

/** One stamp read from stored data, or null. */
function readStamp(value: unknown): ReviewStamp | null {
  if (!isPlainObject(value)) return null;
  const wallMs = value["wallMs"];
  const counter = value["counter"];
  const deviceId = value["deviceId"];
  if (typeof wallMs !== "number" || !Number.isFinite(wallMs)) return null;
  if (typeof counter !== "number" || !Number.isInteger(counter) || counter < 0) return null;
  if (typeof deviceId !== "string" || deviceId === "") return null;
  return { wallMs, counter, deviceId };
}

/** One reference read from stored data, or null when it cannot name a thought. */
function readRef(value: unknown): ThoughtRef | null {
  if (!isPlainObject(value)) return null;
  const path = value["path"];
  const n = value["n"];
  const b = value["b"];
  const d = value["d"];
  const rootN = value["rootN"];
  if (typeof path !== "string" || path === "") return null;
  for (const part of [n, b, d, rootN]) {
    if (typeof part !== "number" || !Number.isInteger(part) || part < 1) return null;
  }
  const day = value["day"] === null ? null : typeof value["day"] === "string" ? value["day"] : undefined;
  const time = value["time"] === null ? null : typeof value["time"] === "string" ? value["time"] : undefined;
  if (day === undefined || time === undefined) return null;
  return {
    path,
    n: n as number,
    b: b as number,
    d: d as number,
    rootN: rootN as number,
    day,
    time,
    prose: typeof value["prose"] === "string" ? value["prose"] : ""
  };
}

/** One Review definition read from stored data, or null. */
function readDefinition(value: unknown): ReviewDefinition | null {
  if (!isPlainObject(value)) return null;
  const name = typeof value["name"] === "string" ? value["name"] : null;
  const tapestryId =
    value["tapestryId"] === null ? null : typeof value["tapestryId"] === "string" ? value["tapestryId"] : undefined;
  const from = typeof value["from"] === "string" ? value["from"] : null;
  const through = typeof value["through"] === "string" ? value["through"] : null;
  const order = value["order"] === "time" || value["order"] === "connections" ? value["order"] : null;
  const beginAt = value["beginAt"] === "first" || value["beginAt"] === "last" ? value["beginAt"] : null;
  if (name === null || tapestryId === undefined || from === null || through === null || order === null || beginAt === null) {
    return null;
  }
  return { name, tapestryId, from, through, order, beginAt };
}

/** One Review cursor read from stored data, or null. */
function readCursorValue(value: unknown): ReviewCursor | null {
  if (!isPlainObject(value)) return null;
  const thought = value["thought"] === null ? null : readRef(value["thought"]);
  if (thought === null && value["thought"] !== null) return null;
  const textOffset = value["textOffset"];
  if (typeof textOffset !== "number" || !Number.isFinite(textOffset) || textOffset < 0) return null;
  return { thought, textOffset };
}

/** One Review record read from stored data, or null when it is not one. */
function readRecord(value: unknown): ReviewRecord | null {
  if (!isPlainObject(value)) return null;
  const id = typeof value["id"] === "string" && value["id"] !== "" ? value["id"] : null;
  const definitionStamp = readStamp(isPlainObject(value["definition"]) ? value["definition"]["stamp"] : null);
  const definitionValue = readDefinition(isPlainObject(value["definition"]) ? value["definition"]["definition"] : null);
  const cursorStamp = readStamp(isPlainObject(value["cursor"]) ? value["cursor"]["stamp"] : null);
  const cursorValue = readCursorValue(isPlainObject(value["cursor"]) ? value["cursor"]["cursor"] : null);
  const tombstone = value["tombstone"] === null ? null : readStamp(value["tombstone"]);
  if (id === null || definitionStamp === null || definitionValue === null || cursorStamp === null || cursorValue === null) {
    return null;
  }
  if (value["tombstone"] !== null && tombstone === null) return null;
  return {
    id,
    definition: { definition: definitionValue, stamp: definitionStamp },
    cursor: { cursor: cursorValue, stamp: cursorStamp },
    tombstone
  };
}

/**
 * Reads a stored collection of Reviews.
 *
 * `malformed` is true when any id carried a value this build cannot read, so a
 * store can refuse to write over data it does not understand instead of
 * discarding the writer's shared work.
 */
export function readReviewMap(value: unknown): { reviews: ReviewMap; malformed: boolean } {
  if (!isPlainObject(value)) return { reviews: {}, malformed: value !== undefined && value !== null };
  const reviews: Record<string, ReviewRecord> = {};
  let malformed = false;
  for (const [id, raw] of Object.entries(value)) {
    const record = readRecord(raw);
    if (record === null || record.id !== id) {
      malformed = true;
      continue;
    }
    reviews[id] = record;
  }
  return { reviews, malformed };
}
