/**
 * What this device remembers about Weaver, and nothing that syncs.
 *
 * Two records, deliberately separate. `weaver:local-state:v1` holds the things a
 * session rebuilds — per-destination layouts, per-pane positions, the last saved
 * thread of each destination, the active destination, and each schedule's
 * outstanding invitation. `weaver:capture:v1` holds the one unsaved draft and the
 * one submission receipt, which must be written together: a keystroke saves a
 * draft on every commit, and serialising every layout with it would rewrite a
 * workspace's worth of JSON per character.
 *
 * Neither belongs in the plugin's `data.json`, which syncs. A draft is the
 * device's unfinished work, a layout is that device's screen, and an
 * acknowledgement is that device's answer to an invitation — sharing them would
 * let one machine's screen rearrange another's, or announce a schedule twice.
 *
 * Everything here is validated on the way in. A stored value is data that may
 * have been written by another build, hand-edited, or half-written, so a record
 * this module cannot read is reported and left exactly as it is: overwriting it
 * would destroy the only copy of the writer's unsaved words.
 */

import type { CaptureInvitation, CaptureReceipt, DraftRecord, ThoughtRef } from "../core/capture";
import { portalContainsBeginning, type PortalInstant } from "../core/portals";
import { isPlainObject as isRecord } from "../core/value";
import type { CaptureRecord, CaptureStore } from "./capture";

/** The key the workspace-side record lives under. */
export const WORKSPACE_STORAGE_KEY = "weaver:local-state:v1";

/** The key the one draft and its receipt live under. */
export const CAPTURE_STORAGE_KEY = "weaver:capture:v1";

/** The key this device's stable id lives under, never synced with the vault. */
export const DEVICE_STORAGE_KEY = "weaver:device:v1";

/** The storage a record is kept in: Obsidian's vault-local storage, injected. */
export interface LocalStorageIo {
  /** The stored value, or null when nothing was ever stored under this key. */
  load(key: string): unknown | null;
  /** Stores the value, replacing whatever was there. Throws when it cannot. */
  save(key: string, value: unknown): void;
}

/** One pane's position, keyed by the path it shows. */
export interface PanePosition {
  path: string;
  /** The pane's own ephemeral state, as the host gave it. */
  state: unknown;
  /**
   * The host leaf this position belongs to, when it has an identity.
   *
   * Two panes can show one file in different modes, so a path alone cannot say
   * which of them a position came from. Matching the leaf first is what keeps a
   * reading pane reading and an editing pane editing.
   */
  leafId: string | null;
  /** Which view the pane was in; absent in records written before this field. */
  mode: "source" | "preview";
}

/** Where a destination was last left: its layout, and what each pane showed. */
export interface WorkspaceSnapshot {
  /** The host's layout object, cloned so it can never be mutated in place. */
  layout: unknown;
  /** One entry per markdown pane, in layout order. */
  panes: PanePosition[];
  /** The file that was active. */
  activePath: string | null;
  /** The leaf that held focus, when the snapshot knows it. */
  activeLeafId: string | null;
}

/** Per-destination memory, namespaced by platform so two screens never merge. */
export interface WorkspaceRecord {
  /** The destination the writer was last viewing. */
  activeContextId: string | null;
  /** `platform:contextId` → the last layout used there. */
  snapshots: Record<string, WorkspaceSnapshot>;
  /** `platform:contextId` → the last saved thread selected there. */
  selections: Record<string, ThoughtRef>;
}

/** What one schedule remembers between sessions. */
export interface ScheduleRuntime {
  /** When this activation began: no occurrence before it is ever offered. */
  activatedAt: number;
  /** The last opening this device answered, in epoch milliseconds. */
  acknowledgedThrough: number | null;
  /** The one outstanding invitation, if one is showing. */
  pending: unknown;
  /** Bumped when time or destination changes; older answers are ignored. */
  generation: number;
}

/** Everything the workspace-side record holds. */
export interface LocalStateRecord {
  workspaces: WorkspaceRecord;
  schedules: Record<string, ScheduleRuntime>;
}

/** A stored record this module could not read, with the value left untouched. */
export class UnreadableState extends Error {}

