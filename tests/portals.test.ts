import { describe, expect, it } from "vitest";
import { portalAlignments, portalInstants, portalPhase } from "../src/core/portals";

const local = (hour: number, minute: number, second = 0) => new Date(2026, 10, 5, hour, minute, second).getTime();

describe("portal instants", () => {
  it("includes overlapping eleven-minute windows and deduplicates mirrors", () => {
    expect(portalInstants(local(12, 0), local(12, 11)).map(p => p.minute)).toEqual([0, 11]);
    expect(portalInstants(local(12, 1), local(12, 12)).map(p => p.minute)).toEqual([11, 12]);
    expect(portalInstants(local(12, 11), local(12, 22)).map(p => p.minute)).toEqual([11, 12, 22]);
    expect(portalInstants(local(22, 22), local(22, 22))).toHaveLength(1);
    expect(portalInstants(local(12, 11) + 1, local(12, 12) - 1)).toEqual([]);
  });
  it("crosses midnight with the actual local date", () => {
    const openings = portalInstants(local(23, 55), local(24, 0));
    expect(openings.map(p => [p.day, p.hour, p.minute])).toEqual([["2026-11-05", 23, 55], ["2026-11-06", 0, 0]]);
  });
  it("uses actual instants across skipped and repeated hours", () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const spring = portalInstants(Date.parse("2026-03-08T09:55:00Z"), Date.parse("2026-03-08T10:11:00Z"));
      expect(spring.map(p => [p.hour, p.minute])).toEqual([[1, 55], [3, 0], [3, 3], [3, 11]]);
      const fall = portalInstants(Date.parse("2026-11-01T08:00:00Z"), Date.parse("2026-11-01T09:59:00Z"));
      const repeats = fall.filter(p => p.minute === 11);
      expect(repeats.map(p => p.offsetMinutes)).toEqual([-420, -480]);
      expect(new Set(repeats.map(p => p.id)).size).toBe(2);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
  it("recognizes real seconds without rounding or late held hits", () => {
    const portal = portalInstants(local(22, 22), local(22, 22))[0]!;
    expect(portalAlignments(portal, local(22, 22, 22) + 999)).toEqual(["hour-echo", "minute-echo"]);
    expect(portalAlignments(portal, local(22, 22) + 200)).toEqual(["boundary"]);
    expect(portalAlignments(portal, local(22, 22, 23))).toEqual([]);
    expect(portalAlignments(portal, local(22, 23, 22))).toEqual([]);
    expect(portalPhase(portal, portal.opensAt - 1, true)).toBe("approaching");
    expect(portalPhase(portal, portal.opensAt, false)).toBe("open");
    expect(portalPhase(portal, portal.opensAt + 60000, false)).toBe("expired");
    expect(portalPhase(portal, portal.opensAt + 60000, true)).toBe("held");
  });
});
