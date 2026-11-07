/**
 * Reading view: the same entry the editor draws, in the same frame.
 *
 * The address paragraph becomes the frame's first child and the clock paragraph
 * its last; the prose between them is the frame's interior. The wrapper is a real
 * element because a box needs one to enclose — and because the file's own text is
 * what labels it: the address row is the top rail's label, and the clock row is the
 * bottom edge, its duration at the left corner and its moment at the right. The
 * rails run through the middle of those rows and are cut behind them by the
 * labels' own backgrounds, so the box reads as running into its own text.
 *
 * The address's own characters are kept, split into digit runs so the digits stay
 * white and the punctuation takes the dimension's colour. Anything typed after
 * the address stays in the DOM untouched, links and emphasis included. A persistent
 * top-right label shows a useful recorded day: another date in a dated note, or
 * any non-current date in an ordinary note. A resolvable date is a link; an
 * ordinary note keeps static text. Awaiting and historical undated entries carry
 * no date label. The clock row's two halves stay time-only: digit and punctuation
 * runs, exactly as in the editor.
 */

import { MarkdownRenderChild, type MarkdownPostProcessor } from "obsidian";

import { dimensionColorVars } from "../core/color";
import { dayKey } from "../core/day";
import { entryDayLabel, type WeavingContext } from "../core/contexts";
import { formatClock, parseClockRow, type ClockRow } from "../core/duration";
import { parseEntries, parseAddressPrefix } from "../core/entries";
import { parseWhisperLine } from "../core/whisper";
import { formatClock as wallClock } from "../core/clock";
import type { EntryClock } from "../entries/clock";
import { writeClockText } from "../editor/duration-ticker";
import { appendClockRuns, appendDigitRuns } from "../ui/dcn";
import { entryDayElement, type OpenDayLink } from "../ui/day-link";

/** Containers whose paragraphs must never be rewritten. */
const SKIP_SELECTOR = "blockquote, .callout, .markdown-embed, li, table, pre, code";

const PROCESSED = "data-weaver-entry-processed";
const HEAD_CLASS = "weaver-entry-head";
const WHISPER_CLASS = "weaver-entry-whisper";
const TEXT_NODE = 3;

/**
 * Moves a clock at the end of the address's paragraph out of the prose. Markdown
 * keeps paused (`=`) and moment-only rows in that paragraph rather than a list
 * section; leaving the raw row there would repeat its date and lose the rail.
 * Only the trailing clock and its separator leave; earlier markup stays intact.
 */
function takeClockTail(paragraph: HTMLElement): ClockRow | null {
  const tail = paragraph.lastChild;
  if (tail?.nodeType !== TEXT_NODE) return null;
  const text = (tail.textContent ?? "").trimEnd();
  const start = text.lastIndexOf("\n") + 1;
  const clock = parseClockRow(text.slice(start).trim());
  if (clock === null) return null;
  const remainder = text.slice(0, start).replace(/\r?\n$/, "");
  if (remainder !== "") tail.textContent = remainder;
  else {
    tail.remove();
    const separator = paragraph.lastChild;
    if (separator?.nodeType === 1 && (separator as Element).tagName === "BR") separator.remove();
  }
  return clock;
}

/**
 * The clock row, in Reading view: the duration at the left corner, the moment at
 * the right, each carrying its own background so the rail is cut twice and shows
 * between them. The parser accepts only the canonical shape, so this re-renders
 * the file's own text: the digits stay white and the colons take the dimension's
 * colour. A recorded day is not drawn here — it labels the frame's top-right
 * corner once, never the bottom row.
 */
function clockElement(parsed: ClockRow, d: number | null, labelled = false): HTMLElement {
  const root = document.createElement("div");
  root.className = "weaver-duration";
  root.setAttribute(PROCESSED, "true");
  if (d !== null) root.setAttribute("style", dimensionColorVars(d));

  if (parsed.duration !== null) {
    const clock = document.createElement("span");
    clock.className = labelled
      ? "weaver-duration-clock weaver-frame-label"
      : "weaver-duration-clock";

    const sigil = document.createElement("span");
    sigil.className = "weaver-duration-sigil";
    sigil.textContent = parsed.duration.sigil;
    clock.appendChild(sigil);
    clock.appendChild(document.createTextNode(" "));

    appendClockRuns(clock, formatClock(parsed.duration.ms));

    root.appendChild(clock);
  }

  const moment = document.createElement("span");
  moment.className = labelled
    ? "weaver-duration-moment weaver-frame-label"
    : "weaver-duration-moment";
  if (parsed.time !== null) appendClockRuns(moment, parsed.time);
  root.appendChild(moment);

  return root;
}

/** A rendered awaiting moment subscribes only while its Markdown section lives. */
class AwaitingClock extends MarkdownRenderChild {
  private unsubscribe: (() => void) | null = null;

  constructor(element: HTMLElement, private readonly clock: EntryClock) {
    super(element);
  }

