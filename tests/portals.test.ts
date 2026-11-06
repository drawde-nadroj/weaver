import { describe, expect, it } from "vitest";

import {
  dueOpening,
  nextOpening,
  occurrencesBetween,
  portalAlignments,
  portalAt,
  portalContainsBeginning,
  portalPhase,
  readPortalSchedules,
  rhythmOccurrences,
  sourceOccurrences,
  type PortalSchedule,
  type PortalSource
} from "../src/core/portals";

/** A local instant, so the assertions read in the machine's own zone. */
const local = (hour: number, minute: number, second = 0, day = 5) =>
  new Date(2026, 10, day, hour, minute, second).getTime();

/** A weekly schedule source, the shape the controller works with. */
function weekly(
  hour: number,
  minute: number,
  weekdays = [0, 1, 2, 3, 4, 5, 6],
  leadMinutes = 11
): PortalSource {
  const schedule: PortalSchedule = {
    id: "s1",
    name: "Morning",
    contextId: "main",
    enabled: true,
    createdAt: 0,
    leadMinutes,
    when: { kind: "weekly", weekdays, hour, minute }
  };
  return {
    id: schedule.id,
    name: schedule.name,
    contextId: schedule.contextId,
    leadMinutes: schedule.leadMinutes,
    createdAt: schedule.createdAt,
    schedule
  };
}

