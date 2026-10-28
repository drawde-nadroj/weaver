import { describe, expect, it } from "vitest";

import { formatClock, pad2 } from "../src/core/clock";

const AT_1730 = new Date(2026, 9, 27, 17, 30, 4);

describe("pad2", () => {
  it("pads and leaves two-digit values alone", () => {
    expect(pad2(7)).toBe("07");
    expect(pad2(12)).toBe("12");
    expect(pad2(0)).toBe("00");
  });
});

describe("formatClock", () => {
  it("is always HH:MM:SS, from the machine's own timezone", () => {
    expect(formatClock(new Date(2026, 9, 27, 9, 5, 3))).toBe("09:05:03");
    expect(formatClock(AT_1730)).toBe("17:30:04");
  });
});
