import { describe, expect, it } from "vitest";

import {
  floatingComposerBox,
  frameBox,
  frameColumn,
  frameSpan,
  loomLayout,
  loomWidth,
  type FrameColumn,
  type FrameSpan
} from "../src/core/frame";

const COLUMN: FrameColumn = { left: 100, right: 500 };
/** Corner 10 + stub 14 + label pad 8: where the address's ink starts inside its rail. */
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

describe("frameBox", () => {
  it("puts the left rail one label inset outside the address's ink", () => {
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
 * address's ink ran 40..63 (centre 51.5), the clock's 177..199 (centre 188), and
 * the next entry's address 235..258 (centre 246.5). In that build the top rail sat
 * at 23 — five pixels above the address's own line — and the bottom rail at 200,
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
    // address's — the gap Reading view's margin is built to match.
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

describe("the floating composer's box", () => {
  const VIEWPORT = { left: 0, right: 1200, top: 0, bottom: 800 };
  const PANE = { left: 200, right: 1000, top: 40, bottom: 800 };
  const CONTENT = { left: 320, right: 880 };

  const box = (overrides: Partial<Parameters<typeof floatingComposerBox>[0]> = {}) =>
    floatingComposerBox({
      viewport: VIEWPORT,
      pane: PANE,
      content: CONTENT,
      inset: 12,
      wantedHeight: 420,
      renderedHeight: 0,
      phone: false,
      bottomReserve: 0,
      ...overrides
    });

  it("takes the writing column, never a widened one", () => {
    const result = box();
    expect(result.left).toBe(320);
    expect(result.width).toBe(560);
  });

  it("centres in the pane when no markdown column can be measured", () => {
    const result = box({ content: null });
    expect(result.width).toBe(720);
    expect(result.left).toBe(200 + (800 - 720) / 2);
  });

  it("keeps a deep underlying indent out of the surface's width", () => {
    // A deeply nested entry is still written at depth 1 in the composer.
    const shallow = box();
    const indented = box({ content: { left: 320, right: 880 } });
    expect(indented).toEqual(shallow);
  });

  it("clamps to a narrow pane rather than overflowing it", () => {
    const narrow = box({ pane: { left: 200, right: 420, top: 40, bottom: 800 } });
    expect(narrow.width).toBe(100);
    expect(narrow.left + narrow.width).toBeLessThanOrEqual(420);
  });

  it("anchors above a phone keyboard and its toolbar", () => {
    const phone = box({
      phone: true,
      bottomReserve: 48,
      viewport: { left: 0, right: 390, top: 0, bottom: 500 },
      pane: { left: 0, right: 390, top: 0, bottom: 800 },
      content: null
    });
    expect(phone.top + phone.maxHeight).toBeLessThanOrEqual(500 - 12 - 48);
  });

  it("drops the preview when the usable height cannot hold both", () => {
    const tiny = box({
      viewport: { left: 0, right: 1200, top: 0, bottom: 90 },
      pane: { left: 200, right: 1000, top: 0, bottom: 90 }
    });
    expect(tiny.preview).toBe(false);
    expect(tiny.maxHeight).toBeLessThanOrEqual(90);
    expect(box().preview).toBe(true);
  });

  it("caps the height by platform share and never by motion", () => {
    // 45% of the usable height on a desk, even when the surface would like more.
    expect(box().maxHeight).toBe(331);
    const short = box({ viewport: { left: 0, right: 1200, top: 0, bottom: 400 } });
    expect(short.maxHeight).toBeLessThanOrEqual(Math.round(400 * 0.45));
    // The same numbers, whatever the invitation's rainbow is doing.
    expect(short).toEqual(box({ viewport: { left: 0, right: 1200, top: 0, bottom: 400 } }));
  });
});

describe("the bottom-anchored surface", () => {
  const VIEWPORT = { left: 0, right: 1200, top: 0, bottom: 800 };
  const PANE = { left: 200, right: 1000, top: 40, bottom: 800 };

  const box = (overrides: Partial<Parameters<typeof floatingComposerBox>[0]> = {}) =>
    floatingComposerBox({
      viewport: VIEWPORT,
      pane: PANE,
      content: { left: 320, right: 880 },
      inset: 12,
      wantedHeight: 420,
      renderedHeight: 0,
      phone: false,
      bottomReserve: 0,
      ...overrides
    });

  it("sits on the bottom edge and grows upward by what it rendered", () => {
    const short = box({ renderedHeight: 120 });
    const tall = box({ renderedHeight: 260 });

    // The bottom edge never moves; only the top does.
    expect(short.top + 120).toBe(tall.top + 260);
    expect(short.top).toBeGreaterThan(tall.top);
  });

  it("leaves no blank card below a short surface", () => {
    const result = box({ renderedHeight: 100 });
    // One inset of air from the pane's bottom edge, and nothing more.
    expect(result.top).toBe(800 - 12 - 100);
  });

  it("caps the height and lets the inside scroll instead of overflowing", () => {
    const result = box({ renderedHeight: 900 });
    // The usable strip is the pane inside the insets, and the cap is its share.
    const usable = 800 - 12 - (40 + 12);
    expect(result.maxHeight).toBe(Math.round(usable * 0.45));
    expect(result.top).toBe(800 - 12 - result.maxHeight);
  });

  it("reserves the phone's own bottom strip", () => {
    const result = box({ renderedHeight: 200, phone: true, bottomReserve: 56 });
    expect(result.top).toBe(800 - 12 - 56 - 200);
  });

  it("uses the visual viewport a keyboard shrinks", () => {
    const result = box({
      renderedHeight: 150,
      viewport: { ...VIEWPORT, top: 100, bottom: 500 }
    });
    expect(result.top).toBe(500 - 12 - 150);
  });

  it("returns zero room rather than an inverted box when nothing fits", () => {
    const result = box({
      renderedHeight: 200,
      viewport: { left: 0, right: 1200, top: 0, bottom: 20 },
      pane: { left: 200, right: 1000, top: 0, bottom: 20 },
      inset: 12
    });

    expect(result.maxHeight).toBe(0);
    expect(result.top).toBe(12);
  });
});

describe("the Loom's geometry", () => {
  const VIEWPORT = { left: 0, right: 1200, top: 0, bottom: 800 };
  const layout = (overrides: Partial<Parameters<typeof loomLayout>[0]> = {}) =>
    loomLayout({
      viewport: VIEWPORT,
      safeArea: 0,
      expanded: false,
      reduced: false,
      activeArea: "lower",
      fontPx: 16,
      controlRows: 0,
      ...overrides
    });

  it("fixes the width at 720 and centres it, never the note's column", () => {
    expect(loomWidth(1200)).toEqual({ width: 720, padding: 16, inset: 16 });
    const box = layout();
    expect(box.width).toBe(720);
    expect(box.left).toBe(Math.round((1200 - 720) / 2));
  });

  it("uses the viewport less 16px on a narrow screen", () => {
    expect(loomWidth(500)).toEqual({ width: 484, padding: 12, inset: 8 });
    const box = layout({ viewport: { left: 0, right: 500, top: 0, bottom: 400 } });
    expect(box.width).toBe(484);
    expect(box.left).toBe(8);
  });

  it("takes a 320px lower-only surface, a 44px reduced row, and clamps to the viewport", () => {
    expect(layout().height).toBe(320);
    expect(layout({ reduced: true }).height).toBe(44);
    expect(layout({ viewport: { ...VIEWPORT, bottom: 200 } }).height).toBe(200 - 16);
  });

  it("anchors the bottom edge and reserves the safe area", () => {
    const box = layout({ safeArea: 48 });
    expect(box.top + box.height).toBe(800 - 16 - 48);
  });

  it("splits an expanded surface only when both regions fit two prose lines", () => {
    const split = layout({ expanded: true, controlRows: 1 });
    expect(split.mode).toBe("split");
    expect(split.height).toBe(640);

    // A short viewport, or too many control rows, keeps one region whole.
    const short = layout({ expanded: true, viewport: { ...VIEWPORT, bottom: 400 } });
    expect(short.mode).toBe("lower");

    const crowded = layout({ expanded: true, controlRows: 20 });
    expect(crowded.mode).toBe("lower");
  });

  it("keeps the active upper region whole when the fit fails", () => {
    const upper = layout({ expanded: true, activeArea: "upper", viewport: { ...VIEWPORT, bottom: 420 } });
    expect(upper.mode).toBe("upper");
  });

  it("carries the fixed chrome metrics", () => {
    const wide = layout();
    expect(wide.header).toBe(40);
    expect(wide.footer).toBe(44);
    expect(wide.padding).toBe(16);
    expect(wide.gap).toBe(8);

    const narrow = layout({ viewport: { left: 0, right: 500, top: 0, bottom: 700 } });
    expect(narrow.header).toBe(44);
    expect(narrow.padding).toBe(12);
  });
});
