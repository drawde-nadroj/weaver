import { describe, expect, it } from "vitest";

import type { ThoughtRef } from "../src/core/capture";
import {
  advanceStamp,
  compareStamps,
  liveReviews,
  mergeReviewMaps,
  reviewNameSuggestion,
  reviewQueryOf,
  reviewScopeOf,
  tombstoneOf,
  validateReviewDefinition,
  type ReviewDefinition,
  type ReviewMap,
  type ReviewRecord,
  type ReviewStamp
} from "../src/core/reviews";

const ref: ThoughtRef = {
  path: "Chrono/2026.11.05.md",
  n: 1,
  b: 1,
  d: 1,
  rootN: 1,
  day: "2026-11-05",
  time: "09:00:00",
  prose: "hi"
};

const stamp = (wallMs: number, counter = 0, deviceId = "a"): ReviewStamp => ({ wallMs, counter, deviceId });

const definition = (name = "Review"): ReviewDefinition => ({
  name,
  tapestryId: "main",
  from: "2026-11-01",
  through: "2026-11-05",
  order: "time",
  beginAt: "first"
});

function record(
  id: string,
  definitionStamp: number,
  cursorStamp: number,
  tombstone: ReviewStamp | null = null,
  name = "Review"
): ReviewRecord {
  return {
    id,
    definition: { definition: definition(name), stamp: stamp(definitionStamp) },
    cursor: { cursor: { thought: ref, textOffset: 0 }, stamp: stamp(cursorStamp) },
    tombstone
  };
}

describe("stamps", () => {
  it("orders by wall time, then counter, then device", () => {
    expect(compareStamps(stamp(1), stamp(2))).toBeLessThan(0);
    expect(compareStamps(stamp(2, 1), stamp(2, 0))).toBeGreaterThan(0);
    expect(compareStamps(stamp(2, 0, "a"), stamp(2, 0, "b"))).toBeLessThan(0);
  });

  it("advances past the highest seen, even when the wall clock goes backwards", () => {
    expect(advanceStamp(null, "dev", 100)).toEqual({ wallMs: 100, counter: 0, deviceId: "dev" });
    expect(advanceStamp(stamp(100, 3), "dev", 100)).toEqual({ wallMs: 100, counter: 4, deviceId: "dev" });
    expect(advanceStamp(stamp(100, 3), "dev", 50)).toEqual({ wallMs: 100, counter: 4, deviceId: "dev" });
    expect(advanceStamp(stamp(100, 3), "dev", 200)).toEqual({ wallMs: 200, counter: 0, deviceId: "dev" });
  });
});

describe("validation", () => {
  it("accepts a real inclusive range", () => {
    expect(validateReviewDefinition(definition())).toEqual({});
  });

  it("rejects an impossible day and a backwards range", () => {
    expect(validateReviewDefinition({ ...definition(), from: "2026-02-30" })["from"]).toBeDefined();
    expect(
      validateReviewDefinition({ ...definition(), from: "2026-11-05", through: "2026-11-01" })["through"]
    ).toBeDefined();
  });
});

describe("scope", () => {
  it("resolves a definition to a range query", () => {
    const def = definition();
    expect(reviewScopeOf(def)).toEqual({ kind: "range", tapestryId: "main", from: "2026-11-01", through: "2026-11-05" });
    expect(reviewQueryOf(def)).toEqual({ scope: reviewScopeOf(def), order: "time", search: { kind: "none" } });
  });

  it("suggests a name from the dates", () => {
    expect(reviewNameSuggestion("2026-11-01", "2026-11-01")).toBe("2026-11-01");
    expect(reviewNameSuggestion("2026-11-01", "2026-11-05")).toContain("2026-11-01");
  });
});

describe("merging two devices", () => {
  const local: ReviewMap = { r1: record("r1", 10, 30, null, "Local name") };
  const remote: ReviewMap = { r1: record("r1", 20, 5, null, "Remote name") };

  it("merges the definition and the cursor independently", () => {
    const merged = mergeReviewMaps(local, remote);
    expect(merged["r1"]?.definition.definition.name).toBe("Remote name");
    expect(merged["r1"]?.cursor.stamp.wallMs).toBe(30);
  });

  it("lets a deletion win over a newer definition", () => {
    const deleted: ReviewMap = { r1: record("r1", 1, 1, stamp(5)) };
    const alive: ReviewMap = { r1: record("r1", 999, 999, null, "Resurrected") };
    const merged = mergeReviewMaps(alive, deleted);
    expect(merged["r1"]?.tombstone).not.toBeNull();
    expect(liveReviews(merged)).toEqual([]);
    expect(tombstoneOf(merged, "r1")).not.toBeNull();
  });

  it("keeps the newer of two tombstones", () => {
    const older: ReviewMap = { r1: record("r1", 1, 1, stamp(5)) };
    const newer: ReviewMap = { r1: record("r1", 1, 1, stamp(9)) };
    expect(mergeReviewMaps(older, newer)["r1"]?.tombstone?.wallMs).toBe(9);
  });

  it("keeps a record present on only one side", () => {
    const merged = mergeReviewMaps(local, {});
    expect(merged["r1"]?.definition.definition.name).toBe("Local name");
  });
});
