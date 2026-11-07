/**
 * Weaver: a day note is a linear list of entries, and a thought may be written
 * from anywhere.
 *
 * An entry is `{ B.D.N }`, its prose, and one clock row `[+-=] HH:MM:SS YYYY-MM-DD
 * HH:MM:SS`. Writing happens in two places that share one writer: inside a note,
 * where the entry is the note's own text, and in the floating composer, which
 * holds one unsaved thought until it is settled. The navigator is the only list
 * and the only navigation.
 *
 * This module is wiring, and only wiring: settings, the one writer, the one clock,
 * the composer, the invitation dock, the workspace service, commands, and the two
 * listeners that keep derived facts (day counters, portal association) true.
 */

import { Component, MarkdownRenderer, Notice, Plugin, TFile, MarkdownView } from "obsidian";

import { readAlignments } from "./core/alignments";
import { formatClock } from "./core/clock";
import { parseClose, planCloseDay } from "./core/close";
import { applyDayStats, recountDay } from "./core/day-stats";
import { entryBySeq, parseEntries } from "./core/entries";
import { applyPlanToSource } from "./core/insert";
import { MAIN_CONTEXT_ID, sourceDayOf } from "./core/contexts";
import { dayKey as dayKeyOf } from "./core/day";
import { threadViewOf, type ThoughtRef } from "./core/capture";
import { portalAlignments, readPortalSchedules } from "./core/portals";
import { editorPathOf } from "./editor/editor-path";
import { back, canGoBack, canGoForward, forward, initialHistory, record, type NavigationHistory, type Stop } from "./core/navigation";
import { OPENING_WINDOW_MS, portalTime } from "./core/portals";
import { closeDecorationsExtension } from "./editor/close-decorations";
import { entryDecorationsExtension } from "./editor/entry-decorations";
import { entryFrameExtension } from "./editor/entry-frame";
import { entryEditExtension, entryKeysExtension } from "./editor/entry-keys";
import { entryIndexExtension, programmaticWrite, refreshEntriesEffect } from "./editor/entry-field";
import { registeredEditorViews, viewRegistryExtension } from "./editor/view-registry";
import { CaptureModelController, type CaptureModelHost } from "./entries/capture-model-controller";
import { CaptureStoreV2 } from "./entries/capture-store";
import { EntryClock } from "./entries/clock";
import { ContextWorkspaces, type LayoutApi } from "./entries/context-workspaces";
import { ensureDayNote, contextList, resolveContextDay } from "./entries/day-note";
import { EntryEngine } from "./entries/engine";
import { LocalState, type WorkspaceSnapshot } from "./entries/local-state";
import { PluginDataStore } from "./entries/plugin-data";
import { PortalController, type OfferedInvitation } from "./entries/portals";
import { ThoughtIndex } from "./entries/thought-index";
import { ReferenceController } from "./entries/reference";
import { EntrySession } from "./entries/session";
import { confirmExistingWrite, minimalChange, rewriteDay } from "./entries/writer";
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
import { normalizeData, whisperReachable, type WeaverData, type WeaverSettings } from "./settings";
import { WeaverSettingTab } from "./settings-tab";
import { applyCss, removeCss } from "./ui/css";
import { Loom, type PortalStripView } from "./ui/loom";
import type { WeavingContext } from "./core/contexts";
import { isMobile, isPhone, isTablet } from "./ui/platform";

/** How long a minute that has closed keeps saying so, once. */
const CLOSED_WINDOW_MS = 3000;

/** Hand edits in a day note settle for this long before the counters follow. */
const DAY_STATS_DELAY_MS = 2000;

/** How long a captured exact-second alignment shows its one acknowledgement. */
const ALIGNED_ACK_MS = 800;

/** Where this device's durable Review replica lives, never synced. */
const REPLICA_STORAGE_KEY = "weaver:device-replica:v1";

/** The local stamp an alignment record writes: `2026-11-05T22:55:00-08:00`. */
const LOCAL_STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})[+-]\d{2}:\d{2}$/;

const BODY_CLASSES = [
  "weaver-no-emphasis",
  "weaver-unequal",
  "weaver-platform-mobile",
  "weaver-phone",
  "weaver-tablet"
];

/** Wiring only: settings, editor extensions, commands, and the two derived facts. */
export default class WeaverPlugin extends Plugin {
  data: WeaverData = normalizeData(null);
  settings: WeaverSettings = this.data.settings;

