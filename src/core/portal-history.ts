/**
 * The day's portal history, as rows a surface can list.
 *
 * Two kinds of fact share one chronology. A recorded row is something that
 * really happened: a note's `weaver-alignments` record, its original local
 * opening and beginning preserved, and its alignments recomputed from those
 * frozen facts rather than from the machine's current timezone. An opening row
 * is only a schedule: an eligible local minute that no record in this note has
 * claimed. Schedule rows are reconstructed on demand and never written.
 *
 * The default view is deliberately small — what is approaching or open now,
 * plus the most recent opportunity that has passed — while `showAll` lays out
 * the whole local day. "Passed" means the opening minute elapsed; it never
 * claims that a notice was delivered or that someone chose to ignore it.
 *
 * Nothing here reads or writes the vault. It parses the note it is given and
 * returns rows, or the reason the note's history could not be read at all.
 */

import { readAlignments, type AlignmentRecord } from "./alignments";
import { pad2 } from "./clock";
import { entryBySeq, parseEntries, type Entry, type EntryIndex } from "./entries";
import {
  portalAlignments,
  portalInstants,
  portalPhase,
  type AlignmentKind,
  type PortalInstant
} from "./portals";

/** One minute, the width of an opening. */
const MINUTE_MS = 60_000;

/** A portal is announced eleven minutes before it opens. */
const LEAD_MS = 11 * MINUTE_MS;

/** A recorded beginning, with the local facts its stamp preserves. */
interface LocalFacts {
  day: string;
  hour: number;
  minute: number;
  second: number;
  offsetMinutes: number;
  epoch: number;
}

/** `2026-11-05T22:55:00-08:00`: local date and clock, numeric offset. */
const LOCAL_STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-])(\d{2}):(\d{2})$/;

/**
 * Reads the local facts a recorded stamp carries.
 *
 * The components are read from the text, not by rendering its epoch in the
 * machine's current zone, so a record keeps the hour and minute the portal was
 * announced at even after travel. `readAlignments` has already validated shape,
 * but the helper still answers null rather than inventing facts.
 */
function parseLocalStamp(value: string): LocalFacts | null {
  const match = LOCAL_STAMP.exec(value);
  if (match === null) return null;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetMinutes = (match[7] === "-" ? -1 : 1) * (Number(match[8]) * 60 + Number(match[9]));
  const epoch = Date.parse(value);
  return {
    day: `${match[1]}-${match[2]}-${match[3]}`,
    hour,
    minute,
    second,
    offsetMinutes,
    epoch
  };
}

/** The opening a record names, rebuilt with its original local facts. */
function portalOfRecord(record: AlignmentRecord): PortalInstant | null {
  const opened = parseLocalStamp(record.opened);
  if (opened === null) return null;
  const opensAt = Date.parse(record.portal);
  if (!Number.isFinite(opensAt)) return null;
  return {
    id: record.portal,
    opensAt,
    day: opened.day,
    hour: opened.hour,
    minute: opened.minute,
    offsetMinutes: opened.offsetMinutes
  };
}

/** The one row an entered portal contributes, aligned or merely entered. */
function recordedLabel(began: LocalFacts, alignments: readonly AlignmentKind[]): string {
  if (alignments.length === 0) {
    const clock = `${pad2(began.hour)}:${pad2(began.minute)}:${pad2(began.second)}`;
    return `Entered · ${clock}`;
  }
  return `Aligned · ${alignmentWords(alignments)}`;
}

/**
 * Turns coincident recognitions into one phrase.
 *
 * A single recognition keeps its full name (`Boundary`, `Hour echo`,
 * `Minute echo`). Coincident ones share the trailing `echo`, as in
 * `Hour + minute echo`; `Boundary + hour echo` reads as one event, not three.
 */
function alignmentWords(kinds: readonly AlignmentKind[]): string {
  const stem = (kind: AlignmentKind): string =>
    kind === "boundary" ? "Boundary" : kind === "hour-echo" ? "Hour" : "Minute";

  const first = stem(kinds[0] ?? "boundary");
  if (kinds.length === 1) {
    return kinds[0] === "boundary" ? first : `${first} echo`;
  }

  const rest = kinds.slice(1).map((kind) => stem(kind).toLowerCase());
  const phrase = [first, ...rest].join(" + ");
  return kinds[kinds.length - 1] === "boundary" ? phrase : `${phrase} echo`;
}

/** A recorded beginning, and the entry it still truthfully points at. */
export interface RecordedPortalHistoryRow {
  kind: "recorded";
  /** Stable for one source row even when its entry association becomes null. */
  id: string;
  record: AlignmentRecord;
  portal: PortalInstant;
  alignments: readonly AlignmentKind[];
  /** The validated entry number, or null when missing, edited, deleted or reused. */
  entry: number | null;
  label: string;
}

/** A scheduled opening that this note has not recorded. */
export interface OpeningPortalHistoryRow {
  kind: "opening";
  id: string;
  portal: PortalInstant;
  phase: "approaching" | "open" | "passed";
  label: string;
}

/** One row in the navigator's portal history. */
export type PortalHistoryRow = RecordedPortalHistoryRow | OpeningPortalHistoryRow;

/** A read history, or why the note's history could not be listed. */
export type PortalHistory =
  | { ok: true; rows: PortalHistoryRow[] }
  | { ok: false; error: string };

