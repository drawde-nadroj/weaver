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

import { isPlainObject } from "./core/value";
import { readReviewMap, type ReviewMap } from "./core/reviews";

/** Every setting Weaver has, in the groups the tab shows them in. */
export interface WeaverSettings {
  // Writing
  /** Rewrite the day note's `travels`, `depth` and `duration` fields. */
  writeDayCounters: boolean;
  /**
   * Offer invitations at all.
   *
   * The master switch: off hides every offering — the built-in rhythm and every
   * configured schedule alike — without touching entries, saved threads or the
   * history a note already carries.
   */
  portalsEnabled: boolean;
  /**
   * Offer the built-in rhythm: the local minutes :00/:11/:22/:33/:44/:55 and each
   * mirrored HH:HH, announced eleven minutes ahead.
   */
  rhythmicPortalsEnabled: boolean;
  /**
   * Every configured invitation, exactly as stored.
   *
   * Raw for the same reason the context list is: an unreadable row is the
   * writer's data and is reported, not rewritten into some other schedule.
   */
  portalSchedules: unknown;
  /**
   * How much the invitation's rainbow moves: static when off, and never a
   * second simultaneous animation.
   */
  portalMotion: "off" | "slow" | "normal" | "fast";

  // Day
  /**
   * Fallback folder for the `main` context, used only when the Daily Notes plugin
   * cannot be read.
   */
  dayNoteFolder: string;
  /** Fallback filename format for `main`, used in the same circumstance. */
  dayNoteFormat: string;
  /**
   * Every additional destination a thought may be woven into, exactly as stored.
   *
   * Kept raw on purpose: an unreadable row is the writer's data, so it is
   * preserved verbatim and reported by `readContexts` rather than being rewritten
   * into some other destination. Only validated rows ever resolve a path.
   */
  contexts: unknown;

  // Look
  equalizeEntrySizes: boolean;
  entrySize: string;
  indentStep: number;
  mobileIndentStep: number;
  indentMaxLevel: number;
  portEmphasisColors: boolean;
  /** Draw a frame around every entry: the rails run through the middle of the address and clock rows, cut behind those labels. */
  entryFrames: boolean;
  /**
   * Start a frame at the entry's own indent. On, a nested entry's frame begins
   * further right, so nesting reads as a staircase; off, every frame begins in the
   * left margin and only the prose carries the indent, so the addresses and the
   * times line up down the note.
   */
  frameFollowsIndent: boolean;
  /**
   * Air below a complete Thread, in pixels: the space between one depth-1
   * entry's whole subtree and the next Thread. Zero keeps the note's old rhythm.
   */
  threadSpacing: number;
  /**
   * Air between branch entries inside a Thread, in pixels: each branch after the
   * Thread's first begins this much lower than the row above it. Zero keeps the
   * note's old rhythm.
   */
  branchSpacing: number;

  // Whisper
  /** Ask the model for a whisper on the idle pause, and again at settle. */
  whisperEnabled: boolean;
  /** The endpoint a whisper is asked of. A loopback address is this machine only. */
  whisperEndpoint: string;
  /** The model's name at that endpoint. A thinking model needs its reasoning turned off in the model's own settings. */
  whisperModelId: string;
  /** Sent as a bearer token when it is not empty; kept in plain text in `data.json`. */
  whisperApiKey: string;
  /**
   * Ask the day-level question as well: one extra request per entry, placing it in
   * its day. Off because a 4B answers it thinly — measured, one usable placement per
   * day's twenty entries — so it is turned on when the model can carry it.
   */
  whisperThreads: boolean;

  // Advanced
  debug: boolean;
}

/** What is on disk: a version, one settings object, and the shared Reviews. */
export interface WeaverData {
  version: 4;
  settings: WeaverSettings;
  /** Reviews travel in `data.json` so a configured vault sync shares them. */
  reviews: ReviewMap;
}

/** Every field's value before a vault says otherwise. */
export const DEFAULT_SETTINGS: WeaverSettings = {
  writeDayCounters: true,
  portalsEnabled: true,
  rhythmicPortalsEnabled: true,
  portalSchedules: [],
  portalMotion: "normal",

  dayNoteFolder: "Chronomancer",
  dayNoteFormat: "YYYY.MM.DD",
  contexts: [],

  equalizeEntrySizes: true,
  entrySize: "1em",
  indentStep: 18,
  mobileIndentStep: 12,
  indentMaxLevel: 8,
  portEmphasisColors: true,

  entryFrames: true,
  frameFollowsIndent: true,
  threadSpacing: 0,
  branchSpacing: 0,

  whisperEnabled: false,
  whisperEndpoint: "http://127.0.0.1:8000/v1",
  whisperModelId: "Qwen3.5-4B-MLX-4bit",
  whisperApiKey: "",
  whisperThreads: false,

  debug: false
};

const ENTRY_SIZE_PATTERN = /^\d+(\.\d+)?(em|rem|px)$/;

/** True for a CSS length Weaver will accept as an entry size. */
export function isValidEntrySize(value: string): boolean {
  return ENTRY_SIZE_PATTERN.test(value.trim());
}

