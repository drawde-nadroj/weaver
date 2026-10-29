/**
 * The frame around one entry: its geometry, and the runs a label is made of.
 *
 * The rules are pi-frame's (`pi-egregore/packages/pi-frame`, `frameRail`), ported
 * from terminal cells to pixels: a frame starts at a limited width, grows with
 * the content it encloses, and stops at the edge it is allowed to occupy. A label
 * sits in a corner of the rail, and a pane too narrow for a frame is drawn
 * without one.
 *
 * pi-frame truncates a label by measuring cells. Here the DOM does it with
 * `text-overflow: ellipsis`, so this module measures nothing, touches no DOM and
 * is pure enough to test without a browser.
 */

import { formatClock } from "./duration";

/** The column a frame may occupy, in the layer's own coordinates. */
export interface FrameColumn {
  left: number;
  right: number;
}

/** The ink a frame encloses: where the text actually ends, not its line boxes. */
export interface FrameExtent {
  left: number;
  right: number;
}

export interface FrameGeometryInput {
  column: FrameColumn;
  /** `null` when nothing on screen could be measured: no frame is drawn. */
  text: FrameExtent | null;
  /** Air between the rail and the text it encloses. */
  gutter: number;
  /** The narrowest a frame may be; it grows from here with the text. */
  minWidth: number;
  /** Below this the pane cannot carry a frame at all. */
  floorWidth: number;
}

export interface FrameGeometry {
  left: number;
  width: number;
  drawn: boolean;
}

/**
 * A frame hugs its text, never reflows it.
 *
 * `left` follows the entry's own indent, so a deeper entry nests inside its
 * parent's column. `width` is the text plus one gutter on each side, held between
 * `minWidth` and the edge of the column — which is what makes a short entry a
 * narrow frame and a long one a frame that reaches the edge.
 */
export function frameGeometry(input: FrameGeometryInput): FrameGeometry {
  const left =
    input.text === null
      ? input.column.left
      : Math.max(input.column.left, input.text.left - input.gutter);

  const available = Math.max(0, input.column.right - left);
  const drawn = input.text !== null && available >= input.floorWidth;
  const wanted = input.text === null ? 0 : input.text.right + input.gutter - left;

  return {
    left,
    width: Math.min(available, Math.max(Math.min(input.minWidth, available), wanted)),
    drawn
  };
}

/** One run of a label: digits stay white, punctuation keeps the entry's colour. */
export interface LabelRun {
  text: string;
  num: boolean;
}

/** Alternating runs, exactly as the marker line itself is split. */
export function labelRuns(text: string): LabelRun[] {
  const runs: LabelRun[] = [];
  for (const part of text.split(/(\d+)/)) {
    if (part === "") continue;
    runs.push({ text: part, num: /^\d+$/.test(part) });
  }
  return runs;
}

/** `{ 1.2.3 } - 13:27:43`, in the marker's canonical shape. */
export function markerLabel(entry: { d: number; c: number; n: number; time: string }): string {
  return `{ ${entry.d}.${entry.c}.${entry.n} } - ${entry.time}`;
}

/** `+ 00:01:30`, the sigil and the clock. */
export function durationLabel(sigil: string, ms: number): string {
  return `${sigil} ${formatClock(ms)}`;
}

export function markerRuns(entry: {
  d: number;
  c: number;
  n: number;
  time: string;
}): LabelRun[] {
  return labelRuns(markerLabel(entry));
}

export function durationRuns(sigil: string, ms: number): LabelRun[] {
  return labelRuns(durationLabel(sigil, ms));
}
