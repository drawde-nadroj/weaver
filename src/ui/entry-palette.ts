/**
 * The entry palette: today's entries in one card, and the three actions that do
 * not need the caret.
 *
 * A self-mounted overlay like the travel card — no `Scope`, keys handled on the
 * card in the capture phase — for the same reason: a scope swallowed `Mod+,`
 * and stopped Obsidian's own settings from opening. Everything this card does
 * not claim reaches Obsidian untouched.
 *
 * The rule it exists for: arrows select, `Enter` settles and descends under the
 * selection, `n` starts a new root at the tip of the day, `x` deletes the
 * selection's whole subtree, `Esc` leaves the caret on the selection. `n` and
 * `x` act only while the query is empty and no filter is locked, so a bare
 * letter is never eaten while a number is being typed.
 *
 * Nothing here caches offsets: every action re-reads the index from the live
 * document first, because a write moves every line under it.
 */

import type { EditorView } from "@codemirror/view";

import { dimensionColorVars } from "../core/color";
import {
  childrenOf,
  entryBySeq,
  findCurrentEntry,
  parseEntries,
  type Entry,
  type EntryIndex
} from "../core/entries";
import { filterRows, parseDcnQuery, type TravelFilter, type TravelRow } from "../core/travel-model";
import { editorPathOf } from "../editor/editor-path";
import type WeaverPlugin from "../main";
import { PALETTE_HINT } from "../notices";
import { appendDigitRuns } from "./dcn";

const PLACEHOLDER = "1 · 1.2 · .14 · 1.2.14";

/** A row's `D.C.N`, its time and its title, in the travel card's shape. */
function rowOf(path: string, dayKey: string, entry: Entry): TravelRow {
  return {
    path,
    dayKey,
    line: entry.line,
    d: entry.d,
    c: entry.c,
    n: entry.n,
    time: entry.time,
    durationMs: entry.durationMs,
    title: entry.title
  };
}

export class EntryPalette {
  private readonly root: HTMLElement;
  private readonly card: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly rowsEl: HTMLElement;

  private view: EditorView | null = null;
  private index: EntryIndex | null = null;
  private path = "";
  private entries: Entry[] = [];
  private filter: TravelFilter | null = null;
  private selected = 0;
  private opened = false;

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // A chord belongs to Obsidian: not prevented, not seen, not swallowed.
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const run = this.action(event.key);
    if (run === null) return;

