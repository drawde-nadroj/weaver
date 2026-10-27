import type { WeaverSettings } from "../settings";
import { paletteCss } from "../core/palette";

export const PALETTE_STYLE_ID = "weaver-palette";

/**
 * Writes the generated palette into a single `<style>` element in `<head>`.
 * Reusing one element keeps the DOM stable across settings changes.
 */
export function applyPalette(settings: WeaverSettings, palette: string[]): void {
  const existing = document.getElementById(PALETTE_STYLE_ID);
  const style = existing instanceof HTMLStyleElement ? existing : document.createElement("style");

  if (style !== existing) {
    style.id = PALETTE_STYLE_ID;
    document.head.appendChild(style);
  }

  style.textContent = paletteCss(settings, palette);
}

export function removePalette(): void {
  document.getElementById(PALETTE_STYLE_ID)?.remove();
}
