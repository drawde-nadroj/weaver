import { describe, expect, it } from "vitest";

import type { AlignmentRecord } from "../src/core/alignments";
import { parseEntries } from "../src/core/entries";
import { linkedPortalEntry, portalHistoryRows, type PortalHistoryRow } from "../src/core/portal-history";

const PORTAL_2255 = "2026-11-06T06:55:00.000Z";
const OPENED_2255 = "2026-11-05T22:55:00-08:00";
const BEGAN_2255 = "2026-11-05T22:55:55-08:00";

function record(overrides: Partial<AlignmentRecord> = {}): AlignmentRecord {
  return {
    portal: PORTAL_2255,
    opened: OPENED_2255,
    began: BEGAN_2255,
    entry: 3,
    ...overrides
  };
}

/** A day note with the given history rows and body lines. */
function note(records: readonly AlignmentRecord[], body: readonly string[] = []): string {
  return [
    "---",
    "date: 2026-11-05",
    "weaver-alignments:",
    ...records.map((item) => `  - ${JSON.stringify(item)}`),
    "---",
    ...body
  ].join("\n");
}

/** The row shape `planPortalEntry` writes, for entry N=3. */
function entryThree(day = "2026-11-05", time = "22:55:55"): string[] {
  return ["{ 1.1.3 }", "", "hello", `- 00:00:00 ${day} ${time}`];
}

function rowsOf(source: string): PortalHistoryRow[] {
  const history = portalHistoryRows(source);
  if (!history.ok) throw new Error(history.error);
  return history.rows;
}

type RecordedRow = Extract<PortalHistoryRow, { kind: "recorded" }>;

/** Every row is a recorded fact: a history lists evidence, never a schedule. */
function recordedRowsOf(source: string): RecordedRow[] {
  return rowsOf(source);
}

function withZone<T>(zone: string, run: () => T): T {
  const previous = process.env["TZ"];
  process.env["TZ"] = zone;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env["TZ"];
    else process.env["TZ"] = previous;
  }
}

describe("recorded portal history rows", () => {
  it("keeps the opening's frozen local facts and the actual beginning", () => {
    const rows = recordedRowsOf(note([record()], entryThree()));
    expect(rows).toHaveLength(1);
    // Recorded facts live outside the current schedule day too.
    expect(
      rowsOf(note([record()], entryThree())).some(
        (row) => row.kind === "recorded"
      )
    ).toBe(true);
    const row = rows[0];
    if (row?.kind !== "recorded") throw new Error("expected a recorded row");

    expect(row.entry).toBe(3);
    expect(row.record.began).toBe(BEGAN_2255);
    expect(row.portal).toMatchObject({
      id: PORTAL_2255,
      opensAt: Date.UTC(2026, 10, 6, 6, 55),
      day: "2026-11-05",
      hour: 22,
      minute: 55,
      offsetMinutes: -480
    });
    expect(row.alignments).toEqual(["minute-echo"]);
    // The minute echo is the portal's own 55th second, not the machine's zone.
    expect(row.label).toBe("Aligned · Minute echo");
  });

  it("does not turn a late held beginning into an alignment", () => {
    const late = record({ began: "2026-11-05T22:56:55-08:00" });
    const rows = recordedRowsOf(
      note([late], entryThree("2026-11-05", "22:56:55")),
    );
    const row = rows[0];
    if (row?.kind !== "recorded") throw new Error("expected a recorded row");

    expect(row.alignments).toEqual([]);
    expect(row.label).toBe("Entered · 22:56:55");
  });

  it("keeps a whole-second beginning just past the opening second unaligned", () => {
    const after = record({ began: "2026-11-05T22:55:56-08:00" });
    const rows = recordedRowsOf(
      note([after], entryThree("2026-11-05", "22:55:56")),
    );
    const row = rows[0];
    if (row?.kind !== "recorded") throw new Error("expected a recorded row");

    expect(row.alignments).toEqual([]);
    expect(row.label).toBe("Entered · 22:55:56");
  });

  it("names boundary, hour echo, minute echo and their coincidence once", () => {
    const boundary = record({ began: "2026-11-05T22:55:00-08:00" });
    const hour = record({
      portal: "2026-11-05T20:22:00.000Z",
      opened: "2026-11-05T12:22:00-08:00",
      began: "2026-11-05T12:22:12-08:00"
    });
    const both = record({
      portal: "2026-11-06T06:22:00.000Z",
      opened: "2026-11-05T22:22:00-08:00",
      began: "2026-11-05T22:22:22-08:00"
    });
    const all = record({
      portal: "2026-11-05T08:00:00.000Z",
      opened: "2026-11-05T00:00:00-08:00",
      began: "2026-11-05T00:00:00-08:00"
    });

    // Rows are chronological by opening instant, not by source order.
    const rows = recordedRowsOf(note([boundary, hour, both, all]));
    expect(rows.map((row) => row.label)).toEqual([
      "Aligned · Boundary + hour + minute echo",
      "Aligned · Hour echo",
      "Aligned · Hour + minute echo",
      "Aligned · Boundary"
    ]);
  });
});

