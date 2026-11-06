/**
 * Invitations: when Weaver may offer to weave, and which offer is outstanding.
 *
 * A portal is only ever a *time*. Every instant here is an epoch millisecond, so
 * a daylight-saving gap has no occurrence at all and a repeated hour has two
 * distinct ones; the frozen local facts a `PortalInstant` carries exist so a
 * record can say "22:55, at −08:00" long after the machine has travelled.
 *
 * Two schedule shapes share that arithmetic. The built-in rhythm is the local
 * minutes the day has always offered — every :00, :11, :22, :33, :44 and :55,
 * plus each mirrored HH:HH. Configured schedules are explicit: an hourly minute,
 * selected weekdays at a time, or one instant.
 *
 * Occurrences are computed from *local calendar days*, not by scanning every
 * minute since an activation: a schedule enabled a month ago has one outstanding
 * invitation, not forty thousand candidates. The window a caller asks for is
 * bounded to the last fifteen local days for weekly schedules (a weekly opening
 * can be skipped entirely by a daylight-saving gap), the current and previous
 * local day for hourly ones, and the instant itself for a one-off.
 *
 * Pure: no DOM, no `obsidian`, no clock of its own.
 */

import { pad2 } from "./clock";
import { dayKey } from "./day";
import { isPlainObject } from "./value";

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

/** The id the built-in rhythm is stored under; no schedule may reuse it. */
export const RHYTHM_SCHEDULE_ID = "rhythm";

/** The lead the rhythm has always had: eleven minutes of notice. */
export const DEFAULT_LEAD_MINUTES = 11;

/** How far back a weekly schedule is examined, in local days. */
const WEEKLY_LOOKBACK_DAYS = 15;

/** A day, as the wall clock counts one. Local day arithmetic is not fixed. */
const DAY_MS = 86_400_000;

/** When a configured schedule recurs. */
export type PortalWhen =
  /** Every hour at `minute`, on the device's current local wall clock. */
  | { kind: "hourly"; minute: number }
  /** Selected weekdays at `hour:minute`; all seven days express daily. */
  | { kind: "weekly"; weekdays: number[]; hour: number; minute: number }
  /** One definite instant, chosen when the schedule was saved. */
  | { kind: "once"; at: number };

/** One configured invitation. */
export interface PortalSchedule {
  id: string;
  name: string;
  /** The destination it invites writing into. */
  contextId: string;
  enabled: boolean;
  /** When it was created; an occurrence before activation is never offered. */
  createdAt: number;
  /** Minutes of notice before the opening, 0–60. */
  leadMinutes: number;
  when: PortalWhen;
}

/**
 * One thing that can offer an invitation: a configured schedule, or the
 * built-in rhythm.
 *
 * The rhythm is not a `PortalSchedule` — its minutes are not any single
 * recurrence shape — so both are described here as a source, and every
 * computation below takes one. That is what lets one dock list them together.
 */
export interface PortalSource {
  /** `rhythm`, or a configured schedule's id. */
  id: string;
  name: string;
  contextId: string;
  leadMinutes: number;
  createdAt: number;
  /** The configured recurrence, or null for the built-in rhythm. */
  schedule: PortalSchedule | null;
}

/** One offering of one schedule: the fact a composer freezes. */
export interface PortalOccurrence {
  /** `${scheduleId}@${portal.id}`: the occurrence, not just the minute. */
  id: string;
  scheduleId: string;
  contextId: string;
  name: string;
  portal: PortalInstant;
}

/** A schedule's state now: approaching, open, or gone past its minute. */
export type PortalPhase = "approaching" | "available" | "expired";

/** How long an opening accepts a beginning: its own minute, and nothing after. */
export const OPENING_WINDOW_MS = 60_000;

/** One raw stored schedule, and why it could not be used when it could not. */
export interface PortalScheduleError {
  index: number | null;
  message: string;
}

/** The usable schedules and every reason the rest were not. */
export interface PortalScheduleRead {
  valid: PortalSchedule[];
  errors: PortalScheduleError[];
}

/** Local midnight at the start of the day containing `at`. */
function localDayStart(at: number): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0).getTime();
}

/** The next local midnight after `at`, so a 23- or 25-hour day is one day. */
function nextLocalDayStart(at: number): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0).getTime();
}

