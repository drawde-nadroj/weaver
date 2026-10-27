/**
 * Weaver settings model.
 *
 * This module is deliberately free of any `obsidian` import so the
 * normalization rules can be unit-tested in plain Node. The settings tab lives
 * in `settings-tab.ts`.
 */

export type TimestampFormat = "HH:mm:ss" | "HH:mm";
export type ColorMode = "vault-stretch" | "fixed-anchor";
export type TravelDefaultLevel = number | "all";
import type { ShuttleItem } from "./shuttle/store";
export type SparkTarget = "today" | "note";

export type { ShuttleItem };

export interface WeaverSettings {
  // Insertion
  timestampFormat: TimestampFormat;
  timestampSeparator: string;
  maxDepth: number;

  // Day
  /** Where a spark lands: today's day note, or the note being edited. */
  sparkTarget: SparkTarget;
  /** Rewrite the day note's `sparks`, `dimensions` and `sources` counters. */
  writeDayCounters: boolean;
  /** Fallback folder, used only when the Daily Notes plugin cannot be read. */
  dayNoteFolder: string;
  /** Fallback filename format, used in the same circumstance. */
  dayNoteFormat: string;

  // Typography & depth
  equalizeHeadingSizes: boolean;
  headingSize: string;
  /** Per-level size overrides; a missing level keeps the theme size. */
  headingLevelSizes: Record<number, string>;
  headingWeight: number;
  indentStep: number;
  mobileIndentStep: number;
  indentMaxLevel: number;

  // Palette
  colorMode: ColorMode;
  paletteTransitionMs: number;

  // Drafts
  /** Render draft blocks as cards; off leaves the markers as plain text. */
  inPageDrafts: boolean;

  // Travel
  travelDefaultLevel: TravelDefaultLevel;
  travelWrap: boolean;

  // Deep headings
  deepHeadingLivePreview: boolean;
  deepHeadingReadingView: boolean;

  // Emphasis
  portEmphasisColors: boolean;

  // Debug
  debug: boolean;
}

export interface WeaverData {
  version: 1;
  settings: WeaverSettings;
  lastVaultMaxLevel: number;
  /** The shuttle: sources loaded and not yet woven in. Device-local session data. */
  shuttle: ShuttleItem[];
}

export const DEFAULT_SETTINGS: WeaverSettings = {
  timestampFormat: "HH:mm:ss",
  timestampSeparator: " - ",
  maxDepth: 12,

  sparkTarget: "today",
  writeDayCounters: true,
  dayNoteFolder: "Chronomancer",
  dayNoteFormat: "YYYY.MM.DD",

  equalizeHeadingSizes: true,
  headingSize: "1em",
  headingLevelSizes: {},
  headingWeight: 600,
  indentStep: 18,
  mobileIndentStep: 12,
  indentMaxLevel: 8,

  colorMode: "vault-stretch",
  paletteTransitionMs: 200,

  inPageDrafts: true,

  travelDefaultLevel: "all",
  travelWrap: false,

  deepHeadingLivePreview: true,
  deepHeadingReadingView: true,

  portEmphasisColors: true,

  debug: false
};

export const MIN_MAX_DEPTH = 6;
export const MAX_MAX_DEPTH = 24;

const HEADING_SIZE_PATTERN = /^\d+(\.\d+)?(em|rem|px)$/;

/** True for a CSS length Weaver will accept as a heading size. */
export function isValidHeadingSize(value: string): boolean {
  return HEADING_SIZE_PATTERN.test(value.trim());
}

export const DEFAULT_DATA: WeaverData = {
  version: 1,
  settings: DEFAULT_SETTINGS,
  lastVaultMaxLevel: 0,
  shuttle: []
};

/**
 * Keeps every row that names a real target and drops the rest. An unknown kind
 * cannot be rendered or woven, so it is dropped rather than guessed at.
 */
export function normalizeShuttle(data: unknown): ShuttleItem[] {
  if (!Array.isArray(data)) return [];

  const items: ShuttleItem[] = [];
  for (const entry of data) {
    if (!isPlainObject(entry)) continue;

    const kind = entry.kind;
    if (kind !== "note" && kind !== "dimension" && kind !== "words") continue;

    const path = text(entry.path, "");
    const label = text(entry.label, "");
    if (path === "" || label === "") continue;

    const item: ShuttleItem = {
      id: text(entry.id, "") || `restored-${items.length}`,
      kind,
      path,
      label,
      addedAt: text(entry.addedAt, "1970-01-01T00:00:00.000Z"),
      usedCount: integer(entry.usedCount, 0, 0, Number.MAX_SAFE_INTEGER)
    };
    if (typeof entry.headingText === "string" && entry.headingText !== "") {
      item.headingText = entry.headingText;
    }
    if (typeof entry.blockId === "string" && entry.blockId !== "") {
      item.blockId = entry.blockId;
    }
    items.push(item);
  }
  return items;
}

