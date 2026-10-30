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
      expect(row.startsWith("09:14:22 - ")).toBe(true);
      expect(parseClockRow(row)).toMatchObject({
        time: "09:14:22",
        duration: { sigil: "-", ms }
      });
    }
  });

  it("reads the two halves independently", () => {
    expect(parseClockRow("09:14:22 + 00:04:12")).toMatchObject({
      time: "09:14:22",
      duration: { sigil: "+", ms: 252_000 }
    });
    expect(parseClockRow("09:14:22")).toMatchObject({ time: "09:14:22", duration: null });
    expect(parseClockRow("+ 00:04:12")).toMatchObject({
      time: null,
      duration: { sigil: "+", ms: 252_000 }
    });
  });

  it("reads the three sigils and rejects anything else", () => {
    expect(parseClockRow("= 00:04:12")?.duration?.sigil).toBe("=");
    expect(parseClockRow("- 00:04:12")?.duration?.sigil).toBe("-");
    expect(parseClockRow("* 00:04:12")).toBeNull();
    expect(parseClockRow("prose + 00:04:12")).toBeNull();
    expect(parseClockRow("09:14:22 prose")).toBeNull();
  });

  it("keeps the moment's own characters, so a rewrite leaves it alone", () => {
    const row = parseClockRow("  9:14  + 00:04:12");

    expect(row?.time).toBe("09:14:00");
    expect(row?.head).toBe("  9:14  ");

    // A duration-only row keeps its indent too: the head is everything the
    // rewrite must not touch, not just the moment.
    expect(parseClockRow("   + 00:04:12")?.head).toBe("   ");
  });

  it("keeps minutes and seconds inside their own range", () => {
    expect(parseClockRow("09:14:22 + 00:60:00")).toBeNull();
    expect(parseClockRow("09:14:22 + 00:00:60")).toBeNull();
    expect(parseClockRow("09:14:22 + 00:59:59")?.duration).toEqual({
      sigil: "+",
      ms: 3_599_000
    });
  });

  it("needs three fields in the duration and the space after the sigil", () => {
    expect(parseClockRow("09:14:22 + 04:00")).toBeNull();
    expect(parseClockRow("09:14:22 +00:04:12")).toBeNull();
    expect(parseClockRow("09:14:22 +\t00:04:12")?.duration?.ms).toBe(252_000);
  });

  it("is a clock row only when it carries a clock", () => {
    expect(parseClockRow("")).toBeNull();
    expect(parseClockRow("   ")).toBeNull();
  });
});
