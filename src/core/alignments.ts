/**
 * Portal history: the openings a day note actually entered, and the frontmatter
 * block that carries them.
 *
 * One record is one fact — a portal opened, and the first text of an entry was
 * really typed at a particular moment. The record keeps the portal's UTC
 * instant, the local opening that names its hour and minute, and the actual
 * local beginning, so the recognition can be recomputed years later without
 * trusting the machine's clock or its current timezone.
 *
 * The block is owned whole: the literal `weaver-alignments` key and its indented
 * sequence of single-line JSON flow mappings. Everything else in the note — the
 * other properties, their nesting, the closing delimiter, the body — is copied
 * byte for byte. The format is canonical on write and strict on read: a record
 * this module cannot read is refused with the reason, never replaced by an empty
 * history, because a lost alignment cannot be recomputed.
 */

import { pad2 } from "./clock";
import { scanFrontmatter } from "./document";

/** The one frontmatter property this module owns, and the only key it writes. */
export const ALIGNMENTS_KEY = "weaver-alignments";

/**
 * One recorded portal beginning.
 *
 * `portal` is the opening instant in canonical UTC and doubles as the portal's
 * identity; `opened` is that same instant written with its original numeric
 * offset, which is what preserves the local hour and minute the echoes are
 * measured against. `began` is the actual first-input moment at whole-second
 * precision, and `entry` is the allocated `N` — or null once that entry has
 * been deleted, because the fact outlives the entry.
 */
export interface AlignmentRecord {
  portal: string;
  opened: string;
  began: string;
  entry: number | null;
}

/** A parsed history, or why the note's history could not be read. */
export type AlignmentRead =
  | { ok: true; records: AlignmentRecord[] }
  | { ok: false; error: string };

/** The rewritten note, or why nothing was written. */
export type AlignmentWrite =
  | { ok: true; source: string }
  | { ok: false; error: string };

/** A record's fields, in the order the canonical row writes them. */
const FIELDS = ["portal", "opened", "began", "entry"] as const;

/** `2026-11-06T06:55:00.000Z` — canonical UTC, milliseconds included. */
const UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

/** `2026-11-05T22:55:00-08:00` — local date and clock at whole seconds, numeric offset. */
const LOCAL_STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-])(\d{2}):(\d{2})$/;

/** `  - {...}` — one sequence item holding one JSON flow mapping. */
const ROW = /^[ \t]*-[ \t]+(\{.*\})[ \t]*$/;

/** The owned key, at column zero, in any of the three forms YAML allows. */
const KEY_LINE = /^(?:weaver-alignments|"weaver-alignments"|'weaver-alignments')[ \t]*:(.*)$/;

/** Pads a year to the four digits a timestamp writes. */
function pad4(value: number): string {
  return String(value).padStart(4, "0");
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`;
}

/**
 * Formats an instant as a local timestamp with its numeric offset:
 * `2026-11-05T22:55:00-08:00`.
 *
 * The milliseconds are floored away, because a recorded beginning is whole
 * seconds and rounding up would report a moment the writer had not reached. The
 * offset is taken for that same instant, so the stamp names exactly the instant
 * it came from — including both sides of a daylight-saving fold, which differ by
 * their offset alone.
 */
export function formatLocalTimestamp(date: Date): string {
  const instant = date.getTime();
  if (!Number.isFinite(instant)) throw new TypeError("formatLocalTimestamp needs a real instant");

  const whole = new Date(Math.floor(instant / 1000) * 1000);
  const year = whole.getFullYear();
  const month = whole.getMonth() + 1;
  const day = whole.getDate();
  const hour = whole.getHours();
  const minute = whole.getMinutes();
  const second = whole.getSeconds();
  // Derived from the local components rather than `getTimezoneOffset`, so the
  // written offset and the written clock always describe the same instant.
  const offsetMinutes = Math.round(
    (Date.UTC(year, month - 1, day, hour, minute, second) - whole.getTime()) / 60000
  );

  return (
    `${pad4(year)}-${pad2(month)}-${pad2(day)}` +
    `T${pad2(hour)}:${pad2(minute)}:${pad2(second)}` +
    formatOffset(offsetMinutes)
  );
}

/** Reads a canonical UTC instant, refusing anything a writer could not have meant. */
function parseUtcInstant(value: unknown): { ok: true; epoch: number } | { ok: false; error: string } {
  if (typeof value !== "string") {
    return { ok: false, error: "`portal` must be the opening instant as a string" };
  }
  if (!UTC_INSTANT.test(value)) {
    return {
      ok: false,
      error: `\`portal\` must be a canonical UTC instant like 2026-11-06T06:55:00.000Z, not ${JSON.stringify(value)}`
    };
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    return { ok: false, error: `\`portal\` names no real instant: ${JSON.stringify(value)}` };
  }
  if (epoch % 60000 !== 0) {
    return { ok: false, error: `\`portal\` must be a whole minute: ${JSON.stringify(value)}` };
  }
  return { ok: true, epoch };
}

