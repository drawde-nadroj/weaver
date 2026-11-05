/**
 * The entry, drawn.
 *
 * Colour and indent ride on two custom properties set per line
 * (`--weaver-dcolor`, `--weaver-d`), so nothing is generated per level: depth 7
 * costs exactly what depth 1 costs. The marker keeps its text — only its runs are
 * marked up, so the line stays editable and the digits stay white while the
 * punctuation carries the dimension's colour.
 *
 * The clock row is replaced by a block widget unless the selection touches it;
 * then it goes back to raw text. Block widgets may not come from a plugin,
 * which is why everything here is a `StateField`.
 *
 * Each of those two rows is also a rail's label and carries two extra pieces of
 * markup: a `weaver-frame-label` mark over the row's own characters, whose
 * background cuts the rail behind it, and a `data-weaver-n` stamp, which is how
 * the frame layer finds the row without asking for a DOM position.
 *
 * The marker row's third piece of markup is the entry-day link at the top-right
 * corner. The entry's own clock row supplies its day when one was recorded, and
 * a historical undated row inherits the day-note filename; the clock row also
 * supplies the entry's time. Neither changes just because the note is read on
 * another day, and the date is not drawn a second time into the clock widget.
 */

import { editorInfoField, editorLivePreviewField } from "obsidian";
import {
  StateField,
  type EditorState,
  type Extension,
  type Range
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

import { dimensionColor, dimensionColorVars } from "../core/color";
import { entryDayName, dayKeyFromName } from "../core/day";
import type { EntrySession } from "../entries/session";
import { INK_CLASS, markerSlices, NUM_CLASS } from "../ui/dcn";
import { dayLinkElement, type OpenDayLink } from "../ui/day-link";
import { entryIndexField, refreshEntriesEffect } from "./entry-field";
import { DurationWidget } from "./stopwatch-widget";

const RUNS: Record<string, Decoration> = {
  [NUM_CLASS]: Decoration.mark({ class: NUM_CLASS }),
  [INK_CLASS]: Decoration.mark({ class: INK_CLASS })
};

/**
 * The class that makes a row a rail's label: its own background covers the rail
 * behind it, so the box appears to stop at the text that names it. Spans share it
 * with the mark over a whole row.
 */
const LABEL_CLASS = "weaver-frame-label";

/** True when the caret or selection touches this range, so it stays raw. */
function touches(state: EditorState, from: number, to: number): boolean {
  const selection = state.selection.main;
  return selection.from <= to && selection.to >= from;
}

/** The marker's runs, in place: digits white, punctuation coloured. */
function addMarkerRuns(ranges: Range<Decoration>[], from: number, text: string): void {
  let cursor = from;
  for (const slice of markerSlices(text)) {
    const to = cursor + slice.text.length;
    ranges.push({ from: cursor, to, value: RUNS[slice.cls] as Decoration });
    cursor = to;
  }
}

/**
 * The entry-day link at the top-right corner: part of the marker row,
 * positioned absolutely so it never joins the text flow or moves a character.
 *
 * `ignoreEvent` keeps a click from also placing the caret: the link is the
 * click's, and the frame around the entry is not a place to write.
 */
class DayLinkWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly sourcePath: string,
    readonly open: OpenDayLink,
    readonly caret: boolean
  ) {
    super();
  }

  eq(other: DayLinkWidget): boolean {
    return other.target === this.target && other.sourcePath === this.sourcePath &&
      other.caret === this.caret;
  }

  toDOM(): HTMLElement {
    const link = dayLinkElement(this.target, this.sourcePath, this.open);
    link.classList.toggle("weaver-daylink-caret", this.caret);
    return link;
  }

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
  session: EntrySession,
  path: string,
  now: number,
  openDayLink?: OpenDayLink
): DecorationSet {
  const index = state.field(entryIndexField, false);
  if (index === undefined || index.entries.length === 0) return Decoration.none;

  const ranges: Range<Decoration>[] = [];

  // A day note is the only surface that can label an entry: without a day
  // filename there is no note to open and no fallback for an undated row. The
  // label for one entry is its recorded day, else that filename — computed per
  // entry, so a newly dated row in an older note names its own day. The wall
  // clock is only for elapsed duration, never for dating an entry read later.
  const basename = basenameOf(path);
  const dayNote = dayKeyFromName(basename) !== null;
  const showDayLinks = state.field(editorLivePreviewField, false) === true && dayNote;

  for (const entry of index.entries) {
    if (entry.line >= state.doc.lines) continue;

    const vars = dimensionColorVars(entry.d);
    const head = state.doc.line(entry.line + 1);
    const dayLinkTarget = showDayLinks ? entryDayName(entry.day, basename) : null;
    // The legacy inline-title row carries prose beside the marker, so an
    // absolute label at its right would sit on top of the writer's first line.
    const inlineTitle =
      entry.firstProseLine !== null && entry.firstProseLine === entry.line;

    // The marker keeps its own text, always: the frame is drawn beside it, never
    // over it, so there is no class to swap when the caret arrives. The stamp is
    // how the frame layer finds this row without asking for a DOM position.
    ranges.push({
      from: head.from,
      to: head.from,
      value: Decoration.line({
        class: "weaver-entry-head",
        attributes: { style: vars, "data-weaver-n": String(entry.n) }
      })
    });

    const prefixTo = Math.min(entry.markerEnd, head.to);
    // The marker's characters are the top rail's label: its background covers the
    // rail behind them, so the box appears to run into its own first row. No
    // padding, so no character moves.
    ranges.push({
      from: head.from,
      to: prefixTo,
      value: Decoration.mark({ class: LABEL_CLASS })
    });
    addMarkerRuns(ranges, head.from, state.doc.sliceString(head.from, prefixTo));

    // The top-right corner's label: generated, absolutely positioned, and the
    // only text on this row that the file does not hold.
    if (dayLinkTarget !== null && !inlineTitle) {
      ranges.push({
        from: head.to,
        to: head.to,
        value: Decoration.widget({
          side: 1,
          widget: new DayLinkWidget(
            dayLinkTarget, path, openDayLink ?? (() => {}),
            state.selection.main.head >= entry.from &&
              state.selection.main.head <= state.doc.line(
                (entry.clockLine ?? entry.proseLines.at(-1) ?? entry.whisperLines.at(-1) ?? entry.line) + 1
              ).to
          )
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

    // A whisper row carries no `--weaver-dcolor` and no `data-weaver-n`: it is the
    // model's reading, so it is the one row that does not take the dimension's
    // colour (the stylesheet's `.weaver-entry-whisper` rule says why), and the
    // frame finds the marker row only.
    for (const line of entry.whisperLines) {
      if (line >= state.doc.lines) continue;
      const row = state.doc.line(line + 1);
      ranges.push({
        from: row.from,
        to: row.from,
        value: Decoration.line({ class: "weaver-entry-whisper" })
      });
    }

    if (entry.clockLine === null || entry.clockLine >= state.doc.lines) continue;

    const row = state.doc.line(entry.clockLine + 1);
    if (touches(state, row.from, row.to)) {
      ranges.push({
        from: row.from,
        to: row.from,
        value: Decoration.line({
          class: "weaver-duration-raw",
          attributes: { style: vars, "data-weaver-n": String(entry.n) }
        })
      });
      // The bottom rail's label, exactly as the widget is: the same row, in the
      // file's own text.
      ranges.push({
        from: row.from,
        to: row.to,
        value: Decoration.mark({ class: LABEL_CLASS })
      });
      continue;
    }

    const active = session.activeFor(path, entry.n);
    // While writing, the row is a live draft whatever the file holds. Once
    // settled it shows the duration the file kept — its sigil, which may be
    // absent when the row carries only a moment.
    const sigil = active ? "-" : (entry.duration?.sigil ?? null);
    const ms = active ? session.elapsed(now) : (entry.duration?.ms ?? 0);
    const to = row.to < state.doc.length ? row.to + 1 : row.to;

    ranges.push({
      from: row.from,
      to,
      value: Decoration.replace({
        block: true,
        widget: new DurationWidget({
          n: entry.n,
          time: entry.time,
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

/** Publishes the entry decorations as one state field. */
export function entryDecorationsExtension(
  getSession: () => EntrySession,
  getPath: () => string,
  openDayLink?: OpenDayLink
): Extension {
  const build = (state: EditorState): DecorationSet =>
    entryDecorationSet(state, getSession(), pathOfState(state, getPath), Date.now(), openDayLink);

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