  session = new EntrySession();
  /** The one clock every stopwatch surface reads; owned for the plugin's life. */
  clock!: EntryClock;
  /** Invitations: which schedule is offering what, right now. */
  portals!: PortalController;
  entries!: EntryEngine;
  /** The model that reads settled entries, and the cache it reads them into. */
  whisper!: WhisperRunner;
  /** Where the navigator's moves came from, and where it can go again. */
  history = initialHistory();
  /** This device's unsent draft, layouts and acknowledgements. */
  local!: LocalState;
  /** The one owner of `data.json`: settings and shared Reviews. */
  dataStore!: PluginDataStore;
  /** The one floating thread surface. */
  composer!: Loom;
  /** Destination travel: what the workspace was, and what it becomes. */
  workspaces!: ContextWorkspaces;
  /** The draft, its timing, and its one submission. */
  controller!: CaptureModelController;
  /** The reading index over recognised notes. */
  thoughtIndex!: ThoughtIndex;
  /** The upper half's reading owner. */
  reference!: ReferenceController;
  /** Bumped to discard stale reading queries. */
  private referenceGeneration = 0;
  /** The versioned capture record over vault-local storage. */
  captureStore!: CaptureStoreV2;

  private dayStatsTimer: number | null = null;
  /** True while one navigation transaction is running. */
  private navigating = false;
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
    this.local = new LocalState({
      load: (key) => this.loadLocal(key),
      save: (key, value) => this.saveLocal(key, value)
    });

    this.captureStore = new CaptureStoreV2({
      load: (key) => this.loadLocal(key),
      save: (key, value) => this.saveLocal(key, value)
    });
    try {
      // Retire v1 only after a verified v2 record exists.
      this.captureStore.migrateFromV1(this.local.load());
    } catch {
      // An unreadable v1 record is left alone; v2 starts empty.
    }

    await this.loadSettings();
    this.syncBodyClasses();
    applyCss(this.settings);

    this.session = new EntrySession();
    this.clock = new EntryClock(this.session, () => Date.now());

    this.portals = new PortalController({
      now: () => Date.now(),
      enabled: () => this.settings.portalsEnabled,
      rhythmic: () => this.settings.rhythmicPortalsEnabled,
      rhythmContext: () => MAIN_CONTEXT_ID,
      schedules: () => this.schedules(),
      state: () => this.local.workspace(),
      persist: (update) => this.local.updateWorkspace(update),
      visible: () => document.visibilityState !== "hidden",
      invite: (occurrence) => {
        new Notice(noticePortal(occurrence.name, portalTime(occurrence.portal), 0), NOTICE_NOOP_MS);
      }
    });

    this.entries = new EntryEngine(this);
    this.whisper = new WhisperRunner({
      model: () => this.whisperModel(),
      land: (path, n, key, whisper) => this.entries.landWhisper(path, n, key, whisper),
      log: (...args: unknown[]) => this.log(...args),
      onChange: () => this.repaintFrames()
    });

    this.controller = new CaptureModelController(this.captureModelHost());

    this.thoughtIndex = new ThoughtIndex({
      paths: () =>
        typeof this.app.vault.getMarkdownFiles === "function"
          ? this.app.vault.getMarkdownFiles().map((file) => file.path)
          : [],
      read: (path) => this.readNote(path),
      generation: () => this.referenceGeneration,
      contexts: () => this.contexts()
    });
    this.reference = new ReferenceController({
      index: this.thoughtIndex,
      load: (target) => this.thoughtIndex.loadThought(target),
      onChange: () => this.composer?.render()
    });
    this.composer = new Loom({
      app: this.app,
      controller: this.controller,
      reference: this.reference,
      clock: this.clock,
      contexts: () => this.contexts(),
      loadThread: async (target) => {
        const source = await this.readNote(target.path);
        return source === null ? null : threadViewOf(parseEntries(source), target.path, target);
      },
      travel: (contextId) => this.visitTapestry(contextId),
      viewing: () => this.workspaces.viewing(),
      renderMarkdown: (element, markdown, sourcePath, component) => {
        void this.renderMarkdown(element, markdown, sourcePath, component);
      },
      openRealms: () => this.composer.showPanel("tapestries"),
      writeHere: (contextId) => {
        void this.controller.setDestination(contextId);
      },
      invitations: () =>
        this.portals.outstanding().map((offered) => ({
          id: offered.occurrence.id,
          name: offered.occurrence.name,
          opening: portalTime(offered.occurrence.portal),
          phase: offered.phase
        })),
      takeInvitation: (occurrenceId) => {
        const offered = this.portals.outstanding().find((candidate) => candidate.occurrence.id === occurrenceId);
        this.openLoom(offered === undefined ? {} : { contextId: offered.occurrence.contextId });
      },
      dismissInvitation: (occurrenceId) => {
        this.portals.dismiss(occurrenceId);
        this.repaintSurface();
      },
      portalStrip: () => this.portalStrip(),
      weaveOpening: (occurrenceId) => {
        const offered = this.portals
          .outstanding()
          .find((candidate) => candidate.occurrence.id === occurrenceId);
        this.openLoom(offered === undefined ? {} : { contextId: offered.occurrence.contextId });
      },
      dismissOpening: (occurrenceId) => {
        this.portals.dismiss(occurrenceId);
        this.repaintSurface();
      },
      openPortals: () => this.composer.showPanel("invitations")
    });

