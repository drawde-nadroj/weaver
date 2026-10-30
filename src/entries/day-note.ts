/**
 * The day plane, resolved against the vault: which file today's note is, and how
 * to create it.
 *
 * The core Daily Notes plugin is the source of truth for the folder and the
 * filename format, because it is what opens the note. Its configuration is not
 * part of Obsidian's published API, so the lookup is defensive: when the plugin
 * or its options cannot be read, the two fallback settings decide the path.
 *
 * The name itself is pure and lives in `core/day.ts`; only the `TFile` half is
 * here, so `core` stays free of the Obsidian runtime.
 */

import { TFile, type App } from "obsidian";

import { dayFrontmatter, dayKey, dayNotePath, type DayNoteOptions } from "../core/day";
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

/** Today's day note path, and the file when it already exists. */
export function resolveDayNote(
  app: App,
  settings: WeaverSettings,
  now: Date
): { path: string; file: TFile | null } {
  const path = dayNotePath(now, dayNoteOptions(app, settings));
  const file = app.vault.getAbstractFileByPath(path);
  return { path, file: file instanceof TFile ? file : null };
}

/**
 * Returns the day note, creating the folder and the file when they are missing.
 * An existing note is never overwritten: creation only ever writes the
 * frontmatter block.
 */
export async function ensureDayNote(app: App, path: string, now: Date): Promise<TFile> {
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) return existing;

  const slash = path.lastIndexOf("/");
  if (slash > 0) {
    const folder = path.slice(0, slash);
    if (app.vault.getAbstractFileByPath(folder) === null) {
      await app.vault.createFolder(folder);
    }
  }

  return app.vault.create(path, dayFrontmatter(dayKey(now)));
}
