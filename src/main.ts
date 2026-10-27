import { MarkdownView, Notice, Plugin, TFile, type Editor } from "obsidian";

import { findCurrentHeading, parseHeadings, type HeadingIndex } from "./core/headings";
import { DraftController } from "./drafts/controller";
import { VaultDraftIndex } from "./drafts/vault-index";
import {
  applyPlanToSource,
  offsetToLineCh,
  planInsertHeading,
  planSourceId,
  planSpark,
  type InsertOptions,
  type InsertPlan
} from "./core/insert";
import { formatClock } from "./core/clock";
import {
  basenameOfPath,
  linkTargetOf,
  planReference,
  shortLabel,
  type Reference
} from "./core/reference";
import { planCloseDay } from "./core/close";
import { applyDayCounts, recountDay, writeDayCounts } from "./core/day-counters";
import { dayKey, ensureDayNote, resolveDayNote } from "./core/day-note";
import { collectBlockIds } from "./core/reference";
import { parseMarks } from "./core/marks";
import { computeInsertLevel } from "./core/insert";
import { openInsertEffect } from "./editor/inline-insert-field";
import { inlineInsertExtension } from "./editor/inline-insert-field";
import { findActiveEditorView, findEditorViewForFile } from "./editor/view-registry";
import { computePalette } from "./core/palette";
import { createDraftProcessor } from "./reading/draft-post-processor";
import { createMarkProcessor } from "./reading/mark-post-processor";
import { createDeepHeadingProcessor } from "./reading/post-processor";
import { draftDecorationsExtension } from "./editor/draft-decorations";
import { headingDecorationsExtension } from "./editor/heading-decorations";
import { markLineExtension } from "./editor/mark-decorations";
import { headingIndexExtension, refreshHeadingsEffect } from "./editor/index-field";
import { TravelController, travelExtension } from "./editor/travel-mode";
import { registeredEditorViews, viewRegistryExtension } from "./editor/view-registry";
import {
  NOTICE_DAY_ALREADY_CLOSED,
  NOTICE_DAY_CLOSED,
  NOTICE_NEEDS_EDITING,
  NOTICE_NOOP_MS,
  NOTICE_PARTIAL_MS,
  NOTICE_REFUSAL_MS,
  NOTICE_NO_DAY_NOTE,
  NOTICE_NO_SOURCE,
  NOTICE_SHUTTLE_EMPTY,
  NOTICE_SPARK_NO_SOURCE,
  noticeCloseCodeBlock,
  noticeCloseFrontmatter
} from "./notices";
import { normalizeData, type WeaverData, type WeaverSettings } from "./settings";

import { TapestryView, TAPESTRY_VIEW_TYPE } from "./ui/tapestry-view";
import { StatusStrip } from "./ui/status-strip";
import { ShuttlePalette } from "./ui/shuttle-palette";
import { TapestrySheet } from "./ui/tapestry-sheet";
import { jumpToReference, jumpToWikiTarget } from "./ui/reference-jump";
import { ShuttleStore, type ShuttleItem } from "./shuttle/store";
import type { Scope } from "./ui/tapestry-data";
import { DraftSearchModal } from "./ui/draft-search-modal";

import { isMobile, isPhone, isTablet } from "./ui/platform";
import { WeaverSettingTab } from "./settings-tab";
import { applyPalette, removePalette } from "./ui/palette";
import { VaultPaletteScanner } from "./vault-scan";

/** Hand edits in the day note settle for this long before the counters follow. */
const DAY_COUNTS_DELAY_MS = 2000;

const BODY_CLASSES = [
  "weaver-no-emphasis",
  "weaver-equal-sizes",
  "weaver-platform-mobile",
  "weaver-phone",
  "weaver-tablet",
  "weaver-traveling"
];

export default class WeaverPlugin extends Plugin {
  data: WeaverData = normalizeData(null);
  settings: WeaverSettings = this.data.settings;
  /** Current H1..Hmax colors, index 0 is H1. */
  palette: string[] = [];

