import { describe, expect, it } from "vitest";

import {
  captureInstantAt,
  type CaptureReceipt,
  type ThoughtRef
} from "../src/core/capture";
import {
  restoredOf,
  storedOf,
  type CaptureState,
  type DraftData,
  type PendingWrite
} from "../src/core/capture-state";
import { CaptureStoreV2, CAPTURE_V2_STORAGE_KEY, CaptureConflict, migrateCaptureV1, readCaptureEnvelope } from "../src/entries/capture-store";
import type { CaptureRecord } from "../src/entries/capture";
import { CAPTURE_STORAGE_KEY, UnreadableState, type LocalStorageIo } from "../src/entries/local-state";

const ref: ThoughtRef = {
  path: "Chrono/2026.11.05.md",
  n: 1,
  b: 1,
  d: 1,
  rootN: 1,
  day: "2026-11-05",
  time: "09:00:00",
  prose: "typed"
};

const instant = captureInstantAt(new Date(2026, 10, 5, 9, 0, 0).getTime());

const draft: DraftData = {
  id: "d1",
  target: { kind: "root", contextId: "main" },
  text: "typed",
  selection: { from: 5, to: 5 },
  beginning: instant,
  durationMs: 2000,
  invitations: []
};

const pending: PendingWrite = {
  kind: "capture",
  intent: {
    kind: "capture",
    id: "op1",
    draft,
    published: instant,
    portal: null
  },
  receipt: {
    kind: "capture",
    id: "op1",
    path: "Chrono/2026.11.05.md",
    before: "before bytes",
    expected: "expected bytes",
    saved: { thought: ref, root: ref }
  }
};

/** In-memory vault-local storage. */
class MemoryIo implements LocalStorageIo {
  readonly values = new Map<string, unknown>();
  load(key: string): unknown | null {
    return this.values.has(key) ? this.values.get(key) : null;
  }
  save(key: string, value: unknown): void {
    this.values.set(key, value);
  }
}

describe("projecting a runtime state", () => {
  it("stores a running draft as its frozen data and restores it paused", () => {
    const state: CaptureState = {
      kind: "draft",
      draft: { ...draft, clock: { baselineMs: 2000, resumedAt: null, shownMs: 2000 } }
    };
    const stored = storedOf(state);
    expect(stored).toEqual({ kind: "draft", draft });
    const restored = restoredOf(stored);
    expect(restored.kind).toBe("draft");
    if (restored.kind === "draft") expect(restored.draft.clock.shownMs).toBe(2000);
  });

  it("stores every in-flight state as pending and restores it as unconfirmed", () => {
    const runtime: CaptureState = { kind: "checking", pending };
    expect(storedOf(runtime)).toEqual({ kind: "pending", pending });
    expect(restoredOf({ kind: "pending", pending }).kind).toBe("unconfirmed");
  });

  it("serializes an unanswered proposal as the draft it protects", () => {
    const state: CaptureState = {
      kind: "target-confirmation",
      draft: { ...draft, clock: { baselineMs: 0, resumedAt: null, shownMs: 0 } },
      proposalId: 4,
      proposed: { kind: "root", contextId: "other" }
    };
    const stored = storedOf(state);
    expect(stored.kind).toBe("draft");
  });
});

describe("the v2 envelope", () => {
  it("round-trips through JSON", () => {
    const envelope = { version: 2 as const, revision: 3, state: storedOf({ kind: "resting", saved: { thought: ref, root: ref } }), acknowledgements: [] };
    expect(readCaptureEnvelope(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope);
  });

  it("refuses a wrong version or a non-positive revision", () => {
    expect(() => readCaptureEnvelope({ version: 1, revision: 1, state: { kind: "empty" } })).toThrow(UnreadableState);
    expect(() => readCaptureEnvelope({ version: 2, revision: 0, state: { kind: "empty" } })).toThrow(UnreadableState);
  });

  it("refuses a pending whose intent and receipt disagree", () => {
    const broken = {
      version: 2,
      revision: 1,
      state: { kind: "pending", pending: { kind: "capture", intent: pending.intent, receipt: { ...pending.receipt, kind: "revision" } } },
      acknowledgements: []
    };
    expect(() => readCaptureEnvelope(broken)).toThrow(UnreadableState);
  });
});

describe("the versioned store", () => {
  it("enforces compare-and-set on the revision", () => {
    const io = new MemoryIo();
    const store = new CaptureStoreV2(io);
    const next = { version: 2 as const, revision: 0, state: storedOf({ kind: "empty" }), acknowledgements: [] };

    expect(store.saveCapture(next, null).revision).toBe(1);
    expect(() => store.saveCapture(next, null)).toThrow(CaptureConflict);
    expect(store.saveCapture(next, 1).revision).toBe(2);
    expect(store.loadCapture()?.revision).toBe(2);
  });

  it("refuses to overwrite a record it cannot read", () => {
    const io = new MemoryIo();
    io.save(CAPTURE_V2_STORAGE_KEY, { version: 2, revision: 1, state: "nonsense" });
    const store = new CaptureStoreV2(io);
    expect(() => store.loadCapture()).toThrow(UnreadableState);
    expect(() => store.saveCapture({ version: 2, revision: 0, state: storedOf({ kind: "empty" }), acknowledgements: [] }, 1)).toThrow(
      CaptureConflict
    );
  });
});

describe("migrating version 1", () => {
  const receipt: CaptureReceipt = {
    id: "receipt-1",
    request: {
      contextId: "main",
      parent: null,
      text: "typed",
      beginning: instant,
      durationMs: 2000,
      portal: null
    },
    invitations: [],
    path: "Chrono/2026.11.05.md",
    thought: ref,
    root: ref,
    before: "before bytes",
    expected: "expected bytes"
  };
  const v1: CaptureRecord = { draft: null, receipt };

  it("preserves receipt bytes and every reference as a pending write", () => {
    const envelope = migrateCaptureV1(v1);
    expect(envelope.version).toBe(2);
    expect(envelope.state.kind).toBe("pending");
    if (envelope.state.kind === "pending") {
      const write = envelope.state.pending;
      if (write.kind === "capture") {
        expect(write.receipt.before).toBe("before bytes");
        expect(write.receipt.expected).toBe("expected bytes");
        expect(write.receipt.saved.thought).toEqual(ref);
        expect(write.intent.published).toEqual(instant);
      }
    }
  });

  it("writes v2, reads it back, and only then retires v1", () => {
    const io = new MemoryIo();
    io.save(CAPTURE_STORAGE_KEY, v1);
    const store = new CaptureStoreV2(io);

    const migrated = store.migrateFromV1(v1);

    expect(migrated?.version).toBe(2);
    expect(io.load(CAPTURE_V2_STORAGE_KEY)).not.toBeNull();
    expect(io.load(CAPTURE_STORAGE_KEY)).toBeNull();
  });

  it("keeps a draft's branch parent rather than making it a root", () => {
    const parent = { ...ref, n: 2, prose: "parent" };
    const envelope = migrateCaptureV1({
      draft: {
        contextId: "main",
        parent,
        root: parent,
        text: "child",
        selection: { from: 5, to: 5 },
        beginning: null,
        durationMs: 0,
        collapsed: false,
        invitations: []
      },
      receipt: null
    });
    expect(envelope.state.kind).toBe("draft");
    if (envelope.state.kind === "draft") {
      expect(envelope.state.draft.target).toEqual({ kind: "branch", parent });
    }
  });
});