export function clamp(value: number, min: number, max: number): number {
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

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** Keeps only valid per-level sizes inside 1..maxDepth. */
export function normalizeLevelSizes(data: unknown, maxDepth: number): Record<number, string> {
  const sizes: Record<number, string> = {};
  if (!isPlainObject(data)) return sizes;

  for (let level = 1; level <= maxDepth; level += 1) {
    const value = data[String(level)];
    if (typeof value === "string" && isValidHeadingSize(value)) sizes[level] = value.trim();
  }
  return sizes;
}

/**
 * Normalizes any persisted payload into a complete, clamped settings object.
 * Unknown fields are dropped; invalid values fall back to the defaults.
 */
export function normalizeSettings(data: unknown): WeaverSettings {
  if (!isPlainObject(data)) return { ...DEFAULT_SETTINGS };

  const maxDepth = integer(data.maxDepth, DEFAULT_SETTINGS.maxDepth, MIN_MAX_DEPTH, MAX_MAX_DEPTH);

  const rawHeadingSize = text(data.headingSize, DEFAULT_SETTINGS.headingSize);
  const headingSize = isValidHeadingSize(rawHeadingSize)
    ? rawHeadingSize.trim()
    : DEFAULT_SETTINGS.headingSize;

  const rawTravelLevel = data.travelDefaultLevel;
  const travelDefaultLevel: TravelDefaultLevel =
    rawTravelLevel === "all"
      ? "all"
      : typeof rawTravelLevel === "number" && Number.isFinite(rawTravelLevel)
        ? clamp(Math.round(rawTravelLevel), 1, maxDepth)
        : DEFAULT_SETTINGS.travelDefaultLevel;

  return {
    timestampFormat: oneOf(data.timestampFormat, ["HH:mm:ss", "HH:mm"] as const, DEFAULT_SETTINGS.timestampFormat),
    timestampSeparator: text(data.timestampSeparator, DEFAULT_SETTINGS.timestampSeparator),
    maxDepth,

    sparkTarget: oneOf(data.sparkTarget, ["today", "note"] as const, DEFAULT_SETTINGS.sparkTarget),
    writeDayCounters: bool(data.writeDayCounters, DEFAULT_SETTINGS.writeDayCounters),
    dayNoteFolder: text(data.dayNoteFolder, DEFAULT_SETTINGS.dayNoteFolder),
    dayNoteFormat: text(data.dayNoteFormat, DEFAULT_SETTINGS.dayNoteFormat),

    equalizeHeadingSizes: bool(data.equalizeHeadingSizes, DEFAULT_SETTINGS.equalizeHeadingSizes),
    headingSize,
    headingLevelSizes: normalizeLevelSizes(data.headingLevelSizes, maxDepth),
    headingWeight: integer(data.headingWeight, DEFAULT_SETTINGS.headingWeight, 300, 800),
    indentStep: integer(data.indentStep, DEFAULT_SETTINGS.indentStep, 0, 48),
    mobileIndentStep: integer(data.mobileIndentStep, DEFAULT_SETTINGS.mobileIndentStep, 0, 32),
    indentMaxLevel: integer(data.indentMaxLevel, DEFAULT_SETTINGS.indentMaxLevel, 1, maxDepth),

    colorMode: oneOf(data.colorMode, ["vault-stretch", "fixed-anchor"] as const, DEFAULT_SETTINGS.colorMode),
    paletteTransitionMs: integer(data.paletteTransitionMs, DEFAULT_SETTINGS.paletteTransitionMs, 0, 1000),

    inPageDrafts: bool(data.inPageDrafts, DEFAULT_SETTINGS.inPageDrafts),

    travelDefaultLevel,
    travelWrap: bool(data.travelWrap, DEFAULT_SETTINGS.travelWrap),

    deepHeadingLivePreview: bool(data.deepHeadingLivePreview, DEFAULT_SETTINGS.deepHeadingLivePreview),
    deepHeadingReadingView: bool(data.deepHeadingReadingView, DEFAULT_SETTINGS.deepHeadingReadingView),

    portEmphasisColors: bool(data.portEmphasisColors, DEFAULT_SETTINGS.portEmphasisColors),

    debug: bool(data.debug, DEFAULT_SETTINGS.debug)
  };
}

const SETTING_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));

function looksLikeBareSettings(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => SETTING_KEYS.has(key));
}

/**
 * Normalizes persisted plugin data. A bare settings object written by an
 * earlier build is wrapped instead of being discarded.
 */
export function normalizeData(data: unknown): WeaverData {
  if (!isPlainObject(data)) {
    return { version: 1, settings: { ...DEFAULT_SETTINGS }, lastVaultMaxLevel: 0, shuttle: [] };
  }

  const lastVaultMaxLevel = integer(data.lastVaultMaxLevel, 0, 0, MAX_MAX_DEPTH);

  if (isPlainObject(data.settings)) {
    return {
      version: 1,
      settings: normalizeSettings(data.settings),
      lastVaultMaxLevel,
      shuttle: normalizeShuttle(data.shuttle)
    };
  }

  if (looksLikeBareSettings(data)) {
    return {
      version: 1,
      settings: normalizeSettings(data),
      lastVaultMaxLevel,
      shuttle: normalizeShuttle(data.shuttle)
    };
  }

  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    lastVaultMaxLevel,
    shuttle: normalizeShuttle(data.shuttle)
  };
}