const ENDPOINT_PATTERN = /^https?:\/\/[^\s]+$/;

/** True for an absolute http(s) endpoint with no whitespace. */
export function isValidWhisperEndpoint(value: string): boolean {
  return ENDPOINT_PATTERN.test(value.trim());
}

/** Every host that means "the machine the request is made from", never another one. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "[::1]", "::1"]);

/**
 * True when this device can reach a whisper endpoint at all.
 *
 * `data.json` syncs, so a loopback endpoint travels with the vault and means *the
 * reader's own device*. On a phone that is guaranteed to reach nothing, so the
 * phone does not ask: capture is untouched, rendering is complete, and the
 * address the writer sets is one both machines can reach.
 */
export function whisperReachable(endpoint: string, mobile: boolean): boolean {
  if (!isValidWhisperEndpoint(endpoint)) return false;
  if (!mobile) return true;

  try {
    return !LOOPBACK_HOSTS.has(new URL(endpoint.trim()).hostname);
  } catch {
    return false;
  }
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

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return clamp(Math.round(numeric), min, max);
}

/** One of the four motion settings, or the fallback for anything else. */
function motion(value: unknown, fallback: WeaverSettings["portalMotion"]): WeaverSettings["portalMotion"] {
  return value === "off" || value === "slow" || value === "normal" || value === "fast"
    ? value
    : fallback;
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
    portalsEnabled: bool(raw.portalsEnabled, DEFAULT_SETTINGS.portalsEnabled),
    rhythmicPortalsEnabled: bool(
      raw.rhythmicPortalsEnabled,
      DEFAULT_SETTINGS.rhythmicPortalsEnabled
    ),
    portalSchedules:
      raw.portalSchedules === undefined ? DEFAULT_SETTINGS.portalSchedules : raw.portalSchedules,
    portalMotion: motion(raw.portalMotion, DEFAULT_SETTINGS.portalMotion),

    dayNoteFolder: text(raw.dayNoteFolder, DEFAULT_SETTINGS.dayNoteFolder),
    dayNoteFormat: text(raw.dayNoteFormat, DEFAULT_SETTINGS.dayNoteFormat),
    // Not normalized: a stored list is data, and an unreadable one must stay
    // readable as the thing that needs repairing.
    contexts: raw.contexts === undefined ? DEFAULT_SETTINGS.contexts : raw.contexts,

    equalizeEntrySizes: bool(raw.equalizeEntrySizes, DEFAULT_SETTINGS.equalizeEntrySizes),
    entrySize: isValidEntrySize(rawEntrySize) ? rawEntrySize.trim() : DEFAULT_SETTINGS.entrySize,
    indentStep: integer(raw.indentStep, DEFAULT_SETTINGS.indentStep, 0, 48),
    mobileIndentStep: integer(raw.mobileIndentStep, DEFAULT_SETTINGS.mobileIndentStep, 0, 32),
    indentMaxLevel: integer(raw.indentMaxLevel, DEFAULT_SETTINGS.indentMaxLevel, 1, 24),
    portEmphasisColors: bool(raw.portEmphasisColors, DEFAULT_SETTINGS.portEmphasisColors),
    entryFrames: bool(raw.entryFrames, DEFAULT_SETTINGS.entryFrames),
    frameFollowsIndent: bool(raw.frameFollowsIndent, DEFAULT_SETTINGS.frameFollowsIndent),
    threadSpacing: integer(raw.threadSpacing, DEFAULT_SETTINGS.threadSpacing, 0, 48),
    branchSpacing: integer(raw.branchSpacing, DEFAULT_SETTINGS.branchSpacing, 0, 48),

    whisperEnabled: bool(raw.whisperEnabled, DEFAULT_SETTINGS.whisperEnabled),
    whisperEndpoint: text(raw.whisperEndpoint, DEFAULT_SETTINGS.whisperEndpoint),
    whisperModelId: text(raw.whisperModelId, DEFAULT_SETTINGS.whisperModelId),
    whisperApiKey: text(raw.whisperApiKey, DEFAULT_SETTINGS.whisperApiKey),
    whisperThreads: bool(raw.whisperThreads, DEFAULT_SETTINGS.whisperThreads),

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
 * the current version — the migration is the normalization. Shared Reviews are
 * decoded leniently here; a store that must refuse to overwrite unreadable data
 * checks the raw envelope itself.
 */
export function normalizeData(data: unknown): WeaverData {
  if (!isPlainObject(data)) {
    return { version: 4, settings: { ...DEFAULT_SETTINGS }, reviews: {} };
  }

  const reviews = readReviewMap(isPlainObject(data.reviews) ? data.reviews : undefined).reviews;

  if (isPlainObject(data.settings)) {
    return { version: 4, settings: normalizeSettings(data.settings), reviews };
  }

  if (looksLikeBareSettings(data)) {
    return { version: 4, settings: normalizeSettings(data), reviews };
  }

  return { version: 4, settings: { ...DEFAULT_SETTINGS }, reviews };
}