/** A finite number, or null. */
function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A non-empty string, or null. */
function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A whole, non-negative integer, or null. */
function whole(value: unknown): number | null {
  const numeric = finite(value);
  return numeric !== null && Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
}

/** A reference this build can still try to validate against a note. */
function readThought(value: unknown): ThoughtRef | null {
  if (!isRecord(value)) return null;
  const path = text(value["path"]);
  const n = whole(value["n"]);
  const b = whole(value["b"]);
  const d = whole(value["d"]);
  const rootN = whole(value["rootN"]);
  if (path === null || n === null || b === null || d === null || rootN === null) return null;
  if (n < 1 || b < 1 || d < 1 || rootN < 1) return null;

  const day = value["day"] === null ? null : text(value["day"]);
  const time = value["time"] === null ? null : text(value["time"]);
  if (value["day"] !== null && day === null) return null;
  if (value["time"] !== null && time === null) return null;

  return {
    path,
    n,
    b,
    d,
    rootN,
    day,
    time,
    prose: typeof value["prose"] === "string" ? value["prose"] : ""
  };
}

function readBeginning(value: unknown): DraftRecord["beginning"] {
  if (!isRecord(value)) return null;
  const at = finite(value["at"]);
  const day = text(value["day"]);
  const time = text(value["time"]);
  const localTimestamp = text(value["localTimestamp"]);
  if (at === null || day === null || time === null || localTimestamp === null) return null;
  return { at, day, time, localTimestamp };
}

/** One opening's frozen local facts, or null when they cannot describe one. */
function readPortalInstant(value: unknown): PortalInstant | null {
  if (!isRecord(value)) return null;
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

/**
 * One stored invitation, or null when it is not evidence of anything.
 *
 * The occurrence identity has to agree with its own two halves, and the frozen
 * opening has to contain the beginning it was stored beside: an invitation that
 * cannot be checked is not silently believed, because believing it would write a
 * record into a note that no opening ever qualified.
 */
function readInvitation(value: unknown, beginning: DraftRecord["beginning"]): CaptureInvitation | null {
  if (!isRecord(value)) return null;
  const occurrenceId = text(value["occurrenceId"]);
  const scheduleId = text(value["scheduleId"]);
  const generation = whole(value["generation"]);
  const contextId = text(value["contextId"]);
  const portal = readPortalInstant(value["portal"]);
  if (occurrenceId === null || scheduleId === null || generation === null) return null;
  if (contextId === null || portal === null) return null;
  if (occurrenceId !== `${scheduleId}@${portal.id}`) return null;
  if (beginning !== null && !portalContainsBeginning(portal, beginning.at)) return null;

  return {
    occurrenceId,
    scheduleId,
    name: typeof value["name"] === "string" ? value["name"] : scheduleId,
    generation,
    portal,
    contextId
  };
}

/** Every readable invitation, and one warning per entry that was dropped. */
function readInvitations(
  value: unknown,
  beginning: DraftRecord["beginning"],
  where: string,
  warnings: string[]
): CaptureInvitation[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`${where}: the stored openings were not a list, so none were kept.`);
    return [];
  }

  const invitations: CaptureInvitation[] = [];
  for (const raw of value) {
    const invitation = readInvitation(raw, beginning);
    if (invitation === null) {
      warnings.push(
        `${where}: one opening could not be trusted, so it was not kept. The draft itself is untouched.`
      );
      continue;
    }
    invitations.push(invitation);
  }
  return invitations;
}

/** A draft, or null when the stored one cannot be trusted. */
function readDraft(value: unknown, warnings: string[]): DraftRecord | null {
  if (!isRecord(value)) return null;
  const contextId = text(value["contextId"]);
  if (contextId === null) return null;
  if (typeof value["text"] !== "string") return null;

  const selection = isRecord(value["selection"]) ? value["selection"] : {};
  const from = whole(selection["from"]) ?? 0;
  const to = whole(selection["to"]) ?? from;
  const beginning = readBeginning(value["beginning"]);

  return {
    contextId,
    parent: value["parent"] === null ? null : readThought(value["parent"]),
    root: value["root"] === null ? null : readThought(value["root"]),
    text: value["text"],
    selection: { from, to },
    beginning,
    durationMs: whole(value["durationMs"]) ?? 0,
    collapsed: value["collapsed"] === true,
    invitations: readInvitations(value["invitations"], beginning, "The stored draft", warnings)
  };
}