describe("the built-in rhythm", () => {
  it("offers the eleven-minute minutes and each mirrored hour", () => {
    const minutes = rhythmOccurrences(local(12, 0), local(12, 22)).map((portal) => portal.minute);
    expect(minutes).toEqual([0, 11, 12, 22]);
  });

  it("crosses midnight with the real local date", () => {
    const openings = rhythmOccurrences(local(23, 55), local(0, 0, 0, 6));
    expect(openings.map((portal) => [portal.day, portal.hour, portal.minute])).toEqual([
      ["2026-11-05", 23, 55],
      ["2026-11-06", 0, 0]
    ]);
  });

  it("keeps both halves of a repeated hour as distinct openings", () => {
    const previous = process.env["TZ"];
    process.env["TZ"] = "America/Los_Angeles";
    try {
      const fall = rhythmOccurrences(
        Date.parse("2026-11-01T08:00:00Z"),
        Date.parse("2026-11-01T09:59:00Z")
      );
      const repeats = fall.filter((portal) => portal.minute === 11 && portal.hour === 1);
      expect(repeats.map((portal) => portal.offsetMinutes)).toEqual([-420, -480]);
      expect(new Set(repeats.map((portal) => portal.id)).size).toBe(2);
    } finally {
      if (previous === undefined) delete process.env["TZ"];
      else process.env["TZ"] = previous;
    }
  });

  it("skips a local minute a daylight-saving gap never had", () => {
    const previous = process.env["TZ"];
    process.env["TZ"] = "America/Los_Angeles";
    try {
      // 02:00–02:59 does not exist on this day; 02:11 must not be invented.
      const spring = rhythmOccurrences(
        Date.parse("2026-03-08T09:00:00Z"),
        Date.parse("2026-03-08T11:00:00Z")
      );
      expect(spring.some((portal) => portal.hour === 2)).toBe(false);
      expect(spring.some((portal) => portal.hour === 3 && portal.minute === 0)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env["TZ"];
      else process.env["TZ"] = previous;
    }
  });
});

describe("a configured recurrence", () => {
  it("offers one opening a day on the selected weekdays", () => {
    const weekdays = [new Date(2026, 10, 5).getDay()];
    const openings = occurrencesBetween(
      { kind: "weekly", weekdays, hour: 9, minute: 0 },
      local(0, 0),
      local(0, 0, 0, 6)
    );
    expect(openings).toHaveLength(1);
    expect(openings[0]?.hour).toBe(9);
    expect(openings[0]?.minute).toBe(0);
  });

  it("offers every hour at its minute, and only while its own minute matches", () => {
    const openings = occurrencesBetween({ kind: "hourly", minute: 11 }, local(0, 0), local(3, 0));
    expect(openings.map((portal) => [portal.hour, portal.minute])).toEqual([
      [0, 11],
      [1, 11],
      [2, 11]
    ]);
  });

  it("keeps a one-off as the instant it was chosen, absent outside its window", () => {
    const at = local(9, 30);
    expect(occurrencesBetween({ kind: "once", at }, local(9, 0), local(10, 0))).toHaveLength(1);
    expect(occurrencesBetween({ kind: "once", at }, local(10, 0), local(11, 0))).toEqual([]);
  });
});

describe("which occurrence is outstanding", () => {
  it("never offers one before the schedule was activated", () => {
    const source = weekly(9, 0);
    const activatedAt = local(10, 0);
    expect(dueOpening(source, local(9, 30), activatedAt, null)).toBeNull();
    expect(dueOpening(source, local(9, 0, 30, 5), activatedAt, null)).toBeNull();
    // The next day's opening is after activation, and live in its own minute.
    expect(dueOpening(source, local(9, 0, 30, 6), activatedAt, null)).not.toBeNull();
  });

  it("offers the opening that is live, not a replay of the whole day", () => {
    const source = weekly(9, 0);
    // Only inside its own minute: an hour later the opening is gone, not pending.
    const due = dueOpening(source, local(9, 0, 30), local(0, 0), null);
    expect(due?.hour).toBe(9);
    expect(due?.minute).toBe(0);
    expect(dueOpening(source, local(11, 0), local(0, 0), null)).toBeNull();
  });

  it("withdraws an opening when its minute has gone by", () => {
    const source = weekly(9, 0);
    const opening = local(9, 0);
    expect(dueOpening(source, opening + 59_999, local(0, 0), null)).not.toBeNull();
    expect(dueOpening(source, opening + 60_000, local(0, 0), null)).toBeNull();
  });

  it("does not backfill a missed opening after a sleep", () => {
    const source = weekly(9, 0);
    // Woken long after the minute: nothing is offered for a moment nobody saw.
    expect(dueOpening(source, local(14, 30), local(0, 0), null)).toBeNull();
  });

  it("stops offering an opening once it has been answered", () => {
    const source = weekly(9, 0);
    const opened = local(9, 0);
    expect(dueOpening(source, local(9, 0, 30), local(0, 0), opened)).toBeNull();
    // The next day's opening is a different fact, and is offered in its own minute.
    expect(dueOpening(source, local(9, 0, 30, 6), local(0, 0), opened)?.opensAt).toBe(
      local(9, 0, 0, 6)
    );
  });

  it("names the next opening after now", () => {
    const source = weekly(9, 0);
    expect(nextOpening(source, local(10, 0))?.opensAt).toBe(local(9, 0, 0, 6));
    expect(nextOpening(source, local(8, 0))?.opensAt).toBe(local(9, 0));
  });

  it("offers the rhythm through the same source shape", () => {
    const rhythm: PortalSource = {
      id: "rhythm",
      name: "Rhythm",
      contextId: "main",
      leadMinutes: 11,
      createdAt: 0,
      schedule: null
    };
    const due = dueOpening(rhythm, local(12, 0, 20), local(11, 0), null);
    expect(due?.minute).toBe(0);
    expect(sourceOccurrences(rhythm, local(12, 0), local(12, 12)).length).toBeGreaterThan(0);
  });
});

describe("phase", () => {
  it("is approaching before the opening, available inside its minute, expired after", () => {
    const portal = portalAt(local(22, 22));
    expect(portalPhase(portal, portal.opensAt - 1)).toBe("approaching");
    expect(portalPhase(portal, portal.opensAt)).toBe("available");
    expect(portalPhase(portal, portal.opensAt + 59_999)).toBe("available");
    expect(portalPhase(portal, portal.opensAt + 60_000)).toBe("expired");
    expect(portalPhase(portal, portal.opensAt + 3_600_000)).toBe("expired");
  });

  it("accepts a beginning inside the opening's own minute and nothing else", () => {
    const portal = portalAt(local(22, 22));
    expect(portalContainsBeginning(portal, portal.opensAt - 1)).toBe(false);
    expect(portalContainsBeginning(portal, portal.opensAt)).toBe(true);
    expect(portalContainsBeginning(portal, portal.opensAt + 59_999)).toBe(true);
    expect(portalContainsBeginning(portal, portal.opensAt + 60_000)).toBe(false);
  });

  it("recognises real seconds without rounding or snapping", () => {
    const portal = portalAt(local(22, 22));
    expect(portalAlignments(portal, local(22, 22, 22) + 999)).toEqual(["hour-echo", "minute-echo"]);
    expect(portalAlignments(portal, local(22, 22) + 200)).toEqual(["boundary"]);
    expect(portalAlignments(portal, local(22, 22, 23))).toEqual([]);
    expect(portalAlignments(portal, local(22, 23, 22))).toEqual([]);
  });
});

describe("readPortalSchedules", () => {
  it("reads a weekly schedule and normalises its days", () => {
    const read = readPortalSchedules([
      {
        id: "s1",
        name: " Morning ",
        contextId: "main",
        enabled: true,
        createdAt: 1,
        leadMinutes: 5,
        when: { kind: "weekly", weekdays: [3, 1, 3], hour: 9, minute: 0 }
      }
    ]);

    expect(read.errors).toEqual([]);
    expect(read.valid[0]?.name).toBe("Morning");
    expect(read.valid[0]?.when).toEqual({ kind: "weekly", weekdays: [1, 3], hour: 9, minute: 0 });
  });

  it("refuses the reserved rhythm id and a recurrence the calendar cannot make", () => {
    expect(readPortalSchedules([{ id: "rhythm", name: "Mine", contextId: "main", when: { kind: "hourly", minute: 1 } }]).errors[0]?.message).toContain("reserved");
    expect(
      readPortalSchedules([
        { id: "s1", name: "Bad", contextId: "main", when: { kind: "hourly", minute: 61 } }
      ]).valid
    ).toEqual([]);
    expect(
      readPortalSchedules([
        { id: "s1", name: "Bad", contextId: "main", when: { kind: "weekly", weekdays: [9], hour: 9, minute: 0 } }
      ]).errors
    ).toHaveLength(1);
    expect(
      readPortalSchedules([
        { id: "s1", name: "Bad", contextId: "main", when: { kind: "once", at: Number.NaN } }
      ]).errors
    ).toHaveLength(1);
  });

  it("reports a stored value that is not a list instead of emptying it", () => {
    const read = readPortalSchedules({ s1: {} });
    expect(read.valid).toEqual([]);
    expect(read.errors[0]?.index).toBeNull();
  });

  it("keeps the row it cannot use and reports where it is", () => {
    const read = readPortalSchedules([{ id: "" }, { id: "s2", name: "Ok", contextId: "main", when: { kind: "hourly", minute: 0 } }]);
    expect(read.valid.map((schedule) => schedule.id)).toEqual(["s2"]);
    expect(read.errors[0]?.index).toBe(0);
  });
});

describe("what a schedule may describe", () => {
  it("refuses a one-off that does not start on a whole minute", () => {
    const instant = local(9, 30) + 4_000;
    const read = readPortalSchedules([
      { id: "once", name: "Once", contextId: "main", when: { kind: "once", at: instant } }
    ]);

    expect(read.valid).toEqual([]);
    expect(read.errors[0]?.message).toContain("whole minute");

    // On the minute it is usable, because that is what a record can name.
    const ok = readPortalSchedules([
      { id: "once", name: "Once", contextId: "main", when: { kind: "once", at: local(9, 30) } }
    ]);
    expect(ok.valid).toHaveLength(1);
    expect(ok.errors).toEqual([]);
  });
});
