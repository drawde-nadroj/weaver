/**
 * How an invitation is named, in the words a writer reads.
 *
 * Kept out of the dock so the same strings serve the navigator, the notice and
 * the accessible labels: one invitation, one wording. Every label here is a
 * function of a frozen occurrence and the current instant, so a countdown can be
 * repainted without touching any other state.
 */

import { pad2 } from "../core/clock";
import type { PortalOccurrence } from "../core/portals";

/** One invitation as a surface shows it: the occurrence, and how near it is. */
export interface InvitationView {
  occurrence: PortalOccurrence;
  phase: "approaching" | "available";
}

/** The opening's own local hour and minute, `09:11`. */
export function openingTime(occurrence: PortalOccurrence): string {
  return `${pad2(occurrence.portal.hour)}:${pad2(occurrence.portal.minute)}`;
}

/**
 * `Opens in 09:30`, rounded up so a countdown never reads `00:00` before its
 * opening, or the empty string once it is open.
 */
export function countdownLabel(occurrence: PortalOccurrence, now: number): string {
  const seconds = Math.max(0, Math.ceil((occurrence.portal.opensAt - now) / 1000));
  if (seconds <= 0) return "Open now";
  return `Opens in ${pad2(Math.floor(seconds / 60))}:${pad2(seconds % 60)}`;
}

/** `09:11 · Spanish`: when it opens, and the destination it invites writing into. */
export function arrivalLabel(occurrence: PortalOccurrence, contextName?: string): string {
  const time = openingTime(occurrence);
  return contextName === undefined ? time : `${time} · ${contextName}`;
}

/** The schedule's own name, or a sentence when it has none. */
export function invitationName(occurrence: PortalOccurrence): string {
  return occurrence.name === "" ? "Invitation" : occurrence.name;
}