    this.workspaces = new ContextWorkspaces({
      app: this.app,
      layout: () => this.layoutApi(),
      contexts: () => this.contexts(),
      state: () => this.local.workspace(),
      save: (update) => this.local.updateWorkspace(update),
      freezeDraft: () => this.controller.pause(),
      openNote: (path) => this.openNote(path),
      notify: (message) => new Notice(message, NOTICE_NOOP_MS)
    });

    this.portals.subscribe(() => this.repaintSurface());

    this.registerEditorExtension([
      viewRegistryExtension,
      entryIndexExtension(),
      entryDecorationsExtension(
        () => this.session,
        () => this.app.workspace.getActiveFile()?.path ?? "",
        () => this.clock,
        () => this.contexts(),
        (target, sourcePath) => {
          void this.app.workspace.openLinkText(target, sourcePath, false);
        }
      ),
      closeDecorationsExtension(),
      entryFrameExtension({
        settings: () => this.settings,
        session: () => this.session,
        reading: (path, n) => this.whisper.pendingFor(path, n),
        portal: (path, n) => this.portalEntries.get(path)?.has(n) === true,
        aligned: (path, n) => {
          const until = this.alignedUntil.get(path)?.get(n);
          return until !== undefined && Date.now() < until;
        },
        fallbackPath: () => this.app.workspace.getActiveFile()?.path ?? ""
      }),
      entryKeysExtension(this),
      entryEditExtension(this)
    ]);

    this.app.workspace.onLayoutReady(() => {
      // Ownership is decided against the real screen before anything is labelled
      // a Realm, so a workspace rearranged between sessions is not relabelled.
      this.workspaces.adopt();
      this.repaintFrames();
      this.portals.start();
      this.repaintSurface();
      // Reconcile shared Reviews before the surface mounts, so the reading place
      // is current, then recover the paused draft and mount hidden/reduced.
      void this.dataStore.onExternalChange();
      this.controller.recover();
      this.composer.mount();
    });

