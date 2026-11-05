/**
 * The frame around one entry: a box, and nothing else.
 *
 * The layer that uses this draws a border and the live highlight. It draws no
 * text: the entry's own first row — the marker line — is the box's top-left
 * label, and its own clock row is the bottom edge, labelling the bottom-left
 * corner with the duration and the bottom-right with the moment. Every label is
 * read once, from the file, in the place a label would sit. Nothing is hidden
 * and nothing is duplicated.
 *
 * Both rails run through the centre of the row that labels them, and the label's
 * own background cuts the rail behind it, so the box reads as running into its
 * own text rather than enclosing it. The box therefore spans from one label inset
 * outside the marker's ink to the right edge of the text column: a box that hugged
 * its text could not put the duration at one bottom corner and the moment at the
 * other without a second rendering of the row.
 *
 * Pure — no DOM, no measurement — so the geometry is testable without a browser.
 */

/** The column a frame may occupy, in the layer's own coordinates. */
export interface FrameColumn {
  left: number;
  right: number;
}

/** What a box needs: the column, the text's left edge, and the label inset. */
export interface FrameBoxInput {
  /** pane-left … column-right, in scroller coordinates. */
  column: FrameColumn;
  /** The first line's left ink; `null` only before anything has been measured. */
  textLeft: number | null;
  gutter: number;
}

/** The rectangle to draw, or `drawn: false` when there is nothing to enclose. */
export interface FrameBox {
  left: number;
  width: number;
  drawn: boolean;
}

/**
 * The box spans one label inset outside the entry's first row's ink to the
 * column's right edge.
 *
 * There is no width below which a box is withheld: a narrow pane gets a narrow
 * box. The only way to get no box is to have measured nothing yet.
 */
export function frameBox(input: FrameBoxInput): FrameBox {
  const left = Math.max(input.column.left, (input.textLeft ?? input.column.left) - input.gutter);
  const width = Math.max(0, input.column.right - left);
  return { left, width, drawn: input.textLeft !== null };
}

/** The three rails: this entry's two, and where the next entry's top one sits. */
export interface FrameSpanInput {
  /** The top rail: the centre of the entry's marker row. */
  firstRail: number;
  /** The bottom rail: the centre of its clock row, or below its last prose row. */
  lastRail: number;
  /** The next entry's top rail; `null` for the last entry in the note. */
  nextRail: number | null;
  /** Clear space required between two rails. */
  air: number;
}

/** The vertical extent to draw, or `drawn: false` when the rails leave no interior. */
export interface FrameSpan {
  top: number;
  bottom: number;
  drawn: boolean;
}

/**
 * The box's vertical extent: from one rail to the other, and nothing more.
 *
 * The rails are the label lines, so there is no padding to add and no cap to
 * apply. The old version derived both ends from the text's edges and padded them,
 * which put the top rail 5 px above the marker's own row and the bottom rail 5 px
 * below the clock's — so the labels sat inside the box instead of on it, and the
 * clock row was clipped by the rail under it.
 *
 * The only judgement left is whether two rails are far enough apart: a box is
 * withheld when the next entry's rail is closer than {@link FrameSpanInput.air},
 * because two labels would then share the space and neither would read. There is
 * no trimming — a rail is a label's centre or it is nothing — and no padding cap.
 * When the rails cross, there is no interior and no box.
 */
export function frameSpan(input: FrameSpanInput): FrameSpan {
  const top = input.firstRail;
  const bottom = input.lastRail;
  const clear = input.nextRail === null || input.nextRail - bottom >= input.air;
  return { top, bottom, drawn: bottom > top && clear };
}
