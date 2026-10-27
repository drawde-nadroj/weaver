import { Notice, Platform, type App, type EventRef, type TFile } from "obsidian";

import { parseDrafts, type DraftBlock } from "../core/drafts";
import { NOTICE_PARTIAL_MS, NOTICE_SCAN_FAILED } from "../notices";

const DEBOUNCE_MS = 500;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 2_000_000;
const MOBILE_IDLE_DELAY_MS = 250;
const IDLE_TIMEOUT_MS = 2000;

interface CacheEntry {
  mtime: number;
  drafts: DraftBlock[];
}

export interface DraftEntry {
  file: TFile;
  draft: DraftBlock;
}

/** Newest first, then by path so equal timestamps from different files are stable. */
export function sortDraftEntries(entries: readonly DraftEntry[]): DraftEntry[] {
  return [...entries].sort((left, right) => {
    if (left.draft.openedAt !== right.draft.openedAt) {
      return left.draft.openedAt < right.draft.openedAt ? 1 : -1;
    }
    if (left.file.path !== right.file.path) return left.file.path < right.file.path ? -1 : 1;
    return left.draft.from - right.draft.from;
  });
}

export interface DraftGroup {
  file: TFile;
  /** The file's entries in the order they arrived (newest first). */
  entries: DraftEntry[];
}

/**
 * Groups entries by file, keeping the order in which each file first appears.
 * `openDrafts()` already sorts newest first, so the group holding the most recent
 * draft comes first and rows inside a group keep that order too.
 */
export function groupDraftsByFile(entries: readonly DraftEntry[]): DraftGroup[] {
  const groups = new Map<string, DraftGroup>();

  for (const entry of entries) {
    const path = entry.file.path;
    const existing = groups.get(path);
    if (existing === undefined) {
      groups.set(path, { file: entry.file, entries: [entry] });
      continue;
    }
    existing.entries.push(entry);
  }

  return [...groups.values()];
}

/**
 * Every open draft in the vault, cached by mtime.
 *
 * The scan is bounded the same way the palette scan is (5000 files, 2 MB each),
 * deferred to idle time on mobile, and rebuilt on a 500 ms debounce when the
 * vault changes. A failed scan keeps the previous results.
 */
export class VaultDraftIndex {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly refs: EventRef[] = [];
  private timer: number | null = null;
  private started = false;
  private inflight: Promise<DraftEntry[]> | null = null;
  private lastResults: DraftEntry[] = [];

  constructor(
    private readonly app: App,
    private readonly getMaxDepth: () => number
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;

    this.refs.push(
      this.app.vault.on("modify", () => this.schedule()),
      this.app.vault.on("create", () => this.schedule()),
      this.app.vault.on("delete", (file) => {
        this.cache.delete(file.path);
        this.schedule();
      }),
      this.app.vault.on("rename", (file, oldPath) => {
        this.cache.delete(oldPath);
        this.cache.delete(file.path);
        this.schedule();
      })
    );

    this.app.workspace.onLayoutReady(() => this.scheduleInitial());
  }

  stop(): void {
    this.started = false;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    for (const ref of this.refs) this.app.vault.offref(ref);
    this.refs.length = 0;
    this.cache.clear();
    this.lastResults = [];
  }

  /** Open drafts across the vault, newest first. */
  async openDrafts(force = false): Promise<DraftEntry[]> {
    if (this.inflight !== null) return this.inflight;

    this.inflight = this.scan(force).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private scheduleInitial(): void {
    if (!this.started) return;

    if (!Platform.isMobile) {
      void this.openDrafts(false);
      return;
    }

    const run = (): void => {
      if (this.started) void this.openDrafts(false);
    };
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
    } else {
      window.setTimeout(run, MOBILE_IDLE_DELAY_MS);
    }
  }

  private schedule(): void {
    if (!this.started) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (this.started) void this.openDrafts(false);
    }, DEBOUNCE_MS);
  }

  private async scan(force: boolean): Promise<DraftEntry[]> {
    try {
      const maxDepth = this.getMaxDepth();
      const files = this.app.vault.getMarkdownFiles().slice(0, MAX_FILES);
      const seen = new Set<string>();
      const entries: DraftEntry[] = [];

      for (const file of files) {
        seen.add(file.path);

        if (file.stat.size > MAX_FILE_BYTES) {
          this.cache.delete(file.path);
          continue;
        }

        const cached = this.cache.get(file.path);
        if (!force && cached !== undefined && cached.mtime === file.stat.mtime) {
          for (const draft of cached.drafts) entries.push({ file, draft });
          continue;
        }

        const source = await this.app.vault.cachedRead(file);
        const drafts = parseDrafts(source, maxDepth);
        this.cache.set(file.path, { mtime: file.stat.mtime, drafts });
        for (const draft of drafts) entries.push({ file, draft });
      }

      for (const path of [...this.cache.keys()]) {
        if (!seen.has(path)) this.cache.delete(path);
      }

      this.lastResults = sortDraftEntries(entries);
      return this.lastResults;
    } catch (error) {
      console.error("Weaver: draft scan failed", error);
      new Notice(NOTICE_SCAN_FAILED, NOTICE_PARTIAL_MS);
      return this.lastResults;
    }
  }
}
