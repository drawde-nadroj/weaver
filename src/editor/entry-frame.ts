/**
 * The frame around every entry, drawn.
 *
 * CodeMirror gives each line its own element and offers no way to wrap a range of
 * lines in a container, so a box that hugs its text cannot be made of borders on
 * the lines. It is drawn *over* the note instead: one absolutely positioned layer
 * inside the scroller, one box per entry, positioned in document coordinates.
 *
 * Three consequences, all deliberate:
 *
 * - **Nothing reflows.** The box catches up to the text; the text never moves to
 *   fit the box. Every pixel-stability invariant the decorations already keep —
 *   the duration line's top across a run of insertions — survives.
 * - **Scrolling is free.** The layer lives inside `.cm-scroller`, which is
 *   already `position: relative`, so its children scroll with the content and a
 *   scroll needs no re-measure. Only a reflow does.
 * - **Editing is untouched.** The layer is `pointer-events: none`; only a past
 *   day's link re-enables the pointer.
 *
 * The marker and the duration keep their lines. While the caret is elsewhere the
 * marker's runs are at `opacity: 0` — still laid out, still announced, still the
 * record — and the frame draws them on the rails. Touch the row and the label
 * steps aside for the raw text, which is the rule the duration line has always
 * followed.
 */

import { editorInfoField, editorLivePreviewField } from "obsidian";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

import { dimensionColor } from "../core/color";
import { dayKey, dayKeyFromName } from "../core/day-note";
import type { DurationSigil } from "../core/duration";
import type { Entry } from "../core/entries";
import {
  durationRuns,
  frameGeometry,
  markerRuns,
  type FrameExtent,
  type FrameGeometry,
  type LabelRun
} from "../core/frame";
import type { EntrySession } from "../entries/session";
import type { WeaverSettings } from "../settings";
import { startTicking, stopTicking, writeDigits } from "./duration-ticker";
import { entryIndexField } from "./entry-field";

/** Air between the rail and the text it encloses. */
const GUTTER = 14;
/** A pane narrower than this carries no frame at all. */
const FLOOR_WIDTH = 120;
/** The limited width a frame starts at, as a share of the pane… */
const MIN_SHARE = 0.3;
/** …held between these. The floor is wide enough for a marker's own label, so
 * the clock is never cut off by a short entry. */
const MIN_FLOOR = 168;
const MIN_CEILING = 280;
/** The chip behind a raw rail row runs this much past its text. */
const CHIP_PAD = 5;

export interface FrameHost {
  settings(): WeaverSettings;
  session(): EntrySession;
  /** Used only when `editorInfoField` cannot name the file. */
  fallbackPath(): string;
  openDayLink(target: string, sourcePath: string): void;
}

interface Ink {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface FrameNode {
  root: HTMLElement;
  signature: string;
  digits: HTMLElement[];
  topChip: HTMLElement;
  bottomChip: HTMLElement;
  /** The transparent click target over the day link, when the label has one. */
  dayHit: HTMLElement | null;
}

/**
 * The ink a line actually paints, not its full-width line box.
 *
 * An empty line paints no text at all, and a line whose only content is a
 * widget can measure as nothing; both fall back to the line's own box, so every
 * rendered line has an extent and a frame is never lost to a missing
 * measurement.
 */
function inkOf(element: HTMLElement): Ink {
  const range = document.createRange();
  range.selectNodeContents(element);

  let ink: Ink | null = null;
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width <= 0 && rect.height <= 0) continue;
    ink =
      ink === null
        ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
        : {
            left: Math.min(ink.left, rect.left),
            right: Math.max(ink.right, rect.right),
            top: Math.min(ink.top, rect.top),
            bottom: Math.max(ink.bottom, rect.bottom)
          };
  }

  if (ink !== null) return ink;

  const box = element.getBoundingClientRect();
  return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
}

/** Every rendered line, by document line number: what may be measured. */
function renderedLines(view: EditorView): Map<number, HTMLElement> {
  const lines = new Map<number, HTMLElement>();
  for (const element of Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-line"))) {
    const position = view.posAtDOM(element, 0);
    lines.set(view.state.doc.lineAt(position).number, element);
  }
  return lines;
}

