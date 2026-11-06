/**
 * The navigator: today's entries, the return stack, today's portal history, and
 * the gestures that move between them.
 *
 * One component serves both platforms. Desktop gets a card over the note and the
 * key map in its footer; a phone gets the same card as a full-screen sheet, where
 * a row is a tap target and the footer names the taps. Nothing else navigates:
 * there is no second list, no query, and no rectangle drawn on the note.
 *
 * The portal section is the human-facing half of the note's `weaver-alignments`
 * block. It lists facts — an opening that was really entered — beside the day's
 * remaining schedule, in one chronology. A schedule row is reconstructed for the
 * current local day and never written; a recorded row keeps the opening's
 * original offset and the actual beginning, so travel cannot rewrite what
 * happened. This is a list, not a scoreboard: no percentage, no missed count, and
 * no targets.
 *
 * It is a self-mounted overlay rather than a `Modal` for one reason: it must
 * never take a `Scope`. A scope is what swallowed `⌘,` and stopped Obsidian's own
 * settings from opening. Keys are handled on the card in the capture phase, and
 * every chord this card does not claim reaches Obsidian untouched.
 *
 * Nothing here caches offsets across a write: every action re-reads the document,
 * because a write moves every line under it. The card is open only while the
 * writer is choosing; it owns exactly one controller subscription and one
 * document listener, both removed on close, and neither is a timer.
 */

import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { pad2 } from "../core/clock";
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
import {
  linkedPortalEntry,
  portalHistoryRows,
  type PortalHistoryRow
} from "../core/portal-history";
import { programmaticWrite } from "../editor/entry-field";
import type WeaverPlugin from "../main";
import { NAVIGATOR_HINT_KEYS, NAVIGATOR_HINT_TOUCH } from "../notices";
import { appendDigitRuns } from "./dcn";

/** One row of the list, in the order the list shows them. */
type Item =
  | { kind: "start" }
  | { kind: "stop"; stop: Stop; entry: Entry | null }
  | { kind: "entry"; entry: Entry }
  | { kind: "portals" }
  | { kind: "portals-all" }
  | { kind: "portal"; row: PortalHistoryRow };

/** `2026-11-05T22:55:00-08:00`: the moment and the offset it was recorded in. */
const LOCAL_STAMP = /T(\d{2}:\d{2}:\d{2})([+-]\d{2}:\d{2})$/;

/**
 * The card's document subscription, shared by every navigator a session opens.
 *
 * A compartment only contributes when its instance is already in the editor's
 * configuration, so the first open appends `compartment.of(listener)` and every
 * later open replaces its content. One instance stays behind as an empty
 * compartment rather than accumulating one per opening.
 */
const CARD_SOURCE = new Compartment();

/** `22:55:00 -08:00` — the actual moment, with the offset it happened at. */
function momentText(began: string): string {
  const match = LOCAL_STAMP.exec(began);
  return match === null ? began : `${match[1]} ${match[2]}`;
}

