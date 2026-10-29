/**
 * The entry, drawn.
 *
 * Colour and indent ride on two custom properties set per line
 * (`--weaver-dcolor`, `--weaver-d`), so nothing is generated per level: depth 7
 * costs exactly what depth 1 costs. The marker keeps its text — only its runs are
 * marked up, so the line stays editable and the digits stay white while the
 * punctuation carries the dimension's colour.
 *
 * The duration line is replaced by a block widget unless the selection touches
 * it; then it goes back to raw text. Block widgets may not come from a plugin,
 * which is why everything here is a `StateField`.
 */

import { editorInfoField, editorLivePreviewField } from "obsidian";
import {
  StateField,
  type EditorState,
  type Extension,
  type Range
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet
} from "@codemirror/view";

import { dimensionColor, dimensionColorVars } from "../core/color";
import { dayKey, dayKeyFromName } from "../core/day-note";
import type { DurationSigil } from "../core/duration";
import type { EntrySession } from "../entries/session";
import type { WeaverSettings } from "../settings";
import { entryIndexField, refreshEntriesEffect } from "./entry-field";
import { DurationWidget } from "./stopwatch-widget";

const NUM = Decoration.mark({ class: "weaver-dcn-num" });
const INK = Decoration.mark({ class: "weaver-dcn-ink" });
const DIGITS = /\d+/g;

/** True when the caret or selection touches this range, so it stays raw. */
function touches(state: EditorState, from: number, to: number): boolean {
  const selection = state.selection.main;
  return selection.from <= to && selection.to >= from;
}

/** Alternating runs: digits white, punctuation in the dimension's colour. */
function addDigitRuns(
  ranges: Range<Decoration>[],
  from: number,
  to: number,
  text: string
): void {
  DIGITS.lastIndex = 0;
  let cursor = 0;
  let match = DIGITS.exec(text);

  while (match !== null) {
    if (match.index > cursor) {
      ranges.push({ from: from + cursor, to: from + match.index, value: INK });
    }
    ranges.push({ from: from + match.index, to: from + match.index + match[0].length, value: NUM });
    cursor = match.index + match[0].length;
    match = DIGITS.exec(text);
  }

  if (cursor < text.length) ranges.push({ from: from + cursor, to, value: INK });
}

/** ` - [[2026.10.26]]` after the clock, on any day that is not today. */
class DayLinkWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly sourcePath: string,
    readonly open: (target: string, sourcePath: string) => void
  ) {
    super();
  }

  eq(other: DayLinkWidget): boolean {
    return other.target === this.target && other.sourcePath === this.sourcePath;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "weaver-entry-daylink";
    span.textContent = ` - [[${this.target}]]`;
    span.addEventListener("click", (event: Event) => {
      event.preventDefault();
      this.open(this.target, this.sourcePath);
    });
    return span;
  }

  /** The click is the link's; the editor must not move the caret instead. */
  ignoreEvent(): boolean {
    return true;
  }
}

function pathOfState(state: EditorState, fallback: () => string): string {
  const info = state.field(editorInfoField, false);
  return info?.file?.path ?? fallback();
}

function basenameOf(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/, "");
}

/**
 * The decoration set for one state. Exported so a test can read it without a
 * live `EditorView`, which needs a real browser to measure.
 */
export function entryDecorationSet(
  state: EditorState,
  settings: WeaverSettings,
  session: EntrySession,
  path: string,
  now: number,
  openDayLink?: (target: string, sourcePath: string) => void
): DecorationSet {
  const index = state.field(entryIndexField, false);
  if (index === undefined || index.entries.length === 0) return Decoration.none;

  const ranges: Range<Decoration>[] = [];

  const basename = basenameOf(path);
  const fileDay = dayKeyFromName(basename);
  const today = dayKey(new Date(now));
  const showDayLink = settings.entryDayLink && fileDay !== null && fileDay !== today;
  // Frames are drawn over the note by `entry-frame.ts`, which also draws the
  // marker on the top rail. The line keeps its text — laid out, announced, still
  // the record — and only its paint is removed. Source mode never hides it: the
  // raw mark is the point of that mode, and the layer does not run there either.
  const framed = settings.entryFrames && state.field(editorLivePreviewField, false) === true;

  for (const entry of index.entries) {
    if (entry.line >= state.doc.lines) continue;

    const vars = dimensionColorVars(entry.d);
    const head = state.doc.line(entry.line + 1);
    const headRaw = touches(state, head.from, head.to);
    const headClasses = ["weaver-entry-head"];
    if (headRaw) headClasses.push("weaver-entry-head-raw");
    else if (framed) headClasses.push("weaver-entry-head-framed");

    ranges.push({
      from: head.from,
      to: head.from,
      value: Decoration.line({
        class: headClasses.join(" "),
        attributes: { style: vars }
      })
    });

    const prefixTo = Math.min(entry.markerEnd, head.to);
    addDigitRuns(ranges, head.from, prefixTo, state.doc.sliceString(head.from, prefixTo));

    if (showDayLink) {
      ranges.push({
        from: prefixTo,
        to: prefixTo,
        value: Decoration.widget({
          side: 1,
          widget: new DayLinkWidget(basename, path, openDayLink ?? (() => {}))
        })
      });
    }

    for (const line of entry.proseLines) {
      if (line >= state.doc.lines) continue;
      const prose = state.doc.line(line + 1);
      ranges.push({
        from: prose.from,
        to: prose.from,
        value: Decoration.line({ class: "weaver-entry-prose", attributes: { style: vars } })
      });
    }

    if (entry.durationLine === null || entry.durationLine >= state.doc.lines) continue;

    const duration = state.doc.line(entry.durationLine + 1);
    if (touches(state, duration.from, duration.to)) {
      ranges.push({
        from: duration.from,
        to: duration.from,
        value: Decoration.line({ class: "weaver-duration-raw", attributes: { style: vars } })
      });
      continue;
    }

    const active = session.activeFor(path, entry.n);
    // While writing, the line is a live draft whatever the file holds; once
    // settled it shows the sigil the file kept — `=` or a legacy `+`.
    const sigil = active ? "-" : ((duration.text[0] ?? "-") as DurationSigil);
    const ms = active ? session.elapsed(now) : entry.durationMs;
    const to = duration.to < state.doc.length ? duration.to + 1 : duration.to;

    ranges.push({
      from: duration.from,
      to,
      value: Decoration.replace({
        block: true,
        widget: new DurationWidget({
          sigil,
          ms,
          active,
          color: dimensionColor(entry.d),
          d: entry.d
        })
      })
    });
  }

  return Decoration.set(ranges, true);
}

export function entryDecorationsExtension(
  getSettings: () => WeaverSettings,
  getSession: () => EntrySession,
  getPath: () => string,
  openDayLink?: (target: string, sourcePath: string) => void
): Extension {
  const build = (state: EditorState): DecorationSet =>
    entryDecorationSet(
      state,
      getSettings(),
      getSession(),
      pathOfState(state, getPath),
      Date.now(),
      openDayLink
    );

  const field = StateField.define<DecorationSet>({
    create: build,
    update: (value, transaction) => {
      if (transaction.docChanged) return build(transaction.state);
      if (transaction.selection !== undefined) return build(transaction.state);
      if (transaction.effects.some((effect) => effect.is(refreshEntriesEffect))) {
        return build(transaction.state);
      }
      return value;
    }
  });

  return [field, EditorView.decorations.from(field)];
}