/**
 * Reads a local stamp, checking the calendar it claims.
 *
 * A stamp is refused when its date or clock would have to roll over — February
 * 30, hour 24 — because those are typos, and when its offset is beyond the
 * ±14:00 any real zone has ever used.
 */
function parseLocalStamp(
  value: unknown,
  field: string
): { ok: true; epoch: number } | { ok: false; error: string } {
  if (typeof value !== "string") {
    return { ok: false, error: `\`${field}\` must be a local timestamp as a string` };
  }
  const match = LOCAL_STAMP.exec(value);
  if (match === null) {
    return {
      ok: false,
      error: `\`${field}\` must be a whole-second local timestamp with a numeric offset like 2026-11-05T22:55:00-08:00, not ${JSON.stringify(value)}`
    };
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHours = Number(match[8]);
  const offsetMinutesPart = Number(match[9]);

  if (offsetHours > 14 || offsetMinutesPart > 59 || (offsetHours === 14 && offsetMinutesPart !== 0)) {
    return { ok: false, error: `\`${field}\` has an impossible UTC offset: ${JSON.stringify(value)}` };
  }
  const offsetMinutes = (match[7] === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutesPart);

  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(utc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    return {
      ok: false,
      error: `\`${field}\` names a date or clock that does not exist: ${JSON.stringify(value)}`
    };
  }

  return { ok: true, epoch: utc - offsetMinutes * 60000 };
}

/** Validates one record, in the shape it must have and in its own internal consistency. */
function validateRecord(
  value: unknown,
  where: string
): { ok: true; record: AlignmentRecord } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: `${where}: a record must be a JSON object` };
  }
  const mapping = value as Record<string, unknown>;

  for (const key of Object.keys(mapping)) {
    if (!(FIELDS as readonly string[]).includes(key)) {
      return { ok: false, error: `${where}: unknown record field ${JSON.stringify(key)}` };
    }
  }
  for (const key of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(mapping, key)) {
      return { ok: false, error: `${where}: record is missing ${JSON.stringify(key)}` };
    }
  }

  const portal = parseUtcInstant(mapping["portal"]);
  if (!portal.ok) return { ok: false, error: `${where}: ${portal.error}` };

  const opened = parseLocalStamp(mapping["opened"], "opened");
  if (!opened.ok) return { ok: false, error: `${where}: ${opened.error}` };
  if (opened.epoch !== portal.epoch) {
    return {
      ok: false,
      error: `${where}: \`opened\` names a different instant than \`portal\` — the opening must keep its own local time`
    };
  }

  const began = parseLocalStamp(mapping["began"], "began");
  if (!began.ok) return { ok: false, error: `${where}: ${began.error}` };

  const entry = mapping["entry"];
  if (entry !== null && !(typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 1)) {
    return {
      ok: false,
      error: `${where}: \`entry\` must be the entry's own number or null, not ${JSON.stringify(entry)}`
    };
  }

  return {
    ok: true,
    record: {
      portal: mapping["portal"] as string,
      opened: mapping["opened"] as string,
      began: mapping["began"] as string,
      entry: entry as number | null
    }
  };
}

