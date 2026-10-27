import { MarkdownView, type App, type TFile } from "obsidian";

import type { DraftBlock } from "../core/drafts";

/**
 * Opens `file` when it is not active, then puts the caret on the draft's title
 * line in editing view, or scrolls its card into view in Reading view.
 */
export function jumpToDraft(app: App, file: TFile, draft: DraftBlock): void {
  const active = app.workspace.getActiveViewOfType(MarkdownView);
  if (active?.file?.path === file.path) {
    place(app, file, draft);
    return;
  }

  // A file deleted between scan and click leaves nothing to jump to, and an
  // unhandled rejection in a sidebar view is worse than a no-op.
  void app.workspace
    .getLeaf(false)
    .openFile(file)
    .then(() => place(app, file, draft))
    .catch(() => undefined);
}

function place(app: App, file: TFile, draft: DraftBlock): void {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  // A file that has not become active yet must never receive a caret jump in
  // the wrong note.
  if (view === null || view.file?.path !== file.path) return;

  if (view.getMode() === "source") {
    const position = { line: draft.titleLine, ch: 0 };
    view.editor.setCursor(position);
    view.editor.scrollIntoView({ from: position, to: position }, true);
    view.editor.focus();
    return;
  }

  // With `inPageDrafts` off there is no card and a preview has no caret, so
  // doing nothing is correct.
  view.contentEl
    .querySelector(`[data-weaver-draft-id="${draft.id}"]`)
    ?.scrollIntoView({ block: "start" });
}
