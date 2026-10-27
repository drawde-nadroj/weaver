import type { Editor, MarkdownView } from "obsidian";
import { Notice } from "obsidian";

import {
  allocateDraftId,
  draftBlockText,
  formatDraftOpened,
  weaveDraftText,
  type DraftBlock
} from "../core/drafts";
import { findCurrentHeading, parseHeadings, type HeadingIndex } from "../core/headings";
import {
  applyPlanToSource,
  computeInsertLevel,
  resolveInsertSite,
  type InsertPlan
} from "../core/insert";
import type { DraftBadgeHandlers } from "../ui/draft-badge";
import type WeaverPlugin from "../main";
import {
  NOTICE_DRAFT_EMPTY,
  NOTICE_NEEDS_EDITING,
  NOTICE_NOOP_MS,
  NOTICE_REFUSAL_MS,
  noticeCloseCodeBlock,
  noticeCloseFrontmatter,
  noticeNoDraftAtCursor
} from "../notices";

function leadingNewlines(text: string): number {
  let count = 0;
  while (count < text.length && text[count] === "\n") count += 1;
  return count;
}

function trailingNewlines(text: string): number {
  let count = 0;
  for (let index = text.length - 1; index >= 0 && text[index] === "\n"; index -= 1) count += 1;
  return count;
}

/**
 * Everything that creates, edits, weaves and discards in-page drafts.
 *
 * The editor is the commit path in editing view, so one undo reverts a weave or
 * a discard. Reading view has no editor, so the same plan is applied through
 * `Vault.process`, which re-reads the file before writing and therefore cannot
 * overwrite a concurrent change.
 */
export class DraftController {
  constructor(private readonly plugin: WeaverPlugin) {}

  get maxDepth(): number {
    return this.plugin.settings.maxDepth;
  }

  /** Handlers for one badge; every badge in the note shares the controller. */
  badgeHandlers(): DraftBadgeHandlers {
    return {
      maxDepth: this.maxDepth,
      onWeave: (id) => this.weaveDraft(id),
      onDiscard: (id) => this.discardDraft(id),
      onLevel: (id, level) => this.setDraftLevel(id, level)
    };
  }

  /** Inserts an empty draft block at the caret. */
  createDraft(now: Date): void {
    const view = this.plugin.activeMarkdownView();
    if (view === null) return;

    if (view.getMode() !== "source") {
      new Notice(NOTICE_NEEDS_EDITING, NOTICE_REFUSAL_MS);
      return;
    }

    const editor = view.editor;
    const source = editor.getValue();
    const index = this.index(source);
    const cursorLine = editor.getCursor().line;
    const site = resolveInsertSite(source, index, cursorLine);

    if (site === null) {
      this.refuse(index, "starting a draft");
      return;
    }

    const level = computeInsertLevel(findCurrentHeading(index, cursorLine), this.maxDepth);
    const ordinal =
      index.headings.filter((heading) => heading.level === level && heading.line <= site.line).length +
      1;
    const id = allocateDraftId(level, ordinal, index.drafts.map((draft) => draft.id));

    const block = draftBlockText({
      id,
      openedAt: formatDraftOpened(now),
      title: "",
      body: ""
    });
    const inserted = site.prefix + block;
    const titleFrom = site.from + site.prefix.length + block.indexOf("\n") + 1;

    this.plugin.applyPlan(editor, source, {
      changes: [{ from: site.from, to: site.to, text: inserted }],
      selection: { from: titleFrom, to: titleFrom }
    });
  }

  /** Weaves the draft the caret sits inside; a miss says so instead of nothing. */
  weaveDraftAtCursor(now: Date): void {
    const view = this.plugin.activeMarkdownView();
    if (view === null || view.getMode() !== "source") {
      new Notice(NOTICE_NEEDS_EDITING, NOTICE_REFUSAL_MS);
      return;
    }

    const draft = this.draftAtCursor();
    if (draft === null) {
      new Notice(noticeNoDraftAtCursor, NOTICE_NOOP_MS);
      return;
    }
    this.weave(draft.id, now);
  }

  weaveDraft(id: string): void {
    this.weave(id, new Date());
  }

  discardDraft(id: string): void {
    this.edit((source, index) => {
      const draft = this.find(index, id);
      if (draft === null) return null;

      const before = source.slice(0, draft.from);
      const after = source.slice(draft.to);
      const preceding = trailingNewlines(before);
      const following = leadingNewlines(after);

      // Removing a block that sat between two blank lines would leave three
      // newlines behind; collapse the run back to one blank line.
      if (preceding + following > 2) {
        const from = draft.from - preceding;
        const to = draft.to + following;
        return { changes: [{ from, to, text: "\n\n" }], selection: { from, to: from } };
      }

      // Otherwise the block's own line break goes with it, so removing a draft
      // welded to the next paragraph does not leave a hole.
      return {
        changes: [{ from: draft.from, to: draft.to + following, text: "" }],
        selection: { from: draft.from, to: draft.from }
      };
    });
  }

