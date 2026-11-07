import { describe, expect, it } from "vitest";

import { parseEntries } from "../src/core/entries";
import {
  compareThoughtTime,
  firstRecord,
  lastRecord,
  moveRecord,
  orderRecords,
  recordInScope,
  recordMatches,
  searchQueryOf,
  thoughtRecordOf,
  type ThoughtRecord
} from "../src/core/reference";

const NOTE = "Chrono/2026.11.05.md";

/** Records for one note, in document order. */
function records(source: string, noteDay = "2026-11-05", tapestryId: string | null = "main"): ThoughtRecord[] {
  const index = parseEntries(source);
  return index.entries.map((entry) => thoughtRecordOf(index, entry, NOTE, tapestryId, noteDay));
}

const INTERLEAVED = [
  "{ 1.1.1 }",
  "root A",
  "+ 00:01:00 2026-11-05 10:00:00",
  "",
  "{ 1.2.2 }",
  "child A",
  "+ 00:01:00 2026-11-05 09:00:00",
  "",
  "{ 2.1.3 }",
  "root B",
  "+ 00:01:00 2026-11-05 11:00:00",
  "",
  "{ 2.2.4 }",
  "child B",
  "+ 00:01:00 2026-11-05 08:00:00",
  ""
].join("\n");

describe("Time order", () => {
  it("ascends recorded moment, placing an untimed thought after timed ones", () => {
    const source = [
      "{ 1.1.1 }",
      "first",
      "+ 00:01:00 2026-11-05 11:00:00",
      "",
      "{ 1.2.2 }",
      "second",
      "+ 00:01:00 2026-11-05 09:00:00",
      "",
      "{ 1.3.3 }",
      "untimed",
      "+ 00:01:00",
      ""
    ].join("\n");
    const ordered = orderRecords(records(source), "time");
    expect(ordered.map((record) => record.thought.n)).toEqual([2, 1, 3]);
  });

  it("sorts across days before moments", () => {
    const source = [
      "{ 1.1.1 }",
      "later day",
      "+ 00:01:00 2026-11-06 08:00:00",
      "",
      "{ 1.2.2 }",
      "earlier day",
      "+ 00:01:00 2026-11-04 23:00:00",
      ""
    ].join("\n");
    const ordered = orderRecords(records(source), "time");
    expect(ordered.map((record) => record.thought.n)).toEqual([2, 1]);
    expect(compareThoughtTime(ordered[0]!, ordered[1]!)).toBeLessThan(0);
  });
});

describe("Connections order", () => {
  it("visits parents before descendants and differs from Time", () => {
    const rows = records(INTERLEAVED);
    expect(orderRecords(rows, "time").map((record) => record.thought.n)).toEqual([4, 2, 1, 3]);
    expect(orderRecords(rows, "connections").map((record) => record.thought.n)).toEqual([1, 2, 3, 4]);
  });

  it("treats a filtered-out parent as a root instead of dropping the child", () => {
    const rows = records(INTERLEAVED).filter((record) => record.thought.n !== 1);
    const ordered = orderRecords(rows, "connections");
    expect(ordered.map((record) => record.thought.n)).toEqual([2, 3, 4]);
  });
});

describe("scope", () => {
  it("selects by recorded day, not by the note's filename day", () => {
    const source = ["{ 1.1.1 }", "hi", "+ 00:01:00 2026-01-01 09:00:00", ""].join("\n");
    const [record] = records(source, "2027-12-31");
    expect(record).toBeDefined();
    expect(recordInScope(record!, { kind: "today", tapestryId: "main", day: "2026-01-01" })).toBe(true);
    expect(recordInScope(record!, { kind: "today", tapestryId: "main", day: "2027-12-31" })).toBe(false);
  });

  it("keeps an undated thought on its note's day and honours the Tapestry", () => {
    const source = ["{ 1.1.1 }", "hi", "+ 00:01:00", ""].join("\n");
    const [record] = records(source, "2026-11-05", null);
    expect(recordInScope(record!, { kind: "range", tapestryId: null, from: "2026-11-01", through: "2026-11-30" })).toBe(true);
    expect(recordInScope(record!, { kind: "history", tapestryId: "main" })).toBe(false);
  });
});

describe("search", () => {
  const rows = records(INTERLEAVED);

  it("parses an address, optionally in braces, and nothing else", () => {
    expect(searchQueryOf("{ 2.1.3 }")).toEqual({ kind: "address", b: 2, d: 1, n: 3 });
    expect(searchQueryOf("2.1.3")).toEqual({ kind: "address", b: 2, d: 1, n: 3 });
    expect(searchQueryOf("root A")).toEqual({ kind: "words", terms: ["root", "a"] });
    expect(searchQueryOf("   ")).toEqual({ kind: "none" });
  });

  it("matches every word as a case-insensitive prose substring", () => {
    const query = searchQueryOf("ROOT a");
    expect(rows.filter((record) => recordMatches(record, query)).map((record) => record.thought.n)).toEqual([1]);
  });

  it("never matches a whisper as prose", () => {
    const source = [
      "{ 1.1.1 }",
      "~ a quiet reading",
      "plain words",
      "+ 00:01:00 2026-11-05 09:00:00",
      ""
    ].join("\n");
    const [record] = records(source);
    expect(recordMatches(record!, searchQueryOf("quiet"))).toBe(false);
    expect(recordMatches(record!, searchQueryOf("plain"))).toBe(true);
  });
});

describe("reading moves", () => {
  const ordered = orderRecords(records(INTERLEAVED), "connections");
  const current = ordered[1]!.thought;

  it("steps previous and next without wrapping", () => {
    expect(moveRecord(ordered, current, "next")?.thought.n).toBe(3);
    expect(moveRecord(ordered, current, "previous")?.thought.n).toBe(1);
    expect(moveRecord(ordered, firstRecord(ordered)!.thought, "previous")).toBeNull();
    expect(moveRecord(ordered, lastRecord(ordered)!.thought, "next")).toBeNull();
  });

  it("moves to parent and child by the tree, and to the ends explicitly", () => {
    expect(moveRecord(ordered, current, "parent")?.thought.n).toBe(1);
    expect(moveRecord(ordered, ordered[0]!.thought, "child")?.thought.n).toBe(2);
    expect(moveRecord(ordered, current, "first")?.thought.n).toBe(1);
    expect(moveRecord(ordered, current, "last")?.thought.n).toBe(4);
  });
});
