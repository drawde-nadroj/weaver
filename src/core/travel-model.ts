/**
 * The travel model, pure: which drafts exist, how a typed query narrows them,
 * and where the cursor is allowed to move.
 *
 * Days ascend, rows ascend by `N`, and neither axis wraps — the two `move*`
 * functions clamp at the edges. Nothing here reads Obsidian.
 */

export interface TravelRow {
  path: string;
  dayKey: string;
  line: number;
  d: number;
  c: number;
  n: number;
  time: string;
  durationMs: number;
  title: string;
}

export interface TravelDay {
  key: string;
  rows: TravelRow[];
}

/**
 * `1` → a dimension, `.14` → a sequence, `1.2` → dimension and child,
 * `1.2.14` → all three. Anything else is not a query.
 */
export type TravelFilter =
  | { kind: "d"; d: number }
  | { kind: "n"; n: number }
  | { kind: "dc"; d: number; c: number }
  | { kind: "dcn"; d: number; c: number; n: number };

const NUMBER = String.raw`\d{1,3}`;

const D_ONLY = new RegExp(`^(${NUMBER})$`);
const N_ONLY = new RegExp(String.raw`^\.(\d{1,6})$`);
const D_C = new RegExp(`^(${NUMBER})\\.(${NUMBER})$`);
const D_C_N = new RegExp(`^(${NUMBER})\\.(${NUMBER})\\.(\\d{1,6})$`);

function integer(value: string | undefined): number {
  return Number.parseInt(value ?? "0", 10);
}

export function parseDcnQuery(text: string): TravelFilter | null {
  const query = text.trim();
  if (query === "") return null;

  const dcn = D_C_N.exec(query);
  if (dcn !== null) {
    return { kind: "dcn", d: integer(dcn[1]), c: integer(dcn[2]), n: integer(dcn[3]) };
  }

  const dc = D_C.exec(query);
  if (dc !== null) return { kind: "dc", d: integer(dc[1]), c: integer(dc[2]) };

  const n = N_ONLY.exec(query);
  if (n !== null) return { kind: "n", n: integer(n[1]) };

  const d = D_ONLY.exec(query);
  if (d !== null) return { kind: "d", d: integer(d[1]) };

  return null;
}

export function filterRows(rows: readonly TravelRow[], filter: TravelFilter | null): TravelRow[] {
  if (filter === null) return [...rows];

  return rows.filter((row) => {
    switch (filter.kind) {
      case "d":
        return row.d === filter.d;
      case "n":
        return row.n === filter.n;
      case "dc":
        return row.d === filter.d && row.c === filter.c;
      case "dcn":
        return row.d === filter.d && row.c === filter.c && row.n === filter.n;
    }
  });
}

/** Days ascending, each day's rows ascending by `N`, narrowed by `filter`. */
export function travelDays(rows: readonly TravelRow[], filter: TravelFilter | null): TravelDay[] {
  const groups = new Map<string, TravelRow[]>();
  for (const row of filterRows(rows, filter)) {
    const bucket = groups.get(row.dayKey);
    if (bucket === undefined) groups.set(row.dayKey, [row]);
    else bucket.push(row);
  }

  return [...groups.keys()]
    .sort((left, right) => left.localeCompare(right))
    .map((key) => ({
      key,
      rows: (groups.get(key) ?? []).sort((left, right) => left.n - right.n)
    }));
}

export function clampCursor(
  days: readonly TravelDay[],
  day: number,
  row: number
): { day: number; row: number } {
  if (days.length === 0) return { day: 0, row: 0 };

  const dayIndex = Math.min(Math.max(day, 0), days.length - 1);
  const rows = (days[dayIndex] as TravelDay).rows;
  const rowIndex = rows.length === 0 ? 0 : Math.min(Math.max(row, 0), rows.length - 1);
  return { day: dayIndex, row: rowIndex };
}

export function moveDay(
  days: readonly TravelDay[],
  day: number,
  row: number,
  delta: number
): { day: number; row: number } {
  return clampCursor(days, day + delta, row);
}

export function moveRow(
  days: readonly TravelDay[],
  day: number,
  row: number,
  delta: number
): { day: number; row: number } {
  return clampCursor(days, day, row + delta);
}
