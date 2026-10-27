/**
 * The contribution calendar, in Weaver's vocabulary.
 *
 * Weeks start Monday, a day's intensity is a bucket of how many sparks it
 * recorded, and every day after the requested end is marked `future` instead of
 * being quietly dropped. Dates move through UTC noon so a daylight-saving shift
 * can never skip or repeat a day.
 */

import { pad2 } from "../core/clock";

export interface CalendarDay {
  /** `YYYY-MM-DD`. */
  key: string;
  count: number;
  closed: boolean;
  intensity: 0 | 1 | 2 | 3 | 4;
  future: boolean;
}

/** A bucket, never a grade: 0, 1, 2–4, 5–9, 10 or more. */
export function intensity(count: number): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(count) || count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** UTC noon for a day key; rejects a date that does not exist. */
function noonOf(key: string): Date {
  const match = DAY_KEY.exec(key);
  if (match === null) throw new Error(`Weaver: invalid day key ${key}`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 12));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Weaver: invalid day key ${key}`);
  }
  return date;
}

/** `2026-10-27` shifted by whole calendar days. */
export function shiftDay(key: string, delta: number): string {
  const date = noonOf(key);
  date.setUTCDate(date.getUTCDate() + Math.round(delta));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** `Mon 27 Oct`, without depending on the machine's locale. */
export function dayLabel(key: string): string {
  const date = noonOf(key);
  return `${WEEKDAYS[date.getUTCDay()] ?? ""} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? ""}`;
}

/** The cell's whole meaning, so a screen reader needs no visual scan. */
export function cellLabel(day: CalendarDay): string {
  const sparks = day.count === 1 ? "1 spark" : `${day.count} sparks`;
  return `${dayLabel(day.key)}: ${sparks}`;
}

/**
 * `weeks` columns of seven days, ending in the week that contains `end`.
 * Days after `end` stay in the grid but are flagged `future`.
 */
export function calendarWeeks(
  counts: ReadonlyMap<string, { count: number; closed: boolean }>,
  end: string,
  weeks: number
): CalendarDay[][] {
  const endDate = noonOf(end);
  const endMillis = endDate.getTime();
  // ISO weekday: 0 is Monday.
  const offset = (endDate.getUTCDay() + 6) % 7;
  const columns = Math.max(1, Math.round(weeks));
  const first = shiftDay(end, -(columns - 1) * 7 - offset);

  const grid: CalendarDay[][] = [];
  for (let column = 0; column < columns; column += 1) {
    const row: CalendarDay[] = [];
    for (let rowIndex = 0; rowIndex < 7; rowIndex += 1) {
      const key = shiftDay(first, column * 7 + rowIndex);
      const entry = counts.get(key);
      const count = entry?.count ?? 0;
      row.push({
        key,
        count,
        closed: entry?.closed ?? false,
        intensity: intensity(count),
        future: noonOf(key).getTime() > endMillis
      });
    }
    grid.push(row);
  }
  return grid;
}

const CELL = 10;
const GAP = 2;
const STEP = CELL + GAP;

/** Draws the grid as one `<svg>`; Enter and click both pick a day. */
export function renderCalendar(
  container: HTMLElement,
  weeks: CalendarDay[][],
  onPick: (key: string) => void
): void {
  container.empty();

  const columns = weeks.length;
  const svg = container.createSvg("svg", { cls: "weaver-cal" });
  svg.setAttr("role", "group");
  svg.setAttr("aria-label", "Sparks per day");
  svg.setAttr("viewBox", `0 0 ${columns * STEP} ${7 * STEP}`);
  svg.setAttr("width", String(columns * STEP));
  svg.setAttr("height", String(7 * STEP));

  weeks.forEach((week, column) => {
    week.forEach((day, rowIndex) => {
      const cell = svg.createSvg("rect", {
        cls: `weaver-cal-cell weaver-cal-${day.intensity}${day.future ? " is-future" : ""}`
      });
      cell.setAttr("x", String(column * STEP));
      cell.setAttr("y", String(rowIndex * STEP));
      cell.setAttr("width", String(CELL));
      cell.setAttr("height", String(CELL));
      cell.setAttr("rx", "2");
      cell.setAttr("tabindex", "0");
      cell.setAttr("role", "button");
      cell.setAttr("aria-label", cellLabel(day));

      cell.addEventListener("click", () => onPick(day.key));
      cell.addEventListener("keydown", (event) => {
        const key = (event as KeyboardEvent).key;
        if (key !== "Enter" && key !== " ") return;
        event.preventDefault();
        onPick(day.key);
      });
    });
  });
}
