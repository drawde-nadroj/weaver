import { describe, expect, it } from "vitest";

import type { ThoughtRef } from "../src/core/capture";
import type { ReviewCursor, ReviewDefinition } from "../src/core/reviews";
import { PluginDataStore, type PluginDataPorts } from "../src/entries/plugin-data";
import { DEFAULT_SETTINGS, type WeaverData } from "../src/settings";

/** In-memory shared file and device replica, with a controllable failure. */
class Ports implements PluginDataPorts {
  shared: unknown = null;
  replica: unknown = null;
  writes = 0;
  fail = false;
  clock = 1000;
  notices: string[] = [];
  changes = 0;

  async readShared(): Promise<unknown> {
    return this.shared;
  }

  async writeShared(data: WeaverData): Promise<void> {
    if (this.fail) throw new Error("disk is full");
    this.writes += 1;
    this.shared = JSON.parse(JSON.stringify(data));
  }

  readLocal(): unknown | null {
    return this.replica;
  }

  writeLocal(value: unknown): void {
    this.replica = JSON.parse(JSON.stringify(value));
  }

  now(): number {
    return this.clock++;
  }

  deviceId(): string {
    return "dev";
  }

  notify(message: string): void {
    this.notices.push(message);
  }

  onChange(): void {
    this.changes += 1;
  }
}

const PATH = "Chrono/2026.11.05.md";

const ref = (n: number, prose = "hi"): ThoughtRef => ({
  path: PATH,
  n,
  b: 1,
  d: 1,
  rootN: n,
  day: "2026-11-05",
  time: "09:00:00",
  prose
});

const definition = (name = "Review"): ReviewDefinition => ({
  name,
  tapestryId: "main",
  from: "2026-11-01",
  through: "2026-11-05",
  order: "time",
  beginAt: "first"
});

const cursor = (n: number | null): ReviewCursor => ({ thought: n === null ? null : ref(n), textOffset: 0 });

describe("one Review, one id", () => {
  it("accepts a create synchronously and shares it after a flush", async () => {
    const ports = new Ports();
    const store = new PluginDataStore(ports);
    await store.load();

    const accepted = store.saveReview({ id: "r1", mode: "create", definition: definition(), cursor: cursor(null) });
    expect(accepted.kind).toBe("accepted");
    await store.flush();

    const shared = ports.shared as WeaverData;
    expect(shared.version).toBe(4);
    expect(Object.keys(shared.reviews)).toEqual(["r1"]);
  });

  it("treats a repeated create with the same content as the same save", async () => {
    const store = new PluginDataStore(new Ports());
    await store.load();
    const change = { id: "r1", mode: "create" as const, definition: definition(), cursor: cursor(null) };

    const first = store.saveReview(change);
    const second = store.saveReview(change);
    expect(first.kind).toBe("accepted");
    expect(second.kind).toBe("accepted");
    if (first.kind === "accepted" && second.kind === "accepted") {
      expect(second.definitionStamp).toEqual(first.definitionStamp);
    }
  });

  it("refuses a different definition under an existing id, and a deleted id", async () => {
    const store = new PluginDataStore(new Ports());
    await store.load();
    store.saveReview({ id: "r1", mode: "create", definition: definition("A"), cursor: cursor(null) });

    expect(
      store.saveReview({ id: "r1", mode: "create", definition: definition("B"), cursor: cursor(null) }).kind
    ).toBe("refused");

    store.deleteReview("r1");
    const afterDelete = store.saveReview({ id: "r1", mode: "create", definition: definition("A"), cursor: cursor(null) });
    expect(afterDelete.kind).toBe("refused");
    if (afterDelete.kind === "refused") expect(afterDelete.reason).toBe("deleted");
  });
});

