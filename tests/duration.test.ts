import { describe, expect, it } from "vitest";

import { formatClock, formatClockRow, parseClockRow } from "../src/core/duration";

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

describe("clock rows", () => {
  it("round-trips every duration it can write", () => {
    for (const ms of [0, 1_000, 59_000, 60_000, 372_000, 3_599_000]) {
      const row = formatClockRow("09:14:22", "-", ms);
      expect(row.startsWith("- ")).toBe(true);
      expect(row.endsWith(" 09:14:22")).toBe(true);
      expect(parseClockRow(row)).toMatchObject({
        time: "09:14:22",
        duration: { sigil: "-", ms }
      });
    }
  });

  it("reads the two halves independently", () => {
    expect(parseClockRow("+ 00:04:12 09:14:22")).toMatchObject({
      time: "09:14:22",
      duration: { sigil: "+", ms: 252_000 }
    });
    expect(parseClockRow("09:14:22")).toMatchObject({ time: "09:14:22", duration: null });
    expect(parseClockRow("+ 00:04:12")).toMatchObject({
      time: null,
      duration: { sigil: "+", ms: 252_000 }
    });
  });

  it("does not read the old moment-first order", () => {
    // A clock row is duration first. The old spelling must fail, so an
    // unmigrated note is not silently read with its clock as prose.
    expect(parseClockRow("09:14:22 + 00:04:12")).toBeNull();
  });

  it("reads the three sigils and rejects anything else", () => {
    expect(parseClockRow("= 00:04:12")?.duration?.sigil).toBe("=");
    expect(parseClockRow("- 00:04:12")?.duration?.sigil).toBe("-");
    expect(parseClockRow("* 00:04:12")).toBeNull();
    expect(parseClockRow("prose + 00:04:12")).toBeNull();
    expect(parseClockRow("09:14:22 prose")).toBeNull();
  });

  it("reports the duration half's span, so a rewrite leaves the moment alone", () => {
    const row = parseClockRow("  + 00:04:12 9:14  ");

    expect(row?.time).toBe("09:14:00");
    expect(row?.durationSpan).toEqual({ from: 2, to: 12 });

    // A duration-only row has a span too; the leading indent is outside it and
    // the rewrite preserves it.
    expect(parseClockRow("   + 00:04:12")?.durationSpan).toEqual({ from: 3, to: 13 });
  });

  it("keeps minutes and seconds inside their own range", () => {
    expect(parseClockRow("+ 00:60:00 09:14:22")).toBeNull();
    expect(parseClockRow("+ 00:00:60 09:14:22")).toBeNull();
    expect(parseClockRow("+ 00:59:59 09:14:22")?.duration).toEqual({
      sigil: "+",
      ms: 3_599_000
    });
  });

  it("needs three fields in the duration and the space after the sigil", () => {
    expect(parseClockRow("+ 04:00 09:14:22")).toBeNull();
    expect(parseClockRow("+00:04:12 09:14:22")).toBeNull();
    expect(parseClockRow("+\t00:04:12 09:14:22")?.duration?.ms).toBe(252_000);
  });

  it("is a clock row only when it carries a clock", () => {
    expect(parseClockRow("")).toBeNull();
    expect(parseClockRow("   ")).toBeNull();
  });
});
