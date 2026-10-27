import { Modal, TFile, type App } from "obsidian";

import type WeaverPlugin from "../main";
import { jumpToDraft } from "./draft-jump";
import { jumpToHeading } from "./dimension-list";
import { firstUntitledSpark, TapestrySource, scopeFiles, type Scope } from "./tapestry-data";
import { countLabel, renderTapestry, type TapestryState } from "./tapestry-sections";

const EMPTY_COUNTS = {
  sparks: 0,
  dimensions: 0,
  sources: 0,
  untitled: 0,
  lastMark: null,
  closedAt: null
};

/**
 * The Tapestry as a bottom sheet.
 *
 * It draws the same sections in the same order with the same words as the
 * sidebar view, in the renderer's touch mode: no cursors, no filters, every row
 * a tap target. The scope chips stay, because scope is the sheet's whole job.
 */
export class TapestrySheet extends Modal {
  constructor(
    app: App,
    private readonly plugin: WeaverPlugin,
    private sheetScope: Scope = "note"
  ) {
    super(app);
  }

  private pending: Promise<void> = Promise.resolve();

  onOpen(): void {
    this.modalEl.addClass("weaver-sheet");
    this.modalEl.addClass("weaver-tapestry-sheet");
    this.pending = this.render();
  }

  /** Resolves once the current render has finished, so callers can await it. */
  async ready(): Promise<void> {
    await this.pending;
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async render(): Promise<void> {
    const load = await new TapestrySource(this.plugin).load(this.sheetScope);
    const activePath = this.plugin.app.workspace.getActiveFile()?.path ?? null;

    const state: TapestryState = {
      scope: this.sheetScope,
      counts: load.counts ?? EMPTY_COUNTS,
      threads: load.threads,
      dimensions: load.dimensions,
      drafts: load.drafts,
      days: load.days,
      weeks: load.weeks,
      queries: { drafts: "", headings: "", threads: "" },
      selection: { drafts: 0, headings: 0, threads: 0 },
      visibleThreads: load.threads,
      visibleDimensions: load.dimensions,
      visibleDrafts: load.drafts,
      noteLabel: load.noteLabel,
      countText: countLabel(this.sheetScope, load.drafts, load.draftsLoaded, load.days),
      sparkTarget: this.plugin.settings.sparkTarget,
      draftsLoaded: load.draftsLoaded,
      hasDayNote: load.hasDayNote,
      activePath,
      untitled: load.counts.untitled,
      loadedSources: this.plugin.shuttles.items().length,
      rail: { indentMaxLevel: this.plugin.settings.indentMaxLevel }
    };

    renderTapestry(
      this.contentEl,
      state,
      {
        onScope: (scope) => {
          this.sheetScope = scope;
          void this.render();
        },
        onThread: (row) => {
          const file = scopeFiles(this.plugin.app, "day", new Date(), this.plugin.settings)[0];
          this.close();
          if (file !== undefined) jumpToHeading(this.plugin.app, file, row.heading);
        },
        onDimension: (heading) => {
          const file = this.plugin.app.workspace.getActiveFile();
          this.close();
          if (file !== null) jumpToHeading(this.plugin.app, file, heading);
        },
        onDraft: (entry) => {
          this.close();
          jumpToDraft(this.plugin.app, entry.file, entry.draft);
        },
        onDay: (row) => {
          const file = this.plugin.app.vault.getAbstractFileByPath(row.path);
          if (!(file instanceof TFile)) return;
          this.close();
          void this.plugin.app.workspace.getLeaf(false).openFile(file);
        },
        onQuery: () => undefined,
        onListKey: () => undefined,
        onFilterKey: () => undefined,
        onSparkTarget: () => {
          this.plugin.settings.sparkTarget =
            this.plugin.settings.sparkTarget === "today" ? "note" : "today";
          void this.plugin.saveSettings();
          this.pending = this.render();
        },
        onRefresh: () => {
          this.pending = this.render();
        },
          onCloseDay: () => {
          this.pending = this.plugin.closeDay().then(() => this.render());
        },
        onShuttle: () => {
          this.close();
          this.plugin.openShuttlePalette();
        },
        onUntitled: () => {
          void firstUntitledSpark(this.plugin.app, this.plugin.settings, new Date()).then((found) => {
            if (found === null) return;
            this.close();
            jumpToHeading(this.plugin.app, found.file, found.heading);
          });
        }
      },
      "touch"
    );
  }
}
