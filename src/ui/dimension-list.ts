/**
 * The dimension list: the note's own headings, as rows you can walk and jump
 * from.
 *
 * It is a list, not a lane: rows are buttons so touch and keyboard both work,
 * indentation is capped so deep dimensions stay readable in a narrow pane, and
 * nothing here writes.
 */

import { MarkdownView, setTooltip, type App, type TFile } from "obsidian";

import type { Heading } from "../core/headings";
import { dimensionLabel } from "../core/vocabulary";
import { canHover } from "./platform";

export interface DimensionListOptions {
  indentMaxLevel: number;
}

function levelOfElement(element: HTMLElement): number {
  const standard = /^H([1-6])$/.exec(element.tagName);
  if (standard !== null) return Number(standard[1]);
  const deep = Number(element.getAttribute("data-weaver-level"));
  return Number.isFinite(deep) && deep >= 7 ? deep : 7;
}

/** Scrolls to a heading, in editing view or Reading view. */
export function jumpToHeading(app: App, file: TFile, heading: Heading): void {
  const editorView = app.workspace.getActiveViewOfType(MarkdownView);
  if (editorView === null || editorView.file !== file) {
    void app.workspace.getLeaf(false).openFile(file);
  }

  const markdown = app.workspace.getActiveViewOfType(MarkdownView);
  if (markdown === null) return;

  if (markdown.getMode() === "source") {
    const line = Math.min(heading.line, markdown.editor.lineCount() - 1);
    const position = { line, ch: 0 };
    markdown.editor.setCursor(position);
    markdown.editor.scrollIntoView({ from: position, to: position }, true);
    markdown.editor.focus();
    return;
  }

  const target = heading.text.trim();
  for (const element of Array.from(
    markdown.contentEl.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6, .weaver-dimension")
  )) {
    if (levelOfElement(element) !== heading.level) continue;
    if ((element.textContent ?? "").trim() !== target) continue;
    element.scrollIntoView({ block: "start" });
    return;
  }
}

/** Renders heading rows; `activeLine` marks the row the cursor is on. */
export function renderDimensionList(
  container: HTMLElement,
  headings: readonly Heading[],
  options: DimensionListOptions,
  onJump: (heading: Heading) => void,
  activeLine: number | null = null
): void {
  container.empty();

  if (headings.length === 0) {
    container.createDiv({ cls: "weaver-dimension-list-empty", text: "No dimensions in this note." });
    return;
  }

  const hover = canHover();

  for (const heading of headings) {
    const indent = Math.min(Math.max(heading.level - 1, 0), options.indentMaxLevel - 1);
    const row = container.createEl("button", {
      cls: `weaver-dimension-row weaver-h${heading.level}${
        heading.line === activeLine ? " is-active" : ""
      }`
    });
    row.style.setProperty("--weaver-dimension-indent", String(indent));
    row.setAttr("data-line", String(heading.line));

    row.createSpan({ cls: "weaver-dimension-bar" });
    row.createSpan({ cls: "weaver-dimension-time", text: heading.time ?? "" });
    row.createSpan({
      cls: "weaver-dimension-title",
      text: heading.title.trim() || heading.text.trim()
    });
    row.createSpan({ cls: "weaver-dimension-level", text: dimensionLabel(heading.level) });

    if (hover) setTooltip(row, heading.text.trim());
    row.addEventListener("click", () => onJump(heading));
  }
}
