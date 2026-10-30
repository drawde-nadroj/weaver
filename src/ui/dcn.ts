/**
 * The digit-and-ink grammar: `D.C.N`, the clock row and the date label all split
 * the same way — digits in the note's own text colour, punctuation in the
 * dimension's.
 *
 * Shared by the navigator, the Live Preview frames and the Reading-view frame —
 * one grammar, every surface. The marker's hyphen is punctuation like every other
 * separator, because on a framed surface the whole marker is the top rail's label
 * and its background cuts the rail; there is no character that belongs to the box
 * instead of the text.
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

/**
 * Splits an `HH:MM:SS` clock into digit runs and separator runs inside `parent`:
 * each colon is `.weaver-duration-ink` (the dimension's colour), each digit run
 * `.weaver-duration-num` (the note's own text colour). Returns the digit spans in
 * order, so a ticking clock can write into them.
 */
export function appendClockRuns(parent: HTMLElement, clock: string): HTMLElement[] {
  const spans: HTMLElement[] = [];

  clock.split(":").forEach((part, index) => {
    if (index > 0) {
      const colon = document.createElement("span");
      colon.className = "weaver-duration-ink";
      colon.textContent = ":";
      parent.appendChild(colon);
    }

    const span = document.createElement("span");
    span.className = "weaver-duration-num";
    span.textContent = part;
    parent.appendChild(span);
    spans.push(span);
  });

  return spans;
}