  travel: TravelController | null = null;
  strip: StatusStrip | null = null;
  /** The scope the next Tapestry view opens at. */
  lastTapestryScope: Scope = "note";
  shuttles!: ShuttleStore;
  private shuttlePalette: ShuttlePalette | null = null;
  /** Where "Return to source" came from, so a second invocation goes back. */
  private returnPlace: { file: TFile; line: number } | null = null;
  drafts!: DraftController;
  draftIndex!: VaultDraftIndex;
  private deepHeadingSignature = "";
  private scanner: VaultPaletteScanner | null = null;
  private dayCountTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.syncBodyClasses();
    this.applyCurrentPalette();

    this.drafts = new DraftController(this);

    // Hand edits in the day note still end with honest counters; the debounce
    // keeps the write count down while typing.
    this.registerEvent(
      this.app.vault.on("modify", (file) => this.scheduleDayCounts(file instanceof TFile ? file : null))
    );

    this.registerEditorExtension([
      viewRegistryExtension,
      headingIndexExtension(() => this.settings.maxDepth),
      headingDecorationsExtension(() => this.settings),
      markLineExtension(),
      draftDecorationsExtension(
        () => this.settings,
        () => this.drafts.badgeHandlers()
      ),
      travelExtension(),
      inlineInsertExtension(this)
    ]);

    this.travel = new TravelController(this);

    this.registerView(TAPESTRY_VIEW_TYPE, (leaf) => new TapestryView(leaf, this));

    // Registration order is execution order: deep headings first, so this pass
    // sees marker paragraphs the way they were written.
    this.registerMarkdownPostProcessor(createDeepHeadingProcessor(this));
    this.registerMarkdownPostProcessor(createDraftProcessor(this));
    this.registerMarkdownPostProcessor(createMarkProcessor());

    this.registerCommands();

    this.scanner = new VaultPaletteScanner(
      this.app,
      () => this.settings.maxDepth,
      () => this.data.lastVaultMaxLevel,
      (level) => this.onVaultDepth(level)
    );
    this.scanner.start();

    this.draftIndex = new VaultDraftIndex(this.app, () => this.settings.maxDepth);
    this.draftIndex.start();

    this.strip = new StatusStrip(this);
    this.strip.start();

    this.shuttles = new ShuttleStore(this.data.shuttle, (items) => {
      this.data.shuttle = items;
      void this.saveData(this.data);
    });

