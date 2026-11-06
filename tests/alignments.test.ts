import { describe, expect, it } from "vitest";

import {
  detachAlignments,
  formatLocalTimestamp,
  mergeAlignment,
  readAlignments,
  type AlignmentRecord
} from "../src/core/alignments";

/** 2026-11-05 22:55:00 in -08:00, which is 2026-11-06 06:55:00 UTC. */
const PORTAL = "2026-11-06T06:55:00.000Z";
const OPENED = "2026-11-05T22:55:00-08:00";
const BEGAN = "2026-11-05T22:55:55-08:00";

const RECORD: AlignmentRecord = { portal: PORTAL, opened: OPENED, began: BEGAN, entry: 3 };

/** A day note as the writer leaves it: stats, unrelated nesting, and body. */
const NOTE = [
  "---",
  "date: 2026-11-05",
  "travels: 1",
  "tags:",
  "  - journal",
  "---",
  "{ b.1.3 }",
  "",
  "- 00:00:07",
  "text"
].join("\n");

/** A note whose history is the given rows, in the canonical arrangement. */
function noteWith(...rows: string[]): string {
  return [
    "---",
    "date: 2026-11-05",
    "weaver-alignments:",
    ...rows.map((row) => `  - ${row}`),
    "---",
    "body"
  ].join("\n");
}

function recordsOf(source: string): AlignmentRecord[] {
  const read = readAlignments(source);
  if (!read.ok) throw new Error(read.error);
  return read.records;
}

function merged(source: string, record: AlignmentRecord): string {
  const write = mergeAlignment(source, record);
  if (!write.ok) throw new Error(write.error);
  return write.source;
}

function errorOf(source: string): string {
  const read = readAlignments(source);
  if (read.ok) throw new Error("expected the history to be refused");
  return read.error;
}

/** Runs `run` with the machine in `zone`, restoring the previous zone after. */
function inZone<T>(zone: string, run: () => T): T {
  const previous = process.env["TZ"];
  process.env["TZ"] = zone;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env["TZ"];
    else process.env["TZ"] = previous;
  }
}

describe("formatLocalTimestamp", () => {
  it("writes whole seconds with a numeric offset that names the same instant", () => {
    const date = new Date(2026, 10, 5, 22, 55, 55, 900);
    const stamp = formatLocalTimestamp(date);

    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(stamp.startsWith("2026-11-05T22:55:55")).toBe(true);
    // Milliseconds are floored, never rounded into a second that had not come.
    expect(Date.parse(stamp)).toBe(Math.floor(date.getTime() / 1000) * 1000);
  });

  it("follows the machine's zone, including both sides of a fold", () => {
    expect(
      inZone("America/New_York", () => formatLocalTimestamp(new Date("2026-11-05T06:55:55.999Z")))
    ).toBe("2026-11-05T01:55:55-05:00");
    expect(
      inZone("Europe/Berlin", () => formatLocalTimestamp(new Date("2026-07-01T12:00:00Z")))
    ).toBe("2026-07-01T14:00:00+02:00");
    expect(
      inZone("America/New_York", () => [
        formatLocalTimestamp(new Date("2026-11-01T05:30:00Z")),
        formatLocalTimestamp(new Date("2026-11-01T06:30:00Z"))
      ])
    ).toEqual(["2026-11-01T01:30:00-04:00", "2026-11-01T01:30:00-05:00"]);
  });

  it("refuses a date that is not an instant", () => {
    expect(() => formatLocalTimestamp(new Date(Number.NaN))).toThrow(TypeError);
  });
});

