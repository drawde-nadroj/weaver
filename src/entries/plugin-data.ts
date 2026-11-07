/**
 * The one owner of `data.json`: settings, shared Reviews and the serialized
 * read–merge–save that keeps two devices from erasing each other.
 *
 * Every write goes through one queue. A job reads the current disk and the current
 * local state when it starts — never a cached envelope — merges the Review
 * registers by their stamps, applies any staged cursor rebinds, and writes the
 * union only when it differs. A failed shared write keeps the local replica and
 * pending ids, so a later flush converges; an unreadable or newer envelope blocks
 * writes rather than replacing the writer's shared work with an empty collection.
 *
 * A Review-only save must never restart controllers or reconfigure runtime
 * settings, and an ordinary settings save keeps whole-settings semantics while
 * preserving the Reviews it did not mean to touch.
 *
 * The store never claims provider delivery: it writes `data.json` and says so.
 * Delivery is whatever sync the writer has configured.
 */

import {
  advanceStamp,
  compareStamps,
  mergeReviewMaps,
  readReviewMap,
  type ReviewCursor,
  type ReviewMap,
  type ReviewRecord,
  type ReviewSave,
  type ReviewStamp
} from "../core/reviews";
import type { ThoughtRef } from "../core/capture";
import { isPlainObject } from "../core/value";
import { normalizeData, type WeaverData, type WeaverSettings } from "../settings";

/** What a Review save returned synchronously. */
export type ReviewAcceptance =
  | { readonly kind: "accepted"; readonly id: string; readonly definitionStamp: ReviewStamp }
  | {
      readonly kind: "refused";
      readonly reason: "deleted" | "conflict" | "storage" | "blocked";
      readonly message: string;
    };

/** A cursor that must move onto a corrected thought at flush time. */
export interface StagedRebind {
  readonly operationId: string;
  readonly before: ThoughtRef;
  readonly after: ThoughtRef;
}

/** What the store needs from the host. */
export interface PluginDataPorts {
  /** Reads the whole synced envelope. */
  readShared(): Promise<unknown>;
  /** Writes the whole synced envelope. */
  writeShared(data: WeaverData): Promise<void>;
  /** Reads this device's durable replica, or null. When omitted, it is memory-only. */
  readLocal?(): unknown | null;
  /** Writes this device's durable replica. When omitted, it is memory-only. */
  writeLocal?(value: unknown): void;
  /** The current wall-clock instant, in epoch milliseconds. */
  now(): number;
  /** This device's stable id, for the hybrid clock. */
  deviceId(): string;
  /** Reports an error worth the writer seeing. */
  notify(message: string): void;
  /** Something a surface draws has changed. */
  onChange(): void;
}

/** The local replica's stored shape. */
interface Replica {
  reviews: ReviewMap;
  pending: readonly string[];
  rebinds: readonly StagedRebind[];
  revision: number;
}

/** The global serialization tail, shared across an ordinary plugin reload. */
const TAIL = Symbol.for("weaver.plugin-data.tail");

/** Chains one task behind every other data job in this process. */
function serialize(task: () => Promise<void>): Promise<void> {
  const host = globalThis as unknown as Record<symbol, Promise<void> | undefined>;
  const previous = host[TAIL] ?? Promise.resolve();
  const next = previous.then(task, task);
  host[TAIL] = next.catch(() => {});
  return next;
}

/** True when two references name the same thought, facts and all. */
function sameRef(
  left: StagedRebind["before"],
  right: StagedRebind["before"]
): boolean {
  return (
    left.path === right.path &&
    left.n === right.n &&
    left.b === right.b &&
    left.d === right.d &&
    left.day === right.day &&
    left.time === right.time &&
    left.prose === right.prose
  );
}

