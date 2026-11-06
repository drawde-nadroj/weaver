/**
 * The one shape guard for values that arrive as `unknown`.
 *
 * Settings payloads, vault-local records and stored context rows all cross the
 * same boundary — data this build did not create — so they all ask the same
 * question first. One guard, one answer: an object with named fields, never an
 * array and never null. Fields stay `unknown` until each is checked, which is the
 * point: this proves a mapping, not its contents.
 */

/** True for a plain object: not null, not an array, not a primitive. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