/** A receipt, or null when the stored one cannot be trusted. */
function readReceipt(value: unknown, warnings: string[]): CaptureReceipt | null {
  if (!isRecord(value)) return null;
  const id = text(value["id"]);
  const path = text(value["path"]);
  const before = typeof value["before"] === "string" ? value["before"] : null;
  const expected = typeof value["expected"] === "string" ? value["expected"] : null;
  const thought = readThought(value["thought"]);
  const root = readThought(value["root"]);
  const request = isRecord(value["request"]) ? value["request"] : null;
  if (id === null || path === null || before === null || expected === null) return null;
  if (thought === null || root === null || request === null) return null;

  const contextId = text(request["contextId"]);
  const body = typeof request["text"] === "string" ? request["text"] : null;
  const beginning = readBeginning(request["beginning"]);
  if (contextId === null || body === null || beginning === null) return null;

  // The single portal a request carries is provenance too: decoded when it is
  // readable, dropped with a warning when it is not, and never invented.
  const portal = request["portal"] === null ? null : readPortalInstant(request["portal"]);
  if (request["portal"] !== null && portal === null) {
    warnings.push("The interrupted save named an opening that could not be read; it was not kept.");
  }

  return {
    id,
    request: {
      contextId,
      parent: request["parent"] === null ? null : readThought(request["parent"]),
      text: body,
      beginning,
      durationMs: whole(request["durationMs"]) ?? 0,
      portal
    },
    path,
    thought,
    root,
    before,
    expected,
    invitations: readInvitations(
      value["invitations"],
      beginning,
      "The interrupted save",
      warnings
    )
  };
}

/**
 * The stored capture, or null.
 *
 * A record that cannot be read is *not* silently dropped here: the caller gets
 * the exception, keeps the raw value, and tells the writer that recovery is
 * unavailable. Capture still works in memory.
 *
 * Provenance is the one part that degrades instead of refusing: an opening that
 * cannot be trusted is dropped into `warnings` while the words stay, because a
 * doubtful record is worth much less than the prose beside it.
 */
export function readCaptureRecord(value: unknown): CaptureRecord | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new UnreadableState("the stored capture is not an object");

  const warnings: string[] = [];
  const draft = value["draft"] === null ? null : readDraft(value["draft"], warnings);
  const receipt = value["receipt"] === null ? null : readReceipt(value["receipt"], warnings);
  if (value["draft"] !== null && draft === null) {
    throw new UnreadableState("the stored draft could not be read");
  }
  if (value["receipt"] !== null && receipt === null) {
    throw new UnreadableState("the stored submission receipt could not be read");
  }
  return { draft, receipt, warnings };
}

/**
 * A snapshot, or null when the stored one cannot be trusted.
 *
 * A record written before panes carried an identity still restores: its missing
 * leaf ids and mode decode as `null` and `source`, which the matcher then treats
 * as "match by path alone, and only where that is unambiguous".
 */
function readSnapshot(value: unknown): WorkspaceSnapshot | null {
  if (!isRecord(value)) return null;
  const panes: PanePosition[] = [];
  for (const pane of Array.isArray(value["panes"]) ? value["panes"] : []) {
    if (!isRecord(pane)) continue;
    const path = text(pane["path"]);
    if (path === null) continue;
    panes.push({
      path,
      state: pane["state"] ?? null,
      leafId: text(pane["leafId"]),
      mode: pane["mode"] === "preview" ? "preview" : "source"
    });
  }
  return {
    layout: value["layout"] ?? null,
    panes,
    activePath: value["activePath"] === null ? null : text(value["activePath"]),
    activeLeafId: text(value["activeLeafId"])
  };
}

