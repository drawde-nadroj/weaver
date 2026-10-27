import { describe, expect, it } from "vitest";

import { formatClock, formatSessionDuration, pad2, parseClockPrefix } from "../src/core/clock";

describe("pad2", () => {
  it("pads to two digits", () => {
    expect(pad2(0)).toBe("00");
    expect(pad2(9)).toBe("09");
    expect(pad2(10)).toBe("10");
    expect(pad2(100)).toBe("100");
  });
});

describe("formatClock", () => {
  it("formats local time with seconds", () => {
    expect(formatClock(new Date(2024, 0, 2, 3, 4, 5), "HH:mm:ss")).toBe("03:04:05");
    expect(formatClock(new Date(2024, 0, 2, 13, 44, 9), "HH:mm:ss")).toBe("13:44:09");
  });

  it("formats local time without seconds", () => {
    expect(formatClock(new Date(2024, 0, 2, 13, 44, 9), "HH:mm")).toBe("13:44");
  });

  it("prints midnight as 00:00:00 rather than 12:00 AM", () => {
    expect(formatClock(new Date(2024, 0, 2, 0, 0, 0), "HH:mm:ss")).toBe("00:00:00");
    expect(formatClock(new Date(2024, 0, 2, 0, 0, 0), "HH:mm")).toBe("00:00");
  });
});

describe("formatSessionDuration", () => {
  const start = new Date(2024, 0, 2, 10, 0, 0);

  it("formats minutes and seconds", () => {
    expect(formatSessionDuration(start, new Date(2024, 0, 2, 10, 0, 0))).toBe("+00:00");
    expect(formatSessionDuration(start, new Date(2024, 0, 2, 10, 0, 5))).toBe("+00:05");
    expect(formatSessionDuration(start, new Date(2024, 0, 2, 10, 1, 30))).toBe("+01:30");
    expect(formatSessionDuration(start, new Date(2024, 0, 2, 10, 59, 59))).toBe("+59:59");
  });

  it("widens past an hour", () => {
    expect(formatSessionDuration(start, new Date(2024, 0, 2, 11, 1, 1))).toBe("+1:01:01");
  });

  it("never goes negative", () => {
    expect(formatSessionDuration(start, new Date(2024, 0, 2, 9, 0, 0))).toBe("+00:00");
  });
});

describe("parseClockPrefix", () => {
  it("splits a time and a separated title", () => {
    expect(parseClockPrefix("16:37:04 - Bhartrhari")).toEqual({ time: "16:37:04", rest: "Bhartrhari" });
    expect(parseClockPrefix("16:37 - Bhartrhari")).toEqual({ time: "16:37", rest: "Bhartrhari" });
  });

  it("accepts single-digit hours", () => {
    expect(parseClockPrefix("9:05 - Early")).toEqual({ time: "9:05", rest: "Early" });
  });

  it("returns an empty title for a bare time", () => {
    expect(parseClockPrefix("16:37")).toEqual({ time: "16:37", rest: "" });
    expect(parseClockPrefix("16:37:04")).toEqual({ time: "16:37:04", rest: "" });
  });

  it("keeps a remainder that has no separator", () => {
    expect(parseClockPrefix("16:37 Bhartrhari")).toEqual({ time: "16:37", rest: " Bhartrhari" });
  });

  it("keeps a hyphenated title intact", () => {
    expect(parseClockPrefix("16:37 - Well-known - note")).toEqual({
      time: "16:37",
      rest: "Well-known - note"
    });
  });

  it("returns no time when the text does not start with a clock", () => {
    expect(parseClockPrefix("Bhartrhari")).toEqual({ time: null, rest: "Bhartrhari" });
    expect(parseClockPrefix("")).toEqual({ time: null, rest: "" });
    expect(parseClockPrefix("16:3 - short")).toEqual({ time: null, rest: "16:3 - short" });
    expect(parseClockPrefix("16:371 - long")).toEqual({ time: null, rest: "16:371 - long" });
    expect(parseClockPrefix("abc 16:37")).toEqual({ time: null, rest: "abc 16:37" });
  });
});