/**
 * Every actual instant `hour:minute` occurs on the day containing `midnight`.
 *
 * Empty when that local minute does not exist — a daylight-saving gap skips it
 * outright, and there is nothing to offer. *Two* entries when the hour repeats:
 * a fold is two real instants with one wall clock, and each is its own opening,
 * which is why the neighbourhood is probed rather than a single constructor
 * trusted.
 */
function localMinutesOn(midnight: number, hour: number, minute: number): number[] {
  const date = new Date(midnight);
  const base = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0).getTime();
  const result: number[] = [];

  for (const delta of [-3_600_000, 0, 3_600_000]) {
    const at = base + delta;
    const probe = new Date(at);
    if (probe.getHours() !== hour || probe.getMinutes() !== minute) continue;
    if (!result.includes(at)) result.push(at);
  }

  return result;
}

/** One opening, with the local facts frozen as they were at that instant. */
export function portalAt(opensAt: number): PortalInstant {
  const date = new Date(opensAt);
  return {
    id: date.toISOString(),
    opensAt,
    day: dayKey(date),
    hour: date.getHours(),
    minute: date.getMinutes(),
    offsetMinutes: -date.getTimezoneOffset()
  };
}

/**
 * The built-in rhythm's minutes: every :00, :11, :22, :33, :44 and :55, and each
 * mirrored HH:HH — so 13:13 is an opening and 13:14 is not.
 */
function rhythmMinutes(): { hour: number; minute: number }[] {
  const minutes: { hour: number; minute: number }[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    for (let minute = 0; minute < 60; minute += 1) {
      if (minute % 11 !== 0 && minute !== hour) continue;
      minutes.push({ hour, minute });
    }
  }
  return minutes;
}

/** Every minute a schedule asks for on a chosen local day. */
function minutesOf(when: PortalWhen): { hour: number; minute: number }[] {
  switch (when.kind) {
    case "hourly":
      return Array.from({ length: 24 }, (_, hour) => ({ hour, minute: when.minute }));
    case "weekly":
      return [{ hour: when.hour, minute: when.minute }];
    case "once":
      return [];
  }
}

/**
 * Every actual local opening of `when` inside `[from, to]`, earliest first.
 *
 * The window is walked by local calendar day, so a 23- or 25-hour day costs the
 * same as any other and a skipped minute simply produces nothing.
 */
export function occurrencesBetween(
  when: PortalWhen,
  from: number,
  to: number
): PortalInstant[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];

  if (when.kind === "once") {
    return when.at >= from && when.at <= to ? [portalAt(when.at)] : [];
  }

  const minutes = minutesOf(when);
  const result: PortalInstant[] = [];
  let midnight = localDayStart(from);

  while (midnight <= to) {
    const weekday = new Date(midnight).getDay();
    const selected =
      when.kind === "hourly" || when.weekdays.length === 0 || when.weekdays.includes(weekday);

    if (selected) {
      for (const { hour, minute } of minutes) {
        for (const at of localMinutesOn(midnight, hour, minute)) {
          if (at < from || at > to) continue;
          result.push(portalAt(at));
        }
      }
    }

    midnight = nextLocalDayStart(midnight);
  }

  return result;
}

/**
 * The built-in rhythm's openings in `[from, to]`.
 *
 * It is a schedule like any other: `rhythm:00`, `rhythm:11` and so on, so a day
 * with no configured schedules still offers the rhythm it always has.
 */
export function rhythmOccurrences(from: number, to: number): PortalInstant[] {
  const minutes = rhythmMinutes();
  const result: PortalInstant[] = [];
  let midnight = localDayStart(from);

  while (midnight <= to) {
    for (const { hour, minute } of minutes) {
      for (const at of localMinutesOn(midnight, hour, minute)) {
        if (at < from || at > to) continue;
        result.push(portalAt(at));
      }
    }
    midnight = nextLocalDayStart(midnight);
  }

  return result;
}

/** The local facts of an opening, `HH:MM`, for a label. */
export function portalTime(portal: PortalInstant): string {
  return `${pad2(portal.hour)}:${pad2(portal.minute)}`;
}

