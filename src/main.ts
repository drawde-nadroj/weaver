/**
 * Weaver: a day note is a linear list of entries.
 *
 * An entry is `{ B.D.N }`, its prose, and one clock row `[+-=] HH:MM:SS HH:MM:SS`.
 * The note and the navigator are the whole surface: nothing else navigates, and
 * every write of a day note goes through one writer.
 */

import { Notice, Plugin, TFile, type MarkdownView } from "obsidian";

import { readAlignments } from "./core/alignments";
import { formatClock, pad2 } from "./core/clock";
import { parseClose, planCloseDay } from "./core/close";
import { applyDayStats, recountDay } from "./core/day-stats";
import { dayKey } from "./core/day";
import { entryBySeq, parseEntries } from "./core/entries";
import { applyPlanToSource } from "./core/insert";
import type { Stop } from "./core/navigator-stack";
import { closeDecorationsExtension } from "./editor/close-decorations";
import { editorPathOf } from "./editor/editor-path";
import { entryDecorationsExtension } from "./editor/entry-decorations";
import { entryFrameExtension } from "./editor/entry-frame";
import { entryEditExtension, entryKeysExtension } from "./editor/entry-keys";
import { entryIndexExtension, programmaticWrite, refreshEntriesEffect } from "./editor/entry-field";
import { portalExtension } from "./editor/portal-widget";
import { registeredEditorViews, viewRegistryExtension } from "./editor/view-registry";
import { EntryClock } from "./entries/clock";
import { EntryEngine } from "./entries/engine";
import { resolveDayNote } from "./entries/day-note";
import { PortalController } from "./entries/portals";
import { EntrySession } from "./entries/session";
import { minimalChange, rewriteDay } from "./entries/writer";
import { NoModel, OmLxModel, type WhisperModel } from "./model/whisper-model";
import { WhisperRunner } from "./model/whisper-runner";
import {
  NOTICE_DAY_ALREADY_CLOSED,
  NOTICE_DAY_CLOSED,
  NOTICE_NO_DAY_NOTE,
  NOTICE_NOOP_MS,
  NOTICE_REFUSAL_MS,
  noticeLegacyFormat,
  noticePortal
} from "./notices";
import { createCloseProcessor } from "./reading/close-processor";
import { createEntryProcessor } from "./reading/entry-processor";
import { PortalReadingTray } from "./reading/portals";
import { normalizeData, whisperReachable, type WeaverData, type WeaverSettings } from "./settings";
import { WeaverSettingTab } from "./settings-tab";
import { applyCss, removeCss } from "./ui/css";
import { Navigator } from "./ui/navigator";
import { isMobile, isPhone, isTablet } from "./ui/platform";

/** Hand edits in the day note settle for this long before the stats follow. */
const DAY_STATS_DELAY_MS = 2000;

/** How long a captured exact-second alignment shows its one acknowledgement. */
const ALIGNED_ACK_MS = 800;

/**
 * The local stamp an alignment record writes: `2026-11-05T22:55:00-08:00`.
 * A record is only trusted for an entry when its beginning names the very day
 * and moment the entry's clock row holds — after a hand edit, a deletion or a
 * reused `N`, proximity is not evidence.
 */
