/**
 * The list cursor shared by the Tapestry's pointer surfaces.
 *
 * The pointer mode walks rows with a keyboard cursor; the touch mode has none.
 * Keeping the index arithmetic here means both modes render from one state and
 * the keyboard rules are stated once.
 */

/** The lists that own a cursor. */
export type CursorSection = "drafts" | "headings" | "threads";

/** An index into one list, clamped and moved without touching the DOM. */
export class ListCursor {
  constructor(public index = 0) {}

  /** Keeps the index inside a list that may have shrunk. */
  clamp(length: number): number {
    this.index = length <= 0 ? 0 : Math.max(0, Math.min(this.index, length - 1));
    return this.index;
  }

  /** Wraps, so walking past the last row returns to the first. */
  move(delta: number, length: number): number {
    if (length <= 0) return 0;
    this.index = (this.index + delta + length) % length;
    return this.index;
  }

  first(): number {
    this.index = 0;
    return this.index;
  }

  /** `Infinity` clamps to the last row. */
  last(length: number): number {
    this.index = Math.max(0, length - 1);
    return this.index;
  }

  select(value: number, length: number): number {
    this.index = value;
    return this.clamp(length);
  }

  reset(): void {
    this.index = 0;
  }
}
