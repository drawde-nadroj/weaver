/**
 * The frame around every entry, drawn.
 *
 * CodeMirror gives each line its own element and offers no way to wrap a range of
 * lines in a container, so the box is drawn *over* the note: one absolutely
 * positioned layer inside the scroller, one box per entry, in document
 * coordinates. The layer draws the border and the live highlight, and no text.
 *
 * Three consequences, all deliberate:
 *
 * - **Nothing reflows.** The box catches up to the text; the text never moves to
 *   fit the box. Every pixel-stability invariant the decorations already keep —
 *   the clock row's top across a run of insertions — survives.
 * - **Scrolling is free.** The layer lives inside `.cm-scroller`, which is
 *   already `position: relative`, so its children scroll with the content and a
 *   scroll needs no re-measure. Only a reflow does.
 * - **Editing is untouched.** The layer is `pointer-events: none`.
 *
 * The file's own rows are the box's rails, and each rail runs through the centre
 * of the row that labels it: the marker row is the top-left label, the clock row
 * the bottom edge — its moment at the left corner, its duration at the right —
 * and each label's own background cuts the rail behind it, so the box reads as
 * running into the text that names it. Nothing is at `opacity: 0`, nothing is
 * painted twice, and the frame survives its ends scrolling out of the render
 * range because a row that is not rendered falls back to the line block's centre.
 *
 * The date labels the top-right corner on every entry, and it is drawn by the
 * entry decoration in the marker row — never by this layer, which paints no text
 * at all.
 */

import { editorInfoField, editorLivePreviewField } from "obsidian";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

import { dimensionColor } from "../core/color";
import { frameBox, frameSpan, type FrameColumn } from "../core/frame";
import type { EntrySession } from "../entries/session";
import type { WeaverSettings } from "../settings";
import { entryIndexField } from "./entry-field";
import { FRAME_EFFECTS, frameEffect } from "./frame-effects";

/** Air between the marker's ink and the left rail, and the stub the frame leaves beside each corner. */
const LEFT_GUTTER = 16;
/** Air between the text column's right edge and the right rail, and the stub that labels the corner. */
const RIGHT_GUTTER = 10;
/** Clear space required between two entries' rails. */
const MIN_AIR = 8;
/** Air below the last prose row when an entry has no clock row. */
const NO_CLOCK_PAD = 8;
/** Air above a marker row when that row also carries prose (the legacy title case). */
const INLINE_TITLE_PAD = 12;

/** What the layer may ask the plugin: settings, the session, the model, and a fallback path. */
export interface FrameHost {
  settings(): WeaverSettings;
  session(): EntrySession;
  /** True while a whisper request for this entry has been pending long enough to show. */
  reading(path: string, n: number): boolean;
  /** Used only when `editorInfoField` cannot name the file. */
  fallbackPath(): string;
}

interface FrameNode {
  root: HTMLElement;
}

/**
 * The rectangle a line actually paints, in client coordinates — the text, not its
 * full-width line box.
 *
 * Both axes matter. The left is the entry's indent, which the box follows. The top
 * and bottom are the text's own edges: a line box is taller than the glyphs in it,
 * and on a scrolled note its height is an estimate besides, so a box built on line
 * boxes drifts away from the words it is supposed to enclose.
 *
 * An empty line paints nothing and measures as an empty rect list; its own box is
 * the fallback, because a line with no ink still has a place.
 */
function inkRect(element: HTMLElement): { left: number; top: number; right: number; bottom: number } {
  const range = document.createRange();
  range.selectNodeContents(element);

  let ink: { left: number; top: number; right: number; bottom: number } | null = null;
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width <= 0 && rect.height <= 0) continue;
    ink =
      ink === null
        ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
        : {
            left: Math.min(ink.left, rect.left),
            top: Math.min(ink.top, rect.top),
            right: Math.max(ink.right, rect.right),
            bottom: Math.max(ink.bottom, rect.bottom)
          };
  }

  if (ink !== null) return ink;

  const box = element.getBoundingClientRect();
  return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
}

interface RenderedRows {
  head?: HTMLElement;
  duration?: HTMLElement;
}

