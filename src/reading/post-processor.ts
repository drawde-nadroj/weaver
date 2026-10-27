import type { MarkdownPostProcessor, MarkdownPostProcessorContext } from "obsidian";

import { parseClockPrefix } from "../core/clock";
import type WeaverPlugin from "../main";

/** Containers whose paragraphs must never be rewritten. */
const SKIP_SELECTOR = "blockquote, .callout, .markdown-embed, li, table";

const DEEP_HEADING_PARAGRAPH = /^(#{7,})(?:[ \t]+(.*))?$/;

const PROCESSED_ATTRIBUTE = "data-weaver-processed";
const TEXT_NODE = 3;

/**
 * Turns a `####### 17:02 - title` paragraph into a real heading element in
 * Reading view.
 *
 * Only the leading hash run is removed from the DOM, so inline links and
 * emphasis inside the heading survive. Anything unusual is left untouched
 * rather than losing content.
 */
export function createDeepHeadingProcessor(plugin: WeaverPlugin): MarkdownPostProcessor {
  return (element: HTMLElement, _context: MarkdownPostProcessorContext): void => {
    if (!plugin.settings.deepHeadingReadingView) return;

    const maxDepth = plugin.settings.maxDepth;
    const paragraphs = Array.from(element.querySelectorAll("p"));

    for (const paragraph of paragraphs) {
      if (paragraph.getAttr(PROCESSED_ATTRIBUTE) !== null) continue;
      if (paragraph.closest(SKIP_SELECTOR) !== null) continue;

      const text = paragraph.textContent ?? "";
      const match = DEEP_HEADING_PARAGRAPH.exec(text);
      if (match === null) continue;

      const level = (match[1] ?? "").length;
      if (level > maxDepth) continue;

      const titleText = match[2] ?? "";
      const firstChild = paragraph.firstChild;
      if (firstChild === null || firstChild.nodeType !== TEXT_NODE) continue;

      const strip = text.length - titleText.length;
      const leading = firstChild.textContent ?? "";
      if (leading.length < strip) continue;

      const clock = parseClockPrefix(titleText);

      const heading = document.createElement("div");
      heading.addClass("weaver-dimension", `weaver-h${level}`);
      heading.setAttr("role", "heading");
      heading.setAttr("aria-level", String(level));
      heading.setAttr("data-weaver-level", String(level));
      heading.setAttr(PROCESSED_ATTRIBUTE, "true");
      if (clock.time !== null) heading.setAttr("data-weaver-time", clock.time);
      heading.setAttr("data-weaver-title", clock.rest);

      firstChild.textContent = leading.slice(strip);
      while (paragraph.firstChild !== null) {
        heading.appendChild(paragraph.firstChild);
      }

      paragraph.replaceWith(heading);
    }
  };
}
