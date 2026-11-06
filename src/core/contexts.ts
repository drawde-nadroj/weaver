/**
 * The destinations Weaver may weave into, and the way back from a path.
 *
 * `main` is the day note the vault already treats as today's — the core Daily
 * Notes plugin's folder and format when it can be read, and the two fallback
 * settings when it cannot. It is reserved: it has no row of its own, its
 * definition keeps resolving through those existing rules, and every other
 * context is an explicit user-authored one that Daily Notes never overrides.
 *
 * The filename language is the one the day plane already expands — `YYYY`, `MM`
 * and `DD`, each appearing once, every other character a literal. Keeping the
 * language that small is what makes its inverse exist: `contextDayForPath`
 * matches a whole vault path back to the context and day it names, so a link can
 * cross between destinations and the daily view can read every configured note
 * without a second index of what happened. A format outside that language is
 * refused here, with the reason, rather than half-read later.
 *
 * The folder is a literal relative path, exactly as the day plane has always
 * treated it, and may be nested. Tokens live in the filename only.
 *
 * Pure: no DOM, no `obsidian`, no filesystem.
 */

import { dayKeyFromName, dayNotePathFor, type DayNoteOptions } from "./day";
import { isPlainObject } from "./value";

/** The reserved id of the day note the vault's own Daily Notes settings name. */
export const MAIN_CONTEXT_ID = "main";

/** That context's display name, which no additional context may reuse. */
export const MAIN_CONTEXT_NAME = "Main";

/** One destination a thought may be woven into. */
export interface WeavingContext {
  /** Stable, immutable identity; `main` is reserved. */
  id: string;
  /** The name a picker shows. Unique case-insensitively. */
  name: string;
  /** Vault-relative folder, literal. Empty means the vault root. */
  folder: string;
  /** Filename format in the `YYYY`/`MM`/`DD` language. */
  format: string;
}

/** A path recognised as one context's note for one day. */
export interface ContextDay {
  contextId: string;
  /** Canonical `YYYY-MM-DD`. */
  day: string;
  /** The path this recognition read. */
  path: string;
}

/** What one raw definition could not be used for, and where it sits. */
export interface ContextError {
  /** Zero-based index in the stored list; null when the list itself is wrong. */
  index: number | null;
  message: string;
}

/** One usable definition, with the raw row it was read from. */
export interface ContextRow {
  /** Zero-based index in the stored list. */
  index: number;
  context: WeavingContext;
}

/** The usable definitions, in stored order, and every reason the rest were not. */
export interface ContextRead {
  valid: WeavingContext[];
  /** The same definitions paired with their stored rows, for an editor to patch. */
  rows: ContextRow[];
  errors: ContextError[];
}

/** One day format, read: its literal folder, its tokens, and its whole template. */
export interface DayTemplate {
  /** Normalised folder: no leading or trailing slash. */
  folder: string;
  /** The filename format as given, trimmed. */
  format: string;
  /** The tokens in the order they appear in `format`. */
  tokens: readonly DayToken[];
  /** Folder, format and extension as one vault-relative path template. */
  source: string;
}

/** The only tokens a filename format may carry. */
export type DayToken = "YYYY" | "MM" | "DD";

/** Every token, in matching order, so `YYYY` is tested before `MM`. */
const TOKENS: readonly DayToken[] = ["YYYY", "MM", "DD"];

/** A run of letters, which in a format must be exactly one whole token. */
const WORD = /[A-Za-z]+/g;

/** Four digits, for a year in a path that is being read back. */
function pad4(value: number): string {
  return String(value).padStart(4, "0");
}

/**
 * A vault-relative folder, normalised, or the reason it is not one.
 *
 * A stored folder is data, so it is repaired rather than trusted: a leading or
 * trailing slash is dropped, and anything that would escape the vault or name an
 * empty segment is refused instead of being silently rewritten into some other
 * destination.
 */
