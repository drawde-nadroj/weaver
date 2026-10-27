/**
 * The one place the product's words live.
 *
 * Glyphs mark events, not structure: a `✦` source line and a `✓` close line are
 * never headings and never enter the census as dimensions. `dimensionLabel` is
 * the only place the `1D…nD` numeral form exists, so a surface cannot invent a
 * second spelling.
 */

export const SPARK_GLYPH = "✦";
export const CLOSE_GLYPH = "✓";
export const RETURN_GLYPH = "↩";
export const NOTE_GLYPH = "▸";
export const WORDS_GLYPH = "❝";

/** `1` becomes `1D`, `12` becomes `12D`. */
export function dimensionLabel(level: number): string {
  return `${level}D`;
}
