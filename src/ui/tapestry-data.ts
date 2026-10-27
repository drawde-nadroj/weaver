/**
 * What the Tapestry reads, and from where.
 *
 * Note and Day scopes read a file and parse it. Month and All scopes read only
 * the counters the metadata cache already holds, and never open a file — a view
 * that scans the whole vault on every keystroke is not an overview, it is a
 * vault scan with a title.
 */

import { TFile, type App } from "obsidian";

import { countDay, type DayCounts } from "../core/day-counters";
import { dayKey, dayKeyFromName, resolveDayNote } from "../core/day-note";
import { pad2 } from "../core/clock";
import { parseHeadings, type Heading } from "../core/headings";
import { parseMarks } from "../core/marks";
import { threadRows, type ThreadRow } from "../core/threads";
import type { DraftEntry } from "../drafts/vault-index";
import { headingIndexField } from "../editor/index-field";
import { findEditorViewForFile } from "../editor/view-registry";
import type WeaverPlugin from "../main";
import type { WeaverSettings } from "../settings";
import { calendarWeeks, type CalendarDay } from "./calendar";

export type Scope = "note" | "day" | "month" | "all";

export interface DayRow {
  /** `YYYY-MM-DD`. */
  key: string;
  count: number;
  closed: boolean;
  path: string;
}

