/**
 * `D.C.N` as digits and punctuation: the digits stay white and the separators
 * take the entry's own colour, exactly as the marker reads in the note.
 *
 * Shared by the travel card and the entry palette — two cards, one grammar.
 */

const DIGITS = /^\d+$/;

export function appendDigitRuns(parent: HTMLElement, text: string): void {
  for (const part of text.split(/(\d+)/)) {
    if (part === "") continue;
    const span = document.createElement("span");
    span.className = DIGITS.test(part) ? "weaver-dcn-num" : "weaver-dcn-ink";
    span.textContent = part;
    parent.appendChild(span);
  }
}
