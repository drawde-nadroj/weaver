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

/**
 * Clearance from label ink to either side rail, matching Reading view's
 * `calc(0.45em + 16px)`: the label halo must leave the rounded corner visible.
 */
export function frameLabelInset(fontSize: number): number {
  return 16 + 0.45 * fontSize;
}

/** The column a frame may occupy, in the layer's own coordinates. */
export interface FrameColumn {
  left: number;
  right: number;
}

/** The pane and the content it holds, in one coordinate space. */
export interface FrameColumnInput {
  /** The pane's own edges. */
  pane: FrameColumn;
  /** The content's own edges: the text column the labels hang off. */
  content: FrameColumn;
  /** One label inset of air outside the text, both sides. */
  gutter: number;
}

/**
 * The column every frame in a view may occupy: from the pane's left edge to one
 * label inset past the content's right, and never past the pane's own right.
 *
 * One column serves the drawn boxes and the pending portal tray alike. The
 * right edge is the content's edge plus one gutter of air, clamped to the pane;
 * the left edge is the pane's own, because the box below it sits the same gutter
 * outside the text. A narrow pane is clamped here rather than in each caller, so
 * a portal can never be narrower than the entries above it.
 */
export function frameColumn(input: FrameColumnInput): FrameColumn {
  return {
    left: input.pane.left,
    right: Math.min(input.content.right + input.gutter, input.pane.right)
  };
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

/**
 * A pending tray's placement inside the note's content.
 *
 * The tray is a child of the content in the normal flow, so the frame's box
 * becomes one negative left margin and one explicit width. Nothing else about
 * the pending portal is an entry: this is the only geometry it shares.
 */
export interface TrayFrame {
  /** The box's left edge, relative to the content's own text edge. */
  marginLeft: number;
  width: number;
}

/**
 * Where the pending tray sits, or `null` before anything has been measured.
 *
 * A pending portal is a root, so its text edge is the note's own — never a
 * child's indent, and never the width of the first entry it happens to follow.
 */
export function trayFrame(input: {
  column: FrameColumn;
  /** The note's own left text edge, in whatever space the column is measured. */
  textLeft: number;
  gutter: number;
}): TrayFrame | null {
  const box = frameBox({
    column: input.column,
    textLeft: input.textLeft,
    gutter: input.gutter
  });
  if (!box.drawn || box.width <= 0) return null;
  return { marginLeft: box.left - input.textLeft, width: box.width };
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
