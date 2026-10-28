/** Pads a clock component to two digits. */
export function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Formats wall-clock time as `HH:MM:SS` using the machine's local timezone.
 * `toLocaleTimeString` is never used: it can insert non-breaking characters and
 * follows locale rules.
 */
export function formatClock(date: Date): string {
  const hours = pad2(date.getHours());
  const minutes = pad2(date.getMinutes());
  return `${hours}:${minutes}:${pad2(date.getSeconds())}`;
}
