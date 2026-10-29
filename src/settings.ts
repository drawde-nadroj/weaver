/**
 * Weaver settings model.
 *
 * This module is deliberately free of any `obsidian` import so the
 * normalization rules can be unit-tested in plain Node. The settings tab lives
 * in `settings-tab.ts`.
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
  equalizeHeadingSizes: boolean;
  headingSize: string;
  headingWeight: number;
  indentStep: number;
  mobileIndentStep: number;
  indentMaxLevel: number;
  portEmphasisColors: boolean;
  /** Draw a frame around every entry: the rails run through the middle of the marker and duration rows, cut behind those labels. */
  entryFrames: boolean;

  // Advanced
  /** Render ` - [[2026.10.26]]` after the clock on any day but today. */
  entryDayLink: boolean;
  debug: boolean;
}

export interface WeaverData {
  version: 2;
  settings: WeaverSettings;
}

export const DEFAULT_SETTINGS: WeaverSettings = {
  writeDayCounters: true,

  dayNoteFolder: "Chronomancer",
  dayNoteFormat: "YYYY.MM.DD",

  equalizeHeadingSizes: true,
  headingSize: "1em",
  headingWeight: 600,
  indentStep: 18,
  mobileIndentStep: 12,
  indentMaxLevel: 8,
  portEmphasisColors: true,

  entryFrames: true,

  entryDayLink: true,
  debug: false
};

const HEADING_SIZE_PATTERN = /^\d+(\.\d+)?(em|rem|px)$/;

/** True for a CSS length Weaver will accept as an entry size. */
export function isValidHeadingSize(value: string): boolean {
  return HEADING_SIZE_PATTERN.test(value.trim());
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
 * Unknown fields are dropped; invalid values fall back to the defaults.
 */
export function normalizeSettings(data: unknown): WeaverSettings {
  if (!isPlainObject(data)) return { ...DEFAULT_SETTINGS };

  const rawHeadingSize = text(data.headingSize, DEFAULT_SETTINGS.headingSize);

  return {
    writeDayCounters: bool(data.writeDayCounters, DEFAULT_SETTINGS.writeDayCounters),

    dayNoteFolder: text(data.dayNoteFolder, DEFAULT_SETTINGS.dayNoteFolder),
    dayNoteFormat: text(data.dayNoteFormat, DEFAULT_SETTINGS.dayNoteFormat),

    equalizeHeadingSizes: bool(data.equalizeHeadingSizes, DEFAULT_SETTINGS.equalizeHeadingSizes),
    headingSize: isValidHeadingSize(rawHeadingSize)
      ? rawHeadingSize.trim()
      : DEFAULT_SETTINGS.headingSize,
    headingWeight: integer(data.headingWeight, DEFAULT_SETTINGS.headingWeight, 300, 800),
    indentStep: integer(data.indentStep, DEFAULT_SETTINGS.indentStep, 0, 48),
    mobileIndentStep: integer(data.mobileIndentStep, DEFAULT_SETTINGS.mobileIndentStep, 0, 32),
    indentMaxLevel: integer(data.indentMaxLevel, DEFAULT_SETTINGS.indentMaxLevel, 1, 24),
    portEmphasisColors: bool(data.portEmphasisColors, DEFAULT_SETTINGS.portEmphasisColors),
    entryFrames: bool(data.entryFrames, DEFAULT_SETTINGS.entryFrames),

    entryDayLink: bool(data.entryDayLink, DEFAULT_SETTINGS.entryDayLink),
    debug: bool(data.debug, DEFAULT_SETTINGS.debug)
  };
}

const SETTING_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));

function looksLikeBareSettings(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => SETTING_KEYS.has(key));
}

/**
 * Normalizes persisted plugin data. A bare settings object written by an earlier
 * build is wrapped instead of being discarded.
 */
export function normalizeData(data: unknown): WeaverData {
  if (!isPlainObject(data)) {
    return { version: 2, settings: { ...DEFAULT_SETTINGS } };
  }

  if (isPlainObject(data.settings)) {
    return { version: 2, settings: normalizeSettings(data.settings) };
  }

  if (looksLikeBareSettings(data)) {
    return { version: 2, settings: normalizeSettings(data) };
  }

  return { version: 2, settings: { ...DEFAULT_SETTINGS } };
}
