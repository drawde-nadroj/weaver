/**
 * The generated stylesheet: the five numbers a note is drawn with, and the two
 * emphasis colours. Nothing is generated per level — depth rides on the
 * `--weaver-d` custom property a line carries, so a deeper entry costs nothing.
 */

import { ANCHORS } from "../core/color";
import { isValidEntrySize, type WeaverSettings } from "../settings";

/** The id of the one `<style>` element the settings are injected into. */
export const STYLE_ID = "weaver-style";

/** The whole generated stylesheet for these settings. */
export function buildCss(settings: WeaverSettings): string {
  const size = isValidEntrySize(settings.entrySize) ? settings.entrySize.trim() : "1em";
  const indentMax = Math.max(1, Math.round(settings.indentMaxLevel));

  const variables = [
    `--weaver-entry-size: ${size};`,
    "--weaver-entry-line-height: 1.35;",
    `--weaver-indent-step: ${Math.max(0, Math.round(settings.indentStep))}px;`,
    `--weaver-indent-step-mobile: ${Math.max(0, Math.round(settings.mobileIndentStep))}px;`,
    `--weaver-indent-max-level: ${indentMax};`
  ];

  const rules = [
    `body {\n  ${variables.join("\n  ")}\n}`,
    // Unequal sizes step down with depth. Still one rule: `--weaver-d` carries
    // the depth, so nothing is generated per level.
    [
      "body.weaver-unequal .weaver-entry-head,",
      "body.weaver-unequal .weaver-entry-prose {",
      "  font-size: calc(var(--weaver-entry-size) * max(0.72, 1 - 0.04 * min(var(--weaver-d, 1) - 1, 6)));",
      "}"
    ].join("\n"),
    [
      "body:not(.weaver-no-emphasis) .markdown-rendered em,",
      "body:not(.weaver-no-emphasis) .cm-em {",
      `  color: ${ANCHORS[1]};`,
      "}",
      "body:not(.weaver-no-emphasis) .markdown-rendered strong,",
      "body:not(.weaver-no-emphasis) .cm-strong {",
      `  color: ${ANCHORS[0]};`,
      "}"
    ].join("\n")
  ];

  return `${rules.join("\n\n")}\n`;
}

/**
 * Writes the stylesheet into a single `<style>` element in `<head>`. Reusing one
 * element keeps the DOM stable across settings changes.
 */
export function applyCss(settings: WeaverSettings): void {
  const existing = document.getElementById(STYLE_ID);
  const style = existing instanceof HTMLStyleElement ? existing : document.createElement("style");

  if (style !== existing) {
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }

  style.textContent = buildCss(settings);
}

/** Removes the injected stylesheet on unload. */
export function removeCss(): void {
  document.getElementById(STYLE_ID)?.remove();
}
