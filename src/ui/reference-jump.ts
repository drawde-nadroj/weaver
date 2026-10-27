import { MarkdownView, TFile, type App } from "obsidian";

import { parseHeadings } from "../core/headings";
import type { Reference } from "../core/reference";
import type { ShuttleItem } from "../shuttle/store";
import { jumpToHeading } from "./dimension-list";

/**
 * Opens a reference's target and lands on the thing it names.
 *
 * Words land on the line that carries the block id, because a `^id` marks the
 * end of the line it belongs to. A target that no longer exists is a no-op: a
 * stale row must not steal the caret from the note being written.
 */
export function jumpToReference(app: App, item: ShuttleItem | Reference): void {
  void openAndPlace(app, item);
}

async function openAndPlace(app: App, item: ShuttleItem | Reference): Promise<void> {
  const target = app.vault.getAbstractFileByPath(item.path);
  if (!(target instanceof TFile)) return;

  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (view?.file?.path !== target.path) {
    await app.workspace.getLeaf(false).openFile(target);
  }

  const opened = app.workspace.getActiveViewOfType(MarkdownView);
  if (opened === null || opened.file?.path !== target.path) return;

  if (item.kind === "note") return;

  const source = await app.vault.cachedRead(target);

  if (item.kind === "dimension" && item.headingText !== undefined) {
    const heading = parseHeadings(source, { maxDepth: 24 }).headings.find(
      (candidate) => candidate.text.trim() === item.headingText?.trim()
    );
    if (heading !== undefined) jumpToHeading(app, target, heading);
    return;
  }

  if (item.kind === "words" && item.blockId !== undefined) {
    const lines = source.split("\n");
    const line = lines.findIndex((candidate) => candidate.trimEnd().endsWith(`^${item.blockId}`));
    if (line < 0) return;

    if (opened.getMode() === "source") {
      const position = { line, ch: (lines[line] ?? "").length };
      opened.editor.setCursor(position);
      opened.editor.scrollIntoView({ from: position, to: position }, true);
      opened.editor.focus();
      return;
    }
    // Reading view has no caret, so the nearest matching block is scrolled into
    // view instead of guessed at.
    opened.contentEl.querySelectorAll("p, li")[line]?.scrollIntoView({ block: "center" });
  }
}

/** Splits `Note#fragment` into its note name and its fragment. */
export function splitLinkTarget(target: string): { note: string; fragment: string | null } {
  const hash = target.indexOf("#");
  if (hash < 0) return { note: target, fragment: null };
  return { note: target.slice(0, hash), fragment: target.slice(hash + 1) };
}

/** The file a wiki link names, resolved by basename when no cache is available. */
export function resolveLinkTarget(app: App, note: string, fromPath: string): TFile | null {
  const direct = app.vault.getAbstractFileByPath(note);
  if (direct instanceof TFile) return direct;

  const byCache = app.metadataCache?.getFirstLinkpathDest(note, fromPath);
  if (byCache instanceof TFile) return byCache;

  const wanted = note.replace(/\.md$/, "").toLowerCase();
  return (
    app.vault
      .getMarkdownFiles()
      .find((file) => file.basename.toLowerCase() === wanted) ?? null
  );
}

/** Follows a `[[note#fragment]]` target to the note and the thing it names. */
export function jumpToWikiTarget(app: App, target: string, fromPath: string): boolean {
  const { note, fragment } = splitLinkTarget(target);
  const file = resolveLinkTarget(app, note, fromPath);
  if (file === null) return false;

  const headingText = fragment !== null && !fragment.startsWith("^") ? fragment : undefined;
  const blockId = fragment?.startsWith("^") ? fragment.slice(1) : undefined;

  jumpToReference(app, {
    kind: headingText !== undefined ? "dimension" : blockId !== undefined ? "words" : "note",
    path: file.path,
    basename: file.basename,
    headingText,
    blockId,
    label: file.basename
  });
  return true;
}
