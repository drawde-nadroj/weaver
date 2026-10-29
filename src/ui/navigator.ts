/**
 * The navigator: today's entries, the return stack, and the three gestures.
 *
 * One component serves both platforms. Desktop gets a card over the note and the
 * key map in its footer; a phone gets the same card as a full-screen sheet, where
 * a row is a tap target and the footer names the taps. Nothing else navigates:
 * there is no second list, no query, and no rectangle drawn on the note.
 *
 * It is a self-mounted overlay rather than a `Modal` for one reason: it must
 * never take a `Scope`. A scope is what swallowed `⌘,` and stopped Obsidian's own
 * settings from opening. Keys are handled on the card in the capture phase, and
 * every chord this card does not claim reaches Obsidian untouched.
 *
 * Nothing here caches offsets across a write: every action re-reads the document,
 * because a write moves every line under it.
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
import { popStop, type Stop } from "../core/navigator-stack";
import { programmaticWrite } from "../editor/entry-field";
import type WeaverPlugin from "../main";
import { NAVIGATOR_HINT_KEYS, NAVIGATOR_HINT_TOUCH } from "../notices";
import { appendDigitRuns } from "./dcn";

/** One row of the list, in the order the list shows them. */
type Item =
  | { kind: "append" }
  | { kind: "stop"; stop: Stop; entry: Entry | null }
  | { kind: "entry"; entry: Entry };

export class Navigator {
  private readonly root: HTMLElement;
  private readonly card: HTMLElement;
  private readonly list: HTMLElement;

  private view: EditorView | null = null;
  private index: EntryIndex | null = null;
  private items: Item[] = [];
  private selected = 0;
  private caret = 0;
  private armedDelete: number | null = null;
  private opened = false;

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // `⌘[` is ours; every other chord belongs to Obsidian. Not prevented, not
    // seen, not swallowed.
    const back = (event.metaKey || event.ctrlKey) && event.key === "[";
    if (!back && (event.ctrlKey || event.altKey || event.metaKey)) return;

    const run = back ? () => this.walkBack() : this.action(event.key, event.shiftKey);
    if (run === null) return;