describe("readAlignments", () => {
  it("reads no key, a blank key and no frontmatter as an empty history", () => {
    expect(readAlignments("")).toEqual({ ok: true, records: [] });
    expect(readAlignments(NOTE)).toEqual({ ok: true, records: [] });
    expect(readAlignments("---\nweaver-alignments:\n---\ntext")).toEqual({
      ok: true,
      records: []
    });
  });

  it("reads every canonical row in the order it was written", () => {
    const later: AlignmentRecord = {
      portal: "2026-11-06T06:59:00.000Z",
      opened: "2026-11-05T22:59:00-08:00",
      began: "2026-11-05T22:59:00-08:00",
      entry: 4
    };

    expect(recordsOf(noteWith(JSON.stringify(RECORD), JSON.stringify(later)))).toEqual([
      RECORD,
      later
    ]);
  });

  it("keeps the writer's local facts across a timezone change", () => {
    const persisted = merged(NOTE, RECORD);

    for (const zone of ["Europe/Berlin", "Asia/Tokyo", "UTC"]) {
      expect(inZone(zone, () => recordsOf(persisted))).toEqual([RECORD]);
    }
  });

  it("accepts a beginning that lands on the next local day", () => {
    const crossing: AlignmentRecord = {
      portal: "2026-11-06T07:59:00.000Z",
      opened: "2026-11-05T23:59:00-08:00",
      began: "2026-11-06T00:00:05-08:00",
      entry: 1
    };

    expect(recordsOf(noteWith(JSON.stringify(crossing)))).toEqual([crossing]);
  });

  it("accepts a record with no entry left, and the same instant in another offset", () => {
    const detached: AlignmentRecord = { ...RECORD, entry: null };
    const travelling: AlignmentRecord = { ...RECORD, opened: "2026-11-06T06:55:00+00:00" };

    expect(recordsOf(noteWith(JSON.stringify(detached), JSON.stringify(travelling)))).toEqual([
      detached,
      travelling
    ]);
  });

  it("refuses a history it cannot read rather than reporting an empty one", () => {
    const duplicated = [
      "---",
      "date: 2026-11-05",
      "weaver-alignments:",
      `  - ${JSON.stringify(RECORD)}`,
      "'weaver-alignments':",
      "---",
      "body"
    ].join("\n");

    expect(errorOf(duplicated)).toContain("appears twice");
    expect(errorOf("---\ndate: 2026-11-05\nweaver-alignments:\n  - {}")).toContain("never closed");
  });

  it("refuses nested content and values on the key line", () => {
    expect(errorOf("---\nweaver-alignments: []\n---\nbody")).toContain("block sequence");
    expect(errorOf("---\nweaver-alignments:\n  - portal: 2026-11-06T06:55:00.000Z\n---\nbody")).toContain(
      "JSON flow mapping"
    );
    expect(errorOf("---\nweaver-alignments:\n  - [1]\n---\nbody")).toContain("JSON flow mapping");
    expect(errorOf("---\nweaver-alignments:\n  - {oops}\n---\nbody")).toContain("not valid JSON");
    expect(errorOf("---\nweaver-alignments:\n  nested:\n    deeper: true\n---\nbody")).toContain(
      "not a record"
    );
  });

  it("refuses rows that do not describe a real opening", () => {
    const cases: Array<[object, string]> = [
      [{ ...RECORD, portal: "2026-11-06T06:55:00Z" }, "canonical UTC instant"],
      [{ ...RECORD, portal: "2026-11-06T06:55:30.000Z" }, "whole minute"],
      [{ ...RECORD, opened: "2026-11-05T22:55:01-08:00" }, "different instant"],
      [{ ...RECORD, opened: "2026-02-30T22:55:00-08:00" }, "does not exist"],
      [{ ...RECORD, opened: "2026-11-05T22:55:00+14:30" }, "impossible UTC offset"],
      [{ ...RECORD, began: "2026-11-05T22:55:55.900-08:00" }, "whole-second local timestamp"],
      [{ ...RECORD, began: "2026-11-05 22:55:55" }, "whole-second local timestamp"],
      [{ ...RECORD, entry: 0 }, "`entry`"],
      [{ ...RECORD, entry: 1.5 }, "`entry`"],
      [{ ...RECORD, entry: "3" }, "`entry`"],
      [{ ...RECORD, target: "22:55" } as unknown as AlignmentRecord, "unknown record field"]
    ];

    for (const [record, reason] of cases) {
      expect(errorOf(noteWith(JSON.stringify(record)))).toContain(reason);
    }

    const missing = { portal: PORTAL, opened: OPENED, began: BEGAN };
    expect(errorOf(noteWith(JSON.stringify(missing)))).toContain("missing");
    expect(errorOf(noteWith("[1,2]"))).toContain("JSON flow mapping");
  });
});

