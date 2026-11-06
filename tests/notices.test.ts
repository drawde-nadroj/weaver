import { describe, expect, it } from "vitest";

import { noticePortal } from "../src/notices";

describe("noticePortal", () => {
  it("names the opening at the normal eleven-minute boundary", () => {
    expect(noticePortal("Rhythm", "22:55", 660)).toBe("Rhythm · 22:55 opens in 11 minutes");
  });

  it("speaks the time actually remaining when a late wake finds the portal closer", () => {
    expect(noticePortal("Rhythm", "22:55", 240)).toBe("Rhythm · 22:55 opens in 4 minutes");
    expect(noticePortal("Rhythm", "22:55", 61)).toBe("Rhythm · 22:55 opens in 2 minutes");
    expect(noticePortal("Rhythm", "22:55", 60)).toBe("Rhythm · 22:55 opens in 1 minute");
  });

  it("counts the last minute in seconds rather than claiming a whole minute", () => {
    expect(noticePortal("Rhythm", "22:55", 59)).toBe("Rhythm · 22:55 opens in 59 seconds");
    expect(noticePortal("Rhythm", "22:55", 1)).toBe("Rhythm · 22:55 opens in 1 second");
  });

  it("says it is open rather than printing a zero countdown", () => {
    expect(noticePortal("Rhythm", "22:55", 0)).toBe("Rhythm · 22:55 is open");
    expect(noticePortal("Rhythm", "22:55", -3)).toBe("Rhythm · 22:55 is open");
  });

  it("never claims a fractional arrival", () => {
    expect(noticePortal("Rhythm", "00:00", 0.4)).toBe("Rhythm · 00:00 opens in 1 second");
  });
});