/** How many weeks a scope draws: a quarter at Month, a year at All. */
export function calendarWeeksFor(scope: Scope): number {
  return scope === "month" ? 12 : 53;
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** Every day note in the vault's day-note folder, newest key last. */
function allDayNotes(app: App, settings: WeaverSettings, now: Date): TFile[] {
  const folder = folderOf(resolveDayNote(app, settings, now).path);
  const files = app.vault
    .getMarkdownFiles()
    .filter((file) => folder === "" || file.path.startsWith(`${folder}/`))
    .filter((file) => dayKeyFromName(file.basename) !== null);

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/** The files a scope reads, in calendar order. */
export function scopeFiles(
  app: App,
  scope: Scope,
  now: Date,
  settings: WeaverSettings
): TFile[] {
  if (scope === "note") {
    const active = app.workspace.getActiveFile();
    return active === null ? [] : [active];
  }

  if (scope === "day") {
    const file = resolveDayNote(app, settings, now).file;
    return file === null ? [] : [file];
  }

  const notes = allDayNotes(app, settings, now);
  if (scope === "all") return notes;

  const month = dayKey(now).slice(0, 7);
  return notes.filter((file) => (dayKeyFromName(file.basename) ?? "").startsWith(month));
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

/**
 * Day totals from the metadata cache. A file without counters counts as zero,
 * which is a missing reading rather than a guess.
 *
 * `closed` is always false here: the closing mark is not a frontmatter field, so
 * a scope that refuses to open files cannot know it.
 */
export function cachedDayRows(app: App, files: readonly TFile[]): DayRow[] {
  const rows: DayRow[] = [];

  for (const file of files) {
    const key = dayKeyFromName(file.basename);
    if (key === null) continue;

    const frontmatter = app.metadataCache?.getFileCache(file)?.frontmatter;
    rows.push({
      key,
      count: numberOrZero(frontmatter?.sparks),
      closed: false,
      path: file.path
    });
  }

  return rows;
}

/** `2026-10` for the current month, used by the Day headers. */
export function monthKey(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
}

/**
 * The day note's first untitled 1D, so the Review's untitled row lands on the
 * dimension it names instead of on the note.
 */
export async function firstUntitledSpark(
  app: App,
  settings: WeaverSettings,
  now: Date
): Promise<{ file: TFile; heading: Heading } | null> {
  const file = scopeFiles(app, "day", now, settings)[0];
  if (file === undefined) return null;

  const source = await app.vault.cachedRead(file);
  const index = parseHeadings(source, { maxDepth: settings.maxDepth });
  const heading = index.headings.find(
    (candidate) => candidate.level === 1 && candidate.title.trim() === ""
  );
  return heading === undefined ? null : { file, heading };
}

/** Everything a scope needs to render, gathered without a view around it. */
export interface TapestryLoad {
  counts: DayCounts;
  threads: ThreadRow[];
  dimensions: Heading[];
  drafts: DraftEntry[];
  days: DayRow[];
  weeks: CalendarDay[][];
  noteLabel: string;
  hasDayNote: boolean;
  draftsLoaded: boolean;
  activePath: string | null;
}

const EMPTY_COUNTS: DayCounts = {
  sparks: 0,
  dimensions: 0,
  sources: 0,
  untitled: 0,
  lastMark: null,
  closedAt: null
};

/**
 * Reads one scope. Note and Day scopes parse a file; Month and All read the
 * counters the metadata cache already holds and never open a file.
 */
export class TapestrySource {
  constructor(private readonly plugin: WeaverPlugin) {}

  async load(scope: Scope): Promise<TapestryLoad> {
    const app = this.plugin.app;
    const now = new Date();
    const activePath = app.workspace.getActiveFile()?.path ?? null;

    if (scope === "note") {
      const dimensions = await this.readActiveDimensions();
      const drafts = await this.readDrafts();
      return {
        counts: EMPTY_COUNTS,
        threads: [],
        dimensions,
        drafts,
        days: [],
        weeks: [],
        noteLabel: app.workspace.getActiveFile()?.basename ?? "",
        hasDayNote: false,
        draftsLoaded: true,
        activePath
      };
    }

    if (scope === "day") {
      const file = resolveDayNote(app, this.plugin.settings, now).file;
      const dayDrafts = (await this.readDrafts()).filter((entry) => entry.file.path === file?.path);

      if (file === null) {
        return {
          counts: EMPTY_COUNTS,
          threads: [],
          dimensions: [],
          drafts: dayDrafts,
          days: [],
          weeks: [],
          noteLabel: "",
          hasDayNote: false,
          draftsLoaded: true,
          activePath
        };
      }

      const source = await app.vault.cachedRead(file);
      const index = parseHeadings(source, { maxDepth: this.plugin.settings.maxDepth });
      const marks = parseMarks(source);
      return {
        counts: countDay(index, marks),
        threads: threadRows(index, marks),
        dimensions: index.headings,
        drafts: dayDrafts,
        days: [],
        weeks: [],
        noteLabel: file.basename,
        hasDayNote: true,
        draftsLoaded: true,
        activePath
      };
    }

    const files = scopeFiles(app, scope, now, this.plugin.settings);
    const days = [...cachedDayRows(app, files)].reverse();

    let sparks = 0;
    let dimensions = 0;
    for (const file of files) {
      const frontmatter = app.metadataCache?.getFileCache(file)?.frontmatter;
      sparks += Number(frontmatter?.sparks) || 0;
      dimensions += Number(frontmatter?.dimensions) || 0;
    }

    const counts = new Map<string, { count: number; closed: boolean }>();
    for (const day of days) counts.set(day.key, { count: day.count, closed: day.closed });

    return {
      counts: { ...EMPTY_COUNTS, sparks, dimensions },
      threads: [],
      dimensions: [],
      drafts: [],
      days,
      weeks: calendarWeeks(counts, dayKey(now), calendarWeeksFor(scope)),
      noteLabel: "",
      hasDayNote: false,
      draftsLoaded: true,
      activePath
    };
  }

  /** The live editor index first, so unsaved typing shows up; else the saved file. */
  private async readActiveDimensions(): Promise<Heading[]> {
    const app = this.plugin.app;
    const file = app.workspace.getActiveFile();
    if (file === null) return [];

    const view = findEditorViewForFile(file);
    const live = view?.state.field(headingIndexField, false);
    if (live !== undefined) return [...live.headings];

    const source = await app.vault.cachedRead(file);
    return parseHeadings(source, { maxDepth: this.plugin.settings.maxDepth }).headings;
  }

  private async readDrafts(): Promise<DraftEntry[]> {
    return [...(await this.plugin.draftIndex.openDrafts())];
  }
}
