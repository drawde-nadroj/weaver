import { describe, expect, it } from "vitest";

import { frameBox, frameColumn, frameSpan, trayFrame, type FrameColumn, type FrameSpan } from "../src/core/frame";

const COLUMN: FrameColumn = { left: 100, right: 500 };
/** Corner 10 + stub 14 + label pad 8: where the marker's ink starts inside its rail. */
const GUTTER = 32;

function box(textLeft: number | null, column: FrameColumn = COLUMN) {
  return frameBox({ column, textLeft, gutter: GUTTER });
}

/**
 * The pending tray is laid out, not drawn: its numbers are relative to the
 * content's own text edge, which is zero. A desktop note is inset from the pane;
 * a phone note runs close to it. Both must produce the box a root entry's frame
 * gets at the same anchor.
 */
describe("frameColumn", () => {
  const PANE: FrameColumn = { left: 0, right: 1400 };

  it("runs from the pane's left edge to one gutter past the content", () => {
    const column = frameColumn({ pane: PANE, content: { left: 200, right: 1000 }, gutter: GUTTER });

    expect(column).toEqual({ left: 0, right: 1032 });
  });

  it("stops at the pane's own right edge rather than running past it", () => {
    const column = frameColumn({ pane: { left: 0, right: 320 }, content: { left: 16, right: 304 }, gutter: GUTTER });

    expect(column).toEqual({ left: 0, right: 320 });
  });
});

describe("trayFrame", () => {
  /** A root entry's marker ink starts at the content's own text edge. */
  function rootEntry(contentLeft: number, column: FrameColumn) {
    return frameBox({ column, textLeft: contentLeft, gutter: GUTTER });
  }

  it("reaches the same two edges as a root entry's frame on a desktop note", () => {
    const content: FrameColumn = { left: 200, right: 1000 };
    const column = frameColumn({ pane: { left: 0, right: 1400 }, content, gutter: GUTTER });

    const entry = rootEntry(content.left, column);
    // In the tray's own coordinates the content's text edge is zero.
    const tray = trayFrame({
      column: frameColumn({
        pane: { left: -200, right: 1200 },
        content: { left: 0, right: 800 },
        gutter: GUTTER
      }),
      textLeft: 0,
      gutter: GUTTER
    });

    expect(tray).toEqual({ marginLeft: -GUTTER, width: entry.width });
    expect(content.left + (tray?.marginLeft ?? 0)).toBe(entry.left);
  });

  it("spans the whole pane on a phone, exactly as the entry frame does", () => {
    const content: FrameColumn = { left: 16, right: 304 };
    const entry = rootEntry(content.left, frameColumn({ pane: { left: 0, right: 320 }, content, gutter: GUTTER }));
    const tray = trayFrame({
      column: frameColumn({
        pane: { left: -16, right: 304 },
        content: { left: 0, right: 288 },
        gutter: GUTTER
      }),
      textLeft: 0,
      gutter: GUTTER
    });

    expect(entry).toEqual({ left: 0, width: 320, drawn: true });
    expect(tray).toEqual({ marginLeft: -16, width: 320 });
  });

  it("never draws before the content has a width", () => {
    expect(trayFrame({ column: { left: 0, right: 0 }, textLeft: 0, gutter: GUTTER })).toBeNull();
  });
});

describe("frameBox", () => {
  it("puts the left rail one label inset outside the marker's ink", () => {
    const frame = box(160);

    expect(frame.drawn).toBe(true);
    expect(frame.left).toBe(128);
    expect(frame.width).toBe(372);
    expect(frame.left + frame.width).toBe(COLUMN.right);
  });

  it("stops at the pane's own edge rather than running outside it", () => {
    const frame = box(110);

    expect(frame.left).toBe(100);
    expect(frame.width).toBe(400);
  });

  it("nests by the entry's own indent", () => {
    const frame = box(200);

    expect(frame.left).toBe(168);
    expect(frame.width).toBe(332);
  });

  it("draws in a narrow pane, narrow", () => {
    const frame = box(110, { left: 100, right: 180 });

    expect(frame.drawn).toBe(true);
    expect(frame.width).toBe(80);
  });

  it("draws nothing only before anything has been measured", () => {
    const frame = box(null);

    expect(frame.drawn).toBe(false);
    expect(frame.left).toBe(COLUMN.left);
    expect(frame.width).toBe(400);
  });
});

const AIR = 8;

function span(firstRail: number, lastRail: number, nextRail: number | null = null) {
  return frameSpan({ firstRail, lastRail, nextRail, air: AIR });
}

/**
 * Every number here was measured off a live screenshot of a 32 px entry: the
 * marker's ink ran 40..63 (centre 51.5), the clock's 177..199 (centre 188), and
 * the next entry's marker 235..258 (centre 246.5). In that build the top rail sat
 * at 23 — five pixels above the marker's own line — and the bottom rail at 200,
 * through the clock's descenders.
 */
describe("frameSpan", () => {
  it("runs each rail through the centre of the row that labels it", () => {
    const frame = span(51, 188);

    expect(frame.drawn).toBe(true);
    expect(frame.top).toBe(51);
    expect(frame.bottom).toBe(188);
  });

  it("reproduces the screenshot's rails exactly", () => {
    const frame = span(51.5, 188, 246.5);

    expect(frame.top).toBe(51.5);
    expect(frame.bottom).toBe(188);
    // 58.5 px of clear space between one entry's clock centre and the next
    // marker's — the gap Reading view's margin is built to match.
    expect(246.5 - frame.bottom).toBeGreaterThanOrEqual(AIR);
  });

  it("needs exactly its air before the next entry's rail", () => {
    expect(span(51, 188, 196).drawn).toBe(true);
    expect(span(51, 188, 195).drawn).toBe(false);
  });

  it("draws no box when the rails touch or cross", () => {
    // A single row's centre cannot sit above itself: no interior, no box.
    expect(span(200, 200).drawn).toBe(false);
    expect(span(200, 180).drawn).toBe(false);
  });

  it("is never capped by the next entry", () => {
    // A rail is a label's centre or it is nothing: the box is withheld rather
    // than trimmed to a height that cuts its own clock.
    const frame = span(51, 188, 400);

    expect(frame.drawn).toBe(true);
    expect(frame.bottom).toBe(188);
  });

  it("keeps every box clear of the next one in a run", () => {
    const rails: Array<[number, number]> = [
      [51.5, 188],
      [246.5, 383],
      [441.5, 578]
    ];
    const boxes: FrameSpan[] = rails.map(([top, bottom], index) =>
      span(top, bottom, rails[index + 1]?.[0] ?? null)
    );

    for (let index = 0; index + 1 < boxes.length; index += 1) {
      const upper = boxes[index] as FrameSpan;
      const lower = boxes[index + 1] as FrameSpan;
      expect(lower.top - upper.bottom).toBeGreaterThanOrEqual(AIR);
    }
  });
});