/**
 * Resolves a record's entry only when its clock row still names the recorded
 * beginning exactly.
 *
 * `N` alone is not identity: entries are deleted and numbers reused. A record is
 * trusted for an entry only when the entry still carries the same recorded day
 * and moment; a manually edited row, a missing entry and a reused number all
 * resolve to null. Nothing is inferred from proximity or title.
 */
export function linkedPortalEntry(record: AlignmentRecord, index: EntryIndex): Entry | null {
  return linkEntry(record, index, parseLocalStamp(record.began));
}

/** The shared association check, once the beginning has already been read. */
function linkEntry(record: AlignmentRecord, index: EntryIndex, began: LocalFacts | null): Entry | null {
  if (record.entry === null || began === null) return null;
  const entry = entryBySeq(index, record.entry);
  if (entry === null) return null;
  if (entry.day !== began.day) return null;
  if (entry.time !== `${pad2(began.hour)}:${pad2(began.minute)}:${pad2(began.second)}`) return null;
  return entry;
}

/** The local midnight bounds of the day containing `now`. */
function localDayBounds(now: number): { start: number; end: number } {
  const date = new Date(now);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0).getTime();
  // Local date arithmetic, not a fixed 24 hours: a folded or skipped hour is
  // part of the real day, and the day can be 25 or 23 hours long.
  const end = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + 1,
    0,
    0,
    0,
    0
  ).getTime();
  return { start, end };
}

/** The opening rows a note should show: the default window or the full day. */
function openingRows(
  now: number,
  showAll: boolean,
  recorded: ReadonlySet<string>
): PortalHistoryRow[] {
  const { start, end } = localDayBounds(now);
  const openings = portalInstants(start, end - 1).filter(
    (portal) => portal.opensAt >= start && portal.opensAt < end && !recorded.has(portal.id)
  );

  let shown: PortalInstant[];
  if (showAll) {
    shown = openings;
  } else {
    const selected = new Map<string, PortalInstant>();
    let mostRecentPassed: PortalInstant | null = null;
    for (const portal of openings) {
      const passesAt = portal.opensAt + MINUTE_MS;
      if (passesAt <= now) {
        if (mostRecentPassed === null || portal.opensAt > mostRecentPassed.opensAt) {
          mostRecentPassed = portal;
        }
        continue;
      }
      // Approaching for the next eleven minutes, open through its own minute.
      if (portal.opensAt - LEAD_MS <= now) selected.set(portal.id, portal);
    }
    if (mostRecentPassed !== null) selected.set(mostRecentPassed.id, mostRecentPassed);
    shown = [...selected.values()];
  }

  return shown.map((portal) => {
    const phase = portalPhase(portal, now, false);
    const status = phase === "approaching" ? "Upcoming" : phase === "open" ? "Open" : "Passed";
    return {
      kind: "opening" as const,
      id: `opening:${portal.id}`,
      portal,
      phase: phase === "approaching" ? "approaching" : phase === "open" ? "open" : "passed",
      label: status
    };
  });
}

/**
 * Lists a day note's portal history.
 *
 * Every recorded event is included, whether or not it still points at an entry.
 * The schedule beneath it is reconstructed for the local day containing `now`
 * and omits any portal the note has already recorded, so one opening is never
 * both a fact and an invitation. Rows are chronological by opening instant, then
 * by recorded beginning, and keep source order for otherwise identical events.
 *
 * `showAll` lays out the whole current local day; otherwise only the eleven
 * minute invitation window, the currently open minute, and the most recent
 * elapsed opening are listed. An unreadable history is returned as an error and
 * never silently becomes an empty list.
 */
export function portalHistoryRows(
  source: string,
  now: number,
  showAll: boolean
): PortalHistory {
  const history = readAlignments(source);
  if (!history.ok) return { ok: false, error: history.error };

  const index = parseEntries(source);
  const recordedIds = new Set(history.records.map((record) => record.portal));

  interface Sortable {
    row: PortalHistoryRow;
    opensAt: number;
    beganAt: number;
    order: number;
  }

  const sortable: Sortable[] = [];
  let order = 0;

  for (const record of history.records) {
    const began = parseLocalStamp(record.began);
    const portal = portalOfRecord(record);
    if (began === null || portal === null) {
      return { ok: false, error: "The recorded portal timestamps could not be read; repair the history before continuing." };
    }
    const opensAt = portal.opensAt;
    const entry = linkEntry(record, index, began) !== null ? record.entry : null;
    const alignments = portalAlignments(portal, began.epoch);
    sortable.push({
      row: {
        kind: "recorded",
        // The association is deliberately absent from the id: nulling an entry
        // must not make a surface lose the selected row it is holding.
        id: `recorded:${order}:${record.portal}:${record.began}`,
        record,
        portal,
        alignments,
        entry,
        label: recordedLabel(began, alignments)
      },
      opensAt,
      beganAt: began.epoch,
      order
    });
    order += 1;
  }

  for (const row of openingRows(now, showAll, recordedIds)) {
    sortable.push({
      row,
      opensAt: row.portal.opensAt,
      beganAt: row.portal.opensAt,
      order
    });
    order += 1;
  }

  sortable.sort(
    (left, right) =>
      left.opensAt - right.opensAt ||
      left.beganAt - right.beganAt ||
      left.order - right.order
  );

  return { ok: true, rows: sortable.map((item) => item.row) };
}