/** The store: settings, Reviews, the replica, and the one serialized writer. */
export class PluginDataStore {
  private settings: WeaverSettings;
  private reviews: ReviewMap = {};
  private data: WeaverData;
  private status: "idle" | "writing" | "blocked" = "idle";
  private readonly pending = new Set<string>();
  private rebinds: StagedRebind[] = [];
  private revision = 0;
  private pendingSettings: WeaverSettings | null = null;
  private disposed = false;

  constructor(private readonly ports: PluginDataPorts) {
    this.data = normalizeData(null);
    this.settings = this.data.settings;
  }

  /** The latest settings, read fresh after every merge. */
  get currentSettings(): WeaverSettings {
    return this.settings;
  }

  /** The current shared Reviews, with local changes already merged. */
  get currentReviews(): ReviewMap {
    return this.reviews;
  }

  /** The whole envelope this store owns. */
  get currentData(): WeaverData {
    return this.data;
  }

  /** True when shared writes are blocked by unreadable data. */
  get blocked(): boolean {
    return this.status === "blocked";
  }

  /** Loads shared data, folds in the durable replica, and drains pending work. */
  async load(): Promise<void> {
    await serialize(async () => {
      let shared: WeaverData;
      try {
        const raw = await this.ports.readShared();
        const decoded = this.decode(raw);
        if (decoded === null) {
          this.status = "blocked";
          this.ports.notify("Shared plugin data could not be read; Review sharing is paused.");
          this.ports.onChange();
          return;
        }
        shared = decoded.data;
        this.status = "idle";
      } catch {
        this.status = "blocked";
        this.ports.notify("Shared plugin data could not be read; Review sharing is paused.");
        this.ports.onChange();
        return;
      }

      this.readReplica();
      this.settings = shared.settings;
      this.data = shared;
      this.reviews = mergeReviewMaps(this.reviews, shared.reviews);
      this.ports.onChange();
    });
  }

  /** Saves an explicit settings snapshot, preserving the shared Reviews. */
  async saveSettings(settings: WeaverSettings): Promise<void> {
    this.settings = settings;
    this.data = { ...this.data, settings };
    this.pendingSettings = settings;
    await this.enqueueFlush();
  }

  /**
   * Accepts one Review save synchronously in the durable replica, then shares it.
   *
   * The definition and cursor are stamped now; the shared write happens on the
   * queue. A store that cannot write its replica refuses rather than losing the
   * change silently.
   */
  saveReview(change: ReviewSave): ReviewAcceptance {
    if (this.status === "blocked") {
      return { kind: "refused", reason: "blocked", message: "Shared data is unreadable; saving is paused." };
    }

    const existing = this.reviews[change.id];
    if (existing?.tombstone !== null && existing?.tombstone !== undefined) {
      return { kind: "refused", reason: "deleted", message: "This Review was deleted; save as a new Review." };
    }
    if (change.mode === "create" && existing !== undefined) {
      // A retried create with the same identity and content is the same save, not
      // a conflict: report the stamp it already has.
      if (
        JSON.stringify(existing.definition.definition) === JSON.stringify(change.definition) &&
        JSON.stringify(existing.cursor.cursor) === JSON.stringify(change.cursor)
      ) {
        return { kind: "accepted", id: change.id, definitionStamp: existing.definition.stamp };
      }
      return { kind: "refused", reason: "conflict", message: "That Review already exists." };
    }
    if (change.mode === "update" && existing === undefined) {
      return { kind: "refused", reason: "conflict", message: "That Review no longer exists." };
    }

    const stamp = advanceStamp(this.highestStamp(change.id), this.ports.deviceId(), this.ports.now());
    const record: ReviewRecord = {
      id: change.id,
      definition: { definition: change.definition, stamp },
      cursor: { cursor: change.cursor, stamp },
      tombstone: null
    };

    try {
      this.commit({ ...this.reviews, [change.id]: record }, change.id);
    } catch (error) {
      return {
        kind: "refused",
        reason: "storage",
        message: error instanceof Error ? error.message : "the local replica could not be written"
      };
    }
    void this.enqueueFlush();
    return { kind: "accepted", id: change.id, definitionStamp: stamp };
  }

