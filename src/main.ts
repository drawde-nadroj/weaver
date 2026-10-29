/**
 * Weaver: a day note is a linear list of entries.
 *
 * An entry is `{ D.C.N } - HH:MM:SS`, its prose, and one duration line. The note
 * and the travel card are the whole surface: nothing else navigates, and nothing
 * else writes.
 */

import { MarkdownView, Notice, Plugin, TFile } from "obsidian";

import { formatClock } from "./core/clock";
import { parseClose, planCloseDay } from "./core/close";
import { applyDayStats, recountDay, writeDayStats } from "./core/day-stats";
import { dayKey, resolveDayNote } from "./core/day-note";
import { parseEntries } from "./core/entries";
import { applyPlanToSource } from "./core/insert";
import type { TravelRow } from "./core/travel-model";
import { closeDecorationsExtension } from "./editor/close-decorations";
import { entryDecorationsExtension } from "./editor/entry-decorations";
import { entryFrameExtension } from "./editor/entry-frame";
import { entryEditExtension, entryKeysExtension } from "./editor/entry-keys";
import { entryIndexExtension, refreshEntriesEffect } from "./editor/entry-field";
import { travelTargetExtension } from "./editor/travel-target";
import { registeredEditorViews, viewRegistryExtension } from "./editor/view-registry";
import { DayIndex } from "./entries/day-index";
import { EntryEngine } from "./entries/engine";
import { EntrySession } from "./entries/session";
import {
  NOTICE_DAY_ALREADY_CLOSED,
  NOTICE_DAY_CLOSED,
  NOTICE_NO_DAY_NOTE,
  NOTICE_NO_DRAFTS,
  NOTICE_NOOP_MS,
  NOTICE_REFUSAL_MS
} from "./notices";
import { createCloseProcessor } from "./reading/close-processor";
import { createEntryProcessor } from "./reading/entry-processor";
import { normalizeData, type WeaverData, type WeaverSettings } from "./settings";
import { WeaverSettingTab } from "./settings-tab";
import { applyCss, removeCss } from "./ui/css";
import { EntryPalette } from "./ui/entry-palette";
import { isMobile, isPhone, isTablet } from "./ui/platform";
import { TravelModal } from "./ui/travel-modal";

/** Hand edits in the day note settle for this long before the stats follow. */
const DAY_STATS_DELAY_MS = 2000;

const BODY_CLASSES = [
  "weaver-no-emphasis",
  "weaver-unequal",
  "weaver-frames",
  "weaver-platform-mobile",
  "weaver-phone",
  "weaver-tablet"
];

export default class WeaverPlugin extends Plugin {
  data: WeaverData = normalizeData(null);
  settings: WeaverSettings = this.data.settings;

  session = new EntrySession();
  entries!: EntryEngine;
  dayIndex!: DayIndex;
  /** The entry travel last opened, mirrored into the editor's own field. */
  travelTarget: { path: string; seq: number } | null = null;

  private travelModal: TravelModal | null = null;
  private palette: EntryPalette | null = null;
  private dayStatsTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.syncBodyClasses();
    applyCss(this.settings);

    this.session = new EntrySession();
    this.entries = new EntryEngine(this);

    this.registerEditorExtension([
      viewRegistryExtension,
      entryIndexExtension(),
      entryDecorationsExtension(
        () => this.settings,
        () => this.session,
        () => this.app.workspace.getActiveFile()?.path ?? "",
        (target, sourcePath) => {
          void this.app.workspace.openLinkText(target, sourcePath, false);
        }
      ),
      closeDecorationsExtension(),
      entryFrameExtension({
        settings: () => this.settings,
        session: () => this.session,
        fallbackPath: () => this.app.workspace.getActiveFile()?.path ?? "",
        openDayLink: (target, sourcePath) => {
          void this.app.workspace.openLinkText(target, sourcePath, false);
        }
      }),
      travelTargetExtension(() => this.app.workspace.getActiveFile()?.path ?? ""),
      entryKeysExtension(this),
      entryEditExtension(this)
    ]);

