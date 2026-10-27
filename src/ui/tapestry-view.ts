import { ItemView, TFile, debounce, type WorkspaceLeaf } from "obsidian";

import { draftElapsed } from "../core/drafts";
import type { DayCounts } from "../core/day-counters";
import type { Heading } from "../core/headings";
import type { ThreadRow } from "../core/threads";



import type { DraftEntry } from "../drafts/vault-index";


import type WeaverPlugin from "../main";

import { jumpToDraft } from "./draft-jump";
import { jumpToHeading } from "./dimension-list";
import { ListCursor, type CursorSection } from "./tapestry-cursor";
import {
  firstUntitledSpark,
  scopeFiles,
  TapestrySource,
  type Scope,
  type TapestryLoad
} from "./tapestry-data";
import { countLabel, renderTapestry, type TapestryHandlers, type TapestryState } from "./tapestry-sections";

export const TAPESTRY_VIEW_TYPE = "weaver-tapestry";

const REFRESH_DEBOUNCE_MS = 200;
const ELAPSED_TICK_MS = 30_000;

const EMPTY_COUNTS: DayCounts = {
  sparks: 0,
  dimensions: 0,
  sources: 0,
  untitled: 0,
  lastMark: null,
  closedAt: null
};

/**
 * The Tapestry: threads, marks, census, calendar and the past horizon at four
 * scopes.
 *
 * The view owns the data and the cursor model; `renderTapestry` owns the DOM, so
 * the phone sheet draws the same sections with the same words and no cursors.
 * It never writes: browsing every scope must leave the vault unchanged.
 */
export class TapestryView extends ItemView {
  private activeScope: Scope = "note";

  private snapshot: TapestryLoad = {
    counts: EMPTY_COUNTS,
    threads: [],
    dimensions: [],
    drafts: [],
    days: [],
    weeks: [],
    noteLabel: "",
    hasDayNote: false,
    draftsLoaded: false,
    activePath: null
  };
  private noteLabel = "";
  private closed = false;
  private timer: number | null = null;
  private readonly source: TapestrySource;

  private readonly queries: Record<CursorSection, string> = {
    drafts: "",
    headings: "",
    threads: ""
  };
  private readonly cursors: Record<CursorSection, ListCursor> = {
    drafts: new ListCursor(),
    headings: new ListCursor(),
    threads: new ListCursor()
  };

