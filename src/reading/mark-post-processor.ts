import type { MarkdownPostProcessor, MarkdownPostProcessorContext } from "obsidian";

import { parseCloseLine, parseSourceLine } from "../core/marks";

/** Containers whose paragraphs must never be rewritten. */
const SKIP_SELECTOR = "blockquote, .callout, .markdown-embed, li, table, pre, code";

// Its own marker, so it never depends on (or blocks) the deep-dimension pass.
const PROCESSED_ATTRIBUTE = "data-weaver-mark-processed";

/**
 * Styles a rendered mark line.
 *
 * A `✦` line becomes a chip and a `✓` line becomes muted text. Only a class is
 * added: the link inside a source line is Obsidian's, and rewriting a mark's
 * DOM would break clicking through to the source.
 */
export function createMarkProcessor(): MarkdownPostProcessor {
  return (element: HTMLElement, _context: MarkdownPostProcessorContext): void => {
    for (const paragraph of Array.from(element.querySelectorAll("p"))) {
      if (paragraph.getAttr(PROCESSED_ATTRIBUTE) !== null) continue;
      if (paragraph.closest(SKIP_SELECTOR) !== null) continue;

      const text = (paragraph.textContent ?? "").trim();
      if (text === "") continue;

      const close = parseCloseLine(text);
      if (close !== null) {
        paragraph.addClass("weaver-close-mark");
        paragraph.setAttr(PROCESSED_ATTRIBUTE, "true");
        paragraph.setAttr("aria-label", `Day closed at ${close}`);
        continue;
      }

      const source = parseSourceLine(text);
      if (source === null) continue;

      paragraph.addClass("weaver-mark");
      paragraph.setAttr(PROCESSED_ATTRIBUTE, "true");
      if (source.target !== null) {
        paragraph.setAttr("aria-label", `Sparked by ${source.label ?? source.target}`);
      }
    }
  };
}