    this.registerMarkdownPostProcessor(createEntryProcessor(this));
    this.registerMarkdownPostProcessor(createCloseProcessor());

    this.dayIndex = new DayIndex(this.app, () => this.settings);
    this.dayIndex.start();

    this.registerEvent(
      this.app.vault.on("modify", (file) => this.scheduleDayStats(file instanceof TFile ? file : null))
    );
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.entries.pause(new Date())));
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") this.entries.pause(new Date());
    });

    this.registerCommands();
    this.addSettingTab(new WeaverSettingTab(this.app, this));

    console.log(`Weaver loaded ${this.manifest.version}`);
  }

  onunload(): void {
    if (this.dayStatsTimer !== null) {
      window.clearTimeout(this.dayStatsTimer);
      this.dayStatsTimer = null;
    }

    this.travelModal?.close();
    this.travelModal = null;
    this.palette?.close();
    this.palette = null;
    this.dayIndex?.stop();
    removeCss();
    document.body.classList.remove(...BODY_CLASSES);
  }

  async saveSettings(): Promise<void> {
    this.data.settings = this.settings;
    await this.saveData(this.data);
  }

  log(...args: unknown[]): void {
    if (this.settings.debug) console.log("[Weaver]", ...args);
  }

  activeMarkdownView(): MarkdownView | null {
    return this.app.workspace.getActiveViewOfType(MarkdownView);
  }

  /**
   * The body classes every stylesheet rule hangs off: the two setting-driven
   * ones, and the platform itself.
   *
   * The platform classes are set here, from Obsidian's own flags, rather than by
   * whichever surface happens to be running: a phone's CSS must not depend on a
   * surface being open.
   */
  syncBodyClasses(): void {
    const body = document.body.classList;
    body.toggle("weaver-no-emphasis", !this.settings.portEmphasisColors);
    body.toggle("weaver-unequal", !this.settings.equalizeHeadingSizes);
    body.toggle("weaver-frames", this.settings.entryFrames);
    body.toggle("weaver-platform-mobile", isMobile());
    body.toggle("weaver-phone", isPhone());
    body.toggle("weaver-tablet", isTablet());
  }

  /** Applies every setting that can change live, without a reload. */
  onSettingsChange(): void {
    this.syncBodyClasses();
    applyCss(this.settings);

    for (const view of registeredEditorViews()) {
      view.dispatch({ effects: refreshEntriesEffect.of(undefined) });
    }

    this.travelModal?.recenter();
  }

  /** Opens the travel card over every draft in the day-note folder. */
  async openTravel(): Promise<void> {
    const days = await this.dayIndex.drafts();

    const rows: TravelRow[] = [];
    for (const day of days) {
      for (const entry of day.entries) {
        rows.push({
          path: day.path,
          dayKey: day.dayKey,
          line: entry.line,
          d: entry.d,
          c: entry.c,
          n: entry.n,
          time: entry.time,
          durationMs: entry.durationMs,
          title: entry.title
        });
      }
    }

    if (rows.length === 0) {
      new Notice(NOTICE_NO_DRAFTS, NOTICE_NOOP_MS);
      return;
    }

    if (this.travelModal?.isOpen === true) {
      this.travelModal.recenter();
      return;
    }

    this.travelModal = new TravelModal(this, this.activeMarkdownView());
    this.travelModal.open(rows);
  }

  /**
   * Opens the entry palette over today's entries, on the note as it is on disk.
   *
   * The engine speaks for a missing note — one refusal, in one place — so this
   * returns quietly when there is nothing to show.
   */
  async openPalette(): Promise<void> {
    const view = await this.entries.revealToday(new Date());
    if (view === null) return;

    if (this.palette?.isOpen === true) return;

    const index = parseEntries(view.state.doc.toString());
    const caretLine = view.state.doc.lineAt(view.state.selection.main.head).number - 1;

    this.palette = new EntryPalette(this);
    this.palette.open(index, view, caretLine);
  }

  /** Closes today's day note: one mark, then the day's own stats. */
  async closeDay(): Promise<void> {
    const now = new Date();
    const file = resolveDayNote(this.app, this.settings, now).file;

    if (file === null) {
      new Notice(NOTICE_NO_DAY_NOTE, NOTICE_REFUSAL_MS);
      return;
    }

    let closed = false;
    await this.app.vault.process(file, (data) => {
      const plan = planCloseDay(data, now);
      if (plan === null) return data;

      closed = true;
      const next = applyPlanToSource(data, plan).source;
      return this.withDayStats(next, now);
    });

    if (!closed) {
      new Notice(NOTICE_DAY_ALREADY_CLOSED, NOTICE_REFUSAL_MS);
      return;
    }

    new Notice(NOTICE_DAY_CLOSED(formatClock(now)), NOTICE_NOOP_MS);
  }

  private registerCommands(): void {
    // Every command carries an icon so Obsidian's mobile toolbar can show it.
    this.addCommand({
      id: "start-entry",
      name: "Start an entry",
      icon: "plus",
      // `Mod+Enter` is taken by the core "Open link under cursor in new tab",
      // whose scope runs before any plugin keymap — see `ENTRY_KEYS`.
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "E" }],
      // Not an editor callback: today's note is the target even from Reading
      // view, and from no note at all.
      callback: () => void this.entries.startToday(new Date())
    });

    this.addCommand({
      id: "insert-entry",
      name: "Insert a child entry",
      icon: "indent-increase",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "J" }],
      editorCallback: (_editor, view) => {
        if (view instanceof MarkdownView) this.entries.startFromCursor(view, new Date());
      }
    });

    this.addCommand({
      id: "travel",
      name: "Travel to a draft",
      icon: "compass",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "Enter" }],
      callback: () => void this.openTravel()
    });

    this.addCommand({
      id: "palette",
      name: "Entry palette",
      icon: "list",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "P" }],
      callback: () => void this.openPalette()
    });

    this.addCommand({
      id: "line-break",
      name: "Insert a line break",
      icon: "corner-down-left",
      // `Enter` settles an open entry on every platform, so a phone's keyboard
      // has no newline: this is the one the toolbar can host. A newline is not
      // prose, so it starts no clock — the writing does.
      editorCallback: (editor) => {
        editor.replaceSelection("\n");
      }
    });

    this.addCommand({
      id: "close-day",
      name: "Close the day",
      icon: "check-circle",
      callback: () => void this.closeDay()
    });
  }

  private async loadSettings(): Promise<void> {
    const stored = await this.loadData();
    const normalized = normalizeData(stored);
    this.data = normalized;
    this.settings = normalized.settings;

    if (JSON.stringify(stored) !== JSON.stringify(normalized)) {
      await this.saveData(this.data);
    }
  }

  /** Recounts the day's stats and merges them into the note. */
  private withDayStats(source: string, now: Date): string {
    if (!this.settings.writeDayCounters) return source;
    const stats = recountDay(source, parseClose(source).closedAt);
    return applyDayStats(source, stats, dayKey(now)).source;
  }

  /** Debounced recount for edits made by hand in the day note. */
  private scheduleDayStats(file: TFile | null): void {
    if (!this.settings.writeDayCounters || file === null) return;
    if (this.dayStatsTimer !== null) window.clearTimeout(this.dayStatsTimer);

    this.dayStatsTimer = window.setTimeout(() => {
      this.dayStatsTimer = null;
      void this.refreshDayStats(file);
    }, DAY_STATS_DELAY_MS);
  }

  private async refreshDayStats(file: TFile): Promise<void> {
    const today = resolveDayNote(this.app, this.settings, new Date()).file;
    if (today === null || today.path !== file.path) return;

    const source = await this.app.vault.cachedRead(file);
    await writeDayStats(this.app, file, recountDay(source, parseClose(source).closedAt));
  }
}
