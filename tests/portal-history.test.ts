import { describe, expect, it } from "vitest";

import type { AlignmentRecord } from "../src/core/alignments";
import { parseEntries } from "../src/core/entries";
import { linkedPortalEntry, portalHistoryRows, type PortalHistoryRow } from "../src/core/portal-history";
import { portalInstants } from "../src/core/portals";

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

function rowsOf(source: string, now: number, showAll = false): PortalHistoryRow[] {
  const history = portalHistoryRows(source, now, showAll);
  if (!history.ok) throw new Error(history.error);
  return history.rows;
}

function openingIds(rows: readonly PortalHistoryRow[]): string[] {
  return rows.filter((row) => row.kind === "opening").map((row) => row.id);
}

type RecordedRow = Extract<PortalHistoryRow, { kind: "recorded" }>;

/** Recorded facts only; the default view also carries today's schedule. */
function recordedRowsOf(source: string, now: number): RecordedRow[] {
  return rowsOf(source, now).filter((row): row is RecordedRow => row.kind === "recorded");
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
    const rows = recordedRowsOf(note([record()], entryThree()), Date.UTC(2027, 0, 1));
    expect(rows).toHaveLength(1);
    // Recorded facts live outside the current schedule day too.
    expect(
      rowsOf(note([record()], entryThree()), Date.UTC(2027, 0, 1)).some(
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
      Date.UTC(2027, 0, 1)
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
      Date.UTC(2027, 0, 1)
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
    const rows = recordedRowsOf(note([boundary, hour, both, all]), Date.UTC(2027, 0, 1));
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
    const rows = recordedRowsOf(edited, Date.UTC(2027, 0, 1));
    const row = rows[0];
    if (row?.kind !== "recorded") throw new Error("expected a recorded row");
    expect(row.entry).toBeNull();
    expect(row.label).toBe("Aligned · Minute echo");
  });

  it("keeps a row id stable when the entry association becomes null", () => {
    const intact = recordedRowsOf(note([record()], entryThree()), Date.UTC(2027, 0, 1))[0];
    const edited = recordedRowsOf(
      note([record()], entryThree("2026-11-05", "22:56:55")),
      Date.UTC(2027, 0, 1)
    )[0];
    const detached = recordedRowsOf(
      note([record({ entry: null })], entryThree()),
      Date.UTC(2027, 0, 1)
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
      const rows = recordedRowsOf(note([record()], entryThree()), Date.UTC(2027, 0, 1));
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

    const rows = recordedRowsOf(note([first, second]), Date.UTC(2027, 0, 1));
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
    const rows = recordedRowsOf(note([second, first]), Date.UTC(2027, 0, 1));

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

describe("schedule rows", () => {
  const emptyDay = note([]);

  it("shows approaching/open plus the most recent passed opening by default", () => {
    withZone("UTC", () => {
      const now = Date.UTC(2026, 10, 5, 12, 23, 0);
      const rows = rowsOf(emptyDay, now, false);
      expect(
        rows.map((row) => [row.kind, row.portal.hour, row.portal.minute, row.label])
      ).toEqual([
        ["opening", 12, 22, "Passed"],
        ["opening", 12, 33, "Upcoming"]
      ]);
      expect(openingIds(rows)).toEqual([
        "opening:2026-11-05T12:22:00.000Z",
        "opening:2026-11-05T12:33:00.000Z"
      ]);
    });
  });

  it("treats the opening minute as open and keeps the last passed one", () => {
    withZone("UTC", () => {
      const rows = rowsOf(emptyDay, Date.UTC(2026, 10, 5, 12, 22, 30), false);
      expect(rows.map((row) => [row.portal.hour, row.portal.minute, row.label])).toEqual([
        [12, 12, "Passed"],
        [12, 22, "Open"],
        [12, 33, "Upcoming"]
      ]);
      expect(rows.map((row) => (row.kind === "opening" ? row.phase : ""))).toEqual([
        "passed",
        "open",
        "approaching"
      ]);
    });
  });

  it("lays out the whole local day in showAll", () => {
    withZone("UTC", () => {
      const now = Date.UTC(2026, 10, 5, 12, 23, 0);
      const dayStart = Date.UTC(2026, 10, 5, 0, 0, 0);
      const dayEnd = Date.UTC(2026, 10, 6, 0, 0, 0);
      const expected = portalInstants(dayStart, dayEnd - 1).map(
        (portal) => `opening:${portal.id}`
      );

      expect(openingIds(rowsOf(emptyDay, now, true))).toEqual(expected);
      const rows = rowsOf(emptyDay, now, true);
      expect(rows[0]?.kind).toBe("opening");
      expect(rows[0]?.portal.hour).toBe(0);
      expect(rows[0]?.portal.minute).toBe(0);
      expect(rows.at(-1)?.portal.hour).toBe(23);
      expect(rows.at(-1)?.portal.minute).toBe(55);
    });
  });

  it("omits a schedule row for a portal this note already recorded", () => {
    withZone("UTC", () => {
      const source = note([record({ entry: null })]);
      const rows = rowsOf(source, Date.UTC(2026, 10, 6, 6, 56, 0), true);
      expect(openingIds(rows)).not.toContain(`opening:${PORTAL_2255}`);
      expect(rows.filter((row) => row.kind === "recorded")).toHaveLength(1);
      // Every other opening of that local day still appears.
      const dayStart = Date.UTC(2026, 10, 6, 0, 0, 0);
      const dayEnd = Date.UTC(2026, 10, 7, 0, 0, 0);
      const expected = portalInstants(dayStart, dayEnd - 1)
        .filter((portal) => portal.id !== PORTAL_2255)
        .map((portal) => `opening:${portal.id}`);
      expect(openingIds(rows)).toEqual(expected);
    });
  });

  it("uses real local midnights so a folded day has 25 hours and a skipped day 23", () => {
    withZone("America/Los_Angeles", () => {
      const fall = new Date(2026, 10, 1, 12, 0, 0).getTime();
      const fallStart = new Date(2026, 10, 1, 0, 0, 0).getTime();
      const fallEnd = new Date(2026, 10, 2, 0, 0, 0).getTime();
      const fallRows = rowsOf(emptyDay, fall, true);
      expect(fallRows).toHaveLength(portalInstants(fallStart, fallEnd - 1).length);
      const repeated = fallRows.filter(
        (row) => row.portal.hour === 1 && row.portal.minute === 11
      );
      expect(repeated.map((row) => row.portal.offsetMinutes)).toEqual([-420, -480]);
      expect(repeated.map((row) => row.portal.day)).toEqual(["2026-11-01", "2026-11-01"]);

      const spring = new Date(2026, 2, 8, 12, 0, 0).getTime();
      const springStart = new Date(2026, 2, 8, 0, 0, 0).getTime();
      const springEnd = new Date(2026, 2, 9, 0, 0, 0).getTime();
      const springRows = rowsOf(emptyDay, spring, true);
      expect(springRows).toHaveLength(portalInstants(springStart, springEnd - 1).length);
      expect(springRows.some((row) => row.portal.hour === 2)).toBe(false);
      expect(springRows.some((row) => row.portal.hour === 3 && row.portal.minute === 0)).toBe(true);
    });
  });
});

describe("unreadable history", () => {
  it("propagates the read error instead of showing an empty history", () => {
    const duplicate = "---\nweaver-alignments:\nweaver-alignments:\n---\nbody";
    const malformed = "---\nweaver-alignments:\n  - {oops}\n---\nbody";
    const unclosed = "---\ndate: 2026-11-05\nweaver-alignments:\n  - {}";

    for (const source of [duplicate, malformed, unclosed]) {
      const history = portalHistoryRows(source, Date.UTC(2026, 10, 5, 12, 0), true);
      expect(history.ok).toBe(false);
      if (!history.ok) expect(history.error).toContain("unreadable");
    }
  });
});
