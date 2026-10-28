import { describe, expect, it } from "vitest";

import { formatClock, formatDurationLine, parseDurationLine } from "../src/core/duration";

describe("formatClock", () => {
  it("pads every field to two digits", () => {
    expect(formatClock(0)).toBe("00:00:00");
    expect(formatClock(372_300)).toBe("00:06:12");
    expect(formatClock(3_723_000)).toBe("01:02:03");
  });

  it("counts in hours and lets them run past a day", () => {
    expect(formatClock(90_000_000)).toBe("25:00:00");
  });

  it("never returns a negative clock", () => {
    expect(formatClock(-500)).toBe("00:00:00");
  });

  it("rounds to the nearest second, the smallest unit the line shows", () => {
    expect(formatClock(499)).toBe("00:00:00");
    expect(formatClock(500)).toBe("00:00:01");
    expect(formatClock(1_499)).toBe("00:00:01");
  });
});

describe("duration lines", () => {
  it("round-trips every value it can write", () => {
    for (const ms of [0, 1_000, 59_000, 60_000, 372_000, 3_599_000]) {
      const line = formatDurationLine("-", ms);
      expect(line.startsWith("- ")).toBe(true);
      expect(parseDurationLine(line)).toEqual({ sigil: "-", ms });
    }
  });

  it("reads seconds out of the clock", () => {
    expect(parseDurationLine("+ 00:04:12")).toEqual({ sigil: "+", ms: 252_000 });
  });

  it("reads the three sigils and rejects anything else", () => {
    expect(parseDurationLine("+ 00:04:12")?.sigil).toBe("+");
    expect(parseDurationLine("= 00:04:12")?.sigil).toBe("=");
    expect(parseDurationLine("- 00:04:12")?.sigil).toBe("-");
    expect(parseDurationLine("00:04:12")).toBeNull();
    expect(parseDurationLine("prose + 00:04:12")).toBeNull();
  });

  it("keeps minutes and seconds inside their own range", () => {
    expect(parseDurationLine("+ 00:60:00")).toBeNull();
    expect(parseDurationLine("+ 00:00:60")).toBeNull();
    expect(parseDurationLine("+ 00:59:59")).toEqual({ sigil: "+", ms: 3_599_000 });
  });

  it("needs three fields and the space after the sigil", () => {
    expect(parseDurationLine("+ 04:00")).toBeNull();
    expect(parseDurationLine("+00:04:12")).toBeNull();
    expect(parseDurationLine("+\t00:04:12")?.ms).toBe(252_000);
  });
});
