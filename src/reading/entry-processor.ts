/**
 * Reading view: the same entry the editor draws, in the same frame.
 *
 * The marker paragraph becomes the frame's first child and the duration
 * paragraph its last; the prose between them is the frame's interior. The
 * wrapper is a real element because a box needs one to enclose — and because the
 * file's own text is what labels it: the marker row is the top rail's label, the
 * duration row the bottom rail's, each appearing once. The rails run through the
 * middle of those rows and are cut behind them by the labels' own backgrounds, so
 * the box reads as running into its own text.
 *
 * The marker's own characters are kept, split into digit runs so the digits stay
 * white and the punctuation takes the dimension's colour. Anything typed after
 * the marker stays in the DOM untouched, links and emphasis included.
 */

import type { MarkdownPostProcessor, MarkdownPostProcessorContext } from "obsidian";

import { dimensionColorVars } from "../core/color";
import { dayKey, dayKeyFromName } from "../core/day";
import { formatClock, parseDurationLine } from "../core/duration";
import { parseMarkerPrefix } from "../core/entries";
import type WeaverPlugin from "../main";
import { appendDigitRuns } from "../ui/dcn";

/** Containers whose paragraphs must never be rewritten. */
const SKIP_SELECTOR = "blockquote, .callout, .markdown-embed, li, table, pre, code";

const PROCESSED = "data-weaver-entry-processed";
const HEAD_CLASS = "weaver-entry-head";
const TEXT_NODE = 3;

function durationElement(
  parsed: NonNullable<ReturnType<typeof parseDurationLine>>,
  d: number | null
): HTMLElement {
  const root = document.createElement("div");
  root.className = "weaver-duration";
  root.setAttribute(PROCESSED, "true");
  if (d !== null) root.setAttribute("style", dimensionColorVars(d));

  const sigil = document.createElement("span");
  sigil.className = "weaver-duration-sigil";
  sigil.textContent = parsed.sigil;
  root.appendChild(sigil);

  // The parser accepts only the canonical shape, so this re-renders the file's
  // own text: the digits stay white and the colons take the dimension's colour.
  formatClock(parsed.ms)
    .split(":")
    .forEach((part, index) => {
      if (index > 0) {
        const colon = document.createElement("span");
        colon.className = "weaver-duration-ink";
        colon.textContent = ":";
        root.appendChild(colon);
      }

      const span = document.createElement("span");
      span.className = "weaver-duration-num";
      span.textContent = part;
      root.appendChild(span);
    });

  return root;
}

/** Builds the post processor that frames entries in Reading view. */
export function createEntryProcessor(plugin: WeaverPlugin): MarkdownPostProcessor {
  return (element: HTMLElement, context: MarkdownPostProcessorContext): void => {
    const sourcePath = context.sourcePath ?? "";
    const basename = (sourcePath.split("/").pop() ?? "").replace(/\.md$/, "");

    const fileDay = dayKeyFromName(basename);
    const showLink =
      plugin.settings.entryDayLink && fileDay !== null && fileDay !== dayKey(new Date());

    // The nearest marker above a duration is simply the last one met, because
    // paragraphs arrive in document order.
    let depth: number | null = null;

    for (const paragraph of Array.from(element.querySelectorAll("p"))) {
      if (paragraph.getAttr(PROCESSED) !== null) continue;
      if (paragraph.closest(SKIP_SELECTOR) !== null) continue;

      const text = paragraph.textContent ?? "";

      const duration = parseDurationLine(text.trim());
      if (duration !== null) {
        // A duration paragraph on its own, with no frame to sit on — a stray
        // line, or one separated from its marker by something that is not a
        // paragraph — is drawn as the plain block it always was.
        paragraph.replaceWith(durationElement(duration, depth));
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

      if (showLink) {
        const link = document.createElement("span");
        link.className = "weaver-entry-daylink";
        link.textContent = ` - [[${basename}]]`;
        link.addEventListener("click", (event: Event) => {
          event.preventDefault();
          void plugin.app.workspace.openLinkText(basename, sourcePath, false);
        });
        head.appendChild(link);
      }

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
        const parsed = parseDurationLine((sibling.textContent ?? "").trim());
        if (parsed !== null) {
          const duration = durationElement(parsed, prefix.d);
          // Only inside a frame: a stray duration with no entry above it must not
          // paint a full-width band over the text it sits beside.
          duration.classList.add("weaver-frame-label");
          frame.appendChild(duration);
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
