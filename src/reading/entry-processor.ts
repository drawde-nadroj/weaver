/**
 * Reading view: the same entry the editor draws, in the same frame.
 *
 * The marker paragraph becomes the frame's first child and the clock paragraph
 * its last; the prose between them is the frame's interior. The wrapper is a real
 * element because a box needs one to enclose — and because the file's own text is
 * what labels it: the marker row is the top rail's label, and the clock row is the
 * bottom edge, its duration at the left corner and its moment at the right. The
 * rails run through the middle of those rows and are cut behind them by the
 * labels' own backgrounds, so the box reads as running into its own text.
 *
 * The marker's own characters are kept, split into digit runs so the digits stay
 * white and the punctuation takes the dimension's colour. Anything typed after
 * the marker stays in the DOM untouched, links and emphasis included. On a note
 * whose filename is a day other than today's, a link to today's daily note is
 * appended to the frame and positioned at its top-right corner; today's note
 * carries none, because it would link back to itself. The clock row's two halves
 * are digit and punctuation runs, exactly as in the editor.
 */

import type { MarkdownPostProcessor } from "obsidian";

import { dimensionColorVars } from "../core/color";
import { dayKey, dayKeyFromName, dayNameLike } from "../core/day";
import { formatClock, parseClockRow, type ClockRow } from "../core/duration";
import { parseEntries, parseMarkerPrefix } from "../core/entries";
import { parseWhisperLine } from "../core/whisper";
import { appendClockRuns, appendDigitRuns } from "../ui/dcn";
import { dayLinkElement, type OpenDayLink } from "../ui/day-link";

/** Containers whose paragraphs must never be rewritten. */
const SKIP_SELECTOR = "blockquote, .callout, .markdown-embed, li, table, pre, code";

const PROCESSED = "data-weaver-entry-processed";
const HEAD_CLASS = "weaver-entry-head";
const WHISPER_CLASS = "weaver-entry-whisper";
const TEXT_NODE = 3;

/**
 * The clock row, in Reading view: the duration at the left corner, the moment at
 * the right, each carrying its own background so the rail is cut twice and shows
 * between them. The parser accepts only the canonical shape, so this re-renders
 * the file's own text: the digits stay white and the colons take the dimension's
 * colour.
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

/**
 * Builds the post processor that frames entries in Reading view. It reads the
 * rendered paragraphs and their source section — no settings or vault access —
 * and takes only the opener the frame's day link needs.
 */
export function createEntryProcessor(openDayLink?: OpenDayLink): MarkdownPostProcessor {
  return (element: HTMLElement, context): void => {
    const sourcePath = context.sourcePath ?? "";
    const basename = (sourcePath.split("/").pop() ?? "").replace(/\.md$/, "");
    const fileDay = dayKeyFromName(basename);
    const today = new Date();
    const showDayLink = fileDay !== null && fileDay !== dayKey(today);
    // The link goes to today, not to the note it is painted on.
    const dayLinkTarget = dayNameLike(today, basename);
    const open = openDayLink ?? (() => {});

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

    // The nearest marker above a duration is simply the last one met, because
    // paragraphs arrive in document order.
    let depth: number | null = null;

    for (const paragraph of Array.from(element.querySelectorAll("p"))) {
      if (paragraph.getAttr(PROCESSED) !== null) continue;
      if (paragraph.closest(SKIP_SELECTOR) !== null) continue;

      const text = paragraph.textContent ?? "";

      const clock = parseClockRow(text.trim());
      if (clock !== null) {
        // A clock row on its own, with no frame to sit on — a stray line, or one
        // separated from its marker by something that is not a paragraph — is
        // drawn as the plain block it always was.
        paragraph.replaceWith(clockElement(clock, depth));
        continue;
      }

      const prefix = parseMarkerPrefix(text);
      if (prefix === null) continue;
      depth = prefix.d;

      const head = document.createElement("div");
      // The marker row is the frame's top rail: its own background cuts the rail
      // behind it, so the box reads as running into the row that names it.
      head.className = "weaver-entry-head weaver-frame-label";
      head.setAttribute("style", dimensionColorVars(prefix.d));
      head.setAttribute("data-weaver-d", String(prefix.d));
      head.setAttribute(PROCESSED, "true");

      appendDigitRuns(head, text.slice(0, prefix.length));

      // Only the marker characters leave the paragraph; a title written after
      // the clock, with its links and emphasis, stays exactly as Obsidian made
      // it — as the entry's first prose line, inside the frame. It is never
      // folded into the rail's label, where it would be ellipsized away.
      const first = paragraph.firstChild;
      const firstText = first?.textContent ?? "";
      if (first !== null && first.nodeType === TEXT_NODE && firstText.startsWith(text.slice(0, prefix.length))) {
        const remainder = firstText.slice(prefix.length);
        first.textContent = remainder;
        // The marker's own soft break is not a blank prose line. Remove exactly
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

      const frame = document.createElement("div");
      frame.className = "weaver-frame is-static";
      frame.setAttribute("style", dimensionColorVars(prefix.d));
      frame.setAttribute("data-weaver-d", String(prefix.d));
      paragraph.replaceWith(frame);
      frame.appendChild(head);

      // The top-right label on a note that is not today's. It is a child of the
      // frame, not of the shrink-wrapped head, so the head stays exactly the
      // marker's own characters.
      if (showDayLink) frame.appendChild(dayLinkElement(dayLinkTarget, sourcePath, open));

      if ((paragraph.textContent ?? "").trim() !== "") {
        const inline = document.createElement("p");
        inline.className = "weaver-entry-prose";
        inline.setAttribute("style", dimensionColorVars(prefix.d));
        while (paragraph.firstChild !== null) inline.appendChild(paragraph.firstChild);
        frame.appendChild(inline);
      }

      let sibling = frame.nextElementSibling;
      while (sibling !== null) {
        const next = sibling.nextElementSibling;

        if (sibling.tagName !== "P") break;
        if (sibling.classList.contains(HEAD_CLASS)) break;
        if (sibling.classList.contains("weaver-frame")) break;

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
          frame.appendChild(clockElement(parsed, prefix.d, true));
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
      const sourceEntry = section === null ? undefined : sourceIndex?.entries.find((entry) =>
        entry.n === prefix.n && entry.line >= section.lineStart && entry.line <= section.lineEnd
      );
      if (sourceEntry?.clockLine !== null && sourceEntry?.clockLine !== undefined &&
          sourceEntry.clockLine > (section?.lineEnd ?? -1)) {
        const sourceClock = parseClockRow(sourceIndex?.lines[sourceEntry.clockLine]?.trim() ?? "");
        if (sourceClock !== null) frame.appendChild(clockElement(sourceClock, prefix.d, true));
      }
    }
  };
}
