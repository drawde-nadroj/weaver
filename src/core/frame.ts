/**
 * The frame around one entry: a box, and nothing else.
 *
 * The layer that uses this draws a border and the live highlight. It draws no
 * text: the entry's own first row — the address line — is the box's top-left
 * label, and its own clock row is the bottom edge, labelling the bottom-left
 * corner with the duration and the bottom-right with the moment. Every label is
 * read once, from the file, in the place a label would sit. Nothing is hidden
 * and nothing is duplicated.
 *
 * Both rails run through the centre of the row that labels them, and the label's
 * own background cuts the rail behind it, so the box reads as running into its
 * own text rather than enclosing it. The box therefore spans from one label inset
 * outside the address's ink to the right edge of the text column: a box that hugged
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

/** The floating composer's rectangle, in viewport coordinates. */
export interface ComposerBox {
  left: number;
  top: number;
  width: number;
  /** The tallest the surface may be; it scrolls internally past this. */
  maxHeight: number;
  /** False when the surface has to be hidden: preview gone, sheet scrolling. */
  preview: boolean;
}

/** Everything the composer's placement may read. */
export interface ComposerBoxInput {
  /** The visual viewport a phone keyboard shrinks; the window's on a desk. */
  viewport: FrameColumn & { top: number; bottom: number };
  /** The active pane's edges, in viewport coordinates. */
  pane: FrameColumn & { top: number; bottom: number };
  /** The text column inside that pane, when one can be measured. */
  content: FrameColumn | null;
  /** Air kept between the surface and every edge it could touch. */
  inset: number;
  /** The height the surface would like, before any clamping. */
  wantedHeight: number;
  /** The height the surface actually rendered, or 0 before it was measured. */
  renderedHeight: number;
  /** True on a phone, where the sheet may take more of the screen. */
  phone: boolean;
  /** Reserved space at the bottom: a mobile toolbar, a safe area. */
  bottomReserve: number;
}

/** How much of a viewport the composer may take, by platform. */
export function composerHeightShare(phone: boolean): number {
  return phone ? 0.6 : 0.45;
}

/**
 * Where the floating composer sits.
 *
 * It floats above the workspace rather than inside a leaf, so it has no flow to
 * inherit and must be told its box: the writing column of the active pane when
 * one can be measured, up to 720px centred in the pane when none can, and always
 * inside the visual viewport with one inset of air. Width is the *text* column —
 * no widening for the surface and no child indentation — because a thought at
 * depth 1 is written where the note's own text is.
 *
 * Height is the surface's own: it sits on the bottom edge and grows upward by
 * exactly what it rendered, never by a fixed card height it would leave blank.
 * The cap is the same share of the usable viewport as before, and past it the
 * surface scrolls inside its own box, so the input and the actions stay reachable
 * above a phone keyboard. When the usable height is too small to hold a preview
 * and an input, the preview is dropped rather than letting the box overflow.
 *
 * A viewport with less room than the insets leave produces a zero-height box at
 * the floor, never a negative one: geometry that cannot exist is not expressed as
 * an inverted rectangle.
 */
export function floatingComposerBox(input: ComposerBoxInput): ComposerBox {
  const usableTop = input.viewport.top + input.inset;
  const usableBottom = input.viewport.bottom - input.inset - input.bottomReserve;

  const floor = Math.max(usableTop, input.pane.top + input.inset);
  const ceiling = Math.min(usableBottom, input.pane.bottom - input.inset);

  const paneLeft = Math.max(input.pane.left, input.viewport.left);
  const paneRight = Math.min(input.pane.right, input.viewport.right);
  const paneWidth = Math.max(0, paneRight - paneLeft);

  let left: number;
  let width: number;
  if (input.content !== null) {
    left = Math.max(input.content.left, paneLeft);
    const right = Math.min(input.content.right, paneRight);
    width = Math.max(0, right - left);
  } else {
    width = Math.min(paneWidth, 720);
    left = paneLeft + Math.max(0, (paneWidth - width) / 2);
  }

  const available = Math.max(0, ceiling - floor);
  const maxHeight = Math.max(
    0,
    Math.min(input.wantedHeight, available * composerHeightShare(input.phone))
  );

  // Before the first measurement, fill the cap: a surface that dropped to nothing
  // and then grew would flicker on every mount.
  const rendered = input.renderedHeight > 0 ? input.renderedHeight : maxHeight;
  const height = Math.max(0, Math.min(rendered, maxHeight, available));

  // A box with no room for both a preview and an input keeps only the input.
  const preview = maxHeight >= 160 && available >= 160;

  return {
    left: Math.round(left),
    top: Math.round(Math.max(floor, ceiling - height)),
    width: Math.round(width),
    maxHeight: Math.round(maxHeight),
    preview
  };
}