const LOCAL_STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})[+-]\d{2}:\d{2}$/;

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
  /** The one clock every stopwatch surface reads; owned for the plugin's life. */
  clock!: EntryClock;
  /** Ephemeral portal lifecycle: the held opening, its notices, its candidates. */
  portals!: PortalController;
  entries!: EntryEngine;
  /** The model that reads settled entries, and the cache it reads them into. */
  whisper!: WhisperRunner;
  /** Where the navigator's last moves came from, oldest first. */
  stack: { stops: Stop[] } = { stops: [] };

  private navigator: Navigator | null = null;
  private dayStatsTimer: number | null = null;
  /** Reading-view portal trays: one lifecycle component for every preview view. */
  private portalReading: PortalReadingTray | null = null;
  /**
   * Which entries of which note were entered from a portal, validated against
   * the note's own readable history: `path` → entry `N`s whose recorded
   * beginning still matches their clock row.
   */
  private readonly portalEntries = new Map<string, Set<number>>();
  /** The acknowledgement window per entry: `path` → `N` → expiry instant. */
  private readonly alignedUntil = new Map<string, Map<number, number>>();
  private readonly alignedTimers = new Set<number>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.syncBodyClasses();
    applyCss(this.settings);

    this.session = new EntrySession();
    // One clock per plugin: a session, one timer, and every surface subscribed
    // to the same painted second. `Date.now` is injected so the sampling is
    // testable, and `onunload` cancels what it scheduled.
    this.clock = new EntryClock(this.session, () => Date.now());
    // The portal lifecycle depends only on the injected host, so it is built
    // before the engine that will later hand it first input. It owns the held
    // opening and the single invitation per announcement, deriving every state
    // from actual time rather than counting timer callbacks. Main only
    // reconciles it; pending frames are rendered from its candidates by the
    // editor surface.
    this.portals = new PortalController({
      now: () => Date.now(),
      enabled: () => this.settings.portalsEnabled,
      todayPath: (at) => resolveDayNote(this.app, this.settings, new Date(at)).path,
      activePath: () => this.app.workspace.getActiveFile()?.path ?? null,
      visible: () => document.visibilityState !== "hidden",
      invite: (portal, remainingSeconds) => {
        new Notice(
          noticePortal(`${pad2(portal.hour)}:${pad2(portal.minute)}`, remainingSeconds),
          NOTICE_NOOP_MS
        );
      }
    });
    this.portals.reconcile();

    this.entries = new EntryEngine(this);
    this.whisper = new WhisperRunner({
      // Read fresh every call: a changed endpoint or model takes effect at once.
      // `NoModel` when the feature is off, and when a loopback address arrives on
      // a phone — an address that can only ever mean the reader's own device.
      model: () => this.whisperModel(),
      land: (path, n, key, whisper) => this.entries.landWhisper(path, n, key, whisper),
      log: (...args: unknown[]) => this.log(...args),
      // A box's effect is chosen while measuring, so the frame has to be told
      // when an entry starts or stops waiting.
      onChange: () => this.repaintFrames()
    });
    this.registerEditorExtension([
      viewRegistryExtension,
      entryIndexExtension(),
      entryDecorationsExtension(
        () => this.session,
        () => this.app.workspace.getActiveFile()?.path ?? "",
        () => this.clock,
        (target, sourcePath) => {
          void this.app.workspace.openLinkText(target, sourcePath, false);
        }
      ),
      closeDecorationsExtension(),
      entryFrameExtension({
        settings: () => this.settings,
        session: () => this.session,
        reading: (path, n) => this.whisper.pendingFor(path, n),
        // An entry is "from a portal" only while the note's readable history
        // still names this entry's own recorded beginning; the acknowledgement
        // is the short window after capture, and both are repainted when they
        // change.
        portal: (path, n) => this.portalEntries.get(path)?.has(n) === true,
        aligned: (path, n) => {
          const until = this.alignedUntil.get(path)?.get(n);
          return until !== undefined && Date.now() < until;
        },
        fallbackPath: () => this.app.workspace.getActiveFile()?.path ?? ""
      }),
      portalExtension({
        controller: this.portals,
        clock: this.clock,
        settings: () => this.settings,
        capture: (view, id, text, at) => this.entries.capturePortal(view, id, text, at),
        lastFailure: (id) => this.entries.portalFailure(id)
      }),
      entryKeysExtension(this),
      entryEditExtension(this)
    ]);

    // Frames ask whether an entry came from a portal; the answer is read from
    // the notes that are already open, before the first paint that needs it.
    this.app.workspace.onLayoutReady(() => {
      this.repaintFrames();
    });

    this.registerMarkdownPostProcessor(
      createEntryProcessor((target, sourcePath) => {
        void this.app.workspace.openLinkText(target, sourcePath, false);
      }, this.clock)
    );
    this.registerMarkdownPostProcessor(createCloseProcessor());

    // One lifecycle owner for Reading-view portals: it watches the visible
    // preview views, never the post-processor callbacks, so a tray cannot be
    // attached twice for one note.
    this.portalReading = new PortalReadingTray(this);
    this.portalReading.start();

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        this.scheduleDayStats(file instanceof TFile ? file : null);
        // Hand edits and reloads can add or remove a recorded beginning; the
        // validated association is cheap to re-derive from what is open.
        this.syncPortalEntries();
      })
    );
    let portalLeaf = this.app.workspace.activeLeaf;
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        // A mode switch in the same leaf retains preparation. Departing to
        // another leaf releases it even when both panes show the same note.
        if (leaf !== portalLeaf) this.portals.release();
        portalLeaf = leaf;
        void this.entries.pause();
      })
    );
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        // Stop before the window is gone: the hidden session must keep the
        // second that was on screen, not one sampled on the way out. A hidden
        // app also cannot hold or announce a portal.
        this.portals.release();
        void this.entries.pause();
        return;
      }
      // A hidden app missed ticks rather than seconds; resampling reconciles
      // the one snapshot every surface will paint, without replaying a backlog,
      // and portal state is derived from the instant rather than a notice queue.
      this.portals.reconcile();
      this.clock.refresh();
    });

    this.registerCommands();
    this.addSettingTab(new WeaverSettingTab(this.app, this));

    console.log(`Weaver loaded ${this.manifest.version}`);
  }

  onunload(): void {
    this.portalReading?.destroy();
    this.portalReading = null;
    this.portals.release();
    this.portals.destroy();
    this.clock.destroy();
    this.whisper.clear();

    for (const timer of this.alignedTimers) window.clearTimeout(timer);
    this.alignedTimers.clear();
    this.alignedUntil.clear();
    this.portalEntries.clear();

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
   * The model this device may ask, or `NoModel`.
   *
   * `NoModel` when the feature is off, and when a loopback address arrives on a
   * phone: `data.json` syncs, so `127.0.0.1` travels with the vault and can only
   * ever mean the reader's own device. Nothing is asked, and nothing is counted
   * as a failure.
   */
  whisperModel(): WhisperModel {
    if (!this.settings.whisperEnabled) return NoModel;
    if (!whisperReachable(this.settings.whisperEndpoint, isMobile())) return NoModel;

    return new OmLxModel(
      this.settings.whisperEndpoint,
      this.settings.whisperModelId,
      this.settings.whisperApiKey
    );
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
    // An answer from the previous endpoint or model must not be served.
    this.whisper.clear();
    // The toggle is honoured here: turning portals off drops the hold and the
    // pending surfaces, without touching entries or recorded history.
    this.portals.reconcile();
    // Reading surfaces carry their frame setting at mount, so they are rebuilt
    // when it changes rather than keeping an old look.
    this.portalReading?.settingsChanged();

    for (const view of registeredEditorViews()) {
      view.dispatch({ effects: refreshEntriesEffect.of(undefined) });
    }
  }

  /**
   * Re-measures the open notes, so a frame effect that changed on its own is drawn.
   */
  repaintFrames(): void {
    // The frame's portal query reads validated history; every repaint refreshes
    // it from the live documents first, so an undo that removed a record is
    // reflected in the same paint.
    this.syncPortalEntries();
    for (const view of registeredEditorViews()) {
      view.dispatch({
        effects: refreshEntriesEffect.of(undefined),
        annotations: programmaticWrite.of(true)
      });
    }
  }

  /**
   * Records that an entry was just entered from a portal, and starts its one
   * acknowledgement if the input landed on an exact second.
   *
   * The association is added directly because the capture that produced it is
   * the evidence; the next history sync re-derives the same answer from the
   * note. The acknowledgement expires after {@link ALIGNED_ACK_MS} and repaints
   * once — it is a moment, not a state the frame keeps.
   */
  portalEntered(path: string, n: number, aligned: boolean): void {
    let entries = this.portalEntries.get(path);
    if (entries === undefined) {
      entries = new Set();
      this.portalEntries.set(path, entries);
    }
    entries.add(n);

    if (!aligned) {
      this.repaintFrames();
      return;
    }

    const rows = this.alignedUntil.get(path) ?? new Map<number, number>();
    rows.set(n, Date.now() + ALIGNED_ACK_MS);
    this.alignedUntil.set(path, rows);

    const timer = window.setTimeout(() => {
      this.alignedTimers.delete(timer);
      const current = this.alignedUntil.get(path);
      if (current === undefined) return;
      current.delete(n);
      if (current.size === 0) this.alignedUntil.delete(path);
      this.repaintFrames();
    }, ALIGNED_ACK_MS + 20);
    this.alignedTimers.add(timer);

    this.repaintFrames();
  }

  /**
   * Re-derives the portal association from the live open documents.
   *
   * The note's own history is the only evidence: a record is trusted for an
   * entry only when its recorded beginning names the same day and moment the
   * entry's clock row holds, so a manually edited row, a deleted entry, and a
   * reused `N` are all rejected. Unreadable history contributes nothing rather
   * than an empty history, and nothing here writes.
   */
  syncPortalEntries(): void {
    this.portalEntries.clear();
    for (const view of registeredEditorViews()) {
      const path = editorPathOf(view);
      if (path === null) continue;

      const source = view.state.doc.toString();
      const history = readAlignments(source);
      if (!history.ok) continue;

      const index = parseEntries(source);
      const entries = new Set<number>();
      for (const record of history.records) {
        if (record.entry === null) continue;
        const began = LOCAL_STAMP.exec(record.began);
        if (began === null) continue;
        const entry = entryBySeq(index, record.entry);
        if (entry === null || entry.day !== began[1] || entry.time !== began[2]) continue;
        entries.add(record.entry);
      }
      if (entries.size > 0) this.portalEntries.set(path, entries);
    }
  }

  /** Explicit preparation preserves a Reading surface's owning leaf when supplied. */
  async preparePortal(id: string, owner?: MarkdownView): Promise<void> {
    await this.entries.revealPortal(id, owner);
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
      id: "start-entry",
      name: "Start an entry",
      icon: "plus",
      // `Mod+Enter` is taken by the core "Open link under cursor in new tab",
      // whose scope runs before any plugin keymap — see `ENTRY_KEYS`.
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "E" }],
      // Not an editor callback: today's note is the target even from Reading
      // view, and from no note at all.
      callback: () => void this.entries.startEntry(new Date())
    });

    this.addCommand({
      id: "descend",
      name: "Descend into a child entry",
      icon: "arrow-down-right",
      callback: () => this.entries.descendAtCaret()
    });

    // The one navigation: start, descend and jump in a single list, with the
    // return stack inside it.
    this.addCommand({
      id: "navigate",
      name: "Today's entries",
      icon: "list",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "P" }],
      callback: () => void this.openNavigator()
    });

    // The retroactive pass: every settled entry that has no whisper yet.
    this.addCommand({
      id: "whisper-day",
      name: "Whisper the day",
      icon: "sparkles",
      callback: () => void this.entries.whisperDay()
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
