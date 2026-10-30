/**
 * Weaver: a day note is a linear list of entries.
 *
 * An entry is `{ D.C.N }`, its prose, and one clock row `HH:MM:SS + HH:MM:SS`.
 * The note and the navigator are the whole surface: nothing else navigates, and
 * every write of a day note goes through one writer.
 */

import { Notice, Plugin, TFile } from "obsidian";

import { formatClock } from "./core/clock";
import { parseClose, planCloseDay } from "./core/close";
import { applyDayStats, recountDay } from "./core/day-stats";
import { dayKey } from "./core/day";
import { parseEntries } from "./core/entries";
import { applyPlanToSource } from "./core/insert";
import type { Stop } from "./core/navigator-stack";
import { closeDecorationsExtension } from "./editor/close-decorations";
import { entryDecorationsExtension } from "./editor/entry-decorations";
import { entryFrameExtension } from "./editor/entry-frame";
import { entryEditExtension, entryKeysExtension } from "./editor/entry-keys";
import { entryIndexExtension, refreshEntriesEffect } from "./editor/entry-field";
import { registeredEditorViews, viewRegistryExtension } from "./editor/view-registry";
import { EntryEngine } from "./entries/engine";
import { resolveDayNote } from "./entries/day-note";
import { EntrySession } from "./entries/session";
import { minimalChange, rewriteDay } from "./entries/writer";
import {
  NOTICE_DAY_ALREADY_CLOSED,
  NOTICE_DAY_CLOSED,
  NOTICE_NO_DAY_NOTE,
  NOTICE_NOOP_MS,
  NOTICE_REFUSAL_MS,
  noticeLegacyFormat
} from "./notices";
import { createCloseProcessor } from "./reading/close-processor";
import { createEntryProcessor } from "./reading/entry-processor";
import { normalizeData, type WeaverData, type WeaverSettings } from "./settings";
import { WeaverSettingTab } from "./settings-tab";
import { applyCss, removeCss } from "./ui/css";
import { Navigator } from "./ui/navigator";
import { isMobile, isPhone, isTablet } from "./ui/platform";

/** Hand edits in the day note settle for this long before the stats follow. */
const DAY_STATS_DELAY_MS = 2000;

const BODY_CLASSES = [
  "weaver-no-emphasis",
  "weaver-unequal",
  "weaver-platform-mobile",
  "weaver-phone",
  "weaver-tablet"
];

/** Wiring only: settings, editor extensions, commands, and the day-stats listener. */
export default class WeaverPlugin extends Plugin {
  data: WeaverData = normalizeData(null);
  settings: WeaverSettings = this.data.settings;

  session = new EntrySession();
  entries!: EntryEngine;
  /** Where the navigator's last moves came from, oldest first. */
  stack: { stops: Stop[] } = { stops: [] };

  private navigator: Navigator | null = null;
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
        () => this.session,
        () => this.app.workspace.getActiveFile()?.path ?? ""
      ),
      closeDecorationsExtension(),
      entryFrameExtension({
        settings: () => this.settings,
        session: () => this.session,
        fallbackPath: () => this.app.workspace.getActiveFile()?.path ?? ""
      }),
      entryKeysExtension(this),
      entryEditExtension(this)
    ]);

    this.registerMarkdownPostProcessor(createEntryProcessor());
    this.registerMarkdownPostProcessor(createCloseProcessor());

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

    this.navigator?.close();
    this.navigator = null;
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
    body.toggle("weaver-unequal", !this.settings.equalizeEntrySizes);
    body.toggle("weaver-frame-fixed", !this.settings.frameFollowsIndent);
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
  }

  /**
   * Opens the navigator over today's entries, on the note as it is on screen.
   *
   * The engine speaks for a missing note — one refusal, in one place — so this
   * returns quietly when there is nothing to show.
   */
  async openNavigator(): Promise<void> {
    const view = await this.entries.revealToday(new Date());
    if (view === null || this.navigator?.isOpen === true) return;

    this.navigator = new Navigator(this);
    this.navigator.open(view);
  }

  /** Closes today's day note: one mark, then the day's own stats. */
  async closeDay(): Promise<void> {
    const now = new Date();
    const file = resolveDayNote(this.app, this.settings, now).file;

    if (file === null) {
      new Notice(NOTICE_NO_DAY_NOTE, NOTICE_REFUSAL_MS);
      return;
    }

    const result = await rewriteDay(
      this.app,
      file,
      (source) => {
        const plan = planCloseDay(source, now);
        if (plan === null) return null;

        const next = this.withDayStats(applyPlanToSource(source, plan).source, now);
        return { changes: minimalChange(source, next), source: next, caret: null };
      },
      true
    );

    if (result === null) {
      const source = await this.app.vault.cachedRead(file);
      if (parseEntries(source).legacyFormat) {
        new Notice(noticeLegacyFormat("closing the day"), NOTICE_REFUSAL_MS);
        return;
      }
      new Notice(NOTICE_DAY_ALREADY_CLOSED, NOTICE_REFUSAL_MS);
      return;
    }

    new Notice(NOTICE_DAY_CLOSED(formatClock(now)), NOTICE_NOOP_MS);
  }

  private registerCommands(): void {
    // Every command carries an icon so Obsidian's mobile toolbar can show it.
    this.addCommand({
      id: "append-entry",
      name: "Append an entry",
      icon: "plus",
      // `Mod+Enter` is taken by the core "Open link under cursor in new tab",
      // whose scope runs before any plugin keymap — see `ENTRY_KEYS`.
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "E" }],
      // Not an editor callback: today's note is the target even from Reading
      // view, and from no note at all.
      callback: () => void this.entries.appendEntry(new Date())
    });

    // The one navigation: append, descend and jump in a single list, with the
    // return stack inside it.
    this.addCommand({
      id: "navigate",
      name: "Today's entries",
      icon: "list",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "P" }],
      callback: () => void this.openNavigator()
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

  /**
   * The stats pass, through the same writer as every other day-note write: the
   * open editor when there is one, so a hand edit and the counters cannot cross.
   */
  private async refreshDayStats(file: TFile): Promise<void> {
    const today = resolveDayNote(this.app, this.settings, new Date()).file;
    if (today === null || today.path !== file.path) return;

    const now = new Date();
    await rewriteDay(
      this.app,
      file,
      (source) => {
        const next = this.withDayStats(source, now);
        const changes = minimalChange(source, next);
        return changes.length === 0 ? null : { changes, source: next, caret: null };
      },
      false
    );
  }
}
