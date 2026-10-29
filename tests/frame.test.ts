import { describe, expect, it } from "vitest";

import {
  durationLabel,
  durationRuns,
  frameGeometry,
  labelRuns,
  markerLabel,
  markerRuns
} from "../src/core/frame";

const COLUMN = { left: 100, right: 500 };
const GUTTER = 14;
const MIN_WIDTH = 140;
const FLOOR = 120;

function frame(text: { left: number; right: number } | null, column = COLUMN) {
  return frameGeometry({ column, text, gutter: GUTTER, minWidth: MIN_WIDTH, floorWidth: FLOOR });
}

describe("frameGeometry", () => {
  it("hugs a short entry instead of filling the pane", () => {
    const geometry = frame({ left: 120, right: 300 });

    expect(geometry.drawn).toBe(true);
    // The rail sits one gutter outside the text on both sides.
    expect(geometry.left).toBe(106);
    expect(geometry.width).toBe(208);
    expect(geometry.left + geometry.width).toBe(314);
  });

  it("grows with the text and stops at the edge", () => {
    expect(frame({ left: 120, right: 380 }).width).toBe(288);
    expect(frame({ left: 120, right: 900 }).width).toBe(394);
    expect(frame({ left: 120, right: 900 }).left + frame({ left: 120, right: 900 }).width).toBe(
      COLUMN.right
    );
  });

  it("never gets narrower than its minimum", () => {
    expect(frame({ left: 120, right: 140 }).width).toBe(MIN_WIDTH);
  });

  it("follows the entry's indent, so a deeper entry nests", () => {
    const geometry = frame({ left: 180, right: 300 });

    expect(geometry.left).toBe(166);
    expect(geometry.width).toBe(148);
  });

  it("does not leave the column when the indent is past the edge", () => {
    const geometry = frame({ left: 460, right: 480 });

    expect(geometry.left).toBe(446);
    expect(geometry.left).toBeGreaterThanOrEqual(COLUMN.left);
  });

  it("draws nothing when the pane cannot carry a frame", () => {
    expect(frame({ left: 110, right: 170 }, { left: 100, right: 180 }).drawn).toBe(false);
  });

  it("draws nothing when nothing could be measured", () => {
    const geometry = frame(null);

    expect(geometry.drawn).toBe(false);
    expect(geometry.left).toBe(COLUMN.left);
  });
});

describe("frame labels", () => {
  it("writes the marker in its canonical shape", () => {
    expect(markerLabel({ d: 2, c: 1, n: 3, time: "13:27:43" })).toBe("{ 2.1.3 } - 13:27:43");
  });

  it("writes the sigil and the clock", () => {
    expect(durationLabel("+", 252_000)).toBe("+ 00:04:12");
  });

  it("splits a label into digit runs and ink runs", () => {
    expect(labelRuns("{ 2.1.3 } - 13:27:43")).toEqual([
      { text: "{ ", num: false },
      { text: "2", num: true },
      { text: ".", num: false },
      { text: "1", num: true },
      { text: ".", num: false },
      { text: "3", num: true },
      { text: " } - ", num: false },
      { text: "13", num: true },
      { text: ":", num: false },
      { text: "27", num: true },
      { text: ":", num: false },
      { text: "43", num: true }
    ]);
  });

  it("keeps exactly three digit runs in a duration, so the clock can tick", () => {
    const digits = durationRuns("-", 3_723_000).filter((run) => run.num);

    expect(digits.map((run) => run.text)).toEqual(["01", "02", "03"]);
  });

  it("carries the marker's own numbers", () => {
    expect(markerRuns({ d: 7, c: 12, n: 140, time: "09:05:00" }).map((run) => run.text)).toEqual([
      "{ ",
      "7",
      ".",
      "12",
      ".",
      "140",
      " } - ",
      "09",
      ":",
      "05",
      ":",
      "00"
    ]);
  });
});