    // A pane the host created after a restore gets its position on the first
    // layout that holds it, rather than being left at the host's own offset.
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.workspaces.flushPending();
      })
    );

    this.registerMarkdownPostProcessor(
      createEntryProcessor(
        () => this.contexts(),
        (target, sourcePath) => {
          void this.app.workspace.openLinkText(target, sourcePath, false);
        },
        this.clock
      )
    );
    this.registerMarkdownPostProcessor(createCloseProcessor());

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        this.scheduleDayStats(file instanceof TFile ? file : null);
        this.syncPortalEntries();
        this.invalidateIndex(file instanceof TFile ? [file.path] : []);
      })
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        this.invalidateIndex(file instanceof TFile ? [file.path] : []);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.invalidateIndex(file instanceof TFile ? [file.path] : []);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.invalidateIndex(file instanceof TFile ? [file.path, oldPath] : [oldPath]);
      })
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        void this.entries.pause();
      })
    );
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        // Stop before the window is gone: the hidden session keeps the second
        // that was on screen. A hidden app also cannot offer an invitation.
        this.workspaces.remember();
        this.controller.pause();
        void this.entries.pause();
        return;
      }
      this.portals.reconcile();
      this.repaintSurface();
      this.clock.refresh();
    });

    this.registerCommands();
    this.addSettingTab(new WeaverSettingTab(this.app, this));

    console.log(`Weaver loaded ${this.manifest.version}`);
  }

  onunload(): void {
    // Ask the data owner to flush now, then release it once that settles; the
    // host does not await unload, so this must not depend on it.
    if (this.dataStore !== undefined) {
      void this.dataStore.flush().finally(() => this.dataStore.dispose());
    }
    this.reference?.dispose();
    this.thoughtIndex?.dispose();
    this.workspaces?.remember();
    this.composer?.destroy();
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

    removeCss();
    document.body.classList.remove(...BODY_CLASSES);
  }

  async saveSettings(): Promise<void> {
    this.data = { ...this.data, settings: this.settings };
    await this.dataStore.saveSettings(this.settings);
  }

  /**
   * Merges a shared-file change without restarting controllers.
   *
   * Only Reviews and the stored envelope move; the runtime settings object is left
   * as it is, so a Review update from another device never silently reconfigures
   * this session.
   */
  async onExternalSettingsChange(): Promise<void> {
    await this.dataStore?.onExternalChange();
    this.data = this.dataStore.currentData;
  }

  /**
   * Every destination a thought may be woven into, `main` first.
   *
   * Read fresh at each call: the list is cheap, and a settings change must take
   * effect in the next frame rather than at the next reload.
   */
  contexts(): readonly WeavingContext[] {
    return contextList(this.app, this.settings).contexts;
  }

  /** Every configured schedule, validated. */
  schedules() {
    return readPortalSchedules(this.settings.portalSchedules).valid;
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
   * The body classes every stylesheet rule hangs off: the setting-driven ones and
   * the platform itself, set here rather than by whichever surface is open.
   */
  syncBodyClasses(): void {
    const body = document.body.classList;
    body.toggle("weaver-no-emphasis", !this.settings.portEmphasisColors);
    body.toggle("weaver-unequal", !this.settings.equalizeEntrySizes);
    body.toggle("weaver-frame-fixed", !this.settings.frameFollowsIndent);
    body.toggle("weaver-platform-mobile", isMobile());
    body.toggle("weaver-phone", isPhone());
    body.toggle("weaver-tablet", isTablet());
    document.body.setAttribute("data-weaver-motion", this.settings.portalMotion);
  }

  /** Applies every setting that can change live, without a reload. */
  onSettingsChange(): void {
    this.syncBodyClasses();
    applyCss(this.settings);
    // An answer from the previous endpoint or model must not be served.
    this.whisper.clear();
    // Schedules and the master switch are read fresh by the controller.
    this.portals.reconcile();
    this.repaintSurface();

    for (const view of registeredEditorViews()) {
      view.dispatch({ effects: refreshEntriesEffect.of(undefined) });
    }
  }

  /**
   * Opens the composer: the one entry point every gesture shares.
   *
   * The destination defaults to what the workspace is showing, so a capture from
   * inside a note lands where the note lives, and `main` when the screen is not a
   * destination. An opening is not passed in: an invitation only chooses the
   * Realm, and whether the writing counts as entered is decided by the first
   * committed input itself. Naming that Realm while another draft exists is a
   * proposal to move it, not a silent retarget; an unnamed open resumes.
   *
   * The surface is mounted and drawn before the input is touched, so the caret can
   * only be restored into a textarea that is already on screen — a phone will not
   * raise a keyboard for an element the writer cannot see.
   */
  openLoom(options: { contextId?: string } = {}, window?: Window): void {
    const contextId = options.contextId ?? this.workspaces.viewing() ?? MAIN_CONTEXT_ID;
    // Where focus came from, remembered before the surface takes it, so Hide can
    // put it back exactly there.
    this.composer.rememberFocus();
    this.controller.open(contextId === "" ? MAIN_CONTEXT_ID : contextId, {
      move: options.contextId !== undefined
    });
    this.composer.mount(window?.document ?? document);
    this.composer.render();
    this.composer.restoreSelection();
    if (this.controller.state.phase === "editing") this.composer.focusInput();
  }

  /**
   * Opens the Loom's reference at the last thought in Time order, without
   * starting a draft or moving an underlying note.
   */
  async openReference(): Promise<void> {
    this.composer.rememberFocus();
    this.referenceGeneration += 1;
    await this.reference.open(
      { scope: { kind: "history", tapestryId: null }, order: "time", search: { kind: "none" } },
      "last",
      null
    );
    this.composer.mount();
    this.composer.render();
  }

  /** Cycles the Tapestries in configured order while the Loom is focused. */
  private cycleTapestry(delta: 1 | -1): void {
    const contexts = this.contexts();
    if (contexts.length === 0) return;
    const current = this.controller.state.contextId || MAIN_CONTEXT_ID;
    const at = Math.max(0, contexts.findIndex((context) => context.id === current));
    const next = contexts[(at + delta + contexts.length) % contexts.length];
    if (next !== undefined) void this.controller.setDestination(next.id);
    this.repaintSurface();
  }

  /** Opens the reference scoped to today's recorded thoughts, without a draft. */
  async openReferenceToday(): Promise<void> {
    this.composer.rememberFocus();
    this.referenceGeneration += 1;
    await this.reference.open(
      {
        scope: { kind: "today", tapestryId: null, day: dayKeyOf(new Date()) },
        order: "time",
        search: { kind: "none" }
      },
      "last",
      null
    );
    this.composer.mount();
    this.composer.render();
  }

  /** Re-measures the open notes, so a frame effect that changed on its own is drawn. */
  repaintFrames(): void {
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
   * entry's clock row holds, so an edited row, a deleted entry and a reused `N`
   * are all rejected. Nothing here writes.
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

  /** Closes the day note on screen, else today's in the current destination. */
  async closeDay(): Promise<void> {
    const now = new Date();
    const active = this.app.workspace.getActiveFile();
    const target =
      active !== null && sourceDayOf(active.path, this.contexts()) !== null
        ? { ok: true as const, file: active }
        : resolveContextDay(this.app, this.settings, this.currentContext(), dayKeyOf(now));

    const file = target.ok ? target.file : null;
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

  /** The destination the composer would write into: the workspace's, else Main. */
  private currentContext(): string {
    const viewing = this.workspaces?.viewing() ?? "";
    return viewing === "" ? MAIN_CONTEXT_ID : viewing;
  }

  // ── the composer's world ─────────────────────────────────────────────────

  private captureModelHost(): CaptureModelHost {
    return {
      now: () => Date.now(),
      contexts: () => this.contexts(),
      writeCapture: (request, retry, beforeCommit, invitations) =>
        this.entries.writeCapture(request, retry, beforeCommit, invitations),
      read: (path) => this.readNote(path),
      confirmPersisted: async (path, expected) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return false;
        return confirmExistingWrite(this.app, file, expected);
      },
      editInNote: (target) => this.editInNote(target),
      freezeNative: () => {
        // Synchronous, so the note's clock stops on the second on screen before
        // the composer takes focus.
        if (this.session.active() !== null) this.session.freezeDisplay();
      },
      pauseNative: async () => {
        const result = await this.entries.pause();
        // Forward the captured publish result, never a later idle inference: a
        // replacement session must not make a failed stop look successful.
        return result.kind !== "failed";
      },
      invitationsAt: (contextId, at) =>
        this.portals.captureAt(contextId, at).map(({ occurrence, generation }) => ({
          occurrenceId: occurrence.id,
          scheduleId: occurrence.scheduleId,
          name: occurrence.name,
          generation,
          portal: occurrence.portal,
          contextId: occurrence.contextId
        })),
      acknowledge: (invitation, saved, beginning) => {
        const status = this.portals.acknowledge(
          {
            id: invitation.occurrenceId,
            scheduleId: invitation.scheduleId,
            contextId: invitation.contextId,
            name: invitation.name,
            portal: invitation.portal
          },
          invitation.generation
        );
        // The frame acknowledges an entry only when its first input landed on an
        // exact second of the opening it was written into.
        if (beginning !== null) {
          this.portalEntered(
            saved.thought.path,
            saved.thought.n,
            portalAlignments(invitation.portal, beginning.at).length > 0
          );
        }
        return status;
      },
      store: this.captureStore,
      onChange: () => this.composer?.render()
    };
  }

  private async readNote(path: string): Promise<string | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    try {
      return await this.app.vault.cachedRead(file);
    } catch {
      return null;
    }
  }

  /** Opens one note and puts the caret in a thought, without starting a clock. */
  private async editInNote(target: ThoughtRef): Promise<boolean> {
    return this.visitThought(target, true);
  }

  /** Opens a destination's note for a visit, creating it because a visit is explicit. */
  private async openNote(path: string): Promise<boolean> {
    const day = sourceDayOf(path, this.contexts());
    const file =
      this.app.vault.getAbstractFileByPath(path) instanceof TFile
        ? (this.app.vault.getAbstractFileByPath(path) as TFile)
        : day === null
          ? null
          : await ensureDayNote(this.app, path, day).catch(() => null);
    if (file === null) return false;

    const existing = this.app.workspace
      .getLeavesOfType("markdown")
      .find((leaf) => leaf.view instanceof MarkdownView && leaf.view.file?.path === path);
    if (existing !== undefined) {
      this.app.workspace.setActiveLeaf(existing, { focus: false });
      await this.app.workspace.revealLeaf(existing);
      return true;
    }

    await this.app.workspace.getLeaf("tab").openFile(file);
    return true;
  }

  /** The host's layout API, or null when it does not expose one. */
  private layoutApi(): LayoutApi | null {
    const workspace = this.app.workspace as unknown as {
      getLayout?: () => unknown;
      changeLayout?: (layout: unknown) => Promise<void>;
    };
    if (typeof workspace.getLayout !== "function" || typeof workspace.changeLayout !== "function") {
      return null;
    }

    const getLayout = workspace.getLayout.bind(workspace);
    const changeLayout = workspace.changeLayout.bind(workspace);
    return { getLayout: () => getLayout(), applyLayout: (layout) => changeLayout(layout) };
  }

  /**
   * Renders saved prose as Markdown, so a link in a thought is still a link.
   *
   * The public renderer, not a workspace-internal one, so embedded notes, tags and
   * links behave exactly as they do in a note — and the component the composer
   * owns is what unloads them when the surface repaints.
   */
  private async renderMarkdown(
    element: HTMLElement,
    markdown: string,
    sourcePath: string,
    component: Component
  ): Promise<void> {
    try {
      await MarkdownRenderer.render(this.app, markdown, element, sourcePath, component);
    } catch {
      // A note that cannot be rendered is still readable as its own text.
      element.textContent = markdown;
    }
  }

  /**
   * The one door to another Realm.
   *
   * The departure is captured *now*, not trusted from the last visit, because a
   * reading position drifts without a layout change. The arrival is recorded only
   * after it succeeded, so a failed visit leaves the history where it was and
   * `Back` can never walk into a place that was not reached.
   */
  async visitTapestry(contextId: string): Promise<boolean> {
    return this.navigate(async () => {
      const departure = this.workspaceStop();
      const moved = await this.workspaces.visit(contextId);
      if (!moved) return false;
      this.history = this.arrivedAt(this.workspaceStop(), departure);
      return true;
    });
  }

  /**
   * The one door to a written thought.
   *
   * `edit` is the bounded correction route: the caret goes into the thought's own
   * prose and the composer keeps its draft. Both routes are the same jump, and
   * both are preflighted by the engine, so a thought that has changed is refused
   * instead of landing somewhere else.
   */
  async visitThought(target: ThoughtRef, edit: boolean): Promise<boolean> {
    return this.navigate(async () => {
      const departure = this.departureStop();
      const moved = await this.entries.jumpTo(target.path, target.n, undefined, edit);
      if (!moved) {
        if (departure !== null) await this.restoreStop(departure);
        return false;
      }
      this.history = this.arrivedAt(this.currentStop(), departure);
      return true;
    });
  }

  /** Back one visit, restored from the place it was, not from its Realm's latest. */
  async goBack(): Promise<boolean> {
    return this.navigate(async () => {
      if (!canGoBack(this.history)) return false;
      const step = back(this.history);
      if (step.stop === null) return false;
      const moved = await this.restoreStop(step.stop);
      if (moved) this.history = step.history;
      return moved;
    });
  }

  /** Forward one visit, exactly as it was left. */
  async goForward(): Promise<boolean> {
    return this.navigate(async () => {
      if (!canGoForward(this.history)) return false;
      const step = forward(this.history);
      if (step.stop === null) return false;
      const moved = await this.restoreStop(step.stop);
      if (moved) this.history = step.history;
      return moved;
    });
  }

  /**
   * One navigation transaction at a time.
   *
   * Two moves racing would leave the screen in neither place, and the second
   * would record an arrival that the first is still describing. A refused
   * transaction changes nothing at all.
   */
  private async navigate(action: () => Promise<boolean>): Promise<boolean> {
    if (this.navigating) return false;
    this.navigating = true;
    try {
      return await action();
    } finally {
      this.navigating = false;
    }
  }

  /** The whole screen as a stop, for moving between Realms. */
  private workspaceStop(): Stop {
    const snapshot = this.workspaces.snapshot();
    const viewing = this.workspaces.viewing();
    return {
      kind: "workspace",
      contextId: viewing === "" ? null : viewing,
      layout: snapshot?.layout ?? null,
      panes: snapshot?.panes ?? [],
      activePath: snapshot?.activePath ?? null,
      activeLeafId: snapshot?.activeLeafId ?? null
    };
  }

  /** The place the caret is, or the whole screen when no editor has it. */
  private currentStop(): Stop {
    return this.entries.stopHere() ?? this.workspaceStop();
  }

  /** The place being left, captured before anything moves. */
  private departureStop(): Stop | null {
    const here = this.entries.stopHere();
    if (here !== null) return here;
    return this.workspaces.snapshot() === null ? null : this.workspaceStop();
  }

  /**
   * Records arriving somewhere, with the place being left made exact first.
   *
   * Refreshing the current stop is what keeps `Back` honest: the writer may have
   * scrolled or moved the caret since the last visit, and the stop that describes
   * where they are *now* is the one `Back` must return them to. When the history
   * is empty, the departure seeds it, so the first `Back` has somewhere to go.
   */
  private arrivedAt(arrival: Stop, departure: Stop | null): NavigationHistory {
    let history = this.history;

    if (departure !== null) {
      const current = history.visits[history.cursor];
      if (current === undefined) {
        history = record(history, departure);
      } else {
        const visits = [...history.visits];
        visits[history.cursor] = departure;
        history = { visits, cursor: history.cursor };
      }
    }

    return record(history, arrival);
  }

  /** Restores one recorded stop: a whole screen, or a caret in a note. */
  private async restoreStop(stop: Stop): Promise<boolean> {
    if (stop.kind === "workspace") {
      const snapshot: WorkspaceSnapshot = {
        layout: stop.layout,
        panes: stop.panes,
        activePath: stop.activePath,
        activeLeafId: stop.activeLeafId
      };
      return this.workspaces.restoreSnapshot(snapshot, stop.contextId);
    }
    return this.entries.jumpTo(stop.path, stop.n, stop);
  }

  /**
   * Repaints the one bottom surface from the openings and the draft.
   *
   * There is no separate dock to keep in step any more: the strip is part of the
   * composer, so one call draws both, and the navigator (when it is open) only
   * re-derives its own list.
   */
  repaintSurface(): void {
    this.composer?.render();
  }

  /**
   * The opening the surface should speak about, if any.
   *
   * Closed, this is the whole surface: the nearest offering in the order the
   * controller sorts — open first, then by opening time. A draft speaks about its
   * own Realm only, and a draft that already qualified says `Through` itself,
   * because an opening it already counts for is not something to offer again.
   */
  portalStrip(): PortalStripView | null {
    const now = Date.now();
    const state = this.controller.state;
    const outstanding = this.portals.outstanding();

    if (state.phase === "editing") {
      if (state.invitations.length > 0) return null;
      const mine = outstanding.find(
        (candidate) => candidate.occurrence.contextId === state.contextId
      );
      if (mine !== undefined) {
        const others = outstanding.filter(
          (candidate) => candidate.occurrence.contextId !== state.contextId
        ).length;
        return this.offeredStrip(mine, now, others);
      }
      return this.closedStrip(state.contextId, true, 0);
    }

    if (state.phase !== "closed") return null;

    const primary = outstanding[0];
    if (primary !== undefined) return this.offeredStrip(primary, now, outstanding.length - 1);
    return this.closedStrip(null, false, 0);
  }

  /** One outstanding opening, as the strip says it. */
  private offeredStrip(
    offered: OfferedInvitation,
    now: number,
    others: number
  ): PortalStripView {
    const opensAt = offered.occurrence.portal.opensAt;
    const live = offered.phase === "available";
    return {
      occurrenceId: offered.occurrence.id,
      contextName: this.contextName(offered.occurrence.contextId),
      opening: portalTime(offered.occurrence.portal),
      phase: live ? "available" : "approaching",
      remainingMs: live ? opensAt + OPENING_WINDOW_MS - now : opensAt - now,
      others,
      writingNormally: false,
      actionable: true
    };
  }

  /**
   * A minute that has just closed, said once and then forgotten.
   *
   * It is derived from the calendar rather than remembered, so waking after a long
   * sleep replays nothing and no missed opening leaves a trace in any note.
   */
  private closedStrip(
    contextId: string | null,
    writingNormally: boolean,
    others: number
  ): PortalStripView | null {
    const closed = this.portals
      .recentlyClosed(CLOSED_WINDOW_MS)
      .find((occurrence) => contextId === null || occurrence.contextId === contextId);
    if (closed === undefined) return null;

    return {
      occurrenceId: closed.id,
      contextName: this.contextName(closed.contextId),
      opening: portalTime(closed.portal),
      phase: "closed",
      remainingMs: 0,
      others,
      writingNormally,
      actionable: false
    };
  }

  /** One Realm's display name, or its id when the settings cannot name it. */
  private contextName(contextId: string): string {
    return this.contexts().find((context) => context.id === contextId)?.name ?? contextId;
  }

  private registerCommands(): void {
    // Every command carries an icon so Obsidian's mobile toolbar can show it.
    this.addCommand({
      id: "start-entry",
      name: "Weave a Thread",
      icon: "plus",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "Enter" }],
      // Not an editor callback: a thought may be woven from any view, or none.
      callback: () => this.openLoom()
    });

    this.addCommand({
      id: "descend",
      name: "Branch from this thought",
      icon: "arrow-down-right",
      callback: () => this.entries.descendAtCaret()
    });

    this.addCommand({
      id: "back",
      name: "Back",
      icon: "arrow-left",
      // No default hotkey: a global binding would shadow the writer's own Vim
      // motions and Obsidian chords. Anyone who wants one can bind it.
      callback: () => void this.goBack()
    });

    this.addCommand({
      id: "forward",
      name: "Forward",
      icon: "arrow-right",
      callback: () => void this.goForward()
    });

    this.addCommand({
      id: "navigate",
      name: "Browse the Loom",
      icon: "list",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "P" }],
      callback: () => void this.openReference()
    });

    this.addCommand({
      id: "view-today",
      name: "View Today",
      icon: "calendar",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "t" }],
      callback: () => void this.openReferenceToday()
    });

    this.addCommand({
      id: "loom-previous-tapestry",
      name: "Previous Tapestry",
      icon: "chevron-left",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "ArrowLeft" }],
      checkCallback: (checking) => {
        if (this.composer?.isOpen !== true) return false;
        if (!checking) this.cycleTapestry(-1);
        return true;
      }
    });

    this.addCommand({
      id: "loom-next-tapestry",
      name: "Next Tapestry",
      icon: "chevron-right",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "ArrowRight" }],
      checkCallback: (checking) => {
        if (this.composer?.isOpen !== true) return false;
        if (!checking) this.cycleTapestry(1);
        return true;
      }
    });

    this.addCommand({
      id: "loom-reference",
      name: "Show the Loom reference",
      icon: "book-open",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "ArrowUp" }],
      checkCallback: (checking) => {
        if (this.composer?.isOpen !== true) return false;
        if (!checking) void this.openReference();
        return true;
      }
    });

    this.addCommand({
      id: "loom-write",
      name: "Return to writing",
      icon: "pencil",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "ArrowDown" }],
      checkCallback: (checking) => {
        if (this.composer?.isOpen !== true) return false;
        if (!checking) this.openLoom();
        return true;
      }
    });

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

  /** Invalidates the reading index for changed paths and discards stale queries. */
  private invalidateIndex(paths: readonly string[]): void {
    for (const path of paths) this.thoughtIndex?.invalidate(path);
    this.referenceGeneration += 1;
  }

  private async loadSettings(): Promise<void> {
    this.dataStore = new PluginDataStore({
      readShared: () => this.loadData(),
      writeShared: (data) => this.saveData(data),
      readLocal: () => this.loadLocal(REPLICA_STORAGE_KEY),
      writeLocal: (value) => this.saveLocal(REPLICA_STORAGE_KEY, value),
      now: () => Date.now(),
      deviceId: () => this.local.deviceId(),
      notify: (message) => new Notice(message, NOTICE_NOOP_MS),
      onChange: () => this.repaintSurface()
    });

    await this.dataStore.load();
    this.data = this.dataStore.currentData;
    this.settings = this.dataStore.currentSettings;
  }

  /** Vault-local storage, when this host exposes it. */
  private loadLocal(key: string): unknown {
    const storage = this.app as unknown as { loadLocalStorage?: (key: string) => unknown };
    if (typeof storage.loadLocalStorage !== "function") return null;
    try {
      return storage.loadLocalStorage(key);
    } catch {
      return null;
    }
  }

  private saveLocal(key: string, value: unknown): void {
    const storage = this.app as unknown as {
      saveLocalStorage?: (key: string, value: unknown) => void;
    };
    if (typeof storage.saveLocalStorage !== "function") {
      throw new Error("this host has no vault-local storage");
    }
    storage.saveLocalStorage(key, value);
  }

  /** Recounts a day's stats and merges them into the note. */
  private withDayStats(source: string, now: Date): string {
    if (!this.settings.writeDayCounters) return source;
    const stats = recountDay(source, parseClose(source).closedAt);
    return applyDayStats(source, stats, dayKeyOf(now)).source;
  }

  /** Debounced recount for edits made by hand in any recognized day note. */
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
   *
   * Every recognized day note is counted, not just `main`'s today: a thought may
   * be woven into any destination, and that note's own numbers are derived from
   * its own text.
   */
  private async refreshDayStats(file: TFile): Promise<void> {
    if (sourceDayOf(file.path, this.contexts()) === null) return;

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