function labelSpan(run: LabelRun, numClass: string, inkClass: string): HTMLElement {
  const span = document.createElement("span");
  span.className = run.num ? numClass : inkClass;
  span.textContent = run.text;
  return span;
}

class EntryFrames {
  private readonly layer: HTMLElement;
  private readonly hitLayer: HTMLElement;
  private readonly frames = new Map<number, FrameNode>();
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

    this.hitLayer = document.createElement("div");
    this.hitLayer.className = "weaver-frame-hit-layer";
    this.hitLayer.setAttribute("aria-hidden", "true");
    view.scrollDOM.appendChild(this.hitLayer);

    this.observer = new ResizeObserver(() => this.schedule());
    this.observer.observe(view.scrollDOM);
    this.schedule();
  }

  update(update: ViewUpdate): void {
    if (
      update.docChanged ||
      update.viewportChanged ||
      update.geometryChanged ||
      update.selectionSet ||
      update.focusChanged ||
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
    this.layer.remove();
    this.hitLayer.remove();
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
    for (const node of this.frames.values()) this.drop(node);
    this.frames.clear();
    this.view.scrollDOM.classList.remove("weaver-frames-live");
  }

  private drop(node: FrameNode): void {
    stopTicking(node.root);
    node.root.remove();
    node.dayHit?.remove();
  }

  private path(): string {
    const info = this.view.state.field(editorInfoField, false);
    return info?.file?.path ?? this.host.fallbackPath();
  }

  private measure(): void {
    const settings = this.host.settings();
    // Source mode keeps the file's own text: a frame that hides the marker is
    // the opposite of what that mode is for.
    if (
      !settings.entryFrames ||
      this.view.state.field(editorLivePreviewField, false) !== true
    ) {
      this.clear();
      return;
    }

    const index = this.view.state.field(entryIndexField, false);
    if (index === undefined || index.entries.length === 0) {
      this.clear();
      return;
    }

    const rendered = renderedLines(this.view);
    if (rendered.size === 0) {
      this.clear();
      return;
    }

    const scroller = this.view.scrollDOM;
    const base = scroller.getBoundingClientRect();
    const ox = scroller.scrollLeft - base.left;
    const oy = scroller.scrollTop - base.top;
    const toX = (clientX: number): number => clientX + ox;
    const toY = (clientY: number): number => clientY + oy;

    const content = this.view.contentDOM.getBoundingClientRect();
    // The frame may breathe one gutter past the text column on the left, into
    // the note's own margin, but never past the visible edge of the pane. The
    // right edge stays the column's: a frame that hugged text past the readable
    // width would look like a mistake.
    const column = { left: toX(base.left), right: toX(content.right) };
    const width = Math.max(0, column.right - column.left);
    const minWidth = Math.min(
      Math.max(width * MIN_SHARE, MIN_FLOOR),
      Math.min(MIN_CEILING, width)
    );

    const now = Date.now();
    const path = this.path();
    const session = this.host.session();
    const selection = this.view.state.selection.main;
    const basename = (path.split("/").pop() ?? path).replace(/\.md$/, "");
    const fileDay = dayKeyFromName(basename);
    const today = dayKey(new Date(now));
    const showLink = settings.entryDayLink && fileDay !== null && fileDay !== today;

    const seen = new Set<number>();

    for (const entry of index.entries) {
      const headNumber = entry.line + 1;
      const lastNumber =
        (entry.durationLine ?? entry.proseLines[entry.proseLines.length - 1] ?? entry.line) + 1;

      const headElement = rendered.get(headNumber);
      const lastElement = rendered.get(lastNumber);
      if (headElement === undefined || lastElement === undefined) continue;

      const headInk = inkOf(headElement);
      const lastInk = inkOf(lastElement);

      let ink: Ink = { ...headInk };
      for (const line of entry.proseLines) {
        const element = rendered.get(line + 1);
        const box = element === undefined ? null : inkOf(element);
        if (box === null) continue;
        ink = {
          left: Math.min(ink.left, box.left),
          right: Math.max(ink.right, box.right),
          top: Math.min(ink.top, box.top),
          bottom: Math.max(ink.bottom, box.bottom)
        };
      }

      const text: FrameExtent = { left: toX(ink.left), right: toX(ink.right) };
      const geometry = frameGeometry({
        column,
        text,
        gutter: GUTTER,
        minWidth,
        floorWidth: FLOOR_WIDTH
      });
      if (!geometry.drawn) continue;

      // The rail runs through the middle of the row it names, so the label that
      // breaks it is centred on the border rather than sitting above it.
      const top = toY((headInk.top + headInk.bottom) / 2);
      // With a duration line the bottom rail runs through that row's middle,
      // mirroring the head. Without one it sits on the last row's floor, which
      // is the same distance below the last text's middle — the frame is
      // symmetric whether or not the entry was closed.
      const bottom =
        entry.durationLine === null
          ? toY(lastElement.getBoundingClientRect().bottom)
          : toY((lastInk.top + lastInk.bottom) / 2);
      // A marker with neither prose nor a duration is a single collapsed row:
      // there is no interior to enclose.
      if (bottom - top < 2) continue;

      const headLine = this.view.state.doc.line(headNumber);
      const durationLine =
        entry.durationLine === null ? null : this.view.state.doc.line(entry.durationLine + 1);
      const headRaw = selection.from <= headLine.to && selection.to >= headLine.from;
      const durationRaw =
        durationLine !== null &&
        selection.from <= durationLine.to &&
        selection.to >= durationLine.from;

      const active = session.activeFor(path, entry.n);
      const sigil = (active
        ? "-"
        : ((durationLine?.text[0] ?? "-") as DurationSigil)) as DurationSigil;
      const ms = active ? session.elapsed(now) : entry.durationMs;

      const link = showLink ? basename : null;
      const signature = [
        entry.d,
        entry.c,
        entry.n,
        entry.time,
        sigil,
        active ? "live" : "still",
        headRaw ? "raw" : "calm",
        durationRaw ? "raw" : "calm",
        link ?? "",
        entry.durationLine === null ? "no-duration" : "duration"
      ].join("|");

      let node = this.frames.get(entry.n);
      if (node === undefined || node.signature !== signature) {
        if (node !== undefined) this.drop(node);
        node = this.build({
          entry,
          sigil,
          ms,
          headRaw,
          durationRaw,
          link,
          hasDuration: entry.durationLine !== null,
          signature
        });
        this.frames.set(entry.n, node);
      }

      seen.add(entry.n);

      node.root.style.left = `${geometry.left}px`;
      node.root.style.top = `${top}px`;
      node.root.style.width = `${geometry.width}px`;
      node.root.style.height = `${Math.max(0, bottom - top)}px`;
      node.root.classList.toggle("is-live", active);
      node.root.style.setProperty("--weaver-dcolor", dimensionColor(entry.d));

      this.placeChip(node.topChip, headInk, geometry, top, ox, oy, headRaw);
      this.placeChip(node.bottomChip, lastInk, geometry, top, ox, oy, durationRaw);
      this.placeDayHit(node, ox, oy);

      if (node.digits.length > 0) {
        if (active) startTicking(node.root, node.digits, ms);
        else {
          stopTicking(node.root);
          writeDigits(node.digits, ms);
        }
      }
    }

    for (const [n, node] of this.frames) {
      if (seen.has(n)) continue;
      this.drop(node);
      this.frames.delete(n);
    }

    // The head and duration rows hide themselves only while there is a frame
    // drawn over them. A pane too narrow to carry one, or a surface the layer
    // does not draw on, keeps the file's own text visible.
    this.view.scrollDOM.classList.toggle("weaver-frames-live", seen.size > 0);
  }

  /** The page-coloured band that cuts the rail where the raw text sits. */
  private placeChip(
    chip: HTMLElement,
    ink: Ink,
    geometry: FrameGeometry,
    top: number,
    ox: number,
    oy: number,
    shown: boolean
  ): void {
    if (!shown) {
      chip.style.display = "none";
      return;
    }

    chip.style.display = "block";
    chip.style.left = `${ink.left + ox - geometry.left - CHIP_PAD}px`;
    chip.style.top = `${ink.top + oy - top}px`;
    chip.style.width = `${ink.right - ink.left + CHIP_PAD * 2}px`;
    chip.style.height = `${ink.bottom - ink.top}px`;
  }

  private build(input: {
    entry: Entry;
    sigil: DurationSigil;
    ms: number;
    headRaw: boolean;
    durationRaw: boolean;
    link: string | null;
    hasDuration: boolean;
    signature: string;
  }): FrameNode {
    const root = document.createElement("div");
    root.className = "weaver-frame";
    this.layer.appendChild(root);
    let hit: HTMLElement | null = null;

    const topChip = document.createElement("span");
    topChip.className = "weaver-frame-chip";
    topChip.style.display = "none";
    root.appendChild(topChip);

    const bottomChip = document.createElement("span");
    bottomChip.className = "weaver-frame-chip";
    bottomChip.style.display = "none";
    root.appendChild(bottomChip);

    if (!input.headRaw) {
      const label = document.createElement("span");
      label.className = "weaver-frame-label weaver-frame-label-top";
      for (const run of markerRuns(input.entry)) {
        label.appendChild(labelSpan(run, "weaver-dcn-num", "weaver-dcn-ink"));
      }

      if (input.link !== null) {
        const day = document.createElement("span");
        day.className = "weaver-entry-daylink";
        day.textContent = ` - [[${input.link}]]`;
        label.appendChild(day);
        hit = this.dayHit(input.link);
      }
      root.appendChild(label);
    }

    const digits: HTMLElement[] = [];
    if (input.hasDuration && !input.durationRaw) {
      const label = document.createElement("span");
      label.className = "weaver-frame-label weaver-frame-label-bottom";

      durationRuns(input.sigil, input.ms).forEach((run, index) => {
        // The first run is the sigil and its space: the one part that carries
        // the dimension's colour rather than the digits' white.
        if (index === 0) {
          const sigil = document.createElement("span");
          sigil.className = "weaver-duration-sigil";
          sigil.textContent = run.text;
          label.appendChild(sigil);
          return;
        }

        const span = labelSpan(run, "weaver-duration-num", "weaver-duration-ink");
        label.appendChild(span);
        if (run.num) digits.push(span);
      });
      root.appendChild(label);
    }

    return {
      root,
      signature: input.signature,
      digits,
      topChip,
      bottomChip,
      dayHit: hit
    };
  }

  /**
   * The day link's click target.
   *
   * The label is painted under the note's text — that is what lets a rail sit
   * behind the file's own words — so a click over it lands on the line instead.
   * This is a transparent box in a layer *above* the text, over the day link
   * only: the link opens the day it names, and the rest of the rail stays inert.
   */
  private dayHit(target: string): HTMLElement {
    const hit = document.createElement("span");
    hit.className = "weaver-frame-dayhit";
    hit.addEventListener("click", (event: Event) => {
      event.preventDefault();
      this.host.openDayLink(target, this.path());
    });
    this.hitLayer.appendChild(hit);
    return hit;
  }

  private placeDayHit(node: FrameNode, ox: number, oy: number): void {
    const hit = node.dayHit;
    const link = node.root.querySelector<HTMLElement>(".weaver-entry-daylink");

    if (hit === null || link === null) {
      if (hit !== null) hit.style.display = "none";
      return;
    }

    const rect = link.getBoundingClientRect();
    hit.style.display = "block";
    hit.style.left = `${rect.left + ox}px`;
    hit.style.top = `${rect.top + oy}px`;
    hit.style.width = `${rect.width}px`;
    hit.style.height = `${rect.height}px`;
  }
}

export function entryFrameExtension(host: FrameHost): Extension {
  return ViewPlugin.fromClass(
    class extends EntryFrames {
      constructor(view: EditorView) {
        super(view, host);
      }
    }
  );
}