/** The card: today's entries, the return stack, portals, and the gestures. */
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

  /** The portal section stays collapsed until it is deliberately opened. */
  private portalsExpanded = false;
  /** `Show all openings` widens the schedule from the window to the whole day. */
  private showAll = false;
  private portalRows: PortalHistoryRow[] = [];
  private portalError: string | null = null;
  /** Each row's element, so the first expansion can bring one into view. */
  private readonly portalElements = new Map<string, HTMLElement>();

  /** The card's own document subscription, installed only while it is open. */
  private readonly sourceListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) this.refresh();
  });
  private stopPortals: (() => void) | null = null;
  /** True while an engine write is already rebuilding the list by hand. */
  private suspended = false;

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
    void this.plugin.entries.pause();

    this.view = view;
    this.armedDelete = null;
    this.buildItems();

    if (!this.opened) {
      document.body.appendChild(this.root);
      this.card.addEventListener("keydown", this.onKeyDown, true);
      document.addEventListener("mousedown", this.onOutside);
      this.opened = true;
      this.attachSignals(view);
    }

    this.render("selection");
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

    this.stopPortals?.();
    this.stopPortals = null;

    this.card.removeEventListener("keydown", this.onKeyDown, true);
    document.removeEventListener("mousedown", this.onOutside);
    this.root.remove();

    const view = this.view;
    this.view = null;
    this.index = null;
    this.items = [];
    this.portalRows = [];
    this.portalError = null;
    this.portalElements.clear();
    if (view === null) return;

    // Detach the card's listener in the same transaction that restores the
    // caret, so closing never costs the editor a second undo step.
    const detached = CARD_SOURCE.get(view.state) === undefined ? null : CARD_SOURCE.reconfigure([]);
    if (restoreCaret) {
      const selection = { anchor: Math.min(this.caret, view.state.doc.length) };
      view.dispatch(
        detached === null
          ? { selection, annotations: programmaticWrite.of(true) }
          : { selection, effects: detached, annotations: programmaticWrite.of(true) }
      );
    } else if (detached !== null) {
      view.dispatch({ effects: detached });
    }
    view.focus();
  }

  /**
   * Watches the two things a row is derived from while the card is open: the
   * portal lifecycle and the note's own text.
   *
   * Neither is a timer. The document listener is a CodeMirror extension in a
   * compartment, removed on close; the controller subscription is dropped in the
   * same place. A second of elapsed time never rebuilds this list — the
   * countdown lives on the portal frame, not here.
   */
  private attachSignals(view: EditorView): void {
    const existing = CARD_SOURCE.get(view.state);
    view.dispatch({
      effects:
        existing === undefined
          ? StateEffect.appendConfig.of(CARD_SOURCE.of(this.sourceListener))
          : CARD_SOURCE.reconfigure(this.sourceListener)
    });
    this.stopPortals = this.plugin.portals.subscribe(() => this.refresh());
  }

  /** Re-reads source and lifecycle, keeping the selected row and scroll place. */
  private refresh(): void {
    if (!this.opened || this.suspended) return;
    const key = this.itemKey(this.items[this.selected]);
    const scroll = this.list.scrollTop;
    this.buildItems(key);
    this.render(scroll);
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
        return () => this.startNew();
      case "x":
      case "X":
        return () => this.removeSelected();
      case "Escape":
        return () => this.close(true);
      default:
        return null;
    }
  }

  /**
   * Re-reads the document: rows, the return stack, the portal history, and the
   * caret's entry.
   *
   * `prefer` names the row the previous render had selected. A refresh keeps
   * that identity when it still exists; a vanished portal row falls back to the
   * section header rather than jumping to whatever entry the caret happens to be
   * in. Without `prefer`, the caret's own entry is selected, which is what an
   * initial open and a return walk want.
   */
  private buildItems(prefer: string | null = null): void {
    const view = this.view;
    if (view === null) return;

    this.caret = view.state.selection.main.head;
    const source = view.state.doc.toString();
    const index = parseEntries(source);
    this.index = index;

    const stops = this.plugin.stack.stops.map(
      (stop): Item => ({
        kind: "stop",
        stop,
        entry: stop.n === null ? null : entryBySeq(index, stop.n)
      })
    );

    const items: Item[] = [
      { kind: "start" },
      ...stops,
      ...index.entries.map((entry): Item => ({ kind: "entry", entry }))
    ];

    this.portalRows = [];
    this.portalError = null;
    if (this.portalsExpanded) {
      const read = portalHistoryRows(source, this.plugin.portals.now(), this.showAll);
      if (read.ok) this.portalRows = read.rows;
      else this.portalError = read.error;
    }

    items.push({ kind: "portals" });
    if (this.portalsExpanded && this.portalError === null) {
      for (const row of this.portalRows) items.push({ kind: "portal", row });
      items.push({ kind: "portals-all" });
    }

    this.items = items;

    if (prefer !== null) {
      const kept = items.findIndex((item) => this.itemKey(item) === prefer);
      if (kept >= 0) {
        this.selected = kept;
        this.clamp();
        return;
      }
      if (prefer.startsWith("portal")) {
        const header = items.findIndex((item) => item.kind === "portals");
        if (header >= 0) {
          this.selected = header;
          this.clamp();
          return;
        }
      }
    }

    const caretLine = view.state.doc.lineAt(this.caret).number - 1;
    const current = findCurrentEntry(index, caretLine);
    const at =
      current === null
        ? -1
        : items.findIndex(
            (item) => item.kind === "entry" && item.entry.n === current.n
          );
    const first = items.findIndex((item) => item.kind === "entry");

    this.selected = Math.max(0, at >= 0 ? at : first);
    this.clamp();
  }

  private clamp(): void {
    this.selected = Math.max(0, Math.min(this.selected, this.items.length - 1));
  }

  /** A stable name for a row, so a refresh can find the same one again. */
  private itemKey(item: Item | undefined): string | null {
    if (item === undefined) return null;
    switch (item.kind) {
      case "start":
        return "start";
      case "stop":
        return `stop:${item.stop.n ?? "none"}:${item.stop.caret}`;
      case "entry":
        return `entry:${item.entry.n}`;
      case "portals":
        return "portals";
      case "portals-all":
        return "portals-all";
      case "portal":
        return `portal:${item.row.id}`;
    }
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
    this.render("selection");
  }

  /** `⏎` / a tap: append, return, jump, expand, or prepare. */
  private activate(): void {
    const item = this.items[this.selected];
    if (item === undefined) return;

    switch (item.kind) {
      case "start":
        this.startNew();
        return;
      case "stop":
        this.walkTo(item.stop);
        return;
      case "entry":
        void this.plugin.entries.jumpTo(item.entry.n);
        this.close();
        return;
      case "portals":
        this.togglePortals();
        return;
      case "portals-all":
        this.toggleShowAll();
        return;
      case "portal":
        this.activatePortal(item.row);
        return;
    }
  }

  /**
   * Enters an opening or follows a recorded fact.
   *
   * A recorded row is revalidated against the live document first: a deleted
   * sequence can be reused, so its recorded beginning must still match. An
   * unavailable entry never becomes a jump. Upcoming and open rows prepare only
   * while portals are enabled; a passed minute is informational unless held.
   */
  private activatePortal(row: PortalHistoryRow): void {
    if (row.kind === "opening") {
      if (this.plugin.settings.portalsEnabled !== true) return;
      const held = this.plugin.portals.held();
      const isHeld = held !== null && held.portal.id === row.portal.id;
      if (row.phase === "passed" && !isHeld) return;

      void this.plugin.preparePortal(row.portal.id);
      this.close();
      return;
    }

    const view = this.view;
    if (view === null) return;
    const entry = linkedPortalEntry(row.record, parseEntries(view.state.doc.toString()));
    if (entry === null) return;

    void this.plugin.entries.jumpTo(entry.n);
    this.close();
  }

  private togglePortals(): void {
    this.portalsExpanded = !this.portalsExpanded;
    this.buildItems("portals");
    // The first look at a day starts at the nearest opening; a second look does
    // the same, because the writer asked for it again.
    this.render(this.portalsExpanded ? "nearest" : "selection");
  }

  private toggleShowAll(): void {
    this.showAll = !this.showAll;
    const scroll = this.list.scrollTop;
    this.buildItems("portals-all");
    this.render(scroll);
  }

  /** `⇧⏎` / a tap on the caret's own row: a child under the selection. */
  private descendSelected(): void {
    const item = this.items[this.selected];
    const view = this.view;
    if (item === undefined || item.kind !== "entry" || view === null) return;

    this.suspended = true;
    try {
      this.plugin.entries.settleAndDescend(view, item.entry);
    } finally {
      this.suspended = false;
    }
    this.close();
  }

  private startNew(): void {
    void this.plugin.entries.startEntry(new Date());
    this.close();
  }

  /**
   * `x`: the selected subtree goes, and the list stays open on what is left.
   *
   * Only a real entry row can be deleted. Schedule rows and recorded portal facts
   * are history, not entries, and the key is inert on them.
   *
   * The engine focuses the editor as part of the write, which would leave the
   * remaining keys dead — so the card takes focus back with the selection
   * clamped, and the list stays open on what is left.
   */
  private removeSelected(): void {
    const item = this.items[this.selected];
    const view = this.view;
    if (item === undefined || item.kind !== "entry" || view === null) return;

    this.suspended = true;
    try {
      this.plugin.entries.deleteEntry(view, item.entry);
    } finally {
      this.suspended = false;
    }
    this.armedDelete = null;
    this.buildItems();
    this.render("selection");
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
      this.render("selection");
    })();
  }

  private walkTo(stop: Stop): void {
    void this.plugin.entries.jumpTo(stop.n, stop);
    this.close();
  }

  /**
   * Draws the list.
   *
   * `scroll` is the one decision every rebuild must make explicitly: follow the
   * selection after a move, restore a place after a refresh, or bring the nearest
   * opening into view on the first expansion.
   */
  private render(scroll: "selection" | "nearest" | number = "selection"): void {
    this.list.textContent = "";
    this.portalElements.clear();

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

      if (item.kind === "start") {
        const button = document.createElement("button");
        button.className = "weaver-navigator-row weaver-navigator-append";
        button.textContent = "＋ start an entry";
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
          entry === null ? "↩ return point" : `↩ ${entry.b}.${entry.d}.${entry.n}`;
        if (at === this.selected) button.classList.add("is-selected");
        if (entry !== null) button.setAttribute("style", dimensionColorVars(entry.d));
        button.addEventListener("click", onRow(at));
        add(at, button);
        return;
      }

      if (item.kind === "portals") {
        const button = document.createElement("button");
        button.className = "weaver-navigator-row weaver-navigator-portals-toggle";
        button.setAttribute("aria-expanded", String(this.portalsExpanded));
        button.textContent = `${this.portalsExpanded ? "▾" : "▸"} Portals`;
        if (at === this.selected) button.classList.add("is-selected");
        button.addEventListener("click", onRow(at));
        add(at, button);

        if (this.portalsExpanded && this.portalError !== null) {
          const error = document.createElement("div");
          error.className = "weaver-navigator-portals-error";
          error.setAttribute("role", "status");
          error.textContent = this.portalError;
          this.list.appendChild(error);
        } else if (this.portalsExpanded && this.portalRows.length === 0) {
          const quiet = document.createElement("div");
          quiet.className = "weaver-navigator-label";
          quiet.textContent = "no portal openings today";
          this.list.appendChild(quiet);
        }
        return;
      }

      if (item.kind === "portals-all") {
        const button = document.createElement("button");
        button.className = "weaver-navigator-row weaver-navigator-portals-all";
        button.setAttribute(
          "aria-pressed",
          String(this.showAll)
        );
        button.textContent = this.showAll ? "Show fewer openings" : "Show all openings";
        if (at === this.selected) button.classList.add("is-selected");
        button.addEventListener("click", onRow(at));
        add(at, button);
        return;
      }

      if (item.kind === "portal") {
        const row = document.createElement("div");
        const rowClasses = ["weaver-navigator-row", "weaver-navigator-portal"];
        if (item.row.kind === "recorded") {
          rowClasses.push("is-recorded");
          if (item.row.entry === null) rowClasses.push("is-unavailable");
        } else {
          rowClasses.push(`is-${item.row.phase}`);
        }
        if (at === this.selected) rowClasses.push("is-selected");
        row.className = rowClasses.join(" ");
        row.setAttribute("data-portal-id", item.row.id);

        const open = document.createElement("button");
        open.className = "weaver-navigator-open";

        const time = document.createElement("span");
        time.className = "weaver-navigator-portal-time";
        time.textContent = `${pad2(item.row.portal.hour)}:${pad2(item.row.portal.minute)}`;
        open.appendChild(time);

        const label = document.createElement("span");
        label.className = "weaver-navigator-portal-label";
        label.textContent = item.row.label;
        open.appendChild(label);

        if (item.row.kind === "recorded") {
          // The actual beginning, with the offset it was recorded in: the fact
          // keeps its own timezone even after the machine travels.
          const moment = document.createElement("span");
          moment.className = "weaver-navigator-portal-moment";
          moment.textContent = momentText(item.row.record.began);
          open.appendChild(moment);

          if (item.row.entry === null) {
            const unavailable = document.createElement("span");
            unavailable.className = "weaver-navigator-portal-unavailable";
            unavailable.textContent = "Entry unavailable";
            open.appendChild(unavailable);
          }
        }

        open.addEventListener("click", onRow(at));
        row.appendChild(open);
        this.portalElements.set(item.row.id, row);
        add(at, row);
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
      appendDigitRuns(dcn, `${item.entry.b}.${item.entry.d}.${item.entry.n}`);
      open.appendChild(dcn);

      const time = document.createElement("span");
      time.className = "weaver-navigator-time";
      time.textContent = item.entry.time ?? "";
      open.appendChild(time);

      // The reading first, then the writer's own words: a whisper is what the
      // entry holds, a title is how it starts.
      const title = item.entry.whisper[0]?.text ?? item.entry.title;
      if (title !== "") {
        const titleSpan = document.createElement("span");
        titleSpan.className = "weaver-navigator-title";
        titleSpan.textContent = title;
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
      label.textContent = "no entries yet — ＋ starts the first";
      const anchorAt = this.items.findIndex((item) => item.kind === "portals");
      const before = anchorAt >= 0 ? rows.get(anchorAt) : undefined;
      if (before !== undefined) this.list.insertBefore(label, before);
      else this.list.appendChild(label);
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

    // Schedule rows are this machine's clock, not a recorded fact: say so once,
    // rather than letting a travel day imply the openings happened here.
    if (this.portalsExpanded && this.portalRows.some((row) => row.kind === "opening")) {
      const note = document.createElement("div");
      note.className = "weaver-navigator-label weaver-navigator-portals-note";
      note.textContent = "Schedule in current timezone";
      this.list.appendChild(note);
    }

    if (scroll === "selection") {
      rows.get(this.selected)?.scrollIntoView({ block: "nearest" });
    } else if (scroll === "nearest") {
      const nearest = this.nearestPortalId();
      if (nearest !== null) {
        this.portalElements.get(nearest)?.scrollIntoView({ block: "nearest" });
      }
    } else {
      this.list.scrollTop = scroll;
    }
  }

  /** The row whose opening is closest to now, for the first expansion. */
  private nearestPortalId(): string | null {
    const now = this.plugin.portals.now();
    let best: { id: string; distance: number } | null = null;
    for (const row of this.portalRows) {
      const distance = Math.abs(row.portal.opensAt - now);
      if (best === null || distance < best.distance) {
        best = { id: row.id, distance };
      }
    }
    return best?.id ?? null;
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
