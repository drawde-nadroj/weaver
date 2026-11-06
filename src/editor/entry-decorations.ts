/**
 * The entry, drawn.
 *
 * Colour and indent ride on two custom properties set per line
 * (`--weaver-dcolor`, `--weaver-d`), so nothing is generated per level: depth 7
 * costs exactly what depth 1 costs. The address keeps its text — only its runs are
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
 * The address row also carries a persistent creation-day link when the recorded
 * day differs from the day-note filename. Same-day and historical undated
 * entries need no label. The date is not repeated in the clock widget.
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
import { entryDayLinkTarget, type WeavingContext } from "../core/contexts";
import type { Entry } from "../core/entries";
import type { EntryClock } from "../entries/clock";
import type { EntrySession } from "../entries/session";
import { INK_CLASS, addressSlices, NUM_CLASS } from "../ui/dcn";
import { dayLinkElement, type OpenDayLink } from "../ui/day-link";
import { entryIndexField, refreshEntriesEffect } from "./entry-field";
import { DurationWidget, type ClockMode } from "./stopwatch-widget";

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

/** The address's runs, in place: digits white, punctuation coloured. */
function addAddressRuns(ranges: Range<Decoration>[], from: number, text: string): void {
  let cursor = from;
  for (const slice of addressSlices(text)) {
    const to = cursor + slice.text.length;
    ranges.push({ from: cursor, to, value: RUNS[slice.cls] as Decoration });
    cursor = to;
  }
}

/**
 * The entry-day link at the top-right corner: part of the address row,
 * positioned absolutely so it never joins the text flow or moves a character.
 *
 * `ignoreEvent` keeps a click from also placing the caret: the link is the
 * click's, and the frame around the entry is not a place to write.
 */
class DayLinkWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly sourcePath: string,
    readonly open: OpenDayLink
  ) {
    super();
  }

  eq(other: DayLinkWidget): boolean {
    return other.target === this.target && other.sourcePath === this.sourcePath;
  }

  toDOM(): HTMLElement {
    return dayLinkElement(this.target, this.sourcePath, this.open);
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function pathOfState(state: EditorState, fallback: () => string): string {
  const info = state.field(editorInfoField, false);
  return info?.file?.path ?? fallback();
}

/**
 * A draft still waiting for its first input: its clock row holds a duration and
 * nothing else. That duration-only row is the durable pending state, so it has no
 * beginning to label — the day and the moment are recorded by the first keystroke,
 * not by insertion. A zero duration or empty prose alone is never enough: a
 * historical row that carries a moment is already someone's beginning.
 */
function isAwaitingDraft(entry: Entry): boolean {
  return (
    entry.state === "draft" &&
    entry.duration !== null &&
    entry.time === null &&
    entry.day === null
  );
}

/**
 * The decoration set for one state. Exported so a test can read it without a
 * live `EditorView`, which needs a real browser to measure.
 */
export function entryDecorationSet(
  state: EditorState,
  session: EntrySession,
  path: string,
  clock: EntryClock,
  contexts: readonly WeavingContext[],
  openDayLink?: OpenDayLink
): DecorationSet {
  const index = state.field(entryIndexField, false);
  if (index === undefined || index.entries.length === 0) return Decoration.none;

  const ranges: Range<Decoration>[] = [];

  // Visibility depends on the record and its note, never the pointer or caret.
  const livePreview = state.field(editorLivePreviewField, false) === true;
  let seenThread = false;

  for (const [position, entry] of index.entries.entries()) {
    if (entry.line >= state.doc.lines) continue;

    const vars = dimensionColorVars(entry.d);
    const head = state.doc.line(entry.line + 1);
    const dayLinkTarget = livePreview ? entryDayLinkTarget(entry.day, path, contexts) : null;
    // Legacy inline prose keeps its rail and date label above the text.
    const inlineTitle =
      entry.firstProseLine !== null && entry.firstProseLine === entry.line;
    // A Thread-start is every depth-1 entry after the note's first Thread; a
    // branch-start is a branch whose predecessor is another branch, so the first
    // branch stays close to its Thread's root and every later one gets the air.
    const previous = position === 0 ? null : index.entries[position - 1];
    const threadStart = entry.d === 1 && seenThread;
    if (entry.d === 1) seenThread = true;
    const branchStart = entry.d > 1 && previous !== null && previous.d > 1;

    // The address keeps its own text, always: the frame is drawn beside it, never
    // over it, so there is no class to swap when the caret arrives. The stamp is
    // how the frame layer finds this row without asking for a DOM position.
    const headClasses = ["weaver-entry-head"];
    if (inlineTitle) headClasses.push("weaver-entry-inline");
    if (threadStart) headClasses.push("weaver-thread-start");
    if (branchStart) headClasses.push("weaver-branch-start");
    ranges.push({
      from: head.from,
      to: head.from,
      value: Decoration.line({
        class: headClasses.join(" "),
        attributes: { style: vars, "data-weaver-n": String(entry.n) }
      })
    });

    const prefixTo = Math.min(entry.addressEnd, head.to);
    // The address's characters are the top rail's label: its background covers the
    // rail behind them, so the box appears to run into its own first row. No
    // padding, so no character moves.
    ranges.push({
      from: head.from,
      to: prefixTo,
      value: Decoration.mark({ class: LABEL_CLASS })
    });
    addAddressRuns(ranges, head.from, state.doc.sliceString(head.from, prefixTo));

    // The date labels the top rail without joining the text flow.
    if (dayLinkTarget !== null) {
      ranges.push({
        from: head.to,
        to: head.to,
        value: Decoration.widget({
          side: 1,
          widget: new DayLinkWidget(dayLinkTarget, path, openDayLink ?? (() => {}))
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
    // frame finds the address row only.
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

    const mode: ClockMode = session.activeFor(path, entry.n)
      ? "running"
      : isAwaitingDraft(entry)
        ? "awaiting"
        : "fixed";
    // While writing, the row is a live draft whatever the file holds, and its left
    // corner is the session's last painted snapshot — never a fresh sample taken
    // here, which is what used to make a stop write a second the writer never saw.
    // A draft awaiting its first input shows the duration the row holds, which is
    // zero until it has been written into, beside the wall clock; a draft paused
    // before its first input keeps the time it had already accumulated. Once
    // settled the row shows the duration the file kept — its sigil, which may be
    // absent when the row carries only a moment.
    const sigil = mode === "running" ? "-" : (entry.duration?.sigil ?? null);
    const ms = mode === "running" ? session.displayed() : (entry.duration?.ms ?? 0);
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
          mode,
          path,
          clock,
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
  getClock: () => EntryClock,
  getContexts: () => readonly WeavingContext[],
  openDayLink?: OpenDayLink
): Extension {
  const build = (state: EditorState): DecorationSet =>
    entryDecorationSet(
      state,
      getSession(),
      pathOfState(state, getPath),
      getClock(),
      getContexts(),
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