/**
 * Every rendered row, by the entry it belongs to: what may be measured.
 *
 * The rows are found by their own `data-weaver-n` stamp, not by a DOM position.
 * A row can be rendered two ways — a `.cm-line`, or the duration's block widget,
 * which is not always a line of its own — and asking CodeMirror for the position
 * of the widget's element named the wrong line, so the clock was measured as
 * something else and the box fell back to the height map at exactly the end that
 * has a label. The stamp is written by the decoration that makes the row, so it
 * cannot drift from it.
 */
function renderedRows(view: EditorView): Map<number, RenderedRows> {
  const rows = new Map<number, RenderedRows>();

  for (const element of Array.from(
    view.contentDOM.querySelectorAll<HTMLElement>("[data-weaver-n]")
  )) {
    const n = Number(element.getAttribute("data-weaver-n"));
    if (!Number.isInteger(n)) continue;
    const row = rows.get(n) ?? {};
    if (element.classList.contains("weaver-entry-head")) row.head = element;
    else if (
      element.classList.contains("weaver-duration") ||
      element.classList.contains("weaver-duration-raw")
    ) {
      row.duration = element;
    }
    rows.set(n, row);
  }

  return rows;
}

class EntryFrames {
  private readonly layer: HTMLElement;
  private readonly frames = new Map<number, FrameNode>();
  /** Each entry's measured indent, kept through the frames it outlives. */
  private readonly lefts = new Map<number, number>();
  private readonly observer: ResizeObserver;
  private pending = 0;
  private destroyed = false;

  constructor(
    private readonly view: EditorView,
    private readonly host: FrameHost
  ) {
    this.layer = document.createElement("div");
    this.layer.className = "weaver-frame-layer";
    this.layer.setAttribute("aria-hidden", "true");
    view.scrollDOM.appendChild(this.layer);

    this.observer = new ResizeObserver(() => this.schedule());
    this.observer.observe(view.scrollDOM);
    this.observer.observe(view.contentDOM);
    // The first measure can run before the note has been laid out, when nothing
    // has a size yet. One more frame later there is something to measure.
    this.schedule();
    window.requestAnimationFrame(() => this.schedule());
  }

