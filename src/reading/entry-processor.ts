/**
 * Reading view: the same entry the editor draws, in the same frame.
 *
 * The marker paragraph becomes the frame's first child and the clock paragraph
 * its last; the prose between them is the frame's interior. The wrapper is a real
 * element because a box needs one to enclose — and because the file's own text is
 * what labels it: the marker row is the top rail's label, and the clock row is the
 * bottom edge, its moment at the left corner and its duration at the right. The
 * rails run through the middle of those rows and are cut behind them by the
 * labels' own backgrounds, so the box reads as running into its own text.
 *
 * The marker's own characters are kept, split into digit runs so the digits stay
 * white and the punctuation takes the dimension's colour. Anything typed after
 * the marker stays in the DOM untouched, links and emphasis included. The day is
 * not drawn into the entry: the day is the file's name, and the note's own header
 * shows it. The clock row's two halves are digit and punctuation runs, exactly as
 * in the editor.
 */

import type { MarkdownPostProcessor } from "obsidian";

import { dimensionColorVars } from "../core/color";
import { formatClock, parseClockRow, type ClockRow } from "../core/duration";
import { parseMarkerPrefix } from "../core/entries";
import { parseWhisperLine } from "../core/whisper";
import { appendClockRuns, appendDigitRuns } from "../ui/dcn";

/** Containers whose paragraphs must never be rewritten. */
const SKIP_SELECTOR = "blockquote, .callout, .markdown-embed, li, table, pre, code";

const PROCESSED = "data-weaver-entry-processed";
const HEAD_CLASS = "weaver-entry-head";
const WHISPER_CLASS = "weaver-entry-whisper";
const TEXT_NODE = 3;

/**
 * The clock row, in Reading view: the moment at the left corner, the duration at
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

  const moment = document.createElement("span");
  moment.className = labelled
    ? "weaver-duration-moment weaver-frame-label"
    : "weaver-duration-moment";
  if (parsed.time !== null) appendClockRuns(moment, parsed.time);
  root.appendChild(moment);

  if (parsed.duration === null) return root;

  const clock = document.createElement("span");
  clock.className = labelled
    ? "weaver-duration-clock weaver-frame-label"
    : "weaver-duration-clock";

  const sigil = document.createElement("span");
  sigil.className = "weaver-duration-sigil";
  sigil.textContent = parsed.duration.sigil;
  clock.appendChild(sigil);

  appendClockRuns(clock, formatClock(parsed.duration.ms));

  root.appendChild(clock);
  return root;
}

/**
 * Builds the post processor that frames entries in Reading view. It reads the
 * paragraph text and nothing else — no settings, no vault access — so it takes no
 * arguments.
 */
export function createEntryProcessor(): MarkdownPostProcessor {
  return (element: HTMLElement): void => {
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
        first.textContent = firstText.slice(prefix.length);
      }

      const frame = document.createElement("div");
      frame.className = "weaver-frame is-static";
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
    }
  };
}