function normalizeFolder(raw: string): { ok: true; folder: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.startsWith("/")) {
    return { ok: false, error: "the folder must be relative to the vault, not absolute" };
  }
  if (trimmed.includes("\\")) {
    return { ok: false, error: "separate folders with `/`, not `\\`" };
  }

  const cleaned = trimmed.replace(/^\/+|\/+$/g, "");
  if (cleaned === "") return { ok: true, folder: "" };

  for (const segment of cleaned.split("/")) {
    if (segment === "") return { ok: false, error: "the folder has an empty segment" };
    if (segment === "." || segment === "..") {
      return { ok: false, error: "the folder must not climb out of the vault" };
    }
  }

  return { ok: true, folder: cleaned };
}

/**
 * Reads a folder and a filename format into a template, or says what is wrong.
 *
 * Every letter run in the format must be `YYYY`, `MM` or `DD`, and none may
 * appear twice: a format the inverse cannot read is refused here rather than
 * accepted and then silently omitted from the daily view.
 */
export function parseDayTemplate(
  folder: string,
  format: string
): { ok: true; template: DayTemplate } | { ok: false; error: string } {
  const clean = normalizeFolder(folder);
  if (!clean.ok) return clean;

  const fmt = format.trim();
  if (fmt === "") return { ok: false, error: "the filename format must not be empty" };
  if (fmt.includes("/")) {
    return { ok: false, error: "put the folder in the folder field, not in the filename format" };
  }

  const seen = new Set<string>();
  const tokens: DayToken[] = [];
  for (const match of fmt.matchAll(WORD)) {
    const word = match[0];
    const token = TOKENS.find((candidate) => candidate === word);
    if (token === undefined) {
      return {
        ok: false,
        error: `\`${word}\` is not a supported format token; use YYYY, MM and DD, and characters between them`
      };
    }
    if (seen.has(token)) return { ok: false, error: `\`${token}\` appears more than once` };
    seen.add(token);
    tokens.push(token);
  }

  const source = clean.folder === "" ? `${fmt}.md` : `${clean.folder}/${fmt}.md`;
  return { ok: true, template: { folder: clean.folder, format: fmt, tokens, source } };
}

/** True when a template names a whole day, so a path can be read back into one. */
export function templateNamesADay(template: DayTemplate): boolean {
  return TOKENS.every((token) => template.tokens.includes(token));
}

/** Escapes everything a regular expression would otherwise read as syntax. */
function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The pattern a template's paths match, and the token each capture group holds.
 *
 * The format is scanned left to right, so the groups come out in the same order
 * as `DayTemplate.tokens` and the two walk together.
 */
function templatePattern(template: DayTemplate): {
  pattern: RegExp;
  order: readonly DayToken[];
} {
  const prefix = template.folder === "" ? "" : `${escapeLiteral(template.folder)}/`;
  const format = template.format;
  let body = "";
  let at = 0;

  while (at < format.length) {
    const token = TOKENS.find((candidate) => format.startsWith(candidate, at));
    if (token !== undefined) {
      body += token === "YYYY" ? "(\\d{4})" : "(\\d{2})";
      at += token.length;
      continue;
    }
    body += escapeLiteral(format[at] ?? "");
    at += 1;
  }

  return { pattern: new RegExp(`^${prefix}${body}\\.md$`), order: [...template.tokens] };
}

/**
 * A canonical day from its parts, or null when the calendar has no such date.
 *
 * The round trip is the check: February 30 and month 13 are typos in a filename,
 * not days, and no surface may be given one.
 */
