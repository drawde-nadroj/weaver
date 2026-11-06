/**
 * The day's portal history, as rows a surface can list.
 *
 * What this returns is evidence and nothing else: a note's `weaver-alignments`
 * record, its original local opening and beginning preserved, and its alignments
 * recomputed from those frozen facts rather than from the machine's current
 * timezone. The schedule a record happened to come from is not part of the note,
 * so it is not invented here — a list of upcoming or pending openings comes from
 * the live controller, which knows the schedules, and a note's history never
 * claims that a notice was delivered or that someone declined one.
 *
 * Nothing here reads or writes the vault. It parses the note it is given and
 * returns rows, or the reason the note's history could not be read at all.
 */

import { readAlignments, type AlignmentRecord } from "./alignments";
import { pad2 } from "./clock";
import { entryBySeq, parseEntries, type Entry, type EntryIndex } from "./entries";
import { portalAlignments, type AlignmentKind, type PortalInstant } from "./portals";


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

/** One row in the navigator's portal history: a recorded beginning. */
export type PortalHistoryRow = RecordedPortalHistoryRow;

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

/**
 * Lists a day note's recorded portal history.
 *
 * Every recorded event is included, whether or not it still points at an entry: a
 * record whose entry was deleted keeps its opening and its moment, and loses only
 * the association. Rows are chronological by opening instant, then by recorded
 * beginning, and keep source order for otherwise identical events. An unreadable
 * history is returned as an error and never silently becomes an empty list.
 */
export function portalHistoryRows(source: string): PortalHistory {
  const history = readAlignments(source);
  if (!history.ok) return { ok: false, error: history.error };

  const index = parseEntries(source);

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

  sortable.sort(
    (left, right) =>
      left.opensAt - right.opensAt ||
      left.beganAt - right.beganAt ||
      left.order - right.order
  );

  return { ok: true, rows: sortable.map((item) => item.row) };
}
