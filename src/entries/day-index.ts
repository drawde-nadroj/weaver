/**
 * Which drafts exist, across the day-note folder only.
 *
 * The scan is bounded (5000 files, 2 MB each) and cached by `mtime`, so a repeat
 * scan reads only what changed. A failed scan keeps the previous results rather
 * than emptying the travel list.
 */

import type { App, EventRef, TAbstractFile } from "obsidian";

import { dayKeyFromName, resolveDayNote } from "../core/day-note";
import { parseEntries, type Entry } from "../core/entries";
import type { WeaverSettings } from "../settings";
import { isMobile } from "../ui/platform";

const DEBOUNCE_MS = 500;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 2_000_000;
const IDLE_TIMEOUT_MS = 2000;

export interface DayDrafts {
  path: string;
  dayKey: string;
  entries: Entry[];
}

interface CachedDay {
  mtime: number;
  entries: Entry[];
}

export class DayIndex {
  private readonly cache = new Map<string, CachedDay>();
  private readonly refs: EventRef[] = [];
  private timer: number | null = null;
  private pending: Promise<DayDrafts[]> | null = null;
  private last: DayDrafts[] = [];
  private started = false;

  constructor(
    private readonly app: App,
    private readonly getSettings: () => WeaverSettings
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;

    this.refs.push(
      this.app.vault.on("modify", () => this.schedule()),
      this.app.vault.on("create", () => this.schedule()),
      this.app.vault.on("delete", (file: TAbstractFile) => {
        this.cache.delete(file.path);
        this.schedule();
      }),
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        this.cache.delete(oldPath);
        this.cache.delete(file.path);
        this.schedule();
      })
    );
  }

  stop(): void {
    this.started = false;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;

    for (const ref of this.refs) this.app.vault.offref(ref);
    this.refs.length = 0;
    this.cache.clear();
    this.last = [];
  }

  /** Days holding at least one draft, ascending; `force` re-reads every file. */
  drafts(force = false): Promise<DayDrafts[]> {
    this.pending ??= this.scan(force).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private schedule(): void {
    if (!this.started) return;
    if (this.timer !== null) window.clearTimeout(this.timer);

    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (!this.started) return;

      const run = (): void => {
        if (this.started) void this.drafts(false);
      };

      // A phone should not spend its first frame on a vault scan.
      if (isMobile() && typeof requestIdleCallback === "function") {
        requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
        return;
      }
      run();
    }, DEBOUNCE_MS);
  }

  private async scan(force: boolean): Promise<DayDrafts[]> {
    try {
      const folder = this.folder();
      const files = this.app.vault
        .getMarkdownFiles()
        .filter((file) => {
          if (folder !== "" && !file.path.startsWith(`${folder}/`)) return false;
          return dayKeyFromName(file.basename) !== null;
        })
        .slice(0, MAX_FILES);

      const seen = new Set<string>();
      const days: DayDrafts[] = [];

      for (const file of files) {
        seen.add(file.path);
        const cached = this.cache.get(file.path);

        if (!force && cached !== undefined && cached.mtime === file.stat.mtime) {
          this.collect(file.path, file.basename, cached.entries, days);
          continue;
        }

        if (file.stat.size > MAX_FILE_BYTES) {
          this.cache.delete(file.path);
          continue;
        }

        const source = await this.app.vault.cachedRead(file);
        const entries = parseEntries(source).entries.filter((entry) => entry.state === "draft");
        this.cache.set(file.path, { mtime: file.stat.mtime, entries });
        this.collect(file.path, file.basename, entries, days);
      }

      for (const path of [...this.cache.keys()]) {
        if (!seen.has(path)) this.cache.delete(path);
      }

      this.last = days.sort((left, right) => left.dayKey.localeCompare(right.dayKey));
      return this.last;
    } catch (error) {
      console.error("Weaver: day scan failed", error);
      return this.last;
    }
  }

  private collect(path: string, basename: string, entries: Entry[], days: DayDrafts[]): void {
    if (entries.length === 0) return;
    const dayKey = dayKeyFromName(basename);
    if (dayKey === null) return;
    days.push({ path, dayKey, entries: [...entries] });
  }

  /** The day-note folder, so an unrelated note is never scanned for entries. */
  private folder(): string {
    const path = resolveDayNote(this.app, this.getSettings(), new Date()).path;
    const cut = path.lastIndexOf("/");
    return cut < 0 ? "" : path.slice(0, cut);
  }
}
