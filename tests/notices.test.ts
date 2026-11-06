import { describe, expect, it } from "vitest";

import { noticePortal } from "../src/notices";

describe("noticePortal", () => {
  it("names the opening at the normal eleven-minute boundary", () => {
    expect(noticePortal("22:55", 660)).toBe("Portal · 22:55 opens in 11 minutes");
  });

  it("speaks the time actually remaining when a late wake finds the portal closer", () => {
    expect(noticePortal("22:55", 240)).toBe("Portal · 22:55 opens in 4 minutes");
    expect(noticePortal("22:55", 61)).toBe("Portal · 22:55 opens in 2 minutes");
    expect(noticePortal("22:55", 60)).toBe("Portal · 22:55 opens in 1 minute");
  });

  it("counts the last minute in seconds rather than claiming a whole minute", () => {
    expect(noticePortal("22:55", 59)).toBe("Portal · 22:55 opens in 59 seconds");
    expect(noticePortal("22:55", 1)).toBe("Portal · 22:55 opens in 1 second");
  });

  it("says it is open rather than printing a zero countdown", () => {
    expect(noticePortal("22:55", 0)).toBe("Portal · 22:55 is open");
    expect(noticePortal("22:55", -3)).toBe("Portal · 22:55 is open");
  });

  it("never claims a fractional arrival", () => {
    expect(noticePortal("00:00", 0.4)).toBe("Portal · 00:00 opens in 1 second");
  });
});