function canonicalDay(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${pad4(year)}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The context and day a vault path names, or null when none does.
 *
 * The whole path is matched, never a folder prefix or a basename: two contexts
 * may share a folder, and only the complete template says which one a file
 * belongs to. A path that matches a template but carries no real date is not a
 * day note of that context.
 */
export function contextDayForPath(
  path: string,
  contexts: readonly WeavingContext[]
): ContextDay | null {
  const candidate = path.replace(/^\/+/, "");

  for (const context of contexts) {
    const parsed = parseDayTemplate(context.folder, context.format);
    if (!parsed.ok) continue;
    if (!templateNamesADay(parsed.template)) continue;

    const { pattern, order } = templatePattern(parsed.template);
    const match = pattern.exec(candidate);
    if (match === null) continue;

    const parts: Record<string, string> = {};
    order.forEach((token, index) => {
      parts[token] = match[index + 1] ?? "";
    });

    const day = canonicalDay(Number(parts["YYYY"]), Number(parts["MM"]), Number(parts["DD"]));
    if (day === null) return null;
    return { contextId: context.id, day, path: candidate };
  }

  return null;
}

/** The path a context's note for `day` has, whether or not the file exists. */
export function contextDayPath(context: WeavingContext, day: string): string {
  return dayNotePathFor(day, { folder: context.folder, format: context.format });
}

/** The reserved definition, resolved through the day plane's existing options. */
export function mainContext(options: DayNoteOptions): WeavingContext {
  return { id: MAIN_CONTEXT_ID, name: MAIN_CONTEXT_NAME, folder: options.folder, format: options.format };
}

/** Main first, then the additional contexts in stored order: the picker's order. */
export function effectiveContexts(
  options: DayNoteOptions,
  additional: readonly WeavingContext[]
): WeavingContext[] {
  return [mainContext(options), ...additional];
}

/**
 * The context with this id, or null.
 *
 * `main` always resolves, because it is defined by the day plane rather than by
 * a stored row; an additional context the vault could not read simply is not in
 * the list, and every caller refuses rather than falling back to another one.
 */
export function contextById(
  contexts: readonly WeavingContext[],
  id: string
): WeavingContext | null {
  return contexts.find((context) => context.id === id) ?? null;
}

/** The id a freshly added context carries, immutable from the moment it exists. */
export function freshContextId(): string {
  const crypto = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  // A vault is edited by one device at a time; time plus noise cannot collide
  // inside one list, and nothing else is claimed by the fallback.
  return `ctx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The name a picker shows, or the id when a stored row has no usable name. */
function readName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (name === "" || name.length > 60) return null;
  // Control characters would let a name lie about the row it labels.
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

/** One raw row, as a definition plus its template, or the reason it is neither. */
function readContext(
  raw: unknown
): { ok: true; context: WeavingContext; template: DayTemplate } | { ok: false; error: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "a context must be an object with an id, a name, a folder and a format" };
  }

  const row = raw;
  const id = typeof row["id"] === "string" ? row["id"].trim() : "";
  if (id === "") return { ok: false, error: "a context needs an id" };
  if (id === MAIN_CONTEXT_ID) {
    return { ok: false, error: `the id \`${MAIN_CONTEXT_ID}\` is reserved for the vault's own day note` };
  }

  const name = readName(row["name"]);
  if (name === null) return { ok: false, error: "a context needs a name of one to sixty characters" };

  const folder = typeof row["folder"] === "string" ? row["folder"] : "";
  const format = typeof row["format"] === "string" ? row["format"] : "";
  const parsed = parseDayTemplate(folder, format);
  if (!parsed.ok) return parsed;
  if (!templateNamesADay(parsed.template)) {
    return { ok: false, error: "the filename format must name the year, month and day with YYYY, MM and DD" };
  }

  return {
    ok: true,
    context: { id, name, folder: parsed.template.folder, format: parsed.template.format },
    template: parsed.template
  };
}

/**
 * The usable additional contexts, and every row that is not one.
 *
 * Nothing unvalidated reaches a resolver. A row is refused, with the reason,
 * when it is not an object, when its id is missing or reserved, when its name is
 * empty or already taken (case-insensitively, so a picker is never ambiguous),
 * when its folder or format cannot be read, or when another context already
 * writes to the same path template. `main` participates in those last two checks
 * when `main` options are supplied, so a row cannot quietly shadow the vault's
 * own day note.
 */
