import { describe, expect, it } from "vitest";

import { calendarWeeks, cellLabel, dayLabel, intensity, shiftDay } from "../src/ui/calendar";

/** The prior contribution contract, ported and extended. */
describe("intensity", () => {
  it("buckets counts without grading them", () => {
    expect([0, 1, 2, 4, 5, 9, 10, 100].map(intensity)).toEqual([0, 1, 2, 2, 3, 3, 4, 4]);
  });

  it("treats a negative or absurd count as nothing recorded", () => {
    expect(intensity(-3)).toBe(0);
    expect(intensity(Number.NaN)).toBe(0);
  });
});

describe("shiftDay", () => {
  it("moves by calendar days across a daylight-saving boundary", () => {
    expect(shiftDay("2026-03-08", 1)).toBe("2026-03-09");
    expect(shiftDay("2026-11-01", -1)).toBe("2026-10-31");
  });

  it("rejects a date that does not exist", () => {
    expect(() => shiftDay("2026-02-30", 1)).toThrow();
    expect(() => shiftDay("invalid", 1)).toThrow();
  });
});

describe("calendarWeeks", () => {
  const counts = new Map([
    ["2026-10-12", { count: 3, closed: false }],
    ["2026-10-13", { count: 4, closed: true }]
  ]);

  it("starts on a Monday, includes the end day and flags later days", () => {
    const weeks = calendarWeeks(counts, "2026-10-12", 12);

    expect(weeks).toHaveLength(12);
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    // Column zero is always a Monday.
    expect(new Date(`${weeks[0]?.[0]?.key}T12:00:00`).getDay()).toBe(1);

    const end = weeks.flat().find((day) => day.key === "2026-10-12");
    expect(end?.count).toBe(3);
    expect(end?.intensity).toBe(2);
    expect(end?.future).toBe(false);

    // The end day sits in the last column.
    expect(weeks[11]?.some((day) => day.key === "2026-10-12")).toBe(true);
  });

  it("marks days after the end as future but keeps their reading", () => {
    const later = calendarWeeks(counts, "2026-10-12", 12).flat().find((day) => day.key === "2026-10-13");
    expect(later?.future).toBe(true);
    expect(later?.count).toBe(4);
    expect(later?.closed).toBe(true);
  });

  it("draws a year at All scope", () => {
    const weeks = calendarWeeks(new Map(), "2026-10-12", 53);
    expect(weeks).toHaveLength(53);
    expect(weeks.flat()).toHaveLength(53 * 7);
  });

  it("reads a day with no counters as zero rather than guessing", () => {
    const empty = calendarWeeks(new Map(), "2026-10-12", 12).flat()[0];
    expect(empty?.count).toBe(0);
    expect(empty?.intensity).toBe(0);
  });
});

describe("labels", () => {
  it("names a day without depending on the machine's locale", () => {
    expect(dayLabel("2026-10-27")).toBe("Tue 27 Oct");
    expect(cellLabel({ key: "2026-10-27", count: 7, closed: false, intensity: 3, future: false })).toBe(
      "Tue 27 Oct: 7 sparks"
    );
    expect(cellLabel({ key: "2026-10-27", count: 1, closed: false, intensity: 1, future: false })).toBe(
      "Tue 27 Oct: 1 spark"
    );
  });
});
