/**
 * The travelled entry, outlined where it sits.
 *
 * The rectangle is an absolute overlay: no padding, no border on lines, no
 * margins, so turning it on moves nothing. Coordinates come from `coordsAtPos`
 * over the entry's prose lines, and are re-measured on scroll because the
 * overlay lives outside the scroller.
 */

import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

import { dimensionColor } from "../core/color";
import { entryBySeq } from "../core/entries";
import { entryIndexField } from "./entry-field";

export const setTravelTarget = StateEffect.define<{ seq: number }>();
export const clearTravelTarget = StateEffect.define<null>();

export const travelTargetField = StateField.define<{ seq: number } | null>({
  create: () => null,
  update: (value, transaction) => {
    let next = value;
    for (const effect of transaction.effects) {
      if (effect.is(setTravelTarget)) next = effect.value;
      else if (effect.is(clearTravelTarget)) next = null;
    }
    return next;
  }
});

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

class TravelRect {
  private readonly element: HTMLElement;
  private readonly onScroll: () => void;

  constructor(private readonly view: EditorView) {
    this.element = document.createElement("div");
    this.element.className = "weaver-travel-rect";
    this.element.style.position = "absolute";
    this.element.style.pointerEvents = "none";
    this.element.style.display = "none";
    view.dom.appendChild(this.element);

    this.onScroll = () => this.measure();
    view.scrollDOM.addEventListener("scroll", this.onScroll);
    this.measure();
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.transactions.length > 0) {
      this.measure();
    }
  }

  destroy(): void {
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.element.remove();
  }

  private measure(): void {
    const target = this.view.state.field(travelTargetField, false) ?? null;
    const index = this.view.state.field(entryIndexField, false);
    if (target === null || index === undefined) {
      this.element.style.display = "none";
      return;
    }

    const entry = entryBySeq(index, target.seq);
    if (entry === null) {
      this.element.style.display = "none";
      return;
    }

    const lines = entry.proseLines.length > 0 ? entry.proseLines : [entry.line];
    const box = this.boxFor(lines);
    if (box === null) {
      this.element.style.display = "none";
      return;
    }

    const origin = this.view.dom.getBoundingClientRect();
    this.element.style.left = `${box.left - origin.left}px`;
    this.element.style.top = `${box.top - origin.top}px`;
    this.element.style.width = `${Math.max(0, box.right - box.left)}px`;
    this.element.style.height = `${Math.max(0, box.bottom - box.top)}px`;
    this.element.style.setProperty("--weaver-dcolor", dimensionColor(entry.d));
    this.element.style.display = "block";
  }

  private boxFor(lines: readonly number[]): Box | null {
    let box: Box | null = null;

    for (const line of lines) {
      if (line + 1 > this.view.state.doc.lines) continue;

      const docLine = this.view.state.doc.line(line + 1);
      const start = this.view.coordsAtPos(docLine.from);
      const end = this.view.coordsAtPos(docLine.to);
      if (start === null || end === null) continue;

      const left = Math.min(start.left, end.left);
      const right = Math.max(start.right, end.right);
      box =
        box === null
          ? { left, right, top: start.top, bottom: start.bottom }
          : {
              left: Math.min(box.left, left),
              right: Math.max(box.right, right),
              top: Math.min(box.top, start.top),
              bottom: Math.max(box.bottom, start.bottom)
            };
    }

    return box;
  }
}

/**
 * The rectangle for one target. Hidden whenever the target's `N` is not in this
 * document, so a stale target can never outline an unrelated entry.
 */
export function travelTargetExtension(_getPath: () => string): Extension {
  return [travelTargetField, ViewPlugin.fromClass(TravelRect)];
}