describe("mergeAlignment", () => {
  it("appends the key to existing frontmatter and leaves every other byte alone", () => {
    const source = merged(NOTE, RECORD);
    const lines = source.split("\n");

    expect(lines.slice(0, 7)).toEqual([
      "---",
      "date: 2026-11-05",
      "travels: 1",
      "tags:",
      "  - journal",
      "weaver-alignments:",
      `  - ${JSON.stringify(RECORD)}`
    ]);
    // Every line the history did not add survives, in order, byte for byte.
    const untouched = lines.filter((line) => !line.startsWith("weaver-alignments:") && !line.startsWith("  - {"));
    expect(untouched).toEqual(NOTE.split("\n"));
    expect(recordsOf(source)).toEqual([RECORD]);
  });

  it("keeps a `...` closure and unknown nested properties", () => {
    const folded = [
      "---",
      "date: 2026-11-05",
      "nested:",
      "  inner:",
      "    deeper: true",
      "...",
      "body"
    ].join("\n");
    const source = merged(folded, RECORD);

    expect(source).toContain("    deeper: true\nweaver-alignments:\n  - ");
    expect(source.endsWith("...\nbody")).toBe(true);
  });

  it("creates the smallest frontmatter block when a note has none", () => {
    const source = merged("{ b.1.1 }\ntext", RECORD);

    expect(source.startsWith("---\nweaver-alignments:\n  - ")).toBe(true);
    expect(source.endsWith("---\n{ b.1.1 }\ntext")).toBe(true);
    expect(recordsOf(source)).toEqual([RECORD]);
  });

  it("rewrites an existing block in canonical form without moving it", () => {
    const loose = [
      "---",
      "date: 2026-11-05",
      "weaver-alignments:",
      `- ${JSON.stringify(RECORD)}`,
      "travels: 1",
      "---",
      "body"
    ].join("\n");
    const source = merged(loose, { ...RECORD, began: "2026-11-05T22:55:56-08:00", entry: 4 });

    expect(source.split("\n").slice(0, 6)).toEqual([
      "---",
      "date: 2026-11-05",
      "weaver-alignments:",
      `  - ${JSON.stringify(RECORD)}`,
      `  - ${JSON.stringify({ ...RECORD, began: "2026-11-05T22:55:56-08:00", entry: 4 })}`,
      "travels: 1"
    ]);
  });

  it("does not record the same alignment twice", () => {
    const once = merged(NOTE, RECORD);

    expect(merged(once, RECORD)).toBe(once);
    expect(recordsOf(once)).toEqual([RECORD]);
  });

  it("keeps both records when two devices entered the same portal", () => {
    const twin: AlignmentRecord = { ...RECORD, began: "2026-11-05T22:55:56-08:00", entry: 4 };
    const both = merged(merged(NOTE, RECORD), twin);

    expect(recordsOf(both)).toEqual([RECORD, twin]);
    // Merging again against the live source neither duplicates nor drops either.
    expect(merged(both, RECORD)).toBe(both);
    expect(merged(both, twin)).toBe(both);
  });

  it("refuses a malformed record and an unreadable note without writing anything", () => {
    const broken: AlignmentRecord = { ...RECORD, opened: "2026-11-05T22:55:01-08:00" };
    expect(mergeAlignment(NOTE, broken).ok).toBe(false);

    const duplicated = "---\nweaver-alignments:\nweaver-alignments:\n---\nbody";
    expect(mergeAlignment(duplicated, RECORD).ok).toBe(false);
    expect(mergeAlignment("---\nweaver-alignments:\n  - {oops}\n---\nbody", RECORD).ok).toBe(false);
  });
});

describe("detachAlignments", () => {
  const TWIN: AlignmentRecord = { ...RECORD, began: "2026-11-05T22:55:56-08:00", entry: 4 };
  const both = merged(merged(NOTE, RECORD), TWIN);

  it("nulls the entry of every deleted record and keeps its facts", () => {
    const result = detachAlignments(both, new Set([3]));
    if (!result.ok) throw new Error(result.error);

    expect(recordsOf(result.source)).toEqual([{ ...RECORD, entry: null }, TWIN]);
    expect(result.source.endsWith("{ b.1.3 }\n\n- 00:00:07\ntext")).toBe(true);
  });

  it("leaves two deleted records as two facts", () => {
    const result = detachAlignments(both, new Set([3, 4]));
    if (!result.ok) throw new Error(result.error);

    expect(recordsOf(result.source).map((row) => row.entry)).toEqual([null, null]);
  });

  it("returns the same source when no record matched", () => {
    expect(detachAlignments(both, new Set([99]))).toEqual({ ok: true, source: both });
    expect(detachAlignments(both, new Set())).toEqual({ ok: true, source: both });
  });

  it("refuses an unreadable history instead of clearing it", () => {
    expect(detachAlignments("---\nweaver-alignments:\n  - {oops}\n---\nbody", new Set([3])).ok).toBe(
      false
    );
  });
});