/** The stored workspace record, with everything unreadable dropped. */
export function readWorkspaceRecord(value: unknown): LocalStateRecord {
  const empty: LocalStateRecord = {
    workspaces: { activeContextId: null, snapshots: {}, selections: {} },
    schedules: {}
  };
  if (!isRecord(value)) return empty;

  const workspaces = isRecord(value["workspaces"]) ? value["workspaces"] : {};
  const snapshots: Record<string, WorkspaceSnapshot> = {};
  for (const [key, raw] of Object.entries(isRecord(workspaces["snapshots"]) ? workspaces["snapshots"] : {})) {
    const snapshot = readSnapshot(raw);
    if (snapshot !== null) snapshots[key] = snapshot;
  }

  const selections: Record<string, ThoughtRef> = {};
  for (const [key, raw] of Object.entries(isRecord(workspaces["selections"]) ? workspaces["selections"] : {})) {
    const ref = readThought(raw);
    if (ref !== null) selections[key] = ref;
  }

  const schedules: Record<string, ScheduleRuntime> = {};
  for (const [key, raw] of Object.entries(isRecord(value["schedules"]) ? value["schedules"] : {})) {
    if (!isRecord(raw)) continue;
    const activatedAt = finite(raw["activatedAt"]);
    if (activatedAt === null) continue;
    schedules[key] = {
      activatedAt,
      acknowledgedThrough: finite(raw["acknowledgedThrough"]),
      pending: raw["pending"] ?? null,
      generation: whole(raw["generation"]) ?? 0
    };
  }

  return {
    workspaces: {
      activeContextId: workspaces["activeContextId"] === null ? null : text(workspaces["activeContextId"]),
      snapshots,
      selections
    },
    schedules
  };
}

/**
 * The two records, over vault-local storage.
 *
 * Reads are defensive and writes are direct: a save that cannot happen throws,
 * which is the one signal a caller must not ignore — an unrecorded submission is
 * exactly the case recovery cannot describe.
 */
export class LocalState implements CaptureStore {
  constructor(private readonly io: LocalStorageIo) {}

  /**
   * The workspace-side record, with anything unreadable dropped.
   *
   * This is the forgiving read a label is drawn from: a store that cannot be
   * read yields an empty record so the surface still renders, because a display
   * that fails is worse than one that forgets.
   */
  workspace(): LocalStateRecord {
    try {
      return readWorkspaceRecord(this.io.load(WORKSPACE_STORAGE_KEY));
    } catch {
      return readWorkspaceRecord(null);
    }
  }

  /**
   * Reads the latest record, applies one synchronous update, stores the result.
   *
   * Unlike {@link workspace}, a read that throws is propagated: an update is a
   * mutation, and building the written envelope from an unreadable store would
   * erase the fields another owner just wrote. The updater runs exactly once
   * against the freshly-read record, so two owners — a portal acknowledgement and
   * a delayed workspace travel, say — never write from the same snapshot and
   * cannot undo each other's fields.
   */
  updateWorkspace(update: (current: LocalStateRecord) => LocalStateRecord): LocalStateRecord {
    const current = readWorkspaceRecord(this.io.load(WORKSPACE_STORAGE_KEY));
    const next = update(current);
    this.io.save(WORKSPACE_STORAGE_KEY, next);
    return next;
  }

  /** The one draft and its receipt, or null. Throws when it cannot be read. */
  load(): CaptureRecord | null {
    return readCaptureRecord(this.io.load(CAPTURE_STORAGE_KEY));
  }

  /** Writes the draft and the receipt as one value, so they cannot disagree. */
  save(record: CaptureRecord): void {
    this.io.save(CAPTURE_STORAGE_KEY, record);
  }

  /**
   * This device's stable id, created on first use and kept device-local.
   *
   * It names which device advanced a Review stamp, so it must never sync with the
   * vault: two machines would share an identity and defeat the hybrid clock. A
   * store that cannot persist the new id still returns it for this session.
   */
  deviceId(): string {
    let stored: unknown = null;
    try {
      stored = this.io.load(DEVICE_STORAGE_KEY);
    } catch {
      stored = null;
    }
    if (typeof stored === "string" && stored !== "") return stored;

    const source = globalThis.crypto as { randomUUID?: () => string } | undefined;
    const id =
      typeof source?.randomUUID === "function"
        ? source.randomUUID()
        : `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      this.io.save(DEVICE_STORAGE_KEY, id);
    } catch {
      // A device that cannot remember its id still has one for this session.
    }
    return id;
  }

  /** Forgets the draft and the receipt together. */
  clear(): void {
    this.io.save(CAPTURE_STORAGE_KEY, null);
  }
}