/**
 * Whether `beganAt` falls inside the opening's own minute.
 *
 * This is the whole eligibility rule for an entry: writing that *begins* in
 * `[opensAt, opensAt + 60s)` was written through the opening, and finishing it
 * afterwards changes nothing. A draft begun before the opening, or after it has
 * closed, is ordinary writing and gets no record — the rule is about the first
 * committed input, not about when a writer got around to saving.
 */
export function portalContainsBeginning(portal: PortalInstant, beganAt: number): boolean {
  return portal.opensAt <= beganAt && beganAt < portal.opensAt + OPENING_WINDOW_MS;
}

/**
 * The phase an opening is in now.
 *
 * `approaching` is any time before the minute; `available` is the opening's own
 * minute; `expired` is everything after it. An invitation is not a permission
 * that waits to be used — a minute that went by unentered is gone, and the next
 * opening is a different one. Whether an approaching opening is close enough to
 * show is the schedule's lead, which the controller applies.
 */
export function portalPhase(portal: PortalInstant, now: number): PortalPhase {
  if (now < portal.opensAt) return "approaching";
  return portalContainsBeginning(portal, now) ? "available" : "expired";
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

/** How far back a source's occurrences are looked for, in local days. */
function lookbackFor(source: PortalSource): number {
  const when = source.schedule?.when;
  if (when === undefined) return 1;
  // A weekly opening can fall in a daylight-saving gap, so a single skipped week
  // must not hide the previous one.
  if (when.kind === "weekly") return WEEKLY_LOOKBACK_DAYS;
  if (when.kind === "hourly") return 2;
  return 1;
}

/** Every opening a source produces in `[from, to]`, earliest first. */
export function sourceOccurrences(source: PortalSource, from: number, to: number): PortalInstant[] {
  return source.schedule === null
    ? rhythmOccurrences(from, to)
    : occurrencesBetween(source.schedule.when, from, to);
}

/**
 * The newest opening of a source that is open right now and this device has not
 * answered.
 *
 * The window starts at the later of the source's activation and the last
 * acknowledgement, so enabling a schedule never replays a month of openings and
 * answering one opening never hides the next. Occurrences are enumerated over
 * recent local days rather than every minute since activation, and a candidate
 * whose minute has already gone by is not due: a missed opening produces no
 * invitation, no notice and no backfill on wake or restart.
 */
export function dueOpening(
  source: PortalSource,
  now: number,
  activatedAt: number,
  acknowledgedThrough: number | null
): PortalInstant | null {
  const floor = Math.max(activatedAt, (acknowledgedThrough ?? 0) + 1);
  if (now < floor) return null;

  const from = Math.max(floor, now - lookbackFor(source) * DAY_MS);
  const candidates = sourceOccurrences(source, from, now).filter((portal) =>
    portalContainsBeginning(portal, now)
  );
  return candidates[candidates.length - 1] ?? null;
}

/** The next opening at or after `now`, for a source that says when it recurs. */
export function nextOpening(source: PortalSource, now: number): PortalInstant | null {
  const horizon = now + lookbackFor(source) * DAY_MS;
  const candidates = sourceOccurrences(source, now, horizon);
  return candidates[0] ?? null;
}

/** A schedule's identity for a cache that must notice any change to it. */
export function scheduleKey(schedule: PortalSchedule): string {
  return `${schedule.id}|${schedule.enabled}|${schedule.contextId}|${schedule.leadMinutes}|${JSON.stringify(schedule.when)}`;
}

/** A weekday from a raw value, or null when it is not one. */
function readWeekday(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6
    ? value
    : null;
}

/** A whole number inside a range, or null. */
function bounded(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

/** Reads `when`, or says what is wrong with it. */
function readWhen(value: unknown): { ok: true; when: PortalWhen } | { ok: false; error: string } {
  if (!isPlainObject(value)) return { ok: false, error: "`when` must describe a recurrence" };

  const kind = value["kind"];
  if (kind === "hourly") {
    const minute = bounded(value["minute"], 0, 59);
    if (minute === null) return { ok: false, error: "an hourly schedule needs a minute from 0 to 59" };
    return { ok: true, when: { kind: "hourly", minute } };
  }

  if (kind === "weekly") {
    const raw = Array.isArray(value["weekdays"]) ? value["weekdays"] : [];
    const weekdays: number[] = [];
    for (const entry of raw) {
      const weekday = readWeekday(entry);
      if (weekday === null) return { ok: false, error: "a weekday must be 0 (Sunday) to 6 (Saturday)" };
      if (!weekdays.includes(weekday)) weekdays.push(weekday);
    }
    if (weekdays.length === 0) return { ok: false, error: "a weekly schedule needs at least one day" };

    const hour = bounded(value["hour"], 0, 23);
    const minute = bounded(value["minute"], 0, 59);
    if (hour === null || minute === null) {
      return { ok: false, error: "a weekly schedule needs a whole hour and minute" };
    }
    return { ok: true, when: { kind: "weekly", weekdays: weekdays.sort(), hour, minute } };
  }

  if (kind === "once") {
    const at = value["at"];
    if (typeof at !== "number" || !Number.isFinite(at)) {
      return { ok: false, error: "a one-off schedule needs the instant it happens" };
    }
    return { ok: true, when: { kind: "once", at } };
  }

  return { ok: false, error: "`when.kind` must be hourly, weekly or once" };
}

/** Reads one raw schedule row, or says why it is not one. */
function readSchedule(
  raw: unknown
): { ok: true; schedule: PortalSchedule } | { ok: false; error: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "a schedule must be an object with a name, a destination and a recurrence" };
  }

  const id = typeof raw["id"] === "string" ? raw["id"].trim() : "";
  if (id === "") return { ok: false, error: "a schedule needs an id" };
  if (id === RHYTHM_SCHEDULE_ID) {
    return { ok: false, error: `the id \`${RHYTHM_SCHEDULE_ID}\` is reserved for the built-in rhythm` };
  }

  const name = typeof raw["name"] === "string" ? raw["name"].trim() : "";
  if (name === "" || name.length > 60) {
    return { ok: false, error: "a schedule needs a name of one to sixty characters" };
  }

  const contextId = typeof raw["contextId"] === "string" ? raw["contextId"].trim() : "";
  if (contextId === "") return { ok: false, error: "a schedule needs a destination" };

  const when = readWhen(raw["when"]);
  if (!when.ok) return when;

  if (when.when.kind === "once") {
    // A one-off is an instant the writer chose; a nonexistent local time can
    // only come from a hand edit, and is refused rather than normalised.
    const at = when.when.at;
    if (!Number.isFinite(new Date(at).getTime())) {
      return { ok: false, error: "that one-off needs a real date and time" };
    }
    // An opening is a whole minute — that is what a record's `portal` names and
    // what the beginning is measured against — so a one-off inside a minute is
    // refused rather than snapped to one.
    if (at % OPENING_WINDOW_MS !== 0) {
      return { ok: false, error: "that one-off needs to start on a whole minute" };
    }
  }

  const createdAt = typeof raw["createdAt"] === "number" && Number.isFinite(raw["createdAt"])
    ? raw["createdAt"]
    : 0;
  const leadMinutes = bounded(raw["leadMinutes"], 0, 60) ?? DEFAULT_LEAD_MINUTES;

  return {
    ok: true,
    schedule: {
      id,
      name,
      contextId,
      enabled: raw["enabled"] !== false,
      createdAt,
      leadMinutes,
      when: when.when
    }
  };
}

/**
 * The usable schedules, and every row that is not one.
 *
 * Nothing unvalidated becomes an invitation. A row is refused, with its reason,
 * when it has no id, reuses the rhythm's, has no name or destination, or
 * describes a recurrence the calendar cannot produce.
 */
export function readPortalSchedules(value: unknown): PortalScheduleRead {
  const valid: PortalSchedule[] = [];
  const errors: PortalScheduleError[] = [];

  if (value === undefined || value === null) return { valid, errors };
  if (!Array.isArray(value)) {
    return {
      valid,
      errors: [{ index: null, message: "the stored schedules are not a list; reset them before adding one" }]
    };
  }

  const ids = new Set<string>();
  value.forEach((raw, index) => {
    const parsed = readSchedule(raw);
    if (!parsed.ok) {
      errors.push({ index, message: parsed.error });
      return;
    }
    if (ids.has(parsed.schedule.id)) {
      errors.push({ index, message: `the id ${JSON.stringify(parsed.schedule.id)} is used twice` });
      return;
    }
    ids.add(parsed.schedule.id);
    valid.push(parsed.schedule);
  });

  return { valid, errors };
}