  update(update: ViewUpdate): void {
    // A selection is geometry here: the caret on the clock row turns the widget
    // back into text, which changes that row's height.
    if (
      update.docChanged ||
      update.viewportChanged ||
      update.geometryChanged ||
      update.selectionSet ||
      update.transactions.length > 0
    ) {
      this.schedule();
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.observer.disconnect();
    if (this.pending !== 0) window.cancelAnimationFrame(this.pending);
    this.pending = 0;
    this.clear();
    this.lefts.clear();
    this.layer.remove();
  }

  /** One measure per animation frame, however many updates ask for it. */
  private schedule(): void {
    if (this.destroyed || this.pending !== 0) return;
    this.pending = window.requestAnimationFrame(() => {
      this.pending = 0;
      if (!this.destroyed) this.measure();
    });
  }

  private clear(): void {
    for (const node of this.frames.values()) node.root.remove();
    this.frames.clear();
  }

  private path(): string {
    const info = this.view.state.field(editorInfoField, false);
    return info?.file?.path ?? this.host.fallbackPath();
  }

  private measure(): void {
    const settings = this.host.settings();
    // Source mode keeps the file's own text, and the layer is not what that mode
    // is for: no box is drawn there.
    if (!settings.entryFrames || this.view.state.field(editorLivePreviewField, false) !== true) {
      this.clear();
      return;
    }

    const index = this.view.state.field(entryIndexField, false);
    if (index === undefined || index.entries.length === 0) {
      this.clear();
      return;
    }

    const rendered = renderedRows(this.view);
    const scroller = this.view.scrollDOM;
    const base = scroller.getBoundingClientRect();
    // `lineBlockAt` speaks document coordinates; `documentTop` is the screen-y of
    // the document's own top, so the two together are a scroll-independent
    // position. A box outlives the lines that scrolled away because a row that is
    // not rendered is placed by its line block.
    const docTop = this.view.documentTop;
    const toX = (clientX: number): number => clientX + scroller.scrollLeft - base.left;
    const toY = (screenY: number): number => screenY - base.top + scroller.scrollTop;

    const content = this.view.contentDOM.getBoundingClientRect();
    const column: FrameColumn = {
      left: toX(base.left),
      right: Math.min(toX(content.right) + RIGHT_GUTTER, toX(base.right))
    };

    const path = this.path();
    const session = this.host.session();
    const seen = new Set<number>();

    // Where each entry's rails run, in the layer's coordinates: through the
    // centre of the row that labels them. A rendered row is measured where it
    // paints; a row that has scrolled away falls back to its line block's centre,
    // which is still the label's centre.
    const spans = index.entries.map((entry) => {
      // A marker row that also carries prose is the legacy title case: the rail
      // goes above the row, or it would cut the entry's own first line.
      const inlineTitle =
        entry.firstProseLine !== null && entry.firstProseLine === entry.line;

      const headElement = rendered.get(entry.n)?.head;
      const headInk = headElement === undefined ? null : inkRect(headElement);
      // Into the layer's own coordinates, and remembered there: the text's offset
      // inside the content does not move when the view scrolls. One label inset
      // outside the ink is where the left rail runs.
      if (headInk !== null) this.lefts.set(entry.n, toX(headInk.left));

      let firstRail: number;
      if (headInk !== null) {
        firstRail = inlineTitle
          ? toY(headInk.top) - INLINE_TITLE_PAD
          : toY((headInk.top + headInk.bottom) / 2);
      } else {
        const block = this.view.lineBlockAt(entry.from);
        firstRail = inlineTitle
          ? toY(block.top + docTop) - INLINE_TITLE_PAD
          : toY(block.top + docTop + block.height / 2);
      }

      const lastLine =
        entry.clockLine ?? entry.proseLines[entry.proseLines.length - 1] ?? entry.line;
      const lastRow = this.view.state.doc.line(lastLine + 1);

      // The bottom rail is the clock row's centre, so its glyphs straddle it —
      // the moment at one corner and the duration at the other. An entry with no
      // clock row has no bottom label: its box closes below its last prose row
      // instead, on air rather than on a rail.
      let lastRail: number;
      if (entry.clockLine !== null) {
        const clockElement = rendered.get(entry.n)?.duration;
        const clockInk = clockElement === undefined ? null : inkRect(clockElement);
        if (clockInk !== null) {
          lastRail = toY((clockInk.top + clockInk.bottom) / 2);
        } else {
          const block = this.view.lineBlockAt(entry.clockFrom);
          lastRail = toY(block.top + docTop + block.height / 2);
        }
      } else {
        lastRail = toY(this.view.lineBlockAt(lastRow.from).bottom + docTop) + NO_CLOCK_PAD;
      }

      return { entry, firstRail, lastRail };
    });

    for (const [position, row] of spans.entries()) {
      const { entry, firstRail, lastRail } = row;

      const box = frameBox({
        column,
        textLeft: this.lefts.get(entry.n) ?? null,
        gutter: LEFT_GUTTER
      });

      const span = frameSpan({
        firstRail,
        lastRail,
        nextRail: spans[position + 1]?.firstRail ?? null,
        air: MIN_AIR
      });

      // A frame needs an interior: a strip of no height is no box at all.
      if (!box.drawn || !span.drawn) continue;

      let node = this.frames.get(entry.n);
      if (node === undefined) {
        const root = document.createElement("div");
        root.className = "weaver-frame";
        this.layer.appendChild(root);
        node = { root };
        this.frames.set(entry.n, node);
      }

      node.root.style.left = `${box.left}px`;
      node.root.style.top = `${span.top}px`;
      node.root.style.width = `${box.width}px`;
      node.root.style.height = `${span.bottom - span.top}px`;
      node.root.style.setProperty("--weaver-dcolor", dimensionColor(entry.d));

      // One effect at a time, chosen by the registry rather than here: the box
      // answers "what is happening now?", and a new effect costs this layer
      // nothing.
      const chosen = frameEffect({
        live: session.activeFor(path, entry.n),
        reading: this.host.reading(path, entry.n)
      });
      for (const effect of FRAME_EFFECTS) {
        node.root.classList.toggle(effect.className, effect === chosen);
      }

      seen.add(entry.n);
    }

    for (const [n, node] of this.frames) {
      if (seen.has(n)) continue;
      node.root.remove();
      this.frames.delete(n);
    }
  }
}

/** Draws one box per entry in a layer inside the scroller. */
export function entryFrameExtension(host: FrameHost): Extension {
  return ViewPlugin.fromClass(
    class extends EntryFrames {
      constructor(view: EditorView) {
        super(view, host);
      }
    }
  );
}