/** The three rails: this entry's two, and where the next entry's top one sits. */
export interface FrameSpanInput {
  /** The top rail: the centre of the entry's address row. */
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
 * which put the top rail 5 px above the address's own row and the bottom rail 5 px
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

/** The rectangle a viewport offers the Loom, in viewport coordinates. */
export interface LoomViewport {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Everything the Loom's placement may read; none of it is the active note's column. */
export interface LoomBoxInput {
  /** The visual viewport a phone keyboard shrinks. */
  viewport: LoomViewport;
  /** Reserved space at the bottom: a mobile toolbar and the safe area. */
  safeArea: number;
  /** True when an upper reference or panel is showing. */
  expanded: boolean;
  /** True for the 44px reduced invitation/draft row. */
  reduced: boolean;
  /** Which half owns focus when the fit test fails. */
  activeArea: "lower" | "upper";
  /** The resolved prose font size, in pixels. */
  fontPx: number;
  /** The maximum contextual control rows either region shows. */
  controlRows: number;
  /** Prose lines each region must fit before a split is chosen. Default 2. */
  proseLines?: number;
}

/** The Loom's rectangle and its internal chrome metrics. */
export interface LoomBox {
  left: number;
  top: number;
  width: number;
  height: number;
  mode: "lower" | "split" | "upper" | "reduced";
  header: number;
  footer: number;
  padding: number;
  gap: number;
}

/** The width the Loom takes across a viewport: 720, or the viewport less its inset. */
export function loomWidth(viewportWidth: number): { width: number; padding: number; inset: number } {
  const narrow = viewportWidth <= 600;
  const padding = narrow ? 12 : 16;
  const inset = narrow ? 8 : 16;
  const width = Math.max(0, narrow ? viewportWidth - 16 : Math.min(720, viewportWidth - 32));
  return { width, padding, inset };
}

/** A bottom-edge anchor and the surface's maximum extent above it. */
export interface LoomAnchor {
  left: number;
  bottom: number;
  width: number;
  maxHeight: number;
}

/**
 * The Loom's bottom anchor in visual-viewport coordinates, not a CSS bottom
 * inset derived from `innerHeight`: a mobile webview can resize the latter
 * without resizing the containing block used by fixed-positioned elements.
 * The renderer translates the surface upward from this edge, so content growth
 * and keyboard panning do not need a second measurement or a retained height.
 * Only a toolbar intersecting the visible rectangle reserves space.
 */
export function loomAnchor(
  viewport: LoomViewport,
  toolbar: LoomViewport | null
): LoomAnchor {
  const { width, inset } = loomWidth(Math.max(0, viewport.right - viewport.left));
  const obstructs = toolbar !== null &&
    toolbar.right > viewport.left && toolbar.left < viewport.right &&
    toolbar.bottom > viewport.top && toolbar.top < viewport.bottom;
  const edge = obstructs ? Math.max(viewport.top, toolbar.top) : viewport.bottom;
  const air = Math.min(inset, Math.max(0, edge - viewport.top) / 2);
  return {
    left: viewport.left + Math.max(0, (viewport.right - viewport.left - width) / 2),
    bottom: edge - air,
    width,
    maxHeight: Math.max(0, edge - viewport.top - 2 * air)
  };
}


/**
 * Where the bottom-anchored Loom sits, independent of the active note's column.
 *
 * The width never measures the writing column: it is 720 centred in the viewport,
 * clamped to the available width less its inset, and 16px narrower still on a
 * narrow screen. The lower-only surface is 320px, an expanded one 640px, and the
 * reduced row 44px, each clamped to the usable height. An expanded surface splits
 * into equal regions only when both fit their controls and two prose lines; below
 * 480px, or when that fit fails, the active region takes the whole body. Nothing
 * here mutates work, selection or focus — it returns a layout only.
 */
export function loomLayout(input: LoomBoxInput): LoomBox {
  const viewportWidth = Math.max(0, input.viewport.right - input.viewport.left);
  const { width, padding, inset } = loomWidth(viewportWidth);
  const narrow = viewportWidth <= 600;
  const header = narrow ? 44 : 40;
  const footer = 44;
  const gap = 8;
  const left = Math.round(input.viewport.left + Math.max(0, (viewportWidth - width) / 2));

  const usable = Math.max(0, input.viewport.bottom - input.viewport.top - inset - input.safeArea);
  const anchoredTop = (height: number): number =>
    Math.round(Math.max(input.viewport.top + inset, input.viewport.bottom - inset - input.safeArea - height));

  if (input.reduced) {
    const height = Math.min(44, usable);
    return { left, top: anchoredTop(height), width, height, mode: "reduced", header, footer, padding, gap };
  }

  if (!input.expanded) {
    const height = Math.min(320, usable);
    return { left, top: anchoredTop(height), width, height, mode: "lower", header, footer, padding, gap };
  }

  const lineHeight = input.fontPx * 1.35;
  const proseLines = input.proseLines ?? 2;
  const minRegion = proseLines * lineHeight + input.controlRows * lineHeight + 2 * padding;
  const body = usable - header - footer - 2 * gap;
  const fits = usable >= 480 && body / 2 >= minRegion;
  const height = Math.min(640, usable);
  const mode: LoomBox["mode"] = fits ? "split" : input.activeArea === "upper" ? "upper" : "lower";
  return { left, top: anchoredTop(height), width, height, mode, header, footer, padding, gap };
}
