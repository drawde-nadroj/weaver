import { describe, expect, it } from "vitest";

import type { ThoughtRef } from "../src/core/capture";
import type { ReferenceQuery, ReferenceSequence, ThoughtRecord, ThoughtSnapshot } from "../src/core/reference";
import type { ReviewSession } from "../src/entries/reference";
import { ReferenceController, type ReferenceHost } from "../src/entries/reference";
import type { ThoughtIndex } from "../src/entries/thought-index";

const PATH = "Chrono/2026.11.05.md";

const ref = (n: number, prose: string, parentN: number | null = null): ThoughtRef => ({
  path: PATH,
  n,
  b: 1,
  d: parentN === null ? 1 : 2,
  rootN: parentN ?? n,
  day: "2026-11-05",
  time: `0${n}:00:00`,
  prose
});

const record = (n: number, prose: string, parentN: number | null = null): ThoughtRecord => ({
  thought: ref(n, prose, parentN),
  tapestryId: "main",
  noteDay: "2026-11-05",
  parentN,
  durationMs: 0,
  whisper: null
});

const sequence = (members: ThoughtRecord[]): ReferenceSequence => ({ members, errors: [] });

const query: ReferenceQuery = {
  scope: { kind: "history", tapestryId: null },
  order: "time",
  search: { kind: "none" }
};

const snapshotOf = (target: ThoughtRef): ThoughtSnapshot => ({
  thought: target,
  root: target,
  ancestry: [target],
  day: target.day,
  time: target.time,
  durationMs: 0,
  originalBlock: "",
  text: target.prose,
  whispers: []
});

function immediate(members: ThoughtRecord[]): ThoughtIndex {
  const seq = sequence(members);
  return {
    query: async () => seq,
    loadThought: async () => ({ kind: "unavailable", thought: ref(1, ""), reason: "unused" }),
    invalidate() {},
    invalidateAll() {},
    dispose() {}
  } as unknown as ThoughtIndex;
}

function host(index: ThoughtIndex, onChange: () => void = () => {}): ReferenceHost {
  return {
    index,
    load: async (target) => ({ kind: "ready", snapshot: snapshotOf(target) }),
    onChange
  };
}

const THREE = [record(1, "one"), record(2, "two", 1), record(3, "three")];

describe("opening and moving", () => {
  it("opens at the first and last thought and loads its body", async () => {
    const controller = new ReferenceController(host(immediate(THREE)));
    await controller.open(query, "first");
    expect(controller.model.readiness.kind).toBe("ready");
    expect(controller.model.selection?.n).toBe(1);
    expect(controller.model.body.kind).toBe("ready");

    await controller.open(query, "last");
    expect(controller.model.selection?.n).toBe(3);
  });

  it("steps without wrapping and moves parent/child by the tree", async () => {
    const controller = new ReferenceController(host(immediate(THREE)));
    await controller.open(query, "first");

    expect(await controller.move("next")).toBe(true);
    expect(controller.model.selection?.n).toBe(2);
    expect(await controller.move("parent")).toBe(true);
    expect(controller.model.selection?.n).toBe(1);
    expect(await controller.move("child")).toBe(true);
    expect(controller.model.selection?.n).toBe(2);

    await controller.open(query, "last");
    expect(await controller.move("next")).toBe(false);
    expect(controller.model.selection?.n).toBe(3);
  });

  it("refuses a selection outside the scope", async () => {
    const controller = new ReferenceController(host(immediate(THREE)));
    await controller.open(query, "first");
    const outside = ref(99, "elsewhere");
    expect(await controller.select(outside)).toBe(false);
    expect(controller.model.place.kind).toBe("unavailable");
  });
});

describe("search", () => {
  it("accepts only a loaded current match, and cancels back to the place", async () => {
    const controller = new ReferenceController(host(immediate(THREE)));
    await controller.open(query, "first");

    controller.beginSearch();
    expect(controller.model.search.kind).toBe("editing");
    await controller.setSearchText("two");
    expect(controller.acceptSearch()).toBe(true);
    expect(controller.model.search.kind).toBe("accepted");

    await controller.cancelSearch();
    expect(controller.model.search.kind).toBe("off");
    expect(controller.model.selection?.n).toBe(1);
  });
});

describe("stale results", () => {
  it("ignores a query that a newer open superseded", async () => {
    const first = deferred<ReferenceSequence>();
    const second = deferred<ReferenceSequence>();
    let call = 0;
    const index = {
      query: () => (call++ === 0 ? first.promise : second.promise),
      loadThought: async () => ({ kind: "unavailable", thought: ref(1, ""), reason: "unused" }),
      invalidate() {},
      invalidateAll() {},
      dispose() {}
    } as unknown as ThoughtIndex;

    const controller = new ReferenceController(host(index));
    const firstOpen = controller.open(query, "first");
    const secondOpen = controller.open(query, "first");

    second.resolve(sequence([record(2, "newer")]));
    await secondOpen;
    expect(controller.model.selection?.n).toBe(2);

    first.resolve(sequence([record(1, "older")]));
    await firstOpen;
    expect(controller.model.selection?.n).toBe(2);
  });
});

describe("correction and deletion", () => {
  it("rebinds an exactly corrected thought in place", async () => {
    const controller = new ReferenceController(host(immediate(THREE)));
    await controller.open(query, "first");
    const before = controller.model.selection!;
    const corrected: ThoughtSnapshot = { ...snapshotOf(before), text: "corrected", thought: { ...before, prose: "corrected" } };

    controller.applyConfirmedRevision(before, corrected);
    expect(controller.model.selection?.prose).toBe("corrected");
    expect(controller.model.body.kind).toBe("ready");
    if (controller.model.body.kind === "ready") expect(controller.model.body.snapshot.text).toBe("corrected");
  });

  it("marks a deleted selection unavailable without advancing", async () => {
    const controller = new ReferenceController(host(immediate(THREE)));
    await controller.open(query, "first");
    const before = controller.model.selection!;

    controller.applyConfirmedDeletion([before]);
    expect(controller.model.selection?.n).toBe(before.n);
    expect(controller.model.place.kind).toBe("unavailable");
    expect(controller.model.body.kind).toBe("none");
  });
});

describe("a live Review", () => {
  const session: ReviewSession = {
    id: "r1",
    definition: {
      name: "Review",
      tapestryId: "main",
      from: "2026-11-01",
      through: "2026-11-05",
      order: "time",
      beginAt: "first"
    },
    definitionStamp: { wallMs: 1, counter: 0, deviceId: "d" },
    cursor: { thought: ref(2, "two", 1), textOffset: 4 },
    cursorStamp: { wallMs: 1, counter: 0, deviceId: "d" }
  };

  it("adopts the saved cursor and reports an external change without moving", async () => {
    const controller = new ReferenceController(host(immediate(THREE)));
    await controller.open(query, "first", session);

    expect(controller.model.activeReview?.id).toBe("r1");
    expect(controller.model.selection?.n).toBe(2);
    expect(controller.model.textOffset).toBe(4);

    controller.observeReviewChange({ id: "r1", status: "changed" });
    expect(controller.model.selection?.n).toBe(2);
    expect(controller.model.notice).toContain("Review changed");
    expect(controller.model.activeReview?.externalStatus).toBe("changed");
  });
});

/** A promise whose resolution the test holds. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