  /** Moves one Review's cursor, stamped independently of its definition. */
  saveCursor(id: string, cursor: ReviewCursor): void {
    const existing = this.reviews[id];
    if (existing === undefined || existing.tombstone !== null) return;
    const stamp = advanceStamp(this.highestStamp(id), this.ports.deviceId(), this.ports.now());
    const record: ReviewRecord = { ...existing, cursor: { cursor, stamp } };
    try {
      this.commit({ ...this.reviews, [id]: record }, id);
    } catch {
      return;
    }
    void this.enqueueFlush();
  }

  /** Tombstones a Review; a later save of that id is refused, never resurrected. */
  deleteReview(id: string): void {
    const existing = this.reviews[id];
    if (existing === undefined || existing.tombstone !== null) return;
    const stamp = advanceStamp(this.highestStamp(id), this.ports.deviceId(), this.ports.now());
    try {
      this.commit({ ...this.reviews, [id]: { ...existing, tombstone: stamp } }, id);
    } catch {
      return;
    }
    void this.enqueueFlush();
  }

  /**
   * Stages a cursor rebind for a corrected thought.
   *
   * It is written to the replica synchronously, so a crash after the receipt is
   * removed cannot strand a cursor on a superseded address.
   */
  stageRebind(operationId: string, before: StagedRebind["before"], after: StagedRebind["after"]): void {
    this.rebinds = [...this.rebinds.filter((rebind) => rebind.operationId !== operationId), { operationId, before, after }];
    try {
      this.writeReplica(true);
    } catch {
      // The caller still holds the note write's own evidence; the rebind is retried.
    }
  }

  /** Merges an external change without reconfiguring runtime settings. */
  async onExternalChange(): Promise<void> {
    await serialize(async () => {
      try {
        const raw = await this.ports.readShared();
        const decoded = this.decode(raw);
        if (decoded === null) {
          this.status = "blocked";
          this.ports.notify("Shared plugin data could not be read; Review sharing is paused.");
          return;
        }
        const merged = mergeReviewMaps(this.reviews, decoded.data.reviews);
        if (JSON.stringify(merged) !== JSON.stringify(decoded.data.reviews)) {
          await this.ports.writeShared({ ...decoded.data, reviews: merged });
        }
        this.reviews = merged;
        this.data = { ...decoded.data, reviews: merged };
        this.writeReplica(false);
        this.ports.onChange();
      } catch {
        this.ports.notify("Shared plugin data could not be read; Review sharing is paused.");
      }
    });
  }

  /** Drains pending changes now. */
  async flush(): Promise<void> {
    await this.enqueueFlush();
  }

  /** Stops this store; later work is dropped. */
  dispose(): void {
    this.disposed = true;
  }

  /** One serialized read–merge–write of the shared envelope. */
  private enqueueFlush(): Promise<void> {
    return serialize(() => this.runFlush());
  }

  private async runFlush(): Promise<void> {
    if (this.disposed || this.status === "blocked") return;
    if (this.pending.size === 0 && this.rebinds.length === 0 && this.pendingSettings === null) return;

    this.status = "writing";
    try {
      const raw = await this.ports.readShared();
      const decoded = this.decode(raw);
      if (decoded === null) {
        this.status = "blocked";
        this.ports.notify("Shared plugin data could not be read; Review sharing is paused.");
        return;
      }

      let merged = mergeReviewMaps(this.reviews, decoded.data.reviews);
      for (const rebind of this.rebinds) merged = applyRebind(merged, rebind);
      const settings = this.pendingSettings ?? decoded.data.settings;
      const next: WeaverData = { version: 4, settings, reviews: merged };

      if (JSON.stringify(next.reviews) !== JSON.stringify(decoded.data.reviews) || settings !== decoded.data.settings) {
        await this.ports.writeShared(next);
      }

      this.reviews = merged;
      this.settings = settings;
      this.data = next;
      this.pending.clear();
      this.rebinds = [];
      this.pendingSettings = null;
      this.status = "idle";
      this.writeReplica(false);
      this.ports.onChange();
    } catch (error) {
      this.status = "idle";
      this.ports.notify(
        `Saved locally; plugin-data save failed · ${error instanceof Error ? error.message : "retry"}`.trim()
      );
      this.writeReplica(false);
    }
  }

