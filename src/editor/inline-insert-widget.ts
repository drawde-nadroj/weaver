import type { EditorView } from "@codemirror/view";
import { WidgetType } from "@codemirror/view";

import { activeRowOf, type InsertRowState, type InsertState } from "../core/inline-insert";
import { dimensionLabel } from "../core/vocabulary";
import type WeaverPlugin from "../main";

/** Everything the widget can do; the field module owns the implementations. */
export interface InlineInsertHandlers {
  maxDepth: number;
  onTitle(rowId: string, value: string): void;
  onFocus(rowId: string, focus: "row" | "level"): void;
  onStepLevel(rowId: string, delta: number): void;
  onAddRow(): void;
  onCommit(): void;
  onCancel(): void;
}

const HINT = "⌘⏎ weave · Esc cancel";
const EMPTY_HINT = "type a title to weave";

/**
 * The control row that sits above the insertion line: no overlay, no dialog over
 * the note, and nothing written until the commit.
 *
 * Typing lands in the row's own input, so the document is untouched until one
 * transaction lands the whole block. `eq` compares structure only — the input
 * owns its text — which is why typing never rebuilds the DOM.
 */
export class InlineInsertWidget extends WidgetType {
  constructor(
    private readonly state: InsertState,
    private readonly plugin: WeaverPlugin,
    /** Built per render, because only `toDOM` is handed the view to dispatch on. */
    private readonly handlersFor: (view: EditorView) => InlineInsertHandlers
  ) {
    super();
  }

  eq(other: InlineInsertWidget): boolean {
    if (other.state.at !== this.state.at) return false;
    if (other.state.focus !== this.state.focus) return false;
    if (other.state.activeRow !== this.state.activeRow) return false;
    if (other.state.rows.length !== this.state.rows.length) return false;
    if (other.plugin.settings.maxDepth !== this.plugin.settings.maxDepth) return false;

    // Levels and ids shape the DOM; titles are the inputs' own state.
    return other.state.rows.every((row, index) => {
      const mine = this.state.rows[index];
      return mine !== undefined && mine.id === row.id && mine.level === row.level;
    });
  }

  /** Room for the rows plus the footer, so the line below does not jump. */
  get estimatedHeight(): number {
    return this.state.rows.length * 32 + 28;
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("div");
    root.className = "weaver-inline-insert";
    root.setAttribute("contenteditable", "false");

    const handlers = this.handlersFor(view);

    for (const row of this.state.rows) {
      root.appendChild(this.buildRow(view, row, handlers, root));
    }

    root.appendChild(this.buildFooter(handlers));
    this.refreshFooter(root);
    this.requestFocus(root);

    return root;
  }

  private buildRow(
    view: EditorView,
    row: InsertRowState,
    handlers: InlineInsertHandlers,
    root: HTMLElement
  ): HTMLElement {
    const active = row.id === this.state.activeRow;
    const wrapper = document.createElement("div");
    wrapper.className = `weaver-inline-row${active ? " is-active" : ""}`;
    wrapper.setAttribute("data-row-id", row.id);

    const level = document.createElement("div");
    level.className = "weaver-inline-level";

    const down = document.createElement("button");
    down.className = "weaver-inline-step";
    down.textContent = "◂";
    down.setAttribute("aria-label", "Decrease dimension level");
    down.disabled = row.level <= 1;
    down.addEventListener("click", () => handlers.onStepLevel(row.id, -1));
    down.addEventListener("focus", () => handlers.onFocus(row.id, "level"));

    const label = document.createElement("span");
    label.className = "weaver-inline-level-label";
    label.textContent = dimensionLabel(row.level);

    const up = document.createElement("button");
    up.className = "weaver-inline-step";
    up.textContent = "▸";
    up.setAttribute("aria-label", "Increase dimension level");
    up.disabled = row.level >= handlers.maxDepth;
    up.addEventListener("click", () => handlers.onStepLevel(row.id, 1));
    up.addEventListener("focus", () => handlers.onFocus(row.id, "level"));

    level.appendChild(down);
    level.appendChild(label);
    level.appendChild(up);

    const title = document.createElement("input");
    title.className = "weaver-inline-title";
    title.type = "text";
    title.placeholder = "Title";
    title.value = row.title;
    title.setAttribute("aria-label", `Title for the ${dimensionLabel(row.level)} dimension`);
    title.addEventListener("input", () => {
      handlers.onTitle(row.id, title.value);
      // The widget is not rebuilt while typing, so the footer follows the inputs.
      this.refreshFooter(root);
    });
    title.addEventListener("focus", () => handlers.onFocus(row.id, "row"));
    title.addEventListener("keydown", (event) => this.handleRowKey(view, event, row, handlers));

    wrapper.appendChild(level);
    wrapper.appendChild(title);
    return wrapper;
  }

  private buildFooter(handlers: InlineInsertHandlers): HTMLElement {
    const footer = document.createElement("div");
    footer.className = "weaver-inline-footer";

    const commit = document.createElement("button");
    commit.className = "weaver-inline-commit";
    commit.textContent = "Weave";
    commit.addEventListener("click", () => handlers.onCommit());

    const hint = document.createElement("span");
    hint.className = "weaver-inline-hint";

    footer.appendChild(commit);
    footer.appendChild(hint);
    // The footer's own key handling, so Escape works from the button too.
    footer.addEventListener("keydown", (event) => this.handleFooterKey(event, handlers));
    return footer;
  }

  /**
   * The empty row is prevention, not a toast: with nothing typed there is
   * nothing to commit, so the button says so and stops.
   */
  private refreshFooter(root: HTMLElement): void {
    const inputs = Array.from(root.querySelectorAll<HTMLInputElement>(".weaver-inline-title"));
    const empty = inputs.every((input) => input.value.trim() === "");

    const commit = root.querySelector<HTMLButtonElement>(".weaver-inline-commit");
    if (commit !== null) commit.disabled = empty;

    const hint = root.querySelector<HTMLElement>(".weaver-inline-hint");
    if (hint !== null) hint.textContent = empty ? EMPTY_HINT : HINT;
  }

  private handleRowKey(
    view: EditorView,
    event: KeyboardEvent,
    row: InsertRowState,
    handlers: InlineInsertHandlers
  ): void {
    if (event.key === "Enter") {
      event.preventDefault();
      // `⌘⏎` and `⌥⏎` commit every row at once; a plain Return starts the next.
      if (event.metaKey || event.ctrlKey || event.altKey) {
        handlers.onCommit();
        return;
      }
      handlers.onAddRow();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      handlers.onCancel();
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      handlers.onFocus(row.id, "level");
      this.focusLevel(view);
    }
  }

  private handleFooterKey(event: KeyboardEvent, handlers: InlineInsertHandlers): void {
    if (event.key === "Escape") {
      event.preventDefault();
      handlers.onCancel();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      handlers.onCommit();
    }
  }

  private focusLevel(view: EditorView): void {
    const root = view.dom.querySelector<HTMLElement>(
      `.weaver-inline-row[data-row-id="${this.state.activeRow}"] .weaver-inline-step`
    );
    window.setTimeout(() => root?.focus(), 0);
  }

  /** A rebuilt widget takes focus back to where the writer left it. */
  private requestFocus(root: HTMLElement): void {
    const active = activeRowOf(this.state);
    const selector =
      this.state.focus === "level"
        ? `.weaver-inline-row[data-row-id="${active.id}"] .weaver-inline-step`
        : `.weaver-inline-row[data-row-id="${active.id}"] .weaver-inline-title`;

    window.setTimeout(() => root.querySelector<HTMLElement>(selector)?.focus(), 0);
  }
}
