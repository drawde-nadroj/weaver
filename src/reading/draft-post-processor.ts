import type { MarkdownPostProcessor } from "obsidian";

import { draftElapsed, draftId, parseDraftClose, parseDraftOpen } from "../core/drafts";
import type WeaverPlugin from "../main";
import {
  buildDraftBadge,
  DRAFT_BADGE_ID_ATTRIBUTE,
  DRAFT_CARD_CLASS,
  DRAFT_ELAPSED_SELECTOR
} from "../ui/draft-badge";

const PROCESSED_ATTRIBUTE = "data-weaver-processed";
const OPENED_ATTRIBUTE = "data-weaver-draft-opened";

/**
 * Structure a draft card must never swallow: leaving the block as plain text is
 * better than restyling a heading, table, callout, quote or embed.
 */
const SKIP_SELECTOR =
  "blockquote, .callout, .markdown-embed, table, h1, h2, h3, h4, h5, h6, .weaver-dimension";

const TICK_MS = 1000;

let ticker: number | null = null;

function stopTicker(): void {
  if (ticker === null) return;
  window.clearInterval(ticker);
  ticker = null;
}

/** One shared ticker refreshes every rendered card; it stops when none remain. */
function refreshCards(now: Date): void {
  const cards = Array.from(document.querySelectorAll<HTMLElement>(`.${DRAFT_CARD_CLASS}`));
  if (cards.length === 0) {
    stopTicker();
    return;
  }

  for (const card of cards) {
    const openedAt = card.getAttribute(OPENED_ATTRIBUTE);
    if (openedAt === null) continue;
    const cell = card.querySelector(DRAFT_ELAPSED_SELECTOR);
    if (cell instanceof HTMLElement) cell.setText(draftElapsed({ openedAt }, now));
  }
}

function ensureTicker(): void {
  if (ticker !== null) return;
  ticker = window.setInterval(() => refreshCards(new Date()), TICK_MS);
}

interface CollectedBlock {
  close: Element;
  nodes: Element[];
}

function collectBlock(marker: Element, id: string): CollectedBlock | null {
  const nodes: Element[] = [];
  let node: Element | null = marker.nextElementSibling;

  while (node !== null) {
    const current: Element = node;

    if (current.matches("p")) {
      const close = parseDraftClose(current.textContent ?? "");
      if (close !== null && draftId(close.level, close.ordinal) === id) {
        return { close: current, nodes };
      }
    }

    if (current.closest(SKIP_SELECTOR) !== null) return null;
    nodes.push(current);
    node = current.nextElementSibling;
  }

  return null;
}

/**
 * Turns a draft block into a card in Reading view.
 *
 * Only the two marker paragraphs are removed; the collected paragraphs are
 * moved, so inline links, emphasis and code inside a draft survive untouched.
 */
export function createDraftProcessor(plugin: WeaverPlugin): MarkdownPostProcessor {
  return (element: HTMLElement): void => {
    if (!plugin.settings.inPageDrafts) return;

    for (const paragraph of Array.from(element.querySelectorAll("p"))) {
      if (paragraph.getAttr(PROCESSED_ATTRIBUTE) !== null) continue;
      if (paragraph.closest(SKIP_SELECTOR) !== null) continue;
      // A marker already moved into a card is body text: drafts never nest.
      if (paragraph.closest(`.${DRAFT_CARD_CLASS}`) !== null) continue;

      const open = parseDraftOpen(paragraph.textContent ?? "");
      if (open === null) continue;

      const id = draftId(open.level, open.ordinal);
      const block = collectBlock(paragraph, id);
      if (block === null) continue;

      const parent = paragraph.parentElement;
      if (parent === null) continue;

      const doc = paragraph.ownerDocument ?? document;
      const card = doc.createElement("div");
      card.className = DRAFT_CARD_CLASS;
      card.setAttr(PROCESSED_ATTRIBUTE, "true");
      card.setAttr(DRAFT_BADGE_ID_ATTRIBUTE, id);
      card.setAttr(OPENED_ATTRIBUTE, open.openedAt);
      card.style.setProperty("--weaver-draft-color", `var(--weaver-h${open.level})`);

      const target = {
        id,
        level: open.level,
        ordinal: open.ordinal,
        openedAt: open.openedAt,
        title: (block.nodes[0]?.textContent ?? "").trim()
      };
      card.appendChild(buildDraftBadge(target, new Date(), plugin.drafts.badgeHandlers()));

      block.nodes.forEach((node, position) => {
        node.addClass(position === 0 ? "weaver-draft-title" : "weaver-draft-body");
        card.appendChild(node);
      });

      parent.insertBefore(card, paragraph);
      paragraph.remove();
      block.close.remove();

      ensureTicker();
    }
  };
}
