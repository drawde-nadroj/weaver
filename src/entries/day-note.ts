/**
 * The day plane, resolved against the vault: which file a destination's note for
 * a given day is, and how to create it.
 *
 * The core Daily Notes plugin is the source of truth for `main`'s folder and
 * filename format, because it is what opens that note. Its configuration is not
 * part of Obsidian's published API, so the lookup is defensive: when the plugin
 * or its options cannot be read, the two fallback settings decide the path. Every
 * other destination is explicit and never inherits from it.
 *
 * A resolution always takes the day it is for. Reading "today" inside this module
 * would let a thought begun before midnight be filed after it.
 *
 * The template itself is pure and lives in `core/contexts.ts`; only the `TFile`
 * half is here, so `core` stays free of the Obsidian runtime.
 */

import { TFile, type App } from "obsidian";

import {
  contextById,
  contextDayPath,
  effectiveContexts,
  readContexts,
  type ContextError,
  type WeavingContext
} from "../core/contexts";
import { dayFrontmatter, type DayNoteOptions } from "../core/day";
import type { WeaverSettings } from "../settings";

interface DailyNotesShape {
  instance?: { options?: { folder?: unknown; format?: unknown } };
}

/** The Daily Notes configuration, when the internal plugin exposes it. */
function dailyNotesOptions(app: App): DayNoteOptions | null {
  try {
    // `internalPlugins` is not part of Obsidian's published API, so every read
    // is shape-checked and any surprise falls back to the two settings.
    const candidate: unknown = app;
    if (typeof candidate !== "object" || candidate === null) return null;
    if (!("internalPlugins" in candidate)) return null;

    const internal = candidate.internalPlugins;
    if (typeof internal !== "object" || internal === null) return null;

    let plugin: unknown;
    if ("getPluginById" in internal && typeof internal.getPluginById === "function") {
      plugin = internal.getPluginById("daily-notes");
    } else if ("plugins" in internal && typeof internal.plugins === "object" && internal.plugins !== null) {
      plugin = Object.entries(internal.plugins).find(([id]) => id === "daily-notes")?.[1];
    }
    if (typeof plugin !== "object" || plugin === null) return null;
    if (!("instance" in plugin) || typeof plugin.instance !== "object" || plugin.instance === null) {
      return null;
    }

    const { options } = plugin.instance as DailyNotesShape["instance"] & object;
    if (typeof options !== "object" || options === null) return null;

    const format =
      "format" in options && typeof options.format === "string" && options.format.trim() !== ""
        ? options.format
        : "YYYY-MM-DD";
    return { folder: "folder" in options && typeof options.folder === "string" ? options.folder : "", format };
  } catch {
    return null;
  }
}

/** The Daily Notes options when readable, else the two fallback settings. */
export function dayNoteOptions(app: App, settings: WeaverSettings): DayNoteOptions {
  return (
    dailyNotesOptions(app) ?? { folder: settings.dayNoteFolder, format: settings.dayNoteFormat }
  );
}

/**
 * Every destination this vault can weave into: `main` first, then the usable
 * additional contexts in stored order, with the reason each rejected row was not
 * one of them.
 *
 * `main` is always present, because it is defined by the day plane rather than by
 * a stored row; that is what keeps a vault with no additional contexts working
 * exactly as it did before they existed.
 */
export function contextList(
  app: App,
  settings: WeaverSettings
): { contexts: WeavingContext[]; errors: ContextError[] } {
  const options = dayNoteOptions(app, settings);
  const read = readContexts(settings.contexts, options);
  return { contexts: effectiveContexts(options, read.valid), errors: read.errors };
}

/** The file a destination's note for `day` has, and whether it exists yet. */
export type ResolvedContextDay =
  | { ok: true; path: string; file: TFile | null }
  | { ok: false; error: string };

/**
 * Resolves one destination's note for one day.
 *
 * A requested destination that is missing or unreadable is an error, never a
 * silent fall back to `main`: writing a thought somewhere the writer did not
 * choose is worse than refusing it. Nothing is created here — a passive read, a
 * picker and the daily view all resolve notes without making any.
 */
export function resolveContextDay(
  app: App,
  settings: WeaverSettings,
  contextId: string,
  day: string
): ResolvedContextDay {
  const { contexts, errors } = contextList(app, settings);
  const context = contextById(contexts, contextId);
  if (context === null) {
    const reason = errors.length > 0 ? ` (${errors[0]?.message ?? ""})` : "";
    return { ok: false, error: `there is no destination called ${JSON.stringify(contextId)}${reason}` };
  }

  const path = contextDayPath(context, day);
  const file = app.vault.getAbstractFileByPath(path);
  return { ok: true, path, file: file instanceof TFile ? file : null };
}

/**
 * Returns the day note at `path`, creating every missing folder in order and the
 * file itself when it is absent.
 *
 * An existing note is never overwritten: creation only ever writes the
 * frontmatter block. A concurrent create that wins the race is accepted by
 * re-reading the exact path, because the file that now exists is the one the
 * caller asked for. A folder sitting where the note belongs, or a file where one
 * of its folders belongs, is an actionable failure rather than something to
 * overwrite.
 */
export async function ensureDayNote(app: App, path: string, day: string): Promise<TFile> {
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) return existing;
  if (existing !== null) throw new Error(`${path} is a folder, not a note`);

  const segments = path.split("/");
  let folder = "";
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] ?? "";
    folder = folder === "" ? segment : `${folder}/${segment}`;
    const found = app.vault.getAbstractFileByPath(folder);
    if (found instanceof TFile) throw new Error(`${folder} is a file, not a folder`);
    if (found !== null) continue;

    try {
      await app.vault.createFolder(folder);
    } catch {
      // A concurrent create may have won the race; the note's own creation is
      // what decides whether the tree is usable, and it reports its own reason.
    }
  }

  try {
    return await app.vault.create(path, dayFrontmatter(day));
  } catch (error) {
    // Only an existing file at the exact path is a recovery; anything else is
    // the real reason the note could not be made.
    const raced = app.vault.getAbstractFileByPath(path);
    if (raced instanceof TFile) return raced;
    throw error;
  }
}