  /** Rewrites both marker lines so the draft takes the next id at `level`. */
  setDraftLevel(id: string, level: number): void {
    this.edit((source, index) => {
      const draft = this.find(index, id);
      if (draft === null) return null;

      const nextLevel = Math.min(this.maxDepth, Math.max(1, Math.round(level)));
      if (nextLevel === draft.level) return null;

      const ordinal =
        index.headings.filter(
          (heading) => heading.level === nextLevel && heading.line <= draft.titleLine
        ).length + 1;
      const taken = index.drafts.filter((other) => other.id !== draft.id).map((other) => other.id);
      const next = allocateDraftId(nextLevel, ordinal, taken);

      const openLine = source.slice(draft.from, draft.titleFrom - 1);
      const closeLine = source.slice(draft.closeFrom, draft.to);
      const nextOpen = openLine.replace(draft.id, next);
      const nextClose = closeLine.replace(draft.id, next);
      if (nextOpen === openLine || nextClose === closeLine) return null;

      const shift = nextOpen.length - openLine.length;
      const caret = draft.titleFrom + shift;

      return {
        changes: [
          { from: draft.from, to: draft.titleFrom - 1, text: nextOpen },
          { from: draft.closeFrom, to: draft.to, text: nextClose }
        ],
        selection: { from: caret, to: caret }
      };
    });
  }

  /** The draft whose markers contain the caret, if any. */
  draftAtCursor(): DraftBlock | null {
    const view = this.plugin.activeMarkdownView();
    if (view === null || view.getMode() !== "source") return null;

    const editor = view.editor;
    const index = this.index(editor.getValue());
    const offset = editor.posToOffset(editor.getCursor());
    return index.drafts.find((draft) => offset >= draft.from && offset <= draft.to) ?? null;
  }

  private weave(id: string, now: Date): void {
    this.edit((_source, index) => {
      const draft = this.find(index, id);
      if (draft === null) return null;

      if (draft.title.trim() === "" && draft.body.trim() === "") {
        new Notice(NOTICE_DRAFT_EMPTY, NOTICE_REFUSAL_MS);
        return null;
      }

      const text = weaveDraftText(draft, this.plugin.insertOptions(), now);
      const caret = draft.from + text.length;
      return {
        changes: [{ from: draft.from, to: draft.to, text }],
        selection: { from: caret, to: caret }
      };
    });
  }

  private find(index: HeadingIndex, id: string): DraftBlock | null {
    return index.drafts.find((draft) => draft.id === id) ?? null;
  }

  private index(source: string): HeadingIndex {
    return parseHeadings(source, { maxDepth: this.maxDepth });
  }

  private refuse(index: HeadingIndex, action: string): void {
    if (index.unclosedFrontmatter) {
      new Notice(noticeCloseFrontmatter(action), NOTICE_REFUSAL_MS);
      return;
    }
    new Notice(noticeCloseCodeBlock(action), NOTICE_REFUSAL_MS);
  }

  /**
   * Builds a plan against the live source and commits it: through the editor
   * when editing, through the vault file in Reading view.
   */
  private edit(build: (source: string, index: HeadingIndex) => InsertPlan | null): void {
    const view = this.plugin.activeMarkdownView();
    if (view === null) return;

    if (view.getMode() === "source") {
      this.commitInEditor(view, build);
      return;
    }

    this.commitInFile(view, build);
  }

  private commitInEditor(
    view: MarkdownView,
    build: (source: string, index: HeadingIndex) => InsertPlan | null
  ): void {
    const editor: Editor = view.editor;
    const source = editor.getValue();
    const plan = build(source, this.index(source));
    if (plan === null) return;
    this.plugin.applyPlan(editor, source, plan);
  }

  private commitInFile(
    view: MarkdownView,
    build: (source: string, index: HeadingIndex) => InsertPlan | null
  ): void {
    const file = view.file;
    if (file === null) return;

    // `process` is atomic read-modify-write, so the plan is always built from
    // the bytes that are about to be replaced.
    void this.plugin.app.vault
      .process(file, (data) => {
        const plan = build(data, this.index(data));
        return plan === null ? data : applyPlanToSource(data, plan).source;
      })
      .then(() => view.previewMode.rerender(true))
      .catch((error: unknown) => {
        console.error("Weaver: could not update the note", error);
      });
  }
}
