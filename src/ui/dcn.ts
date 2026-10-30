/**
 * `D.C.N` as digits and punctuation: the digits stay white and the separators
 * take the entry's own colour, exactly as the marker reads in the note.
 *
 * Shared by the navigator and the Reading-view frame — one grammar, two surfaces.
 * The marker's hyphen is punctuation like every other separator, because on a
 * framed surface the whole marker is the top rail's label and its background
 * cuts the rail; there is no character that belongs to the box instead of the
 * text.
 */

const DIGITS = /^\d+$/;

/** The class digits carry: the note's own text colour. */
export const NUM_CLASS = "weaver-dcn-num";
/** The class punctuation carries: the dimension's colour. */
export const INK_CLASS = "weaver-dcn-ink";

/** A piece of `D.C.N`: its text, and the class it carries. */
export interface Slice {
  text: string;
  cls: string;
}

/**
 * The runs a marker is drawn in: digits white, punctuation coloured. Pure, so the
 * editor's decoration set and the Reading view build the same runs from the same
 * rule.
 */
export function markerSlices(text: string): Slice[] {
  return text
    .split(/(\d+)/)
    .filter((part) => part !== "")
    .map((part) => ({ text: part, cls: DIGITS.test(part) ? NUM_CLASS : INK_CLASS }));
}

/** Splits `D.C.N` into digit runs and separators inside `parent`. */
export function appendDigitRuns(parent: HTMLElement, text: string): void {
  for (const slice of markerSlices(text)) {
    const span = document.createElement("span");
    span.className = slice.cls;
    span.textContent = slice.text;
    parent.appendChild(span);
  }
}
