import { Notice, Platform, type App, type EventRef } from "obsidian";

import { parseHeadings } from "./core/headings";
import { NOTICE_PARTIAL_MS, NOTICE_SCAN_FAILED } from "./notices";

const DEBOUNCE_MS = 500;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 2_000_000;
const MOBILE_IDLE_DELAY_MS = 250;
const IDLE_TIMEOUT_MS = 2000;

interface ScanEntry {
  mtime: number;
  maxLevel: number;
}

/**
 * Tracks the deepest heading level present in the vault so the palette can be
 * stretched across the levels actually in use.
 *
 * The scan is bounded (5000 files, 2 MB each) and cached by mtime, so repeat
 * scans only read what changed. Failures keep the last known depth.
 */
export class VaultPaletteScanner {
  private readonly app: App;
  private readonly getMaxDepth: () => number;
  private readonly getLastMaxLevel: () => number;
  private readonly onDepth: (level: number) => void;

  private readonly cache = new Map<string, ScanEntry>();
  private readonly refs: EventRef[] = [];
  private timer: number | null = null;
  private depth = 0;
  private running = false;
  private started = false;

  constructor(
    app: App,
    getMaxDepth: () => number,
    getLastMaxLevel: () => number,
    onDepth: (level: number) => void
  ) {
    this.app = app;
    this.getMaxDepth = getMaxDepth;
    this.getLastMaxLevel = getLastMaxLevel;
    this.onDepth = onDepth;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.depth = this.getLastMaxLevel();

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
  }

  private scheduleInitial(): void {
    if (!this.started || this.running) return;

    if (!Platform.isMobile) {
      void this.rescan(false);
      return;
    }

    const run = () => {
      if (this.started) void this.rescan(false);
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
      if (this.started) void this.rescan(false);
    }, DEBOUNCE_MS);
  }

  /** Walks the vault, updating the cached depth when it changes. */
  async rescan(force = false): Promise<void> {
    if (this.running && !force) return;
    this.running = true;

    try {
      const maxDepth = this.getMaxDepth();
      const files = this.app.vault.getMarkdownFiles().slice(0, MAX_FILES);
      const seen = new Set<string>();
      let maximum = 0;

      for (const file of files) {
        seen.add(file.path);
        const cached = this.cache.get(file.path);

        if (!force && cached !== undefined && cached.mtime === file.stat.mtime) {
          if (cached.maxLevel > maximum) maximum = cached.maxLevel;
          continue;
        }

        if (file.stat.size > MAX_FILE_BYTES) {
          this.cache.delete(file.path);
          continue;
        }

        const source = await this.app.vault.cachedRead(file);
        const level = parseHeadings(source, { maxDepth }).maxLevel;
        this.cache.set(file.path, { mtime: file.stat.mtime, maxLevel: level });
        if (level > maximum) maximum = level;
      }

      for (const path of [...this.cache.keys()]) {
        if (!seen.has(path)) this.cache.delete(path);
      }

      this.running = false;

      if (maximum !== this.depth) {
        this.depth = maximum;
        this.onDepth(maximum);
      }
    } catch (error) {
      this.running = false;
      console.error("Weaver: vault palette scan failed", error);
      new Notice(NOTICE_SCAN_FAILED, NOTICE_PARTIAL_MS);
    }
  }
}