describe("settings and shared data", () => {
  it("keeps the shared Reviews when only settings are saved", async () => {
    const ports = new Ports();
    ports.shared = {
      version: 4,
      settings: { ...DEFAULT_SETTINGS, debug: true },
      reviews: {
        r1: {
          id: "r1",
          definition: { definition: definition(), stamp: { wallMs: 1, counter: 0, deviceId: "d" } },
          cursor: { cursor: cursor(null), stamp: { wallMs: 1, counter: 0, deviceId: "d" } },
          tombstone: null
        }
      }
    };
    const store = new PluginDataStore(ports);
    await store.load();

    await store.saveSettings({ ...DEFAULT_SETTINGS, debug: false });

    const shared = ports.shared as WeaverData;
    expect(shared.settings.debug).toBe(false);
    expect(shared.reviews["r1"]).toBeDefined();
  });

  it("blocks writes when the shared Reviews cannot be read, without clobbering them", async () => {
    const ports = new Ports();
    ports.shared = { version: 4, settings: {}, reviews: { r1: 42 } };
    const store = new PluginDataStore(ports);
    await store.load();

    expect(store.blocked).toBe(true);
    const refused = store.saveReview({ id: "r2", mode: "create", definition: definition(), cursor: cursor(null) });
    expect(refused.kind).toBe("refused");
    if (refused.kind === "refused") expect(refused.reason).toBe("blocked");
  });
});

describe("retry after a failed shared write", () => {
  it("retains the local change and converges on a later flush", async () => {
    const ports = new Ports();
    const store = new PluginDataStore(ports);
    await store.load();

    ports.fail = true;
    store.saveReview({ id: "r1", mode: "create", definition: definition(), cursor: cursor(null) });
    await store.flush();
    expect(ports.notices.join(" ")).toContain("Saved locally");
    expect(ports.replica).not.toBeNull();

    ports.fail = false;
    await store.flush();
    const shared = ports.shared as WeaverData;
    expect(Object.keys(shared.reviews)).toEqual(["r1"]);
  });
});

describe("cursor rebinds", () => {
  it("moves only a cursor still exactly on the original thought", async () => {
    const ports = new Ports();
    ports.shared = {
      version: 4,
      settings: DEFAULT_SETTINGS,
      reviews: {
        moved: {
          id: "moved",
          definition: { definition: definition(), stamp: { wallMs: 1, counter: 0, deviceId: "d" } },
          cursor: { cursor: cursor(1), stamp: { wallMs: 1, counter: 0, deviceId: "d" } },
          tombstone: null
        },
        elsewhere: {
          id: "elsewhere",
          definition: { definition: definition(), stamp: { wallMs: 1, counter: 0, deviceId: "d" } },
          cursor: { cursor: cursor(9), stamp: { wallMs: 1, counter: 0, deviceId: "d" } },
          tombstone: null
        }
      }
    };
    const store = new PluginDataStore(ports);
    await store.load();

    const before = ref(1);
    const after = ref(1, "corrected");
    store.stageRebind("op-1", before, after);
    await store.flush();

    const shared = ports.shared as WeaverData;
    expect(shared.reviews["moved"]?.cursor.cursor.thought?.prose).toBe("corrected");
    expect(shared.reviews["elsewhere"]?.cursor.cursor.thought?.n).toBe(9);
  });
});

describe("external change", () => {
  it("merges a freshly arrived Review without disturbing the local one", async () => {
    const ports = new Ports();
    const store = new PluginDataStore(ports);
    await store.load();
    store.saveReview({ id: "r1", mode: "create", definition: definition(), cursor: cursor(null) });
    await store.flush();

    const current = ports.shared as WeaverData;
    ports.shared = {
      ...current,
      reviews: {
        ...current.reviews,
        r2: {
          id: "r2",
          definition: { definition: definition("Other"), stamp: { wallMs: 5, counter: 0, deviceId: "other" } },
          cursor: { cursor: cursor(null), stamp: { wallMs: 5, counter: 0, deviceId: "other" } },
          tombstone: null
        }
      }
    };
    await store.onExternalChange();

    expect(Object.keys(store.currentReviews).sort()).toEqual(["r1", "r2"]);
  });
});
