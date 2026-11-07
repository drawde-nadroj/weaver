import { describe, expect, it } from "vitest";

import {
  LocalState,
  WORKSPACE_STORAGE_KEY,
  type LocalStateRecord,
  type LocalStorageIo
} from "../src/entries/local-state";

/** An in-memory vault-local store that can be told to fail its reads. */
class MemoryIo implements LocalStorageIo {
  readonly values = new Map<string, unknown>();
  failRead = false;
  writes = 0;

  load(key: string): unknown | null {
    if (this.failRead) throw new Error("storage is unavailable");
    return this.values.has(key) ? this.values.get(key) : null;
  }

  save(key: string, value: unknown): void {
    this.writes += 1;
    this.values.set(key, value);
  }
}

/** A stored record with no workspace or schedule memory. */
function emptyRecord(): LocalStateRecord {
  return { workspaces: { activeContextId: null, snapshots: {}, selections: {} }, schedules: {} };
}

describe("workspace updates", () => {
  it("applies one update to the latest record and returns what it stored", () => {
    const io = new MemoryIo();
    const local = new LocalState(io);

    let calls = 0;
    const next = local.updateWorkspace((current) => {
      calls += 1;
      return { ...current, workspaces: { ...current.workspaces, activeContextId: "main" } };
    });

    expect(calls).toBe(1);
    expect(next.workspaces.activeContextId).toBe("main");
    expect(io.values.get(WORKSPACE_STORAGE_KEY)).toBe(next);
  });

  it("preserves a field another owner wrote before the second update's read", () => {
    const io = new MemoryIo();
    const local = new LocalState(io);

    // A portal acknowledges an invitation first...
    local.updateWorkspace((current) => ({
      ...current,
      schedules: {
        ...current.schedules,
        rhythm: { activatedAt: 1, acknowledgedThrough: 2, pending: null, generation: 3 }
      }
    }));

    // ...then a delayed workspace travel writes only its own slice.
    local.updateWorkspace((current) => ({
      ...current,
      workspaces: { ...current.workspaces, activeContextId: "ctx-spanish" }
    }));

    const stored = io.values.get(WORKSPACE_STORAGE_KEY) as LocalStateRecord;
    expect(stored.workspaces.activeContextId).toBe("ctx-spanish");
    expect(stored.schedules["rhythm"]?.acknowledgedThrough).toBe(2);
  });

  it("keeps a schedule written during an awaited travel whose write started from an older read", async () => {
    const io = new MemoryIo();
    const local = new LocalState(io);

    // The travel reads the record to find its snapshot, then awaits layout work.
    const readBefore = local.workspace();
    expect(readBefore.schedules).toEqual({});

    // During that await, a portal acknowledgement lands.
    local.updateWorkspace((current) => ({
      ...current,
      schedules: {
        ...current.schedules,
        rhythm: { activatedAt: 1, acknowledgedThrough: 9, pending: null, generation: 4 }
      }
    }));

    await Promise.resolve();

    // The travel finishes, writing only the active destination it owns.
    local.updateWorkspace((current) => ({
      ...current,
      workspaces: { ...current.workspaces, activeContextId: "ctx-spanish" }
    }));

    const stored = io.values.get(WORKSPACE_STORAGE_KEY) as LocalStateRecord;
    expect(stored.workspaces.activeContextId).toBe("ctx-spanish");
    expect(stored.schedules["rhythm"]?.acknowledgedThrough).toBe(9);
  });

  it("propagates a storage read failure instead of overwriting with an empty record", () => {
    const io = new MemoryIo();
    const local = new LocalState(io);
    io.failRead = true;

    expect(() => local.updateWorkspace((current) => current)).toThrow("storage is unavailable");
    expect(io.writes).toBe(0);
  });

  it("still yields an empty record when a display read fails", () => {
    const io = new MemoryIo();
    const local = new LocalState(io);
    io.failRead = true;

    expect(local.workspace()).toEqual(emptyRecord());
  });
});
