/**
 * The return stack: where a jump came from.
 *
 * Every move the navigator makes — an append, a descend, a jump — pushes the
 * place it left, so `⌘[` can walk back through exactly the path taken. The stack
 * is session state, device-local, never written anywhere.
 *
 * Pure: no DOM, no editor, no clock.
 */

export interface Stop {
  /** The entry the caret was in, or `null` outside every entry. */
  n: number | null;
  caret: number;
  scroll: number;
}

/** How far back a day's wandering is remembered. */
export const STACK_LIMIT = 8;

/**
 * The stack with `stop` on top.
 *
 * Pushing where you already are is not a step: the same entry and the same caret
 * twice would make `⌘[` look broken. Past the limit the oldest stop falls off.
 */
export function pushStop(stops: readonly Stop[], stop: Stop, limit = STACK_LIMIT): Stop[] {
  const top = stops[stops.length - 1];
  if (top !== undefined && top.n === stop.n && top.caret === stop.caret) return [...stops];

  const next = [...stops, stop];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** The stack without its top, and the stop that was there. */
export function popStop(stops: readonly Stop[]): { stops: Stop[]; stop: Stop | null } {
  if (stops.length === 0) return { stops: [], stop: null };
  return { stops: stops.slice(0, -1), stop: stops[stops.length - 1] ?? null };
}