    event.preventDefault();
    event.stopPropagation();
    run();
  };

  private readonly onOutside = (event: MouseEvent): void => {
    const target = event.target;
    if (target instanceof Node && this.card.contains(target)) return;
    this.close();
  };

  constructor(private readonly plugin: WeaverPlugin) {
    this.root = document.createElement("div");
    this.root.className = "weaver-navigator";

    this.card = document.createElement("div");
    this.card.className = "weaver-navigator-card";
    this.card.setAttribute("tabindex", "-1");
    this.root.appendChild(this.card);

    this.list = document.createElement("div");
    this.list.className = "weaver-navigator-list";
    this.card.appendChild(this.list);

    const hint = document.createElement("div");
    hint.className = "weaver-navigator-hint";

    const keys = document.createElement("span");
    keys.className = "weaver-navigator-hint-keys";
    keys.textContent = NAVIGATOR_HINT_KEYS;
    hint.appendChild(keys);

    const touch = document.createElement("span");
    touch.className = "weaver-navigator-hint-touch";
    touch.textContent = NAVIGATOR_HINT_TOUCH;
    hint.appendChild(touch);

    this.card.appendChild(hint);
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** Shows today's entries, with the caret's own entry selected. */
  open(view: EditorView): void {
    // Nothing keeps ticking behind the card.
    this.plugin.entries.pause(new Date());

    this.view = view;
    this.armedDelete = null;
    this.buildItems();

    if (!this.opened) {
      document.body.appendChild(this.root);
      this.card.addEventListener("keydown", this.onKeyDown, true);
      document.addEventListener("mousedown", this.onOutside);
      this.opened = true;
    }

    this.render();
    this.card.focus();
  }

  /**
   * Takes the card away.
   *
   * `restoreCaret` is only ever `true` for `Esc`: every other path is about to
   * move the caret itself, and a restore would fight the move it just handed to
   * the engine.
   */
  close(restoreCaret = false): void {
    if (!this.opened) return;
    this.opened = false;

    this.card.removeEventListener("keydown", this.onKeyDown, true);
    document.removeEventListener("mousedown", this.onOutside);
    this.root.remove();

    const view = this.view;
    this.view = null;
    this.index = null;
    this.items = [];
    if (view === null) return;

    if (restoreCaret) {
      view.dispatch({
        selection: { anchor: Math.min(this.caret, view.state.doc.length) },
        annotations: programmaticWrite.of(true)
      });
    }
    view.focus();
  }

  /** The command a key runs here, or `null` when the key is not ours. */
  private action(key: string, shift: boolean): (() => void) | null {
    switch (key) {
      case "ArrowUp":
        return () => this.move(-1);
      case "ArrowDown":
        return () => this.move(1);
      case "Enter":
        return shift ? () => this.descendSelected() : () => this.activate();
      case "n":
      case "N":
        return () => this.appendNew();
      case "x":
      case "X":
        return () => this.removeSelected();
      case "Escape":
        return () => this.close(true);
      default:
        return null;
    }
  }

  /** Re-reads the document: rows, the return stack, and the caret's entry. */
  private buildItems(): void {
    const view = this.view;
    if (view === null) return;

    this.caret = view.state.selection.main.head;
    const index = parseEntries(view.state.doc.toString());
    this.index = index;

    const stops = this.plugin.stack.stops.map(
      (stop): Item => ({
        kind: "stop",
        stop,
        entry: stop.n === null ? null : entryBySeq(index, stop.n)
      })
    );

    this.items = [
      { kind: "append" },
      ...stops,
      ...index.entries.map((entry): Item => ({ kind: "entry", entry }))
    ];

    const caretLine = view.state.doc.lineAt(this.caret).number - 1;
    const current = findCurrentEntry(index, caretLine);
    const at =
      current === null
        ? -1
        : this.items.findIndex(
            (item) => item.kind === "entry" && item.entry.n === current.n
          );
    const first = this.items.findIndex((item) => item.kind === "entry");

    this.selected = Math.max(0, at >= 0 ? at : first);
    this.clamp();
  }

  private clamp(): void {
    this.selected = Math.max(0, Math.min(this.selected, this.items.length - 1));
  }

  /** The `N` of the entry the caret is in, or `null` outside every entry. */
  private currentSeq(): number | null {
    const view = this.view;
    const index = this.index;
    if (view === null || index === null) return null;

    const line = view.state.doc.lineAt(this.caret).number - 1;
    return findCurrentEntry(index, line)?.n ?? null;
  }

  private move(delta: number): void {
    this.selected += delta;
    this.clamp();
    this.armedDelete = null;
    this.render();
  }

  /** `⏎` / a tap: append, return, or jump. */
  private activate(): void {
    const item = this.items[this.selected];
    if (item === undefined) return;

    if (item.kind === "append") {
      this.appendNew();
      return;
    }

    if (item.kind === "stop") {
      this.walkTo(item.stop);
      return;
    }

    void this.plugin.entries.jumpTo(item.entry.n);
    this.close();
  }

  /** `⇧⏎` / a tap on the caret's own row: a child under the selection. */
  private descendSelected(): void {
    const item = this.items[this.selected];
    const view = this.view;
    if (item === undefined || item.kind !== "entry" || view === null) return;

    this.plugin.entries.settleAndDescend(view, item.entry);
    this.close();
  }

  private appendNew(): void {
    void this.plugin.entries.appendEntry(new Date());
    this.close();
  }

  /**
   * `x`: the selected subtree goes, and the list stays open on what is left.
   *
   * The engine focuses the editor as part of the write, which would leave the
   * remaining keys dead — so the card takes focus back with the selection
   * clamped, and the list stays open on what is left.
   */
  private removeSelected(): void {
    const item = this.items[this.selected];
    const view = this.view;
    if (item === undefined || item.kind !== "entry" || view === null) return;

    this.plugin.entries.deleteEntry(view, item.entry);
    this.armedDelete = null;
    this.buildItems();
    this.render();
    this.card.focus();
  }

  /** `⌘[`: back one stop, with the panel open on the place returned to. */
  private walkBack(): void {
    const { stops, stop } = popStop(this.plugin.stack.stops);
    this.plugin.stack.stops = stops;
    if (stop === null) return;

    void (async () => {
      await this.plugin.entries.jumpTo(stop.n, stop);
      this.buildItems();
      this.render();
    })();
  }

  private walkTo(stop: Stop): void {
    void this.plugin.entries.jumpTo(stop.n, stop);
    this.close();
  }

  private render(): void {
    this.list.textContent = "";

    const index = this.index;
    if (this.view === null || index === null) return;

    const current = this.currentSeq();
    const rows = new Map<number, HTMLElement>();
    const add = (at: number, element: HTMLElement): void => {
      rows.set(at, element);
      this.list.appendChild(element);
    };

    /** A row's tap: the caret's own row descends, everything else activates. */
    const onRow = (at: number): (() => void) => () => {
      this.selected = at;
      this.armedDelete = null;

      const item = this.items[at];
      if (item?.kind === "entry" && item.entry.n === current) this.descendSelected();
      else this.activate();
    };

    this.items.forEach((item, at) => {
      if (item.kind === "stop" && !rows.has(-1)) {
        // One label for the whole return block, above its first row.
        const label = document.createElement("div");
        label.className = "weaver-navigator-label";
        label.textContent = "return";
        this.list.appendChild(label);
        rows.set(-1, label);
      }

      if (item.kind === "append") {
        const button = document.createElement("button");
        button.className = "weaver-navigator-row weaver-navigator-append";
        button.textContent = "＋ end of day";
        if (at === this.selected) button.classList.add("is-selected");
        button.addEventListener("click", onRow(at));
        add(at, button);
        return;
      }

      if (item.kind === "stop") {
        const button = document.createElement("button");
        button.className = "weaver-navigator-row weaver-navigator-stop";
        const entry = item.entry;
        button.textContent =
          entry === null ? "↩ return point" : `↩ ${entry.d}.${entry.c}.${entry.n}`;
        if (at === this.selected) button.classList.add("is-selected");
        if (entry !== null) button.setAttribute("style", dimensionColorVars(entry.d));
        button.addEventListener("click", onRow(at));
        add(at, button);
        return;
      }

      // A row is a container, not a button: the row's own tap target and its
      // delete are siblings, so a click on one can never reach the other.
      const row = document.createElement("div");
      const classes = ["weaver-navigator-row", "weaver-navigator-entry"];
      if (item.entry.n === current) classes.push("is-current");
      if (at === this.selected) classes.push("is-selected");
      row.className = classes.join(" ");
      row.setAttribute("style", dimensionColorVars(item.entry.d));

      const open = document.createElement("button");
      open.className = "weaver-navigator-open";

      const dcn = document.createElement("span");
      dcn.className = "weaver-navigator-dcn";
      appendDigitRuns(dcn, `${item.entry.d}.${item.entry.c}.${item.entry.n}`);
      open.appendChild(dcn);

      const time = document.createElement("span");
      time.className = "weaver-navigator-time";
      time.textContent = item.entry.time;
      open.appendChild(time);

      if (item.entry.title !== "") {
        const titleSpan = document.createElement("span");
        titleSpan.className = "weaver-navigator-title";
        titleSpan.textContent = item.entry.title;
        open.appendChild(titleSpan);
      }

      // The blast radius of `x`, visible before the press.
      const kids = childrenOf(index, item.entry).length;
      if (kids > 0) {
        const count = document.createElement("span");
        count.className = "weaver-navigator-count";
        count.textContent = `+${kids}`;
        open.appendChild(count);
      }

      open.addEventListener("click", onRow(at));
      row.appendChild(open);
      row.appendChild(this.deleteButton(at));
      add(at, row);
    });

    if (index.entries.length === 0) {
      const label = document.createElement("div");
      label.className = "weaver-navigator-label";
      label.textContent = "no entries yet — ＋ appends the first";
      this.list.appendChild(label);
    } else {
      const label = document.createElement("div");
      label.className = "weaver-navigator-label";
      label.textContent = "today";
      // After the append row and the return stack, before the first entry.
      const first = this.items.findIndex((item) => item.kind === "entry");
      const before = rows.get(first);
      if (before !== undefined) this.list.insertBefore(label, before);
      else this.list.appendChild(label);
    }

    rows.get(this.selected)?.scrollIntoView({ block: "nearest" });
  }

  /** `✕` arms on the first press and deletes on the second. */
  private deleteButton(at: number): HTMLElement {
    const button = document.createElement("button");
    button.className = "weaver-navigator-delete";
    button.setAttribute("aria-label", "Delete entry");
    button.textContent = "✕";

    button.addEventListener("click", (event: Event) => {
      event.stopPropagation();
      this.selected = at;

      if (this.armedDelete !== at) {
        this.armedDelete = at;
        button.textContent = "✕ again";
        return;
      }

      this.removeSelected();
    });

    return button;
  }
}