  private readonly scheduleScope = debounce(() => {
    void this.refresh();
  }, REFRESH_DEBOUNCE_MS);

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: WeaverPlugin
  ) {
    super(leaf);
    // A freshly created view opens where the caller asked it to.
    this.activeScope = plugin.lastTapestryScope;
    this.source = new TapestrySource(plugin);
  }

  getViewType(): string {
    return TAPESTRY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Tapestry";
  }

  getIcon(): string {
    return "waypoints";
  }

  /** The scope this view is showing. */
  getScope(): Scope {
    return this.activeScope;
  }

  /** Switches scope without touching the scroll position. */
  async setScope(scope: Scope): Promise<void> {
    if (scope === this.activeScope) {
      await this.refresh();
      return;
    }

    const scroll = this.contentEl.scrollTop;
    this.activeScope = scope;
    this.resetCursors();
    await this.refresh();
    this.contentEl.scrollTop = scroll;
  }

  async onOpen(): Promise<void> {
    this.closed = false;

    const vault = this.plugin.app.vault;
    this.registerEvent(vault.on("modify", () => this.scheduleScope()));
    this.registerEvent(vault.on("create", () => this.scheduleScope()));
    this.registerEvent(vault.on("delete", () => this.scheduleScope()));
    this.registerEvent(vault.on("rename", () => this.scheduleScope()));
    this.registerEvent(
      this.plugin.app.workspace.on("editor-change", () => this.scheduleScope())
    );
    this.registerEvent(
      this.plugin.app.workspace.on("active-leaf-change", () => {
        void this.refresh();
      })
    );

    this.timer = window.setInterval(() => this.tickElapsed(), ELAPSED_TICK_MS);
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.contentEl.empty();
  }

  /** Re-reads whatever the current scope shows, then repaints. */
  async refresh(): Promise<void> {
    if (this.closed) return;
    await this.refreshData();
    this.render();
  }

  /** Re-reads the settings-backed controls after any settings change. */
  syncControls(): void {
    void this.refresh();
  }

  private resetCursors(): void {
    this.queries.drafts = "";
    this.queries.headings = "";
    this.queries.threads = "";
    this.cursors.drafts.reset();
    this.cursors.headings.reset();
    this.cursors.threads.reset();
  }

  private async refreshData(): Promise<void> {
    this.snapshot = await this.source.load(this.activeScope);
    this.noteLabel = this.snapshot.noteLabel;
  }

  private visibleDrafts(): DraftEntry[] {
    const scoped = this.snapshot.drafts;
    const query = this.queries.drafts;
    if (query === "") return scoped;
    return scoped.filter((entry) =>
      `${entry.draft.id}\n${entry.draft.title}\n${entry.draft.body}`.toLowerCase().includes(query)
    );
  }

  private visibleHeadings(): Heading[] {
    const query = this.queries.headings;
    if (query === "") return this.snapshot.dimensions;
    return this.snapshot.dimensions.filter((heading) => heading.text.toLowerCase().includes(query));
  }

  private visibleThreads(): ThreadRow[] {
    const query = this.queries.threads;
    if (query === "") return this.snapshot.threads;
    return this.snapshot.threads.filter((thread) => thread.heading.text.toLowerCase().includes(query));
  }

  private state(): TapestryState {
    const visibleDrafts = this.visibleDrafts();
    const visibleDimensions = this.visibleHeadings();
    const visibleThreads = this.visibleThreads();
    const activeFile = this.plugin.app.workspace.getActiveFile();

    return {
      scope: this.activeScope,
      counts: this.snapshot.counts,
      threads: this.snapshot.threads,
      dimensions: this.snapshot.dimensions,
      drafts: this.snapshot.drafts,
      days: this.snapshot.days,
      weeks: this.snapshot.weeks,
      queries: this.queries,
      selection: {
        drafts: this.cursors.drafts.index,
        headings: this.cursors.headings.index,
        threads: this.cursors.threads.index
      },
      visibleThreads,
      visibleDimensions,
      visibleDrafts,
      noteLabel: this.noteLabel,
      countText: this.countText(),
      sparkTarget: this.plugin.settings.sparkTarget,
      draftsLoaded: this.snapshot.draftsLoaded,
      hasDayNote: this.snapshot.hasDayNote,
      activePath: activeFile?.path ?? null,
      untitled: this.snapshot.counts.untitled,
      loadedSources: this.plugin.shuttles.items().length,
      rail: { indentMaxLevel: this.plugin.settings.indentMaxLevel }
    };
  }

  private render(): void {
    const state = this.state();
    this.clampCursors(state);
    // Rebuilding the panel must not steal focus from the field being typed in.
    const focus = focusedTarget(this.contentEl);
    renderTapestry(this.contentEl, this.state(), this.handlers(), "pointer");
    restoreFocus(this.contentEl, focus);
  }

  private clampCursors(state: TapestryState): void {
    this.cursors.drafts.clamp(state.visibleDrafts.length);
    this.cursors.headings.clamp(state.visibleDimensions.length);
    this.cursors.threads.clamp(state.visibleThreads.length);
  }

  private countText(): string {
    return countLabel(
      this.activeScope,
      this.visibleDrafts(),
      this.snapshot.draftsLoaded,
      this.snapshot.days
    );
  }

  private handlers(): TapestryHandlers {
    return {
      onScope: (scope) => {
        void this.setScope(scope);
      },
      onThread: (row) => {
        const file = scopeFiles(this.plugin.app, "day", new Date(), this.plugin.settings)[0];
        if (file !== undefined) jumpToHeading(this.plugin.app, file, row.heading);
      },
      onDimension: (heading) => {
        const file = this.plugin.app.workspace.getActiveFile();
        if (file !== null) jumpToHeading(this.plugin.app, file, heading);
      },
      onDraft: (entry) => {
        jumpToDraft(this.plugin.app, entry.file, entry.draft);
      },
      onDay: (row) => {
        const file = this.plugin.app.vault.getAbstractFileByPath(row.path);
        if (!(file instanceof TFile)) return;
        void this.plugin.app.workspace.getLeaf(false).openFile(file);
      },
      onQuery: (section, value) => {
        this.queries[section] = value.trim().toLowerCase();
        this.cursors[section].reset();
        this.render();
      },
      onListKey: (section, event) => this.handleListKey(section, event),
      onFilterKey: (section, event) => this.handleFilterKey(section, event),
      onSparkTarget: () => {
        this.plugin.settings.sparkTarget =
          this.plugin.settings.sparkTarget === "today" ? "note" : "today";
        void this.plugin.saveSettings();
        this.render();
      },
      onRefresh: () => {
        void this.refresh();
      },
      onCloseDay: () => {
        void this.plugin.closeDay().then(() => this.refresh());
      },
      onShuttle: () => {
        this.plugin.openShuttlePalette();
      },
      onUntitled: () => {
        void firstUntitledSpark(this.plugin.app, this.plugin.settings, new Date()).then((found) => {
          if (found !== null) jumpToHeading(this.plugin.app, found.file, found.heading);
        });
      }
    };
  }

  private visibleLength(section: CursorSection): number {
    if (section === "drafts") return this.visibleDrafts().length;
    return section === "headings" ? this.visibleHeadings().length : this.visibleThreads().length;
  }

  private jumpSelected(section: CursorSection): void {
    if (section === "drafts") {
      const entry = this.visibleDrafts()[this.cursors.drafts.index];
      if (entry !== undefined) jumpToDraft(this.plugin.app, entry.file, entry.draft);
      return;
    }

    if (section === "threads") {
      const thread = this.visibleThreads()[this.cursors.threads.index];
      if (thread === undefined) return;
      const file = scopeFiles(this.plugin.app, "day", new Date(), this.plugin.settings)[0];
      if (file !== undefined) jumpToHeading(this.plugin.app, file, thread.heading);
      return;
    }

    const heading = this.visibleHeadings()[this.cursors.headings.index];
    if (heading === undefined) return;
    const file = this.plugin.app.workspace.getActiveFile();
    if (file !== null) jumpToHeading(this.plugin.app, file, heading);
  }

  private focusFilter(section: CursorSection): void {
    this.contentEl
      .querySelector<HTMLInputElement>(`.weaver-panel-filter[data-section="${section}"]`)
      ?.focus();
  }

  private focusList(section: CursorSection): void {
    const list = this.contentEl.querySelector<HTMLElement>(`[data-list-section="${section}"]`);
    if (list === null) return;

    // Keyboard focus is invisible inside a custom pane, so the list marks itself
    // here as well as on `focusin` (a programmatic focus may not fire one).
    for (const other of Array.from(this.contentEl.querySelectorAll<HTMLElement>("[data-list-section]"))) {
      if (other !== list) other.removeClass("is-focused");
    }
    list.focus();
    list.addClass("is-focused");
  }

  private clearFilter(section: CursorSection): void {
    this.queries[section] = "";
    this.cursors[section].reset();
    this.render();
  }

  private handleListKey(section: CursorSection, event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const cursor = this.cursors[section];
    const length = this.visibleLength(section);

    switch (event.key) {
      case "ArrowDown":
      case "j":
        event.preventDefault();
        cursor.move(1, length);
        this.render();
        return;
      case "ArrowUp":
      case "k":
        event.preventDefault();
        cursor.move(-1, length);
        this.render();
        return;
      case "Home":
        event.preventDefault();
        cursor.first();
        this.render();
        return;
      case "End":
        event.preventDefault();
        cursor.last(length);
        this.render();
        return;
      case "Enter":
        event.preventDefault();
        this.jumpSelected(section);
        return;
      case "Tab":
        // Note scope walks between its two lists; a single-cursor scope lets Tab
        // leave the panel instead of trapping focus.
        if (section === "threads") return;
        event.preventDefault();
        this.focusList(section === "drafts" ? "headings" : "drafts");
        return;
      case "/":
        event.preventDefault();
        this.focusFilter(section);
        return;
      case "Escape":
        this.clearFilter(section);
        return;
      default:
        if (event.key.length === 1 && !event.shiftKey && event.key !== " ") {
          event.preventDefault();
          this.startFilter(section, event.key);
        }
    }
  }

  private handleFilterKey(section: CursorSection, event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const cursor = this.cursors[section];
    const length = this.visibleLength(section);

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        cursor.move(1, length);
        this.render();
        this.focusFilter(section);
        return;
      case "ArrowUp":
        event.preventDefault();
        cursor.move(-1, length);
        this.render();
        this.focusFilter(section);
        return;
      case "Enter":
        event.preventDefault();
        this.jumpSelected(section);
        return;
      case "Escape":
        event.preventDefault();
        this.clearFilter(section);
        this.focusList(section);
        return;
      default:
    }
  }

  /** A typed letter becomes this section's filter without aiming at a field. */
  private startFilter(section: CursorSection, key: string): void {
    this.queries[section] = `${this.queries[section]}${key}`.toLowerCase();
    this.cursors[section].reset();
    this.render();
    const input = this.contentEl.querySelector<HTMLInputElement>(
      `.weaver-panel-filter[data-section="${section}"]`
    );
    if (input === null) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  /** Rewrites only the elapsed cells, so a running timer never rebuilds a list. */
  private tickElapsed(): void {
    if (this.closed) return;

    const now = new Date();
    for (const row of Array.from(
      this.contentEl.querySelectorAll<HTMLElement>(".weaver-draft-result")
    )) {
      const openedAt = row.getAttr("data-opened-at");
      const cell = row.querySelector(".weaver-draft-result-elapsed");
      if (openedAt === null || !(cell instanceof HTMLElement)) continue;
      cell.setText(draftElapsed({ openedAt }, now));
    }
  }
}

/** Where focus was before a re-render, in the terms the renderer understands. */
interface FocusTarget {
  kind: "filter" | "list";
  section: CursorSection;
}

function focusedTarget(container: HTMLElement): FocusTarget | null {
  const active = document.activeElement;
  if (active === null || !(active instanceof HTMLElement)) return null;
  if (!container.contains(active)) return null;

  const filter = active.getAttr("data-section");
  if (filter !== null) return { kind: "filter", section: filter as CursorSection };

  const list = active.getAttr("data-list-section");
  if (list !== null) return { kind: "list", section: list as CursorSection };
  return null;
}

function restoreFocus(container: HTMLElement, target: FocusTarget | null): void {
  if (target === null) return;

  const selector =
    target.kind === "filter"
      ? `.weaver-panel-filter[data-section="${target.section}"]`
      : `[data-list-section="${target.section}"]`;
  const element = container.querySelector<HTMLElement>(selector);
  if (element === null) return;

  element.focus();
  if (element instanceof HTMLInputElement) {
    element.setSelectionRange(element.value.length, element.value.length);
  }
}
