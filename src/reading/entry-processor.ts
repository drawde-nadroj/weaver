/**
 * Reading view: the same entry the editor draws.
 *
 * The marker paragraph becomes the head element and the duration paragraph
 * becomes the duration element. Nothing is wrapped and no nesting is introduced,
 * so margins do not move and inline markup inside the prose survives untouched.
 */

import type { MarkdownPostProcessor, MarkdownPostProcessorContext } from "obsidian";

import { dimensionColorVars } from "../core/color";
import { dayKey, dayKeyFromName } from "../core/day-note";
import { formatClock, parseDurationLine } from "../core/duration";
import { parseMarkerPrefix } from "../core/entries";
import type WeaverPlugin from "../main";

/** Containers whose paragraphs must never be rewritten. */
const SKIP_SELECTOR = "blockquote, .callout, .markdown-embed, li, table";

const PROCESSED = "data-weaver-entry-processed";
const HEAD_CLASS = "weaver-entry-head";
const TEXT_NODE = 3;
const DIGITS = /^\d+$/;

/** Digits white, punctuation in the entry's colour. */
function appendDigitRuns(parent: HTMLElement, text: string): void {
  for (const part of text.split(/(\d+)/)) {
    if (part === "") continue;
    const span = document.createElement("span");
    span.className = DIGITS.test(part) ? "weaver-dcn-num" : "weaver-dcn-ink";
    span.textContent = part;
    parent.appendChild(span);
  }
}

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

/** The closest head above `element`, which is where its depth comes from. */
function nearestHeadDepth(element: Element): number | null {
  let sibling = element.previousElementSibling;
  while (sibling !== null) {
    if (sibling.classList.contains(HEAD_CLASS)) {
      const raw = sibling.getAttribute("data-weaver-d");
      return raw === null ? null : Number.parseInt(raw, 10);
    }
    sibling = sibling.previousElementSibling;
  }
  return null;
}

export function createEntryProcessor(plugin: WeaverPlugin): MarkdownPostProcessor {
  return (element: HTMLElement, context: MarkdownPostProcessorContext): void => {
    const sourcePath = context.sourcePath ?? "";
    const basename = (sourcePath.split("/").pop() ?? "").replace(/\.md$/, "");

    const fileDay = dayKeyFromName(basename);
    const showLink =
      plugin.settings.entryDayLink && fileDay !== null && fileDay !== dayKey(new Date());

    for (const paragraph of Array.from(element.querySelectorAll("p"))) {
      if (paragraph.getAttr(PROCESSED) !== null) continue;
      if (paragraph.closest(SKIP_SELECTOR) !== null) continue;

      const text = paragraph.textContent ?? "";

      const duration = parseDurationLine(text.trim());
      if (duration !== null) {
        paragraph.replaceWith(durationElement(duration, nearestHeadDepth(paragraph)));
        continue;
      }

      const prefix = parseMarkerPrefix(text);
      if (prefix === null) continue;

      const head = document.createElement("div");
      head.className = HEAD_CLASS;
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

      // Only the marker characters leave the DOM; a title written after the
      // clock, with its links and emphasis, stays exactly as Obsidian made it.
      const first = paragraph.firstChild;
      const firstText = first?.textContent ?? "";
      if (first !== null && first.nodeType === TEXT_NODE && firstText.startsWith(text.slice(0, prefix.length))) {
        first.textContent = firstText.slice(prefix.length);
      }

      while (paragraph.firstChild !== null) head.appendChild(paragraph.firstChild);
      paragraph.replaceWith(head);

      let sibling = head.nextElementSibling;
      while (sibling !== null) {
        if (sibling.classList.contains(HEAD_CLASS)) break;
        if (sibling.tagName === "P" && parseDurationLine((sibling.textContent ?? "").trim()) !== null) break;

        sibling.classList.add("weaver-entry-prose");
        sibling.setAttribute("style", dimensionColorVars(prefix.d));
        sibling = sibling.nextElementSibling;
      }
    }
  };
}
