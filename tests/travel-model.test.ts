import { describe, expect, it } from "vitest";

import {
  clampCursor,
  parseDcnQuery,
  moveDay,
  moveRow,
  travelDays,
  type TravelRow
} from "../src/core/travel-model";

function row(dayKey: string, n: number, d = 1, c = 1): TravelRow {
  return {
    path: `${dayKey}.md`,
    dayKey,
    line: n,
    d,
    c,
    n,
    time: "10:00:00",
    durationMs: 0,
    title: `entry ${n}`
  };
}

describe("parseDcnQuery", () => {
  it("reads each of the four forms", () => {
    expect(parseDcnQuery("3")).toEqual({ kind: "d", d: 3 });
    expect(parseDcnQuery(".14")).toEqual({ kind: "n", n: 14 });
    expect(parseDcnQuery("3.2")).toEqual({ kind: "dc", d: 3, c: 2 });
    expect(parseDcnQuery("3.2.14")).toEqual({ kind: "dcn", d: 3, c: 2, n: 14 });
  });

  it("refuses anything else", () => {
    expect(parseDcnQuery("")).toBeNull();
    expect(parseDcnQuery("abc")).toBeNull();
    expect(parseDcnQuery("3.")).toBeNull();
    expect(parseDcnQuery("1.2.3.4")).toBeNull();
    expect(parseDcnQuery("1234")).toBeNull();
  });
});

describe("travelDays", () => {
  const rows = [row("2026-10-27", 9), row("2026-10-26", 2), row("2026-10-26", 1)];

  it("groups by day ascending, rows by sequence ascending", () => {
    const days = travelDays(rows, null);

    expect(days.map((day) => day.key)).toEqual(["2026-10-26", "2026-10-27"]);
    expect(days[0]?.rows.map((entry) => entry.n)).toEqual([1, 2]);
  });

  it("narrows to the matches and keeps only the days that hold one", () => {
    const days = travelDays(rows, { kind: "n", n: 9 });

    expect(days.length).toBe(1);
    expect(days[0]?.key).toBe("2026-10-27");
  });

  it("matches a dimension and child together", () => {
    const filtered = travelDays([row("2026-10-26", 1, 2, 1), row("2026-10-26", 2, 2, 3)], {
      kind: "dc",
      d: 2,
      c: 3
    });

    expect(filtered[0]?.rows.map((entry) => entry.n)).toEqual([2]);
  });
});

describe("the cursor", () => {
  const days = travelDays([row("2026-10-26", 1), row("2026-10-26", 2), row("2026-10-27", 3)], null);

  it("clamps at both edges instead of wrapping", () => {
    expect(moveDay(days, 0, 0, -1)).toEqual({ day: 0, row: 0 });
    expect(moveDay(days, 1, 0, 1)).toEqual({ day: 1, row: 0 });
    expect(moveRow(days, 0, 1, 5)).toEqual({ day: 0, row: 1 });
    expect(moveRow(days, 0, 0, -1)).toEqual({ day: 0, row: 0 });
  });

  it("keeps the row inside the day it lands on", () => {
    const next = moveDay(days, 0, 1, 1);
    expect(next).toEqual({ day: 1, row: 0 });
    expect(clampCursor(days, 9, 9)).toEqual({ day: 1, row: 0 });
  });

  it("survives having nothing to show", () => {
    expect(clampCursor([], 3, 3)).toEqual({ day: 0, row: 0 });
  });
});
