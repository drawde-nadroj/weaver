import type { MarkdownPostProcessor, MarkdownPostProcessorContext } from "obsidian";

import { CLOSE_MARK } from "../core/close";

/** Containers whose paragraphs must never be rewritten. */
const SKIP_SELECTOR = "blockquote, .callout, .markdown-embed, li, table, pre, code";

const PROCESSED_ATTRIBUTE = "data-weaver-close-processed";

/**
 * Styles the rendered closing mark.
 *
 * Only a class and a label are added: the text is the record, and rewriting it
 * would lose the fact that it is a line in the note.
 */
export function createCloseProcessor(): MarkdownPostProcessor {
  return (element: HTMLElement, _context: MarkdownPostProcessorContext): void => {
    for (const paragraph of Array.from(element.querySelectorAll("p"))) {
      if (paragraph.getAttr(PROCESSED_ATTRIBUTE) !== null) continue;
      if (paragraph.closest(SKIP_SELECTOR) !== null) continue;

      const text = (paragraph.textContent ?? "").trim();
      const match = CLOSE_MARK.exec(text);
      if (match === null) continue;

      paragraph.addClass("weaver-close-mark");
      paragraph.setAttr(PROCESSED_ATTRIBUTE, "true");
      paragraph.setAttr("aria-label", `Day closed at ${match[1] ?? ""}`);
    }
  };
}