describe("linkedPortalEntry", () => {
  it("accepts only an entry whose recorded day and moment still match", () => {
    const correct = note([record()], entryThree());
    const correctRecord = record();
    expect(linkedPortalEntry(correctRecord, parseEntries(correct))?.n).toBe(3);

    const editedTime = note([record()], entryThree("2026-11-05", "22:56:55"));
    expect(linkedPortalEntry(correctRecord, parseEntries(editedTime))).toBeNull();

    const editedDay = note([record()], entryThree("2026-11-06", "22:55:55"));
    expect(linkedPortalEntry(correctRecord, parseEntries(editedDay))).toBeNull();

    const deleted = note([record()], []);
    expect(linkedPortalEntry(correctRecord, parseEntries(deleted))).toBeNull();

    // N=3 was reused by a different entry after the recorded one was deleted.
    const reused = note([record()], entryThree("2026-11-06", "09:00:00"));
    expect(linkedPortalEntry(correctRecord, parseEntries(reused))).toBeNull();

    expect(linkedPortalEntry(record({ entry: null }), parseEntries(correct))).toBeNull();
  });

  it("shows the factual event even when its entry is unavailable", () => {
    const edited = note([record()], entryThree("2026-11-05", "22:56:55"));
    const rows = recordedRowsOf(edited);
    const row = rows[0];
    if (row?.kind !== "recorded") throw new Error("expected a recorded row");
    expect(row.entry).toBeNull();
    expect(row.label).toBe("Aligned · Minute echo");
  });

  it("keeps a row id stable when the entry association becomes null", () => {
    const intact = recordedRowsOf(note([record()], entryThree()))[0];
    const edited = recordedRowsOf(
      note([record()], entryThree("2026-11-05", "22:56:55")),
    )[0];
    const detached = recordedRowsOf(
      note([record({ entry: null })], entryThree()),
    )[0];

    if (intact?.kind !== "recorded") throw new Error("expected recorded rows");
    if (edited?.kind !== "recorded") throw new Error("expected recorded rows");
    if (detached?.kind !== "recorded") throw new Error("expected recorded rows");
    expect(intact.entry).toBe(3);
    expect(edited.entry).toBeNull();
    expect(detached.entry).toBeNull();
    expect(new Set([intact.id, edited.id, detached.id]).size).toBe(1);
  });
});

describe("travel and daylight-saving history", () => {
  it("reads the original offset rather than the current machine zone", () => {
    withZone("UTC", () => {
      const rows = recordedRowsOf(note([record()], entryThree()));
      const row = rows[0];
      if (row?.kind !== "recorded") throw new Error("expected a recorded row");

      expect(row.portal.hour).toBe(22);
      expect(row.portal.minute).toBe(55);
      expect(row.portal.offsetMinutes).toBe(-480);
      expect(row.label).toBe("Aligned · Minute echo");
      // A current-zone rendering would place this opening at 06:55 UTC.
      expect(row.record.opened).toBe(OPENED_2255);
      expect(row.record.began).toBe(BEGAN_2255);
    });
  });

  it("keeps both halves of a repeated local hour as distinct portals", () => {
    const first = record({
      portal: "2026-11-01T08:11:00.000Z",
      opened: "2026-11-01T01:11:00-07:00",
      began: "2026-11-01T01:11:00-07:00",
      entry: null
    });
    const second = record({
      portal: "2026-11-01T09:11:00.000Z",
      opened: "2026-11-01T01:11:00-08:00",
      began: "2026-11-01T01:11:00-08:00",
      entry: null
    });

    const rows = recordedRowsOf(note([first, second]));
    expect(rows).toHaveLength(2);
    const portals = rows.map((row) => (row.kind === "recorded" ? row.portal : null));
    expect(portals.map((portal) => portal?.offsetMinutes)).toEqual([-420, -480]);
    expect(portals.map((portal) => portal?.day)).toEqual(["2026-11-01", "2026-11-01"]);
    expect(portals.map((portal) => portal?.hour)).toEqual([1, 1]);
    expect(rows.map((row) => row.label)).toEqual(["Aligned · Boundary", "Aligned · Boundary"]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });

  it("keeps concurrent captures of one portal as separate chronological rows", () => {
    const first = record({ began: "2026-11-05T22:55:55-08:00", entry: null });
    const second = record({ began: "2026-11-05T22:56:23-08:00", entry: null });
    const rows = recordedRowsOf(note([second, first]));

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => (row.kind === "recorded" ? row.record.began : ""))).toEqual([
      first.began,
      second.began
    ]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect(rows.map((row) => row.label)).toEqual([
      "Aligned · Minute echo",
      "Entered · 22:56:23"
    ]);
  });
});

describe("unreadable history", () => {
  it("propagates the read error instead of showing an empty history", () => {
    const duplicate = "---\nweaver-alignments:\nweaver-alignments:\n---\nbody";
    const malformed = "---\nweaver-alignments:\n  - {oops}\n---\nbody";
    const unclosed = "---\ndate: 2026-11-05\nweaver-alignments:\n  - {}";

    for (const source of [duplicate, malformed, unclosed]) {
      const history = portalHistoryRows(source);
      expect(history.ok).toBe(false);
      if (!history.ok) expect(history.error).toContain("unreadable");
    }
  });
});