/** Parses one sequence row, or says what is wrong with the line. */
function parseRecordRow(
  raw: string,
  line: number
): { ok: true; record: AlignmentRecord } | { ok: false; error: string } {
  const flow = ROW.exec(raw)?.[1];
  if (flow === undefined) {
    return {
      ok: false,
      error: `line ${line} is not a single-line JSON flow mapping like \`  - {"portal":…,"opened":…,"began":…,"entry":…}\``
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(flow);
  } catch {
    return { ok: false, error: `line ${line} is not valid JSON: ${flow.trim()}` };
  }
  return validateRecord(parsed, `line ${line}`);
}

/** Where the owned key sits, and how far its sequence reaches. */
interface Owned {
  keyLine: number;
  /** The last row's line index; equals `keyLine` when the sequence is empty. */
  lastRow: number;
}

/**
 * Finds the owned key inside the frontmatter and bounds its sequence.
 *
 * Two occurrences refuse the whole read: a note carrying the history twice has
 * no single answer for what was entered, and picking one would silently discard
 * the other. Content indented under the key that is not a row is refused for the
 * same reason — a nested mapping is history this parser does not understand, not
 * an empty history.
 */
function locateOwned(
  lines: readonly string[],
  end: number
): { ok: true; found: Owned | null } | { ok: false; error: string } {
  let found: Owned | null = null;

  for (let index = 1; index < end; index += 1) {
    const raw = lines[index] ?? "";
    const match = KEY_LINE.exec(raw);
    if (match === null) continue;

    if (found !== null) {
      return {
        ok: false,
        error: `\`${ALIGNMENTS_KEY}\` appears twice (lines ${found.keyLine + 1} and ${index + 1}); keep one history`
      };
    }

    const rest = match[1] ?? "";
    if (rest.trim() !== "") {
      return {
        ok: false,
        error: `\`${ALIGNMENTS_KEY}\` must hold a block sequence with the key alone on its line, not ${JSON.stringify(rest.trim())}`
      };
    }

    found = { keyLine: index, lastRow: index };
  }

  if (found === null) return { ok: true, found: null };

  // The sequence runs from the key to its last row. Blank lines inside it are
  // allowed by YAML; the first unindented key ends it.
  let lastRow = found.keyLine;
  for (let index = found.keyLine + 1; index < end; index += 1) {
    const raw = lines[index] ?? "";
    if (raw.trim() === "") continue;
    if (ROW.test(raw)) {
      lastRow = index;
      continue;
    }
    if (/^[ \t]*-/.test(raw)) {
      return {
        ok: false,
        error: `line ${index + 1} is not a single-line JSON flow mapping under \`${ALIGNMENTS_KEY}\`; nested mappings and lists are not history`
      };
    }
    if (/^[ \t]/.test(raw)) {
      return {
        ok: false,
        error: `line ${index + 1} is nested under \`${ALIGNMENTS_KEY}\` but is not a record; history is a sequence of JSON flow mappings`
      };
    }
    break;
  }

  return { ok: true, found: { keyLine: found.keyLine, lastRow } };
}

/**
 * Reads a note's portal history.
 *
 * A note without the key, or with the key left blank, has no history yet: that
 * is the empty list, not an error. Anything else that cannot be read is reported
 * with the line and the reason, and the caller must refuse to write — an
 * unreadable history is never replaced by an empty one.
 */
export function readAlignments(source: string): AlignmentRead {
  const lines = source.split("\n");
  const frontmatter = scanFrontmatter(lines);
  if (frontmatter.kind === "unclosed") {
    return {
      ok: false,
      error: "portal history is unreadable: the note's frontmatter is never closed — add its closing `---` line"
    };
  }
  if (frontmatter.kind === "none") return { ok: true, records: [] };

  const owned = locateOwned(lines, frontmatter.end);
  if (!owned.ok) return { ok: false, error: `portal history is unreadable: ${owned.error}` };
  if (owned.found === null) return { ok: true, records: [] };

  const records: AlignmentRecord[] = [];
  for (let index = owned.found.keyLine + 1; index <= owned.found.lastRow; index += 1) {
    const raw = lines[index] ?? "";
    if (raw.trim() === "") continue;
    const row = parseRecordRow(raw, index + 1);
    if (!row.ok) {
      return {
        ok: false,
        error: `portal history is unreadable under \`${ALIGNMENTS_KEY}\`: ${row.error}`
      };
    }
    records.push(row.record);
  }

  return { ok: true, records };
}

/** One record in the canonical row it is written as. */
function canonicalRow(record: AlignmentRecord): string {
  return (
    "  - " +
    JSON.stringify({
      portal: record.portal,
      opened: record.opened,
      began: record.began,
      entry: record.entry
    })
  );
}

/**
 * Rewrites the owned block in place, leaving every other byte alone.
 *
 * The block replaces exactly the lines the key and its sequence occupied. A note
 * with no key gets one appended at the end of its frontmatter — above the closing
 * delimiter, whatever that delimiter is — and a note with no frontmatter at all
 * gets the smallest block the day notes already use.
 */
function writeRecords(source: string, records: readonly AlignmentRecord[]): AlignmentWrite {
  const lines = source.split("\n");
  const frontmatter = scanFrontmatter(lines);
  if (frontmatter.kind === "unclosed") {
    return {
      ok: false,
      error: "portal history was not written: the note's frontmatter is never closed"
    };
  }

  const owned = locateOwned(lines, frontmatter.kind === "none" ? -1 : frontmatter.end);
  if (!owned.ok) return { ok: false, error: `portal history was not written: ${owned.error}` };

  const block = [`${ALIGNMENTS_KEY}:`, ...records.map(canonicalRow)];

  if (owned.found !== null) {
    const next = [
      ...lines.slice(0, owned.found.keyLine),
      ...block,
      ...lines.slice(owned.found.lastRow + 1)
    ];
    return { ok: true, source: next.join("\n") };
  }

  if (frontmatter.kind === "closed") {
    const next = [...lines.slice(0, frontmatter.end), ...block, ...lines.slice(frontmatter.end)];
    return { ok: true, source: next.join("\n") };
  }

  return { ok: true, source: `${["---", ...block, "---", ""].join("\n")}${source}` };
}

/**
 * Adds one recorded alignment to a note's history.
 *
 * The record is validated first and the note's history is read first, so a
 * malformed record and an unreadable note both refuse rather than overwrite. A
 * row already identical in portal, beginning and entry is not added twice; two
 * devices that entered the same portal at different moments both keep their
 * record, because neither fact is a correction of the other.
 */
export function mergeAlignment(source: string, record: AlignmentRecord): AlignmentWrite {
  const valid = validateRecord(record, "record");
  if (!valid.ok) return { ok: false, error: `portal history was not written: ${valid.error}` };

  const current = readAlignments(source);
  if (!current.ok) return { ok: false, error: current.error };

  const exists = current.records.some(
    (row) =>
      row.portal === valid.record.portal &&
      row.began === valid.record.began &&
      row.entry === valid.record.entry
  );
  const records = exists ? current.records : [...current.records, valid.record];

  return writeRecords(source, records);
}

/**
 * Detaches deleted entries from the history it belongs to.
 *
 * Deleting an entry nulls the records of every entry in the deleted subtree, in
 * the same plan that removes the text, so a reused `N` can never adopt an older
 * portal. The records themselves are kept: the opening and the moment are
 * facts about the day, and they are exactly what the history is for. Two records
 * that both lose their entry stay two records — collapsing them would erase an
 * event, not tidy it.
 */
export function detachAlignments(source: string, deleted: ReadonlySet<number>): AlignmentWrite {
  const current = readAlignments(source);
  if (!current.ok) return { ok: false, error: current.error };

  let touched = false;
  const records: AlignmentRecord[] = current.records.map((row) => {
    if (row.entry === null || !deleted.has(row.entry)) return row;
    touched = true;
    return { portal: row.portal, opened: row.opened, began: row.began, entry: null };
  });

  if (!touched) return { ok: true, source };
  return writeRecords(source, records);
}
