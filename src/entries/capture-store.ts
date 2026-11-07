/**
 * The durable capture record, version 2: the tagged work and its one write.
 *
 * Version 1 stored a draft beside a nullable receipt, and a phase string lived in
 * memory. That could not describe "a correction borrowed the composer", "a write
 * is unconfirmed", or "completion is stored but the receipt is not yet removed",
 * so the new envelope stores exactly one {@link StoredCaptureState}. A read that
 * cannot be trusted throws and leaves the raw bytes alone; a revision that does
 * not match refuses the write, so a late callback from an unloaded instance
 * cannot overwrite its successor.
 *
 * Migration reads v1 only to produce v2, writes v2, reads it back, and only then
 * retires v1. Receipt bytes and every reference-bearing slot are preserved; an
 * unresolved legacy value stays evidence rather than becoming an empty draft.
 */

import type {
  CaptureInstant,
  CaptureInvitation,
  CaptureReceipt,
  DraftTarget,
  SavedThought,
  ThoughtRef
} from "../core/capture";
import {
  type DraftData,
  type PendingWrite,
  type RestorableWork,
  type RevisionData,
  type StoredCaptureState,
  type TextSelection,
  type WriteIntent,
  type WriteReceipt
} from "../core/capture-state";
import type { PortalInstant } from "../core/portals";
import { isPlainObject } from "../core/value";
import type { CaptureRecord } from "./capture";
import { CAPTURE_STORAGE_KEY, UnreadableState, type LocalStorageIo } from "./local-state";

/** The key the versioned capture lives under. */
export const CAPTURE_V2_STORAGE_KEY = "weaver:capture:v2";

/** The whole durable capture: version, revision, state and owed acknowledgements. */
export interface CaptureEnvelopeV2 {
  readonly version: 2;
  readonly revision: number;
  readonly state: StoredCaptureState;
  readonly acknowledgements: readonly CaptureInvitation[];
}

/** A write that expected one revision and found another. */
export class CaptureConflict extends Error {}

