/** Local openings are epoch instants, so daylight-saving gaps and repeats stay real. */
import { dayKey } from "./day";

/** The local facts of an opening, frozen independently of later timezone changes. */
export interface PortalInstant {
  id: string;
  opensAt: number;
  day: string;
  hour: number;
  minute: number;
  offsetMinutes: number;
}

/** Exact-second recognitions, never targets or snapped input times. */
export type AlignmentKind = "boundary" | "hour-echo" | "minute-echo";

/** Enumerates eligible actual local minutes in inclusive epoch bounds. */
export function portalInstants(fromMs: number, toMs: number): PortalInstant[] {
  const result: PortalInstant[] = [];
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return result;
  for (let at = Math.ceil(fromMs / 60000) * 60000; at <= toMs; at += 60000) {
    const date = new Date(at);
    const hour = date.getHours();
    const minute = date.getMinutes();
    if (minute % 11 !== 0 && minute !== hour) continue;
    result.push({ id: date.toISOString(), opensAt: at, day: dayKey(date), hour, minute,
      offsetMinutes: -date.getTimezoneOffset() });
  }
  return result;
}

/** Returns every coincident recognition in the opening's original minute. */
export function portalAlignments(portal: PortalInstant, beganAt: number): readonly AlignmentKind[] {
  const second = Math.floor(beganAt / 1000) - portal.opensAt / 1000;
  const result: AlignmentKind[] = [];
  if (second === 0) result.push("boundary");
  if (second === portal.hour) result.push("hour-echo");
  if (second === portal.minute) result.push("minute-echo");
  return result;
}

/** Preparation extends the open minute, never unlocks it early. */
export function portalPhase(portal: PortalInstant, now: number, held: boolean): "approaching" | "open" | "held" | "expired" {
  if (now < portal.opensAt) return "approaching";
  if (now < portal.opensAt + 60000) return "open";
  return held ? "held" : "expired";
}
