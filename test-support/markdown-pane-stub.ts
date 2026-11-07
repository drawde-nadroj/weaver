/** A DOM-only editor double for shell behavior; real Markdown is live-checked in Obsidian. */
import type { MarkdownPaneOptions, PaneSelection } from "../src/ui/markdown-pane";
import { shimDocument, type ShimElement } from "./dom";

/** Preserves editor identity and selection while shell tests exercise real controller transitions. */
export class MarkdownPane {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly input: HTMLTextAreaElement;

  constructor(private readonly options: MarkdownPaneOptions) {
    this.dom = document.createElement("div");
    this.dom.className = "weaver-markdown";
    this.input = document.createElement("textarea");
    this.input.className = "cm-content";
    this.input.setAttribute("contenteditable", "true");
    this.input.setAttribute("aria-label", options.label);
    this.contentDOM = this.input;
    this.dom.appendChild(this.input);
    options.parent.appendChild(this.dom);
    this.input.addEventListener("input", () => options.onChange?.(this.text, this.selection));
    this.input.addEventListener("keydown", (event) => options.onKey?.(event));
    this.input.addEventListener("compositionstart", () => options.onComposition?.(true));
    this.input.addEventListener("compositionend", () => {
      options.onComposition?.(false);
      options.onChange?.(this.text, this.selection);
    });
  }

  get text(): string { return this.input.value; }
  get selection(): PaneSelection { return { from: this.input.selectionStart, to: this.input.selectionEnd }; }
  get hasFocus(): boolean { return shimDocument.activeElement === this.input as unknown as ShimElement; }

  get caretBounds(): { top: number; bottom: number } | null { return null; }

  update(text: string, _sourcePath: string, readOnly: boolean, selection?: PaneSelection, _resetHistory?: boolean): void {
    this.input.value = text;
    this.input.readOnly = readOnly;
    this.dom.setAttribute("data-readonly", String(readOnly));
    if (selection !== undefined) this.input.setSelectionRange(selection.from, selection.to);
  }

  insertText(text: string): void {
    if (this.input.readOnly) return;
    const { from, to } = this.selection;
    this.input.value = this.text.slice(0, from) + text + this.text.slice(to);
    this.input.setSelectionRange(from + text.length, from + text.length);
    this.options.onChange?.(this.text, this.selection);
  }

  focus(selection?: PaneSelection): void {
    if (selection !== undefined) this.input.setSelectionRange(selection.from, selection.to);
    shimDocument.activeElement = this.input as unknown as ShimElement;
  }
  blur(): void {
    if (this.hasFocus) shimDocument.activeElement = null;
  }
  destroy(): void { this.dom.remove(); }
}