    event.preventDefault();
    event.stopPropagation();
    run();
  };

  /**
   * The command a key runs here, or `null` when the key belongs to the query or
   * to Obsidian.
   *
   * `n` and `x` are commands only while nothing is being typed and no filter is
   * locked: the event is left alone, so a bare letter reaches the input instead
   * of being eaten out of a number.
   */
  private action(key: string): (() => void) | null {
    switch (key) {
      case "ArrowUp":
        return () => this.step(-1);
      case "ArrowDown":
        return () => this.step(1);
      case "Enter":
        return () => this.commit();
      case "Escape":
        return () => this.escape();
      case "n":
      case "N":
        return this.bare() ? () => this.startRoot() : null;
      case "x":
      case "X":
        return this.bare() ? () => this.remove() : null;
      default:
        return null;
    }
  }

  private readonly onOutside = (event: MouseEvent): void => {
    const target = event.target;
    if (target instanceof Node && this.card.contains(target)) return;
    this.close();
  };

  private readonly onResize = (): void => {
    this.recenter();
  };

  constructor(private readonly plugin: WeaverPlugin) {
    this.root = document.createElement("div");
    // The travel card's overlay geometry: one positioning rule, two cards.
    this.root.className = "weaver-travel-modal weaver-palette-modal";

    this.card = document.createElement("div");
    this.card.className = "weaver-palette-card";
    this.root.appendChild(this.card);

    this.input = document.createElement("input");
    // The travel card's query geometry: one input rule, two cards.
    this.input.className = "weaver-travel-query weaver-palette-query";
    this.input.setAttribute("type", "text");
    this.input.setAttribute("autocomplete", "off");
    this.input.setAttribute("spellcheck", "false");
    this.input.setAttribute("placeholder", PLACEHOLDER);
    this.card.appendChild(this.input);

    this.rowsEl = document.createElement("div");
    this.rowsEl.className = "weaver-travel-rows weaver-palette-rows";
    this.card.appendChild(this.rowsEl);

    const hint = document.createElement("div");
    hint.className = "weaver-palette-hint";
    hint.textContent = PALETTE_HINT;
    this.card.appendChild(hint);
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** Shows today's entries with the caret's own entry selected. */
  open(index: EntryIndex, view: EditorView, caretLine: number): void {
    // Nothing keeps ticking behind the card.
    this.plugin.entries.pause(new Date());

    this.view = view;
    this.path = editorPathOf(view) ?? "";
    this.filter = null;
    this.input.value = "";
    this.load(index, caretLine);

    if (!this.opened) {
      document.body.appendChild(this.root);
      this.card.addEventListener("keydown", this.onKeyDown, true);
      document.addEventListener("mousedown", this.onOutside);
      window.addEventListener("resize", this.onResize);
      window.visualViewport?.addEventListener("resize", this.onResize);
      window.visualViewport?.addEventListener("scroll", this.onResize);
      this.opened = true;
    }

    this.render();
    this.recenter();
    this.input.focus();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;

    this.card.removeEventListener("keydown", this.onKeyDown, true);
    document.removeEventListener("mousedown", this.onOutside);
    window.removeEventListener("resize", this.onResize);
    window.visualViewport?.removeEventListener("resize", this.onResize);
    window.visualViewport?.removeEventListener("scroll", this.onResize);
    this.root.remove();

    this.view = null;
  }

  /** Centres the card in the note pane, or in the visible viewport on a phone. */
  recenter(): void {
    if (!this.opened) return;

    const viewport = window.visualViewport;
    const phone = document.body.classList.contains("weaver-phone");
    const rect =
      phone || viewport === undefined || viewport === null || viewport.height <= 0
        ? {
            left: viewport?.offsetLeft ?? 0,
            top: viewport?.offsetTop ?? 0,
            width: viewport?.width ?? window.innerWidth,
            height: viewport?.height ?? window.innerHeight
          }
        : {
            left: 0,
            top: 0,
            width: window.innerWidth,
            height: window.innerHeight
          };

    this.root.style.left = `${rect.left + rect.width / 2}px`;
    this.root.style.top = `${rect.top + rect.height / 2}px`;
  }

  /** `n` and `x` never interfere with a query being typed. */
  private bare(): boolean {
    return this.input.value.trim() === "" && this.filter === null;
  }

  /** Re-reads the rows from a fresh index, keeping the selected entry if it survived. */
  private load(index: EntryIndex, caretLine: number): void {
    // The entry the caret is in, or the one directly above it: the same rule the
    // writer's own palette note asks for.
    const current = findCurrentEntry(index, caretLine);

    this.index = index;
    this.entries = index.entries;
    this.selected = current === null ? 0 : Math.max(0, index.entries.indexOf(current));
    this.clamp();
  }

  /** The rows the filter leaves, in document order. */
  private visible(): Entry[] {
    if (this.filter === null) return this.entries;
    const keep = new Set(
      filterRows(
        this.entries.map((entry) => rowOf(this.path, "", entry)),
        this.filter
      ).map((row) => row.n)
    );
    return this.entries.filter((entry) => keep.has(entry.n));
  }

  private clamp(): void {
    this.selected = Math.max(0, Math.min(this.selected, this.visible().length - 1));
  }

  private step(delta: number): void {
    this.selected += delta;
    this.clamp();
    this.render();
  }

  /** `Enter`: lock a typed query, or settle the selection and descend under it. */
  private commit(): void {
    const text = this.input.value;

    if (text.trim() !== "") {
      const filter = parseDcnQuery(text);
      // Unparseable is not a command: the card stays open with the text intact.
      if (filter === null) return;

      this.filter = filter;
      this.input.value = "";
      this.selected = 0;
      this.clamp();
      this.render();
      return;
    }

    const entry = this.visible()[this.selected];
    const view = this.view;
    this.close();
    if (entry === undefined || view === null) return;
    this.plugin.entries.settleAndDescend(view, entry);
  }

  /** `Escape`: the query, then the filter, then the caret. */
  private escape(): void {
    if (this.input.value.trim() !== "") {
      this.input.value = "";
      this.render();
      return;
    }

    if (this.filter !== null) {
      this.filter = null;
      this.clamp();
      this.render();
      return;
    }

    this.commitSelection();
  }

  /** `Esc` with nothing left to clear: the caret lands on the selection. */
  private commitSelection(): void {
    const picked = this.visible()[this.selected];
    const view = this.view;
    if (picked === undefined || view === null) {
      this.close();
      return;
    }

    // The document as it is now, not as the rows were drawn.
    const entry = entryBySeq(parseEntries(view.state.doc.toString()), picked.n);
    this.close();
    if (entry === null) return;

    view.dispatch({
      selection: { anchor: entry.proseFrom },
      scrollIntoView: true
    });
    view.focus();
  }

  private startRoot(): void {
    const view = this.view;
    this.close();
    if (view === null) return;
    void this.plugin.entries.startToday(new Date());
  }

  /** `x`: the whole subtree goes, and the card stays open on the row above it. */
  private remove(): void {
    const entry = this.visible()[this.selected];
    const view = this.view;
    if (entry === undefined || view === null) return;

    this.plugin.entries.deleteEntry(view, entry);

    // The rows are the document as it now is: a deletion above the selection
    // moves every line below it.
    this.index = parseEntries(view.state.doc.toString());
    this.entries = this.index.entries;
    this.clamp();
    this.render();
  }

  private render(): void {
    this.rowsEl.textContent = "";

    const visible = this.visible();
    visible.forEach((entry, index) => {
      const button = document.createElement("button");
      button.className = index === this.selected ? "weaver-palette-row is-current" : "weaver-palette-row";
      button.setAttribute("style", dimensionColorVars(entry.d));

      const dcn = document.createElement("span");
      dcn.className = "weaver-palette-dcn";
      appendDigitRuns(dcn, `${entry.d}.${entry.c}.${entry.n}`);
      button.appendChild(dcn);

      const time = document.createElement("span");
      time.className = "weaver-palette-time";
      time.textContent = entry.time;
      button.appendChild(time);

      if (entry.title !== "") {
        const title = document.createElement("span");
        title.className = "weaver-palette-title";
        title.textContent = entry.title;
        button.appendChild(title);
      }

      // The blast radius of `x`, visible before the press.
      const kids = this.index === null ? 0 : childrenOf(this.index, entry).length;
      if (kids > 0) {
        const count = document.createElement("span");
        count.className = "weaver-palette-count";
        count.textContent = `+${kids}`;
        button.appendChild(count);
      }

      const state = document.createElement("span");
      state.className = "weaver-palette-state";
      state.textContent = entry.state === "settled" ? "+" : "→";
      button.appendChild(state);

      button.addEventListener("click", () => {
        this.selected = index;
        this.render();
      });

      this.rowsEl.appendChild(button);
    });
  }
}
