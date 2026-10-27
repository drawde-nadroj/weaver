import { Notice } from "obsidian";

import { draftElapsed } from "../core/drafts";
import { dimensionLabel } from "../core/vocabulary";
import { NOTICE_NOOP_MS, noticeDraftCopied } from "../notices";

/** The fields a badge needs; a `DraftBlock` satisfies this structurally. */
export interface DraftBadgeTarget {
  id: string;
  level: number;
  ordinal: number;
  openedAt: string;
  title: string;
}

/** What a badge can do. `maxDepth` lives here so the builder needs no plugin. */
export interface DraftBadgeHandlers {
  maxDepth: number;
  onWeave(id: string): void;
  onDiscard(id: string): void;
  onLevel(id: string, level: number): void;
}

export const DRAFT_BADGE_ID_ATTRIBUTE = "data-weaver-draft-id";
export const DRAFT_ELAPSED_CLASS = "weaver-draft-elapsed";
export const DRAFT_ELAPSED_SELECTOR = `.${DRAFT_ELAPSED_CLASS}`;

export const DRAFT_BADGE_CLASS = "weaver-draft-badge";
export const DRAFT_CARD_CLASS = "weaver-draft";

function copyText(text: string): void {
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (clipboard === undefined || typeof clipboard.writeText !== "function") return;
  void clipboard.writeText(text).catch(() => undefined);
}

/** Rewrites the elapsed cell, so a ticking caller can avoid rebuilding. */
export function refreshDraftElapsed(root: HTMLElement, draft: DraftBadgeTarget, now: Date): void {
  const cell = root.querySelector(DRAFT_ELAPSED_SELECTOR);
  if (cell instanceof HTMLElement) cell.setText(draftElapsed(draft, now));
}

/**
 * The one badge used by Live Preview and Reading view: a clickable, speakable
 * draft id, when it opened, how long ago that was, a level stepper, Weave and
 * discard. Colours come from the level, via `--weaver-h{n}`.
 */
export function buildDraftBadge(
  draft: DraftBadgeTarget,
  now: Date,
  handlers: DraftBadgeHandlers
): HTMLElement {
  const badge = document.createElement("div");
  badge.className = DRAFT_BADGE_CLASS;
  badge.setAttr(DRAFT_BADGE_ID_ATTRIBUTE, draft.id);
  badge.style.setProperty("--weaver-draft-color", `var(--weaver-h${draft.level})`);

  const head = badge.createDiv({ cls: "weaver-draft-head" });

  const idButton = head.createEl("button", { cls: "weaver-draft-id", text: `draft ${draft.id}` });
  idButton.setAttr("aria-label", `Copy draft ${draft.id}`);
  idButton.addEventListener("click", () => {
    copyText(`draft ${draft.id}`);
    new Notice(noticeDraftCopied(draft.id), NOTICE_NOOP_MS);
  });

  head.createSpan({ cls: "weaver-draft-opened", text: openedClock(draft) });
  head.createSpan({ cls: DRAFT_ELAPSED_CLASS, text: draftElapsed(draft, now) });

  const actions = badge.createDiv({ cls: "weaver-draft-actions" });

  const stepper = actions.createDiv({ cls: "weaver-draft-stepper" });
  const decrease = stepper.createEl("button", { text: "−", cls: "weaver-stepper-button" });
  decrease.setAttr("aria-label", "Decrease draft level");
  decrease.disabled = draft.level <= 1;
  decrease.addEventListener("click", () => handlers.onLevel(draft.id, draft.level - 1));

  stepper.createSpan({ cls: "weaver-draft-level", text: dimensionLabel(draft.level) });

  const increase = stepper.createEl("button", { text: "+", cls: "weaver-stepper-button" });
  increase.setAttr("aria-label", "Increase draft level");
  increase.disabled = draft.level >= handlers.maxDepth;
  increase.addEventListener("click", () => handlers.onLevel(draft.id, draft.level + 1));

  const weave = actions.createEl("button", {
    text: "Weave",
    cls: "weaver-draft-weave mod-cta"
  });
  weave.addEventListener("click", () => handlers.onWeave(draft.id));

  const discard = actions.createEl("button", { text: "×", cls: "weaver-draft-discard" });
  discard.setAttr("aria-label", "Discard draft");
  discard.addEventListener("click", () => handlers.onDiscard(draft.id));

  return badge;
}

/** The marker's own clock, `HH:mm:ss`. */
function openedClock(draft: DraftBadgeTarget): string {
  const space = draft.openedAt.indexOf(" ");
  return space < 0 ? draft.openedAt : draft.openedAt.slice(space + 1);
}