  onload(): void {
    const moment = this.containerEl.querySelector<HTMLElement>(".weaver-duration-moment");
    if (moment === null) return;
    const digits = appendClockRuns(moment, wallClock(new Date(this.clock.snapshot().now)));
    this.unsubscribe = this.clock.subscribe((now) => writeClockText(digits, wallClock(new Date(now))));
  }

  onunload(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

/**
 * Builds the post processor that frames entries in Reading view. Section source
 * preserves signed-list extraction; an optional shared clock paints awaiting
 * moments with section-owned subscription cleanup, without writing note bytes.
 */
export function createEntryProcessor(
  contexts: () => readonly WeavingContext[],
  openDayLink?: OpenDayLink,
  clock?: EntryClock,
  currentDay: () => string = () => dayKey(new Date())
): MarkdownPostProcessor {
  return (element: HTMLElement, context): void => {
    const sourcePath = context.sourcePath ?? "";
    const open = openDayLink ?? (() => {});
    // Only the fallback path uses these: with a source index every address can ask
    // the note itself whether a Thread or a branch came before it. The path reset
    // keeps one document's last Thread from spacing the next document's first.
    let fallbackPath: string | null = null;
    let seenThread = false;
    let previousDepth: number | null = null;
    if (sourcePath !== fallbackPath) {
      fallbackPath = sourcePath;
      seenThread = false;
      previousDepth = null;
    }
    const renderClock = (parsed: ClockRow, d: number | null, labelled = false): HTMLElement => {
      const row = clockElement(parsed, d, labelled);
      if (clock !== undefined && parsed.time === null && parsed.duration !== null &&
          parsed.duration.sigil !== "+") context.addChild(new AwaitingClock(row, clock));
      return row;
    };

    // Obsidian renders each Markdown block separately. A canonical + or - clock
    // is a list in another section, not a paragraph beside the entry's prose.
    // Read its source address rather than guessing a sigil from the rendered list.
    const section = context.getSectionInfo?.(element) ?? null;
    const sourceIndex = section === null ? null : parseEntries(section.text);
    if (section !== null && sourceIndex !== null) {
      const sectionText = sourceIndex.lines.slice(section.lineStart, section.lineEnd + 1).join("\n").trim();
      const clockEntry = sourceIndex.entries.find((entry) =>
        entry.clockLine !== null &&
        entry.clockLine >= section.lineStart && entry.clockLine <= section.lineEnd &&
        sectionText === sourceIndex.lines[entry.clockLine]?.trim()
      );
      if (clockEntry !== undefined) {
        element.setAttribute("hidden", "");
        return;
      }
    }

    // The nearest address above a duration is simply the last one met, because
    // paragraphs arrive in document order.
    let depth: number | null = null;

    for (const paragraph of Array.from(element.querySelectorAll("p"))) {
      if (paragraph.getAttr(PROCESSED) !== null) continue;
      if (paragraph.closest(SKIP_SELECTOR) !== null) continue;

      const text = paragraph.textContent ?? "";

      const clock = parseClockRow(text.trim());
      if (clock !== null) {
        // A clock row on its own, with no frame to sit on — a stray line, or one
        // separated from its address by something that is not a paragraph — is
        // drawn as the plain block it always was.
        paragraph.replaceWith(renderClock(clock, depth));
        continue;
      }

      const prefix = parseAddressPrefix(text);
      if (prefix === null) continue;
      depth = prefix.d;

      // The entry this section holds, when the source can be read: its own
      // recorded day is the day the label names, even if it was written into an
      // older note. Without section context the same day is found below, in the
      // address paragraph's contained lines or in the clock paragraph beside it.
      const sourceEntry = section === null ? undefined : sourceIndex?.entries.find((entry) =>
        entry.n === prefix.n && entry.line >= section.lineStart && entry.line <= section.lineEnd
      );
      let entryDay: string | null = sourceEntry?.day ?? null;

      // A Thread-start is every depth-1 entry after the note's first Thread; a
      // branch-start is a branch whose predecessor is another branch, so the
      // first branch stays close to its Thread's root. Reading the source index
      // makes this independent of section render order; the fallback remembers
      // the previous address for a note whose source cannot be read.
      const sourcePosition =
        sourceEntry === undefined || sourceIndex === null
          ? -1
          : sourceIndex.entries.indexOf(sourceEntry);
      let threadStart: boolean;
      let branchStart: boolean;
      if (sourcePosition >= 0 && sourceIndex !== null) {
        threadStart =
          prefix.d === 1 &&
          sourceIndex.entries.slice(0, sourcePosition).some((entry) => entry.d === 1);
        branchStart =
          prefix.d > 1 && sourcePosition > 0 && sourceIndex.entries[sourcePosition - 1].d > 1;
      } else {
        threadStart = prefix.d === 1 && seenThread;
        branchStart = prefix.d > 1 && previousDepth !== null && previousDepth > 1;
      }
      if (prefix.d === 1) seenThread = true;
      previousDepth = prefix.d;

      const head = document.createElement("div");
      // The address row is the frame's top rail: its own background cuts the rail
      // behind it, so the box reads as running into the row that names it.
      head.className = "weaver-entry-head weaver-frame-label";
      head.setAttribute("style", dimensionColorVars(prefix.d));
      head.setAttribute("data-weaver-d", String(prefix.d));
      head.setAttribute(PROCESSED, "true");

      appendDigitRuns(head, text.slice(0, prefix.length));

      // Only the address characters leave the paragraph; a title written after
      // the clock, with its links and emphasis, stays exactly as Obsidian made
      // it — as the entry's first prose line, inside the frame. It is never
      // folded into the rail's label, where it would be ellipsized away.
      const first = paragraph.firstChild;
      const firstText = first?.textContent ?? "";
      if (first !== null && first.nodeType === TEXT_NODE && firstText.startsWith(text.slice(0, prefix.length))) {
        const remainder = firstText.slice(prefix.length);
        first.textContent = remainder;
        // The address's own soft break is not a blank prose line. Remove exactly
        // that separator, retaining any later author-written breaks and markup.
        const separator = first.nextSibling;
        if (remainder.trim() === "" && separator !== null &&
            separator.nodeType === 1 && (separator as Element).tagName === "BR") {
          first.remove();
          separator.remove();
          const proseStart = paragraph.firstChild;
          if (proseStart?.nodeType === TEXT_NODE) {
            proseStart.textContent = (proseStart.textContent ?? "").replace(/^\r?\n/, "");
          }
        } else if (/^[ \t]*\r?\n/.test(remainder)) {
          first.textContent = remainder.replace(/^[ \t]*\r?\n/, "");
        }
      }

      const containedClock = takeClockTail(paragraph);
      entryDay = containedClock?.day ?? entryDay;

      const frame = document.createElement("div");
      const frameClasses = ["weaver-frame", "is-static"];
      if (threadStart) frameClasses.push("weaver-thread-start");
      if (branchStart) frameClasses.push("weaver-branch-start");
      frame.className = frameClasses.join(" ");
      frame.setAttribute("style", dimensionColorVars(prefix.d));
      frame.setAttribute("data-weaver-d", String(prefix.d));
      paragraph.replaceWith(frame);
      frame.appendChild(head);

      if ((paragraph.textContent ?? "").trim() !== "") {
        const inline = document.createElement("p");
        inline.className = "weaver-entry-prose";
        inline.setAttribute("style", dimensionColorVars(prefix.d));
        while (paragraph.firstChild !== null) inline.appendChild(paragraph.firstChild);
        frame.appendChild(inline);
      }
      if (containedClock !== null) frame.appendChild(renderClock(containedClock, prefix.d, true));

      let sibling = frame.nextElementSibling;
      while (sibling !== null) {
        const next = sibling.nextElementSibling;

        if (sibling.tagName !== "P") break;
        if (sibling.classList.contains(HEAD_CLASS)) break;
        if (sibling.classList.contains("weaver-frame")) break;
        // The next address may not have been decorated yet in this render batch.
        // Its paragraph owns another frame; consuming it would nest sibling entries.
        if (parseAddressPrefix(sibling.textContent ?? "") !== null) break;

        // A whisper row is the model's reading, not the writer's prose: the class
        // overrides the colour, and `--weaver-d` stays, because the comment's rule
        // indents by it.
        if (parseWhisperLine((sibling.textContent ?? "").trim()) !== null) {
          sibling.classList.add(WHISPER_CLASS);
          sibling.setAttribute("style", dimensionColorVars(prefix.d));
          frame.appendChild(sibling);
          sibling = next;
          continue;
        }

        const parsed = parseClockRow((sibling.textContent ?? "").trim());
        if (parsed !== null) {
          entryDay = parsed.day ?? entryDay;
          frame.appendChild(renderClock(parsed, prefix.d, true));
          sibling.remove();
          break;
        }

        sibling.classList.add("weaver-entry-prose");
        sibling.setAttribute("style", dimensionColorVars(prefix.d));
        frame.appendChild(sibling);
        sibling = next;
      }

      // The clock's own section is suppressed independently, so block rendering
      // order and virtualized section boundaries cannot leave a bullet behind.
      if (sourceEntry?.clockLine !== null && sourceEntry?.clockLine !== undefined &&
          sourceEntry.clockLine > (section?.lineEnd ?? -1)) {
        const sourceClock = parseClockRow(sourceIndex?.lines[sourceEntry.clockLine]?.trim() ?? "");
        if (sourceClock !== null) {
          entryDay = sourceClock.day ?? entryDay;
          frame.appendChild(renderClock(sourceClock, prefix.d, true));
        }
      }

      // The recorded date is visible when it is useful context. A resolvable
      // target stays interactive; an ordinary note still keeps a static label.
      const dayLabel = entryDayLabel(entryDay, sourcePath, contexts(), currentDay());
      if (dayLabel !== null) {
        frame.insertBefore(entryDayElement(dayLabel, sourcePath, open), head.nextSibling);
      }
    }
  };
}