    // One menu item, so the shuttle is discoverable without a chord.
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu) => {
        menu.addItem((item) =>
          item
            .setTitle("Weaver: load to shuttle")
            .setIcon("inbox")
            .onClick(() => {
              void this.loadShuttle();
            })
        );
      })
    );

    this.addSettingTab(new WeaverSettingTab(this.app, this));
    this.deepHeadingSignature = this.renderSignature();

    console.log(`Weaver loaded ${this.manifest.version}`);
  }

  onunload(): void {
    if (this.dayCountTimer !== null) {
      window.clearTimeout(this.dayCountTimer);
      this.dayCountTimer = null;
    }
    this.travel?.destroy();
    this.travel = null;
    this.strip?.destroy();
    this.strip = null;
    this.scanner?.stop();
    this.scanner = null;
    this.draftIndex?.stop();
    removePalette();
    document.body.classList.remove(...BODY_CLASSES);
  }

  async saveSettings(): Promise<void> {
    this.data.settings = this.settings;
    await this.saveData(this.data);
  }

  insertOptions(): InsertOptions {
    return {
      maxDepth: this.settings.maxDepth,
      separator: this.settings.timestampSeparator,
      format: this.settings.timestampFormat
    };
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
    body.toggle("weaver-equal-sizes", this.settings.equalizeHeadingSizes);
    body.toggle("weaver-platform-mobile", isMobile());
    body.toggle("weaver-phone", isPhone());
    body.toggle("weaver-tablet", isTablet());
  }

  applyCurrentPalette(): void {
    this.palette = computePalette(
      this.settings.colorMode,
      this.data.lastVaultMaxLevel,
      this.settings.maxDepth
    );
    applyPalette(this.settings, this.palette);
  }

  /**
   * Opens the inline weave row.
   *
   * It lands where the caret already is: authoring happens in the note, not in a
   * dialog over it, and nothing is written until the commit.
   */
  openComposer(): void {
    const view = this.activeMarkdownView();
    if (view === null) return;

    if (!this.isEditing(view)) {
      new Notice(NOTICE_NEEDS_EDITING, NOTICE_REFUSAL_MS);
      return;
    }

    const editor = view.editor;
    const index = this.indexOf(editor.getValue());
    const cursorLine = editor.getCursor().line;
    const at = editor.posToOffset(editor.getCursor());
    const level = computeInsertLevel(findCurrentHeading(index, cursorLine), this.settings.maxDepth);

    const cm =
      view.file === null
        ? null
        : (findEditorViewForFile(view.file) ?? findActiveEditorView(this.app));
    cm?.dispatch({
      effects: openInsertEffect.of({ at, level, maxDepth: this.settings.maxDepth })
    });
  }

  log(...args: unknown[]): void {
    if (this.settings.debug) console.log("[Weaver]", ...args);
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

  /** Applies every setting that can change live, without a reload. */
  onSettingsChange(): void {
    this.syncBodyClasses();
    this.applyCurrentPalette();

    // Reindexing while travel is open would leave the target pointing at stale
    // offsets, so travel is closed first.
    if (this.travel?.active === true) this.travel.exit();

    for (const view of registeredEditorViews()) {
      view.dispatch({ effects: refreshHeadingsEffect.of(undefined) });
    }

    if (this.renderSignature() !== this.deepHeadingSignature) {
      this.deepHeadingSignature = this.renderSignature();
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        const view = leaf.view;
        if (view instanceof MarkdownView && view.getMode() === "preview") {
          view.previewMode.rerender(true);
        }
      }
    }

    // The ribbon and the settings tab must keep the panel's toggles honest.
    for (const leaf of this.app.workspace.getLeavesOfType(TAPESTRY_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof TapestryView) view.syncControls();
    }
    void this.strip?.update();
  }

  /** Re-reads the vault for the deepest heading level in use. */
  async rescanPalette(): Promise<void> {
    await this.scanner?.rescan(true);
  }

  /**
   * Opens (or reveals) the Tapestry as a tab, at a scope.
   *
   * One Tapestry, one tab: an open one is re-scoped and revealed rather than
   * duplicated, which is what the strip and the Review both rely on. The requested
   * scope is remembered before the view is created, because a new leaf constructs
   * a fresh Tapestry.
   */
  openTapestry(scope: Scope = "note"): void {
    this.lastTapestryScope = scope;

    // A phone has no tabs, so the Tapestry arrives as a sheet instead.
    if (isPhone()) {
      this.openTapestrySheet(scope);
      return;
    }

    const workspace = this.app.workspace;
    const existing = workspace.getLeavesOfType(TAPESTRY_VIEW_TYPE)[0];
    if (existing !== undefined) {
      const view = existing.view;
      if (view instanceof TapestryView) void view.setScope(scope);
      workspace.setActiveLeaf(existing, { focus: true });
      void workspace.revealLeaf(existing);
      return;
    }

    const leaf = workspace.getLeaf("tab");
    void leaf.setViewState({ type: TAPESTRY_VIEW_TYPE, active: true });
  }

  /** Settings that change what Reading view must re-render. */
  private renderSignature(): string {
    return `${this.settings.deepHeadingReadingView}:${this.settings.maxDepth}`;
  }

  private onVaultDepth(level: number): void {
    if (this.data.lastVaultMaxLevel === level) return;
    this.data.lastVaultMaxLevel = level;
    void this.saveData(this.data);
    this.applyCurrentPalette();
  }

  private registerCommands(): void {
    // Every command carries an icon so Obsidian's mobile toolbar can show it.
    this.addCommand({
      id: "spark",
      name: "Spark",
      icon: "sparkles",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "k" }],
      // Not an editor callback: the Today target works from Reading view and
      // with no note open at all.
      callback: () => void this.spark()
    });

    this.addCommand({
      id: "insert-heading",
      name: "Insert dimension",
      icon: "heading",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "j" }],
      editorCallback: () => this.beginInsertHeading()
    });

    this.addCommand({
      id: "open-composer",
      name: "Weave rows",
      icon: "pencil",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "l" }],
      editorCallback: () => this.openComposer()
    });

    this.addCommand({
      id: "load-shuttle",
      name: "Shuttle",
      icon: "inbox",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "g" }],
      // Load, then open: the palette arriving with the row at the top is the
      // whole feedback, so a successful load says nothing else.
      callback: () => void this.loadShuttle()
    });

    this.addCommand({
      id: "return",
      name: "Return to source",
      icon: "corner-up-left",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "Enter" }],
      callback: () => this.returnToSource()
    });

    this.addCommand({
      id: "close-day",
      name: "Close the day",
      icon: "check-circle",
      callback: () => void this.closeDay()
    });

    this.addCommand({
      id: "new-draft",
      name: "Start a draft at the cursor",
      icon: "file-plus",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "d" }],
      editorCallback: () => this.drafts.createDraft(new Date())
    });

    this.addCommand({
      id: "weave-draft",
      name: "Weave the draft at the cursor",
      icon: "check",
      editorCallback: () => this.drafts.weaveDraftAtCursor(new Date())
    });

    this.addCommand({
      id: "open-draft-search",
      name: "Search open drafts",
      icon: "search",
      callback: () => new DraftSearchModal(this.app, this).open()
    });

    this.addCommand({
      id: "tapestry",
      name: "Open Tapestry",
      icon: "waypoints",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "t" }],
      callback: () => this.openTapestry()
    });

    this.addCommand({
      id: "travel",
      name: "Travel through dimensions",
      icon: "compass",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "p" }],
      editorCallback: () => this.travel?.enter()
    });

  }

  /** The Tapestry as a bottom sheet, for surfaces without a sidebar. */
  openTapestrySheet(scope: Scope = this.lastTapestryScope): void {
    this.lastTapestryScope = scope;
    new TapestrySheet(this.app, this, scope).open();
  }

  /**
   * Writes the next dimension at the caret's site and puts the caret in its
   * title: you type the dimension in the note, never in a control row.
   */
  beginInsertHeading(): void {
    const view = this.activeMarkdownView();
    if (view === null) return;

    if (!this.isEditing(view)) {
      new Notice(NOTICE_NEEDS_EDITING, NOTICE_REFUSAL_MS);
      return;
    }

    this.insertHeading(view, "", undefined, new Date());
  }

  private isEditing(view: MarkdownView): boolean {
    return view.getMode() === "source";
  }

  private indexOf(source: string): HeadingIndex {
    return parseHeadings(source, { maxDepth: this.settings.maxDepth });
  }

  insertHeading(
    view: MarkdownView,
    title: string,
    levelOverride: number | undefined,
    now: Date
  ): void {
    const editor = view.editor;
    const source = editor.getValue();
    const index = this.indexOf(source);
    const cursorLine = editor.getCursor().line;

    const plan = planInsertHeading(
      source,
      index,
      cursorLine,
      now,
      this.insertOptions(),
      title,
      levelOverride
    );

    if (plan === null) {
      this.notifyRefusal(index, "inserting a dimension");
      return;
    }

    this.applyPlan(editor, source, plan);
  }

  /**
   * Public so the mobile action sheet and commands share one path.
   *
   * Two targets, two commit paths: *This note* writes through the editor so one
   * undo reverts it, and *Today* writes through `Vault.process`, which needs no
   * open editor — so Spark works from Reading view and with no note at all.
   */
  async spark(): Promise<void> {
    const now = new Date();
    const view = this.activeMarkdownView();
    const selection = this.selectionOf(view);

    if (this.settings.sparkTarget === "note") {
      if (view === null || !this.isEditing(view)) {
        new Notice(NOTICE_NEEDS_EDITING, NOTICE_REFUSAL_MS);
        return;
      }
      this.sparkIntoNote(view, selection, now);
      return;
    }

    await this.sparkIntoDayNote(view, selection, now);
  }

  /** Closes today's day note: one mark, then the counters. */
  async closeDay(): Promise<void> {
    const now = new Date();
    const file = resolveDayNote(this.app, this.settings, now).file;
    if (file === null) {
      new Notice(NOTICE_NO_DAY_NOTE, NOTICE_REFUSAL_MS);
      return;
    }

    let closed = false;
    await this.app.vault.process(file, (data) => {
      const plan = planCloseDay(data, now, this.insertOptions());
      if (plan === null) return data;
      closed = true;
      return this.withDayCounts(applyPlanToSource(data, plan).source, now);
    });

    if (!closed) {
      new Notice(NOTICE_DAY_ALREADY_CLOSED, NOTICE_REFUSAL_MS);
      return;
    }
    new Notice(
      NOTICE_DAY_CLOSED(formatClock(now, this.settings.timestampFormat)),
      NOTICE_NOOP_MS
    );
  }


  /**
   * The shuttle's one verb: load the caret's context, then open the palette.
   *
   * The row arriving at the top of an open palette is the acknowledgement; a
   * toast on every load would be noise over the thing it describes. The empty
   * notice is for the case that has nothing to show at all.
   */
  async loadShuttle(): Promise<void> {
    const view = this.activeMarkdownView();
    const file = view?.file ?? this.app.workspace.getActiveFile();

    if (view === null || file === null) {
      if (this.shuttles.items().length === 0) new Notice(NOTICE_SHUTTLE_EMPTY, NOTICE_NOOP_MS);
      this.openShuttlePalette();
      return;
    }

    const selection = this.selectionOf(view);
    if (selection !== null) {
      const source = view.editor.getValue();
      const idPlan = planSourceId(source, selection, collectBlockIds(source));
      if (idPlan.change !== null) {
        const end = idPlan.change.to;
        this.applyPlan(view.editor, source, {
          changes: [idPlan.change],
          selection: { from: end, to: end }
        });
      }

      this.shuttles.load({
        kind: "words",
        path: file.path,
        blockId: idPlan.id,
        label: shortLabel(selection.text)
      });
      this.openShuttlePalette();
      return;
    }

    const source = this.isEditing(view) ? view.editor.getValue() : await this.app.vault.cachedRead(file);
    const cursorLine = this.isEditing(view) ? view.editor.getCursor().line : 0;
    const index = this.indexOf(source);
    const heading = findCurrentHeading(index, cursorLine);

    if (heading !== null) {
      const label = `${heading.time ?? ""} ${heading.title}`.trim() || heading.text.trim();
      this.shuttles.load({
        kind: "dimension",
        path: file.path,
        headingText: heading.text.trim(),
        label
      });
      this.openShuttlePalette();
      return;
    }

    this.shuttles.load({ kind: "note", path: file.path, label: file.basename });
    this.openShuttlePalette();
  }

  /** Opens the shuttle palette. It is the whole feedback for a load. */
  openShuttlePalette(): void {
    this.shuttlePalette ??= new ShuttlePalette(this);
    this.shuttlePalette.open();
  }

  /** Weaves a loaded source in at the caret, keeping the row loaded. */
  weaveShuttleItem(item: ShuttleItem): void {
    const view = this.activeMarkdownView();
    if (view === null || !this.isEditing(view)) {
      new Notice(NOTICE_NEEDS_EDITING, NOTICE_REFUSAL_MS);
      return;
    }

    const editor = view.editor;
    const source = editor.getValue();
    const range = editor.listSelections()[0];
    if (range === undefined) return;

    const anchor = editor.posToOffset(range.anchor);
    const head = editor.posToOffset(range.head);
    const ref: Reference = {
      kind: item.kind,
      path: item.path,
      basename: basenameOfPath(item.path),
      headingText: item.headingText,
      blockId: item.blockId,
      label: item.label
    };

    this.applyPlan(
      editor,
      source,
      planReference(source, ref, Math.min(anchor, head), Math.max(anchor, head))
    );
    this.shuttles.markUsed(item.id);
  }

  /** Opens a loaded source without leaving the note being written. */
  openShuttleItem(item: ShuttleItem): void {
    // Opening is not weaving: the `·n` badge counts sources woven in.
    jumpToReference(this.app, item);
  }

  /** Sparks a new thread caused by a loaded source. */
  async sparkFrom(item: ShuttleItem): Promise<void> {
    const now = new Date();
    const sourceRef = { target: linkTargetOf(item), label: item.label };
    const view = this.activeMarkdownView();

    if (this.settings.sparkTarget === "note") {
      // The target *is* this note, so there is nowhere legible to write if this
      // note cannot be edited: say so rather than writing to today behind it.
      if (view === null || !this.isEditing(view)) {
        new Notice(NOTICE_NEEDS_EDITING, NOTICE_REFUSAL_MS);
        return;
      }
      this.sparkIntoNote(view, null, now, sourceRef);
      this.shuttles.markUsed(item.id);
      return;
    }

    await this.sparkIntoDayNote(view, null, now, sourceRef);
    this.shuttles.markUsed(item.id);
  }

  /**
   * Jumps to the `✦` source of the spark above the caret, and back again.
   *
   * The return place is session-only: it is where the writing happened, not a
   * claim that anything was noticed.
   */
  returnToSource(): void {
    const view = this.activeMarkdownView();
    if (view === null || view.file === null || !this.isEditing(view)) {
      new Notice(NOTICE_NEEDS_EDITING, NOTICE_REFUSAL_MS);
      return;
    }

    const place = this.returnPlace;
    if (place !== null && place.file.path === view.file.path) {
      this.returnPlace = null;
      this.placeCaret(view, place.line);
      return;
    }

    const source = view.editor.getValue();
    const index = this.indexOf(source);
    const cursorLine = view.editor.getCursor().line;
    const spark = findCurrentHeading(index, cursorLine);
    const target = spark === null ? null : this.sourceTargetOf(source, index, spark.line);
    if (target === null) {
      new Notice(NOTICE_NO_SOURCE, NOTICE_REFUSAL_MS);
      return;
    }

    this.returnPlace = { file: view.file, line: cursorLine };
    if (!jumpToWikiTarget(this.app, target, view.file.path)) {
      this.returnPlace = null;
      new Notice(NOTICE_NO_SOURCE, NOTICE_REFUSAL_MS);
    }
  }

  /** The `✦` link target under a 1D dimension, or null when it records none. */
  private sourceTargetOf(source: string, index: HeadingIndex, sparkLine: number): string | null {
    const next = index.headings.find(
      (candidate) => candidate.line > sparkLine && candidate.level === 1
    );
    const boundary = next?.line ?? Number.POSITIVE_INFINITY;

    for (const mark of parseMarks(source).sources) {
      if (mark.line <= sparkLine || mark.line >= boundary) continue;
      return mark.target;
    }
    return null;
  }

  private placeCaret(view: MarkdownView, line: number): void {
    const last = Math.max(0, view.editor.lineCount() - 1);
    const position = { line: Math.min(line, last), ch: 0 };
    view.editor.setCursor(position);
    view.editor.scrollIntoView({ from: position, to: position }, true);
    view.editor.focus();
  }

  private sparkIntoNote(
    view: MarkdownView,
    selection: { from: number; to: number; text: string } | null,
    now: Date,
    sourceRef?: { target: string; label: string }
  ): void {
    const editor = view.editor;
    const source = editor.getValue();
    const index = this.indexOf(source);
    const plan = planSpark({
      source,
      index,
      now,
      options: this.insertOptions(),
      selection,
      noteBasename: view.file?.basename ?? "",
      existingIds: collectBlockIds(source),
      sourceRef
    });

    if (plan === null) {
      this.notifyRefusal(index, "sparking");
      return;
    }

    this.applyPlan(editor, source, plan);
    this.scheduleDayCounts(view.file);
    void this.strip?.update();
  }

  private async sparkIntoDayNote(
    view: MarkdownView | null,
    selection: { from: number; to: number; text: string } | null,
    now: Date,
    sourceRef?: { target: string; label: string }
  ): Promise<void> {
    const resolved = resolveDayNote(this.app, this.settings, now);
    let dayFile = resolved.file;
    if (dayFile === null) {
      try {
        dayFile = await ensureDayNote(this.app, resolved.path, now);
      } catch {
        // A read-only vault or a sync lock must fail loudly, never fall back to
        // writing the spark into whatever note happens to be open.
        new Notice(NOTICE_NO_DAY_NOTE, NOTICE_REFUSAL_MS);
        return;
      }
    }

    const sourceFile = selection === null ? null : (view?.file ?? null);
    const selectionId = await this.writeSourceId(sourceFile, selection, dayFile);
    if (sourceFile !== null && selection !== null && selectionId === undefined) {
      new Notice(NOTICE_SPARK_NO_SOURCE, NOTICE_PARTIAL_MS);
    }

    let refusal: HeadingIndex | null = null;
    let written = "";
    let caret: number | null = null;

    await this.app.vault.process(dayFile, (data) => {
      const index = this.indexOf(data);
      const plan = planSpark({
        source: data,
        index,
        now,
        options: this.insertOptions(),
        selection,
        noteBasename: sourceFile?.basename ?? "",
        existingIds: collectBlockIds(data),
        selectionId,
        sourceRef
      });

      if (plan === null) {
        refusal = index;
        return data;
      }

      const next = applyPlanToSource(data, plan).source;
      written = next;
      caret = plan.selection.from;
      return this.withDayCounts(next, now);
    });

    if (refusal !== null) {
      this.notifyRefusal(refusal, "sparking");
      return;
    }

    await this.openDayNote(dayFile, written, caret);
    void this.strip?.update();
  }

  /**
   * Appends the block id to the selection's last line, in its own note.
   *
   * The id is never rolled back if the day-note write then fails: an unused id
   * is harmless, while a compensating write could fail harder than the one that
   * went wrong. Stale offsets are refused rather than applied — the selection
   * text must still be where the editor said it was.
   */
  private async writeSourceId(
    file: TFile | null,
    selection: { from: number; to: number; text: string } | null,
    dayFile: TFile
  ): Promise<string | undefined> {
    if (file === null || selection === null || file.path === dayFile.path) return undefined;

    let id: string | undefined;
    try {
      await this.app.vault.process(file, (data) => {
        if (data.slice(selection.from, selection.to) !== selection.text) return data;

        const idPlan = planSourceId(data, selection, collectBlockIds(data));
        id = idPlan.id;
        if (idPlan.change === null) return data;

        const end = idPlan.change.to;
        return applyPlanToSource(data, {
          changes: [idPlan.change],
          selection: { from: end, to: end }
        }).source;
      });
    } catch {
      return undefined;
    }
    return id;
  }

  /**
   * Shows the day note: revealing the tab that already holds it, or opening one
   * of its own.
   *
   * `getLeaf(false)` would reuse — and therefore replace — the tab the writer is
   * in, so a spark taken from another note would take that note off screen. The
   * caret lands only when the note is really the one now on screen.
   */
  private async openDayNote(file: TFile, source: string, caret: number | null): Promise<void> {
    const workspace = this.app.workspace;
    const existing = workspace
      .getLeavesOfType("markdown")
      .find((leaf) => leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path);

    if (existing !== undefined) {
      workspace.setActiveLeaf(existing, { focus: true });
      await workspace.revealLeaf(existing);
    } else {
      await workspace.getLeaf("tab").openFile(file);
    }

    const view = this.activeMarkdownView();
    if (caret === null || view === null || view.file?.path !== file.path || !this.isEditing(view)) {
      return;
    }

    const position = offsetToLineCh(source, caret);
    view.editor.setCursor(position);
    view.editor.scrollIntoView({ from: position, to: position }, true);
    view.editor.focus();
  }

  /** Recounts the day's counters and merges them into the note. */
  private withDayCounts(source: string, now: Date): string {
    if (!this.settings.writeDayCounters) return source;
    const counts = recountDay(source, this.settings.maxDepth);
    return applyDayCounts(source, counts, dayKey(now)).source;
  }

  /** Debounced recount for edits made by hand in the day note. */
  private scheduleDayCounts(file: TFile | null): void {
    if (!this.settings.writeDayCounters || file === null) return;
    if (this.dayCountTimer !== null) window.clearTimeout(this.dayCountTimer);
    this.dayCountTimer = window.setTimeout(() => {
      this.dayCountTimer = null;
      void this.refreshDayCounts(file);
    }, DAY_COUNTS_DELAY_MS);
  }

  private async refreshDayCounts(file: TFile): Promise<void> {
    const resolved = resolveDayNote(this.app, this.settings, new Date());
    if (resolved.file === null || resolved.file.path !== file.path) return;

    const source = await this.app.vault.cachedRead(file);
    await writeDayCounts(this.app, file, recountDay(source, this.settings.maxDepth));
  }

  /** The editor's current selection, in absolute offsets, or null. */
  private selectionOf(
    view: MarkdownView | null
  ): { from: number; to: number; text: string } | null {
    if (view === null || !this.isEditing(view)) return null;

    const editor = view.editor;
    const range = editor.listSelections()[0];
    if (range === undefined) return null;

    const anchor = editor.posToOffset(range.anchor);
    const head = editor.posToOffset(range.head);
    const from = Math.min(anchor, head);
    const to = Math.max(anchor, head);
    if (from === to) return null;

    return { from, to, text: editor.getRange(editor.offsetToPos(from), editor.offsetToPos(to)) };
  }

  /**
   * Applies a plan as one transaction, so a single undo reverts all of it.
   *
   * Change offsets are resolved against the current document; the selection is
   * resolved against the document *after* the changes, because that is the state
   * the caret ends up in.
   */
  applyPlan(editor: Editor, source: string, plan: InsertPlan): void {
    const changes = plan.changes.map((change) => ({
      from: editor.offsetToPos(change.from),
      to: editor.offsetToPos(change.to),
      text: change.text
    }));

    const nextSource = applyPlanToSource(source, plan).source;
    const selection = {
      from: offsetToLineCh(nextSource, plan.selection.from),
      to: offsetToLineCh(nextSource, plan.selection.to)
    };

    editor.transaction({ changes, selection });
    editor.focus();
    editor.scrollIntoView(selection, true);
  }

  private notifyRefusal(index: HeadingIndex, action: string): void {
    if (index.unclosedFrontmatter) {
      new Notice(noticeCloseFrontmatter(action), NOTICE_REFUSAL_MS);
      return;
    }
    new Notice(noticeCloseCodeBlock(action), NOTICE_REFUSAL_MS);
  }
}