export function readContexts(value: unknown, main?: DayNoteOptions): ContextRead {
  const valid: WeavingContext[] = [];
  const rows: ContextRow[] = [];
  const errors: ContextError[] = [];

  if (value === undefined || value === null) return { valid, rows, errors };
  if (!Array.isArray(value)) {
    return {
      valid,
      rows,
      errors: [{ index: null, message: "the stored contexts are not a list; reset them before adding one" }]
    };
  }

  const names = new Set<string>([MAIN_CONTEXT_NAME.toLowerCase()]);
  const ids = new Set<string>([MAIN_CONTEXT_ID]);
  const sources = new Set<string>();
  if (main !== undefined) {
    const template = parseDayTemplate(main.folder, main.format);
    if (template.ok) sources.add(template.template.source.toLowerCase());
  }

  value.forEach((raw, index) => {
    const parsed = readContext(raw);
    if (!parsed.ok) {
      errors.push({ index, message: parsed.error });
      return;
    }

    const { context, template } = parsed;
    if (ids.has(context.id)) {
      errors.push({ index, message: `the id ${JSON.stringify(context.id)} is used twice` });
      return;
    }
    if (names.has(context.name.toLowerCase())) {
      errors.push({ index, message: `a context named ${JSON.stringify(context.name)} already exists` });
      return;
    }
    const source = template.source.toLowerCase();
    if (sources.has(source)) {
      errors.push({ index, message: `another destination already writes to ${template.source}` });
      return;
    }

    ids.add(context.id);
    names.add(context.name.toLowerCase());
    sources.add(source);
    valid.push(context);
    rows.push({ index, context });
  });

  return { valid, rows, errors };
}

/**
 * The reason a candidate destination cannot be added, or null when it can.
 *
 * The settings surface asks before writing a row, so a typo is refused with an
 * explanation beside the field rather than becoming a stored row that every
 * later resolve has to work around.
 */
export function contextDraftError(folder: string, format: string): string | null {
  const parsed = parseDayTemplate(folder, format);
  if (!parsed.ok) return parsed.error;
  if (!templateNamesADay(parsed.template)) {
    return "the filename format must name the year, month and day with YYYY, MM and DD";
  }
  return null;
}

/**
 * The day a source path belongs to when it is a configured day note, or when it
 * is an older dotted or dashed day note that predates configured destinations.
 *
 * The second case is deliberate reading support for notes written before
 * contexts existed: such a note is recognised by its basename alone and is never
 * a writing destination. Nothing else is a day note.
 */
export function sourceDayOf(path: string, contexts: readonly WeavingContext[]): string | null {
  const contained = contextDayForPath(path, contexts);
  if (contained !== null) return contained.day;
  const basename = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
  return dayKeyFromName(basename);
}

const DOTTED_DAY = /^\d{4}\.\d{2}\.\d{2}$/;
const DASHED_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The creation-day link for an entry whose recorded day differs from its note's.
 *
 * The target is a full vault path in the containing context's own format, so the
 * link crosses from one destination to another correctly; a note that is not a
 * configured destination keeps the basename-relative link it has always had. The
 * recorded day may be earlier or later than the note's — a branch written after
 * midnight belongs to yesterday's file — and a same-day or undated entry carries
 * no link at all.
 */
export function entryDayLinkTarget(
  day: string | null,
  sourcePath: string,
  contexts: readonly WeavingContext[]
): string | null {
  if (day === null) return null;

  const contained = contextDayForPath(sourcePath, contexts);
  if (contained !== null) {
    if (contained.day === day) return null;
    const context = contextById(contexts, contained.contextId);
    if (context === null) return null;
    return contextDayPath(context, day).replace(/\.md$/i, "");
  }

  const basename = (sourcePath.split("/").pop() ?? sourcePath).replace(/\.md$/i, "");
  const noteDay = dayKeyFromName(basename);
  if (noteDay === null || noteDay === day) return null;
  if (DOTTED_DAY.test(basename)) return day.replace(/-/g, ".");
  return DASHED_DAY.test(basename) ? day : null;
}