  /** Applies one local change to the replica, or throws when it cannot be written. */
  private commit(next: ReviewMap, pendingId: string): void {
    const previous = this.reviews;
    this.reviews = next;
    this.pending.add(pendingId);
    this.revision += 1;
    try {
      this.writeReplica(true);
    } catch (error) {
      this.reviews = previous;
      this.pending.delete(pendingId);
      this.revision -= 1;
      throw error;
    }
  }

  /** The highest stamp this device has seen for one Review. */
  private highestStamp(id: string): ReviewStamp | null {
    const record = this.reviews[id];
    if (record === undefined) return null;
    let best = record.definition.stamp;
    if (compareStamps(record.cursor.stamp, best) > 0) best = record.cursor.stamp;
    if (record.tombstone !== null && compareStamps(record.tombstone, best) > 0) best = record.tombstone;
    return best;
  }

  /** Decodes the envelope, refusing one this build cannot safely rewrite. */
  private decode(raw: unknown): { data: WeaverData } | null {
    if (raw === null || raw === undefined) {
      return { data: normalizeData(null) };
    }
    if (!isPlainObject(raw)) return null;
    if (isPlainObject(raw["reviews"])) {
      const read = readReviewMap(raw["reviews"]);
      if (read.malformed) return null;
    }
    return { data: normalizeData(raw) };
  }

  private readReplica(): void {
    if (this.ports.readLocal === undefined) return;
    let raw: unknown;
    try {
      raw = this.ports.readLocal();
    } catch {
      return;
    }
    if (!isPlainObject(raw)) return;

    const reviews = readReviewMap(raw["reviews"]).reviews;
    if (Object.keys(reviews).length > 0) this.reviews = mergeReviewMaps(reviews, this.reviews);

    const pending = raw["pending"];
    if (Array.isArray(pending)) {
      for (const id of pending) if (typeof id === "string") this.pending.add(id);
    }

    const rebinds = raw["rebinds"];
    if (Array.isArray(rebinds)) {
      this.rebinds = rebinds.filter(
        (rebind): rebind is StagedRebind =>
          isPlainObject(rebind) &&
          typeof rebind["operationId"] === "string" &&
          isPlainObject(rebind["before"]) &&
          isPlainObject(rebind["after"])
      );
    }

    const revision = raw["revision"];
    if (typeof revision === "number" && Number.isInteger(revision)) this.revision = revision;
  }

  /** Writes the durable replica. `required` makes an unwritable replica throw. */
  private writeReplica(required: boolean): void {
    if (this.ports.writeLocal === undefined) {
      if (required) throw new Error("this host has no durable replica");
      return;
    }
    const replica: Replica = {
      reviews: this.reviews,
      pending: [...this.pending],
      rebinds: this.rebinds,
      revision: this.revision
    };
    try {
      this.ports.writeLocal(replica);
    } catch (error) {
      if (required) throw error;
    }
  }
}

/** Applies a staged cursor rebind to reviews whose cursor still equals `before`. */
function applyRebind(reviews: ReviewMap, rebind: StagedRebind): ReviewMap {
  let changed = false;
  const next: Record<string, ReviewRecord> = { ...reviews };
  for (const [id, record] of Object.entries(reviews)) {
    const thought = record.cursor.cursor.thought;
    if (thought === null || !sameRef(thought, rebind.before)) continue;
    next[id] = { ...record, cursor: { ...record.cursor, cursor: { ...record.cursor.cursor, thought: rebind.after } } };
    changed = true;
  }
  return changed ? next : reviews;
}
