/**
 * Weaver settings model.
 *
 * This module is deliberately free of any `obsidian` import so the
 * normalization rules can be unit-tested in plain Node. The settings tab lives
 * in `settings-tab.ts`.
 *
 * A field's name is the product's word for the thing: `entrySize`, never
 * `headingSize`. `heading` is Markdown syntax here, and a setting that draws an
 * entry is not about syntax. The v2 spellings survive in exactly one place —
 * `LEGACY_SETTING_KEYS` — because a vault's saved `data.json` is data, not code,
 * and renaming a field must not silently reset it.
 */

export interface WeaverSettings {
  // Writing
  /** Rewrite the day note's `travels`, `depth` and `duration` fields. */
  writeDayCounters: boolean;

  // Day
  /** Fallback folder, used only when the Daily Notes plugin cannot be read. */
  dayNoteFolder: string;
  /** Fallback filename format, used in the same circumstance. */
  dayNoteFormat: string;

  // Look
  equalizeEntrySizes: boolean;
  entrySize: string;
  indentStep: number;
  mobileIndentStep: number;
  indentMaxLevel: number;
  portEmphasisColors: boolean;
  /** Draw a frame around every entry: the rails run through the middle of the marker and clock rows, cut behind those labels. */
  entryFrames: boolean;
  /**
   * Start a frame at the entry's own indent. On, a nested entry's frame begins
   * further right, so nesting reads as a staircase; off, every frame begins in the
   * left margin and only the prose carries the indent, so the markers and the
   * times line up down the note.
   */
  frameFollowsIndent: boolean;

  // Advanced
  debug: boolean;
}

/** What is on disk: a version and one settings object. */
export interface WeaverData {
  version: 3;
  settings: WeaverSettings;
}

/** Every field's value before a vault says otherwise. */
export const DEFAULT_SETTINGS: WeaverSettings = {
  writeDayCounters: true,

  dayNoteFolder: "Chronomancer",
  dayNoteFormat: "YYYY.MM.DD",

  equalizeEntrySizes: true,
  entrySize: "1em",
  indentStep: 18,
  mobileIndentStep: 12,
  indentMaxLevel: 8,
  portEmphasisColors: true,

  entryFrames: true,
  frameFollowsIndent: true,

  debug: false
};

const ENTRY_SIZE_PATTERN = /^\d+(\.\d+)?(em|rem|px)$/;

/** True for a CSS length Weaver will accept as an entry size. */
export function isValidEntrySize(value: string): boolean {
  return ENTRY_SIZE_PATTERN.test(value.trim());
}

/**
 * Every older name the model has carried, and the only place they are read.
 *
 * "Heading" was the old word for the unit; the entry model renamed it, so the
 * three Look fields were renamed with it. Dropping an old key instead of mapping
 * it would reset a writer's choice on upgrade, which is a silent data loss —
 * hence the mapping, and hence it lives here rather than in a second settings
 * model. A stored name with no current name at all (`entryWeight`, `entryDate`)
 * is simply dropped by `normalizeSettings`.
 */
const LEGACY_SETTING_KEYS: Readonly<Record<string, string>> = {
  equalizeHeadingSizes: "equalizeEntrySizes",
  headingSize: "entrySize"
};

/** Copies a payload's values onto their current names; current names win. */
function withCurrentKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...raw };

  for (const [legacy, current] of Object.entries(LEGACY_SETTING_KEYS)) {
    if (!(current in next) && legacy in next) next[current] = next[legacy];
    delete next[legacy];
  }

  return next;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return clamp(Math.round(numeric), min, max);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Normalizes any persisted payload into a complete, clamped settings object.
 * Unknown fields are dropped; invalid values fall back to the defaults; a v2
 * field name keeps its value under the v3 name.
 */
export function normalizeSettings(data: unknown): WeaverSettings {
  if (!isPlainObject(data)) return { ...DEFAULT_SETTINGS };

  const raw = withCurrentKeys(data);
  const rawEntrySize = text(raw.entrySize, DEFAULT_SETTINGS.entrySize);

  return {
    writeDayCounters: bool(raw.writeDayCounters, DEFAULT_SETTINGS.writeDayCounters),

    dayNoteFolder: text(raw.dayNoteFolder, DEFAULT_SETTINGS.dayNoteFolder),
    dayNoteFormat: text(raw.dayNoteFormat, DEFAULT_SETTINGS.dayNoteFormat),

    equalizeEntrySizes: bool(raw.equalizeEntrySizes, DEFAULT_SETTINGS.equalizeEntrySizes),
    entrySize: isValidEntrySize(rawEntrySize) ? rawEntrySize.trim() : DEFAULT_SETTINGS.entrySize,
    indentStep: integer(raw.indentStep, DEFAULT_SETTINGS.indentStep, 0, 48),
    mobileIndentStep: integer(raw.mobileIndentStep, DEFAULT_SETTINGS.mobileIndentStep, 0, 32),
    indentMaxLevel: integer(raw.indentMaxLevel, DEFAULT_SETTINGS.indentMaxLevel, 1, 24),
    portEmphasisColors: bool(raw.portEmphasisColors, DEFAULT_SETTINGS.portEmphasisColors),
    entryFrames: bool(raw.entryFrames, DEFAULT_SETTINGS.entryFrames),
    frameFollowsIndent: bool(raw.frameFollowsIndent, DEFAULT_SETTINGS.frameFollowsIndent),

    debug: bool(raw.debug, DEFAULT_SETTINGS.debug)
  };
}

const SETTING_KEYS = new Set([
  ...Object.keys(DEFAULT_SETTINGS),
  ...Object.keys(LEGACY_SETTING_KEYS)
]);

function looksLikeBareSettings(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => SETTING_KEYS.has(key));
}

/**
 * Normalizes persisted plugin data. A bare settings object written by an earlier
 * build is wrapped instead of being discarded, and every payload is reported as
 * the current version — the migration is the normalization.
 */
export function normalizeData(data: unknown): WeaverData {
  if (!isPlainObject(data)) {
    return { version: 3, settings: { ...DEFAULT_SETTINGS } };
  }

  if (isPlainObject(data.settings)) {
    return { version: 3, settings: normalizeSettings(data.settings) };
  }

  if (looksLikeBareSettings(data)) {
    return { version: 3, settings: normalizeSettings(data) };
  }

  return { version: 3, settings: { ...DEFAULT_SETTINGS } };
}