/** A whole, non-negative integer, or null. */
function whole(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** A finite number, or null. */
function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A non-empty string, or null. */
function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** One frozen instant, or null. */
function readInstant(value: unknown): CaptureInstant | null {
  if (!isPlainObject(value)) return null;
  const at = finite(value["at"]);
  const day = text(value["day"]);
  const time = text(value["time"]);
  const localTimestamp = text(value["localTimestamp"]);
  if (at === null || day === null || time === null || localTimestamp === null) return null;
  return { at, day, time, localTimestamp };
}

/** One strict reference, or null. */
function readRef(value: unknown): ThoughtRef | null {
  if (!isPlainObject(value)) return null;
  const path = text(value["path"]);
  const n = whole(value["n"]);
  const b = whole(value["b"]);
  const d = whole(value["d"]);
  const rootN = whole(value["rootN"]);
  if (path === null || n === null || b === null || d === null || rootN === null) return null;
  if (n < 1 || b < 1 || d < 1 || rootN < 1) return null;
  const rawDay = value["day"];
  const day = rawDay === null ? null : typeof rawDay === "string" && rawDay !== "" ? rawDay : null;
  if (rawDay !== null && day === null) return null;
  const rawTime = value["time"];
  const time = rawTime === null ? null : typeof rawTime === "string" && rawTime !== "" ? rawTime : null;
  if (rawTime !== null && time === null) return null;
  return { path, n, b, d, rootN, day, time, prose: typeof value["prose"] === "string" ? value["prose"] : "" };
}

/** One text range, or null. */
function readSelection(value: unknown): TextSelection | null {
  if (!isPlainObject(value)) return null;
  const from = whole(value["from"]);
  const to = whole(value["to"]);
  if (from === null || to === null) return null;
  return { from, to };
}

/** One frozen opening, or null. */
function readPortal(value: unknown): PortalInstant | null {
  if (!isPlainObject(value)) return null;
  const id = text(value["id"]);
  const opensAt = finite(value["opensAt"]);
  const day = text(value["day"]);
  const hour = whole(value["hour"]);
  const minute = whole(value["minute"]);
  const offsetMinutes = finite(value["offsetMinutes"]);
  if (id === null || opensAt === null || day === null) return null;
  if (hour === null || hour > 23 || minute === null || minute > 59) return null;
  if (offsetMinutes === null) return null;
  return { id, opensAt, day, hour, minute, offsetMinutes };
}

/** One stored invitation, or null. */
function readInvitation(value: unknown): CaptureInvitation | null {
  if (!isPlainObject(value)) return null;
  const occurrenceId = text(value["occurrenceId"]);
  const scheduleId = text(value["scheduleId"]);
  const generation = whole(value["generation"]);
  const contextId = text(value["contextId"]);
  const portal = readPortal(value["portal"]);
  if (occurrenceId === null || scheduleId === null || generation === null) return null;
  if (contextId === null || portal === null) return null;
  if (occurrenceId !== `${scheduleId}@${portal.id}`) return null;
  const name = typeof value["name"] === "string" ? value["name"] : scheduleId;
  return { occurrenceId, scheduleId, name, generation, portal, contextId };
}

/** Every readable invitation; a doubtful one is dropped, never invented. */
function readInvitations(value: unknown): CaptureInvitation[] {
  if (!Array.isArray(value)) return [];
  return value.map(readInvitation).filter((item): item is CaptureInvitation => item !== null);
}

/** A draft target, or null. */
function readTarget(value: unknown): DraftTarget | null {
  if (!isPlainObject(value)) return null;
  if (value["kind"] === "root") {
    const contextId = text(value["contextId"]);
    return contextId === null ? null : { kind: "root", contextId };
  }
  if (value["kind"] === "branch") {
    const parent = readRef(value["parent"]);
    return parent === null ? null : { kind: "branch", parent };
  }
  return null;
}

/** Frozen draft data, or null. */
function readDraftData(value: unknown): DraftData | null {
  if (!isPlainObject(value)) return null;
  const id = typeof value["id"] === "string" ? value["id"] : null;
  const target = readTarget(value["target"]);
  const selection = readSelection(value["selection"]);
  const durationMs = whole(value["durationMs"]);
  if (id === null || target === null || selection === null || durationMs === null) return null;
  if (typeof value["text"] !== "string") return null;
  const beginning = value["beginning"] === null ? null : readInstant(value["beginning"]);
  if (value["beginning"] !== null && beginning === null) return null;
  return {
    id,
    target,
    text: value["text"],
    selection,
    beginning,
    durationMs,
    invitations: readInvitations(value["invitations"])
  };
}

/** A saved thought, or null. */
function readSaved(value: unknown): SavedThought | null {
  if (!isPlainObject(value)) return null;
  const thought = readRef(value["thought"]);
  const root = readRef(value["root"]);
  return thought === null || root === null ? null : { thought, root };
}

/** Restorable work, or null. */
function readRestorable(value: unknown): RestorableWork | null {
  if (!isPlainObject(value)) return null;
  if (value["kind"] === "empty") return { kind: "empty" };
  if (value["kind"] === "draft") {
    const draft = readDraftData(value["draft"]);
    return draft === null ? null : { kind: "draft", draft };
  }
  if (value["kind"] === "resting") {
    const saved = readSaved(value["saved"]);
    return saved === null ? null : { kind: "resting", saved };
  }
  return null;
}

/** A correction, or null when its protected work is itself a revision. */
function readRevision(value: unknown): RevisionData | null {
  if (!isPlainObject(value)) return null;
  const id = typeof value["id"] === "string" ? value["id"] : null;
  const target = readRef(value["target"]);
  const selection = readSelection(value["selection"]);
  const returnTo = readRestorable(value["returnTo"]);
  if (id === null || target === null || selection === null || returnTo === null) return null;
  if (typeof value["originalBlock"] !== "string") return null;
  if (typeof value["originalText"] !== "string") return null;
  if (typeof value["text"] !== "string") return null;
  return {
    id,
    target,
    originalBlock: value["originalBlock"],
    originalText: value["originalText"],
    text: value["text"],
    selection,
    returnTo
  };
}

/** A guarded receipt's shared fields, validated. */
interface ReceiptBase {
  id: string;
  path: string;
  before: string;
  expected: string;
}

function readReceiptBase(value: Record<string, unknown>): ReceiptBase | null {
  const id = typeof value["id"] === "string" ? value["id"] : null;
  const path = text(value["path"]);
  if (id === null || path === null) return null;
  if (typeof value["before"] !== "string" || typeof value["expected"] !== "string") return null;
  return { id, path, before: value["before"], expected: value["expected"] };
}

/** A write receipt, or null. */
function readReceipt(value: unknown): WriteReceipt | null {
  if (!isPlainObject(value)) return null;
  const base = readReceiptBase(value);
  if (base === null) return null;
  if (value["kind"] === "capture") {
    const saved = readSaved(value["saved"]);
    return saved === null ? null : { kind: "capture", ...base, saved };
  }
  if (value["kind"] === "revision") {
    const thought = readRef(value["thought"]);
    return thought === null ? null : { kind: "revision", ...base, thought };
  }
  return null;
}

/** A write intent, or null. */
function readIntent(value: unknown): WriteIntent | null {
  if (!isPlainObject(value)) return null;
  const id = typeof value["id"] === "string" ? value["id"] : null;
  if (id === null) return null;
  if (value["kind"] === "capture") {
    const draft = readDraftData(value["draft"]);
    const published = readInstant(value["published"]);
    const portal = value["portal"] === null ? null : readPortal(value["portal"]);
    if (draft === null || published === null) return null;
    if (value["portal"] !== null && portal === null) return null;
    return { kind: "capture", id, draft, published, portal };
  }
  if (value["kind"] === "revision") {
    const revision = readRevision(value["revision"]);
    return revision === null ? null : { kind: "revision", id, revision };
  }
  return null;
}

/** One frozen write and its matching receipt, or null. */
function readPending(value: unknown): PendingWrite | null {
  if (!isPlainObject(value)) return null;
  const intent = readIntent(value["intent"]);
  const receipt = readReceipt(value["receipt"]);
  if (intent === null || receipt === null || intent.kind !== receipt.kind) return null;
  if (intent.kind === "capture" && receipt.kind === "capture") {
    return { kind: "capture", intent, receipt };
  }
  if (intent.kind === "revision" && receipt.kind === "revision") {
    return { kind: "revision", intent, receipt };
  }
  return null;
}

/** One stored capture state, or null when it cannot be trusted. */
function readState(value: unknown): StoredCaptureState | null {
  if (!isPlainObject(value)) return null;
  switch (value["kind"]) {
    case "empty":
      return { kind: "empty" };
    case "draft": {
      const draft = readDraftData(value["draft"]);
      return draft === null ? null : { kind: "draft", draft };
    }
    case "resting": {
      const saved = readSaved(value["saved"]);
      return saved === null ? null : { kind: "resting", saved };
    }
    case "revision": {
      const revision = readRevision(value["revision"]);
      return revision === null ? null : { kind: "revision", revision };
    }
    case "preparing": {
      const intent = readIntent(value["intent"]);
      if (intent === null) return null;
      const retryOf = value["retryOf"] === null ? null : readPending(value["retryOf"]);
      if (value["retryOf"] !== null && retryOf === null) return null;
      return { kind: "preparing", intent, retryOf };
    }
    case "pending": {
      const pending = readPending(value["pending"]);
      return pending === null ? null : { kind: "pending", pending };
    }
    default:
      return null;
  }
}

/**
 * Reads a stored v2 envelope, throwing when it cannot be trusted.
 *
 * A malformed or newer record is an error, not an empty capture: the caller keeps
 * the raw bytes and blocks persistence rather than overwriting the only copy.
 */
export function readCaptureEnvelope(value: unknown): CaptureEnvelopeV2 {
  if (!isPlainObject(value)) throw new UnreadableState("the stored capture is not an object");
  if (value["version"] !== 2) throw new UnreadableState("the stored capture is not version 2");
  const revision = whole(value["revision"]);
  const state = readState(value["state"]);
  if (revision === null || revision < 1 || state === null) {
    throw new UnreadableState("the stored capture could not be read");
  }
  const acknowledgements = readInvitations(value["acknowledgements"]);
  return { version: 2, revision, state, acknowledgements };
}

/** The v1 record as a v2 envelope, preserving receipt bytes and every reference. */
export function migrateCaptureV1(record: CaptureRecord): CaptureEnvelopeV2 {
  if (record.receipt !== null) {
    const intent = readLegacyIntent(record.receipt);
    if (intent !== null) {
      return {
        version: 2,
        revision: 1,
        state: { kind: "pending", pending: intent },
        acknowledgements: [...record.receipt.invitations]
      };
    }
  }
  if (record.draft !== null) {
    const draft = record.draft;
    const target: DraftTarget =
      draft.parent !== null
        ? { kind: "branch", parent: draft.parent }
        : { kind: "root", contextId: draft.contextId };
    const data: DraftData = {
      id: "legacy-draft",
      target,
      text: draft.text,
      selection: draft.selection,
      beginning: draft.beginning,
      durationMs: draft.durationMs,
      invitations: draft.invitations
    };
    return {
      version: 2,
      revision: 1,
      state: { kind: "draft", draft: data },
      acknowledgements: [...draft.invitations]
    };
  }
  return { version: 2, revision: 1, state: { kind: "empty" }, acknowledgements: [] };
}

/** The v1 receipt as a pending write, or null when its slots cannot be rebuilt. */
function readLegacyIntent(receipt: CaptureReceipt): PendingWrite | null {
  const request = receipt.request;
  const target: DraftTarget =
    request.parent !== null
      ? { kind: "branch", parent: request.parent }
      : { kind: "root", contextId: request.contextId };
  const draft: DraftData = {
    id: receipt.id,
    target,
    text: request.text,
    selection: { from: request.text.length, to: request.text.length },
    beginning: request.beginning,
    durationMs: request.durationMs,
    invitations: receipt.invitations
  };
  const intent: WriteIntent = {
    kind: "capture",
    id: receipt.id,
    draft,
    published: request.beginning,
    portal: request.portal
  };
  const receiptV2: WriteReceipt = {
    kind: "capture",
    id: receipt.id,
    path: receipt.path,
    before: receipt.before,
    expected: receipt.expected,
    saved: { thought: receipt.thought, root: receipt.root }
  };
  return { kind: "capture", intent, receipt: receiptV2 };
}

/**
 * The versioned capture over vault-local storage.
 *
 * `saveCapture` compares the stored revision with the expected one, so a stale
 * callback cannot write over a newer state; `migrateFromV1` writes v2, reads it
 * back, and only then clears v1.
 */
export class CaptureStoreV2 {
  constructor(private readonly io: LocalStorageIo) {}

  /** The stored envelope, or null. Throws when it cannot be trusted. */
  loadCapture(): CaptureEnvelopeV2 | null {
    const raw = this.io.load(CAPTURE_V2_STORAGE_KEY);
    return raw === null || raw === undefined ? null : readCaptureEnvelope(raw);
  }

  /**
   * Writes the next envelope at `expectedRevision + 1`.
   *
   * Null expects no existing record; otherwise the stored revision must match.
   */
  saveCapture(next: CaptureEnvelopeV2, expectedRevision: number | null): CaptureEnvelopeV2 {
    const raw = this.io.load(CAPTURE_V2_STORAGE_KEY);
    const current =
      raw === null || raw === undefined
        ? null
        : (() => {
            try {
              return readCaptureEnvelope(raw);
            } catch {
              // An unreadable record is not an absent one: refuse rather than overwrite.
              throw new CaptureConflict("the stored capture cannot be read; nothing was written");
            }
          })();

    const actual = current?.revision ?? null;
    if (actual !== expectedRevision) {
      throw new CaptureConflict(
        `the stored capture is at revision ${actual ?? "none"}, not ${expectedRevision ?? "none"}`
      );
    }

    const stored: CaptureEnvelopeV2 = { ...next, version: 2, revision: (expectedRevision ?? 0) + 1 };
    this.io.save(CAPTURE_V2_STORAGE_KEY, stored);
    return stored;
  }

  /**
   * Writes a migrated v1 record as v2, verifies it, then retires v1.
   *
   * Returns the new envelope. A read-back that disagrees leaves v1 in place.
   */
  migrateFromV1(legacy: CaptureRecord | null): CaptureEnvelopeV2 | null {
    if (legacy === null) return null;
    if (this.io.load(CAPTURE_V2_STORAGE_KEY) !== null) return this.loadCapture();

    const envelope = migrateCaptureV1(legacy);
    this.io.save(CAPTURE_V2_STORAGE_KEY, envelope);
    const readBack = readCaptureEnvelope(this.io.load(CAPTURE_V2_STORAGE_KEY));
    if (JSON.stringify(readBack) !== JSON.stringify(envelope)) {
      throw new UnreadableState("the migrated capture did not read back");
    }
    this.io.save(CAPTURE_STORAGE_KEY, null);
    return readBack;
  }
}
