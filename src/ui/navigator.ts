/**
 * The navigator: the Realm you are in, the day's thoughts across every Realm, and
 * the openings that are still live.
 *
 * It is the only list and the only navigation. Three tabs share one card —
 * **History**, one chronology for a chosen day; **Realms**, where travelling and
 * writing are two different buttons because they are two different acts; and
 * **Portals**, the openings that can still be entered plus the ones that were
 * really recorded. Nothing here writes an entry: opening a row travels, branching
 * opens or retargets the composer, and deleting asks the engine after a
 * confirmation.
 *
 * Three rules keep it honest:
 *
 *  - **Browsing is not travelling.** Selecting a row changes nothing outside the
 *    card; only `Enter`, a tap on the row's own action, or a Realm's `Travel`
 *    moves the screen.
 *  - **One selection model.** A stable key identifies the selected row, a roving
 *    `tabindex` keeps focus on it, and mouse and keyboard update the same value —
 *    so what is drawn selected, what is focused, and what an action acts on can
 *    never drift apart.
 *  - **A countdown is not a rebuild.** A portal tick repaints the text of the rows
 *    that changed, and rebuilds the list only when the rows themselves are
 *    different, so the writer's focus survives a ticking second.
 *
 * It is a self-mounted overlay rather than a `Modal` for one reason: it must never
 * take a `Scope`. A scope is what once swallowed `⌘,`, and every chord this card
 * does not claim must reach Obsidian untouched.
 */

import { pad2 } from "../core/clock";
import { contextDayPath } from "../core/contexts";
import { dimensionColorVars } from "../core/color";
import { entryBySeq, parseEntries } from "../core/entries";
import { rootEntryOf, thoughtRefOf, type ThoughtRef } from "../core/capture";
import { linkedPortalEntry, portalHistoryRows } from "../core/portal-history";
import type { PortalOccurrence } from "../core/portals";
import { editorPathOf } from "../editor/editor-path";
import { findActiveEditorView, registeredEditorViews } from "../editor/view-registry";
import type WeaverPlugin from "../main";
import { NAVIGATOR_HINT_KEYS, NAVIGATOR_HINT_TOUCH } from "../notices";
import { readDailyLog, type DailyLog, type DailyRow } from "../entries/daily-log";
import { appendDigitRuns } from "./dcn";
import type { PortalHistoryRow } from "../core/portal-history";

/** The three things the card can be showing. */
export type NavigatorSection = "history" | "realms" | "portals";

/** How the card was opened, so it lands on the reason it was opened. */
export interface NavigatorOptions {
  section?: NavigatorSection;
}

/** One selectable row, in the order the card draws them. */
type Item =
  | { kind: "row"; key: string; row: DailyRow }
  | { kind: "realm"; key: string; contextId: string }
  | { kind: "offer"; key: string; occurrence: PortalOccurrence; phase: OfferedPhase }
  | { kind: "closed"; key: string; occurrence: PortalOccurrence }
  | { kind: "record"; key: string; path: string; row: PortalHistoryRow };

/** A recorded capture, with the note it was found in. */
interface RecordedRow {
  path: string;
  row: PortalHistoryRow;
}

/**
 * The card.
 *
 * It owns no note state that outlives a render: every action re-reads what it
 * acts on, because a write moves every line under it and a stale offset is how a
 * navigation lands somewhere unintended.
 */
export class Navigator {
  private readonly root: HTMLElement;
  private readonly card: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly filter: HTMLSelectElement;
  private readonly dayInput: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly notice: HTMLElement;

  private items: Item[] = [];
  /** The recorded captures the Portals tab lists, read with the day. */
  private recorded: RecordedRow[] = [];
  private selectedKey = "";
  private armedDelete = "";
  private opened = false;
  private section: NavigatorSection = "history";
  /** The day the list is showing, canonical `YYYY-MM-DD`. */
  private day = todayKey();
  /** The Realm filter: `all`, or a Realm id. Remembered for this session. */
  private filterBy = "all";
  private log: DailyLog = { rows: [], untimed: [], errors: [], unsupported: [] };
  /** Bumped on every load, so a stale answer cannot replace a newer one. */
  private generation = 0;
  private loading = false;
  private destroyed = false;
  private signature = "";

  private stopPortals: (() => void) | null = null;

  private readonly onKeyDown = (event: KeyboardEvent): void => this.handleKey(event);
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
    this.card.setAttribute("role", "dialog");
    this.card.setAttribute("aria-label", "Navigator");
    this.card.setAttribute("tabindex", "-1");
    this.root.appendChild(this.card);

    const header = document.createElement("div");
    header.className = "weaver-navigator-header";

    this.tabs = document.createElement("div");
    this.tabs.className = "weaver-navigator-tabs";
    this.tabs.setAttribute("role", "tablist");
    this.tabs.setAttribute("aria-label", "Navigator sections");

    for (const section of ["history", "realms", "portals"] as const) {
      const tab = document.createElement("button");
      tab.className = "weaver-navigator-tab";
      tab.setAttribute("type", "button");
      tab.setAttribute("role", "tab");
      tab.setAttribute("data-section", section);
      tab.textContent = section === "history" ? "History" : section === "realms" ? "Realms" : "Portals";
      tab.addEventListener("click", () => {
        this.section = section;
        void this.load();
      });
      this.tabs.appendChild(tab);
    }
    header.appendChild(this.tabs);

    this.filter = document.createElement("select");
    this.filter.className = "weaver-navigator-filter";
    this.filter.setAttribute("aria-label", "Realm filter");
    this.filter.addEventListener("change", () => {
      this.filterBy = this.filter.value;
      void this.load();
    });
    header.appendChild(this.filter);

    this.dayInput = document.createElement("input");
    this.dayInput.className = "weaver-navigator-day";
    this.dayInput.setAttribute("type", "date");
    this.dayInput.setAttribute("aria-label", "Day");
    this.dayInput.addEventListener("change", () => {
      if (this.dayInput.value === "") return;
      this.day = this.dayInput.value;
      void this.load();
    });
    header.appendChild(this.dayInput);

    this.card.appendChild(header);

    this.list = document.createElement("div");
    this.list.className = "weaver-navigator-list";
    this.list.setAttribute("role", "listbox");
    this.list.setAttribute("aria-label", "Navigator rows");
    this.card.appendChild(this.list);

    this.actions = document.createElement("div");
    this.actions.className = "weaver-navigator-actions";
    this.card.appendChild(this.actions);

    this.notice = document.createElement("div");
    this.notice.className = "weaver-navigator-notice";
    this.notice.setAttribute("role", "status");
    this.notice.setAttribute("aria-live", "polite");
    this.card.appendChild(this.notice);

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

  /** True while the card is on screen. */
  get isOpen(): boolean {
    return this.opened;
  }

  /**
   * Shows the card on the section that was asked for.
   *
   * It does not reveal today's note and does not create one: the list is built
   * from the vault as it is, so opening the navigator on an empty day is a
   * reading, not a write.
   */
  async open(options: NavigatorOptions = {}): Promise<void> {
    void this.plugin.entries.pause();

    if (options.section !== undefined) this.section = options.section;

    if (!this.opened) {
      document.body.appendChild(this.root);
      this.card.addEventListener("keydown", this.onKeyDown, true);
      document.addEventListener("mousedown", this.onOutside);
      this.opened = true;
      this.stopPortals = this.plugin.portals.subscribe(() => {
        void this.refresh();
      });
    }

    await this.load();
    this.card.focus();
  }

  /** A second open call, while the card is already up: change section instead. */
  async choose(options: NavigatorOptions = {}): Promise<void> {
    if (options.section !== undefined) {
      this.section = options.section;
      await this.load();
      return;
    }
    await this.refresh();
  }

  /**
   * Takes the card away.
   *
   * `restoreFocus` is only ever true for a cancellation: every other path is
   * about to move the screen itself, and a restore would fight the move it just
   * handed to the plugin.
   */
  close(restoreFocus = false): void {
    if (!this.opened) return;
    this.opened = false;

    this.stopPortals?.();
    this.stopPortals = null;

    this.card.removeEventListener("keydown", this.onKeyDown, true);
    document.removeEventListener("mousedown", this.onOutside);
    this.root.remove();
    this.items = [];
    this.signature = "";

    if (!restoreFocus) return;
    const view = findActiveEditorView(this.plugin.app);
    if (view === null) return;
    view.focus();
  }

  /** Destroys the card for good, when the plugin unloads. */
  destroy(): void {
    this.destroyed = true;
    this.close();
  }

  /** Re-derives the list after something outside it changed. */
  async refresh(): Promise<void> {
    if (!this.opened) return;
    await this.load();
  }

  /** Re-reads what the current section shows, keeping the selected row. */
  private async load(): Promise<void> {
    if (this.destroyed || !this.opened) return;
    const generation = ++this.generation;
    this.loading = true;
    this.render();

    const contexts = this.plugin.contexts();
    const log =
      this.section === "history"
        ? await readDailyLog(
            {
              paths: () => this.plugin.app.vault.getMarkdownFiles().map((file) => file.path),
              read: (path) => this.readNote(path),
              generation: () => this.generation
            },
            contexts,
            this.day
          )
        : { rows: [], untimed: [], errors: [], unsupported: [] };

    if (generation !== this.generation || !this.opened) return;
    this.log = log;
    this.recorded = this.section === "portals" ? await this.readRecords() : [];
    if (generation !== this.generation || !this.opened) return;
    this.loading = false;
    this.buildItems();
    this.render();
  }

  /**
   * The text the card acts on: an open editor's own document first, because it
   * may hold unsaved writing the file on disk does not have yet.
   */
  private async readNote(path: string): Promise<string | null> {
    for (const view of registeredEditorViews()) {
      if (editorPathOf(view) === path) return view.state.doc.toString();
    }
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (file === null) return null;
    try {
      return await this.plugin.app.vault.cachedRead(file as never);
    } catch {
      return null;
    }
  }

  /** Every row the current section draws, in order. */
  private buildItems(): void {
    const items: Item[] = [];

    if (this.section === "history") {
      const timed = this.filtered(this.log.rows);
      const untimed = this.filtered(this.log.untimed);
      for (const row of timed) items.push({ kind: "row", key: `row:${row.path}:${row.n}`, row });
      for (const row of untimed) items.push({ kind: "row", key: `row:${row.path}:${row.n}`, row });
    } else if (this.section === "realms") {
      for (const context of this.plugin.contexts()) {
        items.push({ kind: "realm", key: `realm:${context.id}`, contextId: context.id });
      }
    } else {
      for (const offered of this.plugin.portals.outstanding()) {
        items.push({
          kind: "offer",
          key: `offer:${offered.occurrence.id}`,
          occurrence: offered.occurrence,
          phase: offered.phase === "available" ? "available" : "approaching"
        });
      }
      for (const closed of this.plugin.portals.recentlyClosed(3000)) {
        items.push({ kind: "closed", key: `closed:${closed.id}`, occurrence: closed });
      }
      for (const recorded of this.recorded) {
        items.push({
          kind: "record",
          key: `record:${recorded.path}:${recorded.row.id}`,
          path: recorded.path,
          row: recorded.row
        });
      }
    }

    this.items = items;
    if (!items.some((item) => item.key === this.selectedKey)) {
      this.selectedKey = items[0]?.key ?? "";
    }
  }

  /** The rows the Realm filter allows. */
  private filtered(rows: readonly DailyRow[]): DailyRow[] {
    if (this.filterBy === "all") return [...rows];
    return rows.filter((row) => row.contextId === this.filterBy);
  }

  /**
   * The recorded openings of every Realm's note for the selected day.
   *
   * The note on screen is read from its editor, because it may hold writing the
   * file does not have yet; every other Realm's note is read from the vault. A
   * recorded capture belongs to the note that holds it, not to whichever note is
   * open, so a closed note's evidence is still listed.
   */
  private async readRecords(): Promise<RecordedRow[]> {
    const result: RecordedRow[] = [];
    const seen = new Set<string>();

    for (const context of this.plugin.contexts()) {
      const path = contextDayPath(context, this.day);
      if (seen.has(path)) continue;
      seen.add(path);

      const source = await this.readNote(path);
      if (source === null) continue;
      const read = portalHistoryRows(source);
      if (!read.ok) continue;
      for (const row of read.rows) result.push({ path, row });
    }

    return result;
  }

  /** The item the selection points at. */
  private selected(): Item | undefined {
    return this.items.find((item) => item.key === this.selectedKey);
  }

  /**
   * One key, one decision.
   *
   * The card reads keys in the capture phase so a structural letter never reaches
   * an editor behind it, and it hands every key back that it does not claim. A
   * text field or a picker keeps its own keys: arrows and letters are what a date
   * input and a select are made of.
   */
  private handleKey(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (isEditable(event.target)) return;

    const back = (event.metaKey || event.ctrlKey) && event.key === "[";
    const forwardChord = (event.metaKey || event.ctrlKey) && event.key === "]";
    if (!back && !forwardChord && (event.ctrlKey || event.altKey || event.metaKey)) return;

    if (back || forwardChord) {
      event.preventDefault();
      event.stopPropagation();
      void (back ? this.plugin.goBack() : this.plugin.goForward());
      return;
    }

    const onTab = tagNameOf(event.target) === "button" && this.tabs.contains(event.target as Node);

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (this.armedDelete !== "") {
        this.armedDelete = "";
        this.render();
        return;
      }
      this.close(true);
      return;
    }

    if (onTab && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      event.preventDefault();
      this.cycleTab(event.key === "ArrowRight" ? 1 : -1);
      return;
    }

    const run = this.action(event);
    if (run === null) return;
    event.preventDefault();
    event.stopPropagation();
    run();
  }

  /** The command a key runs here, or `null` when the key is not ours. */
  private action(event: KeyboardEvent): (() => void) | null {
    switch (event.key) {
      case "ArrowUp":
      case "k":
        return () => this.move(-1);
      case "ArrowDown":
      case "j":
        return () => this.move(1);
      case "Enter":
        return event.shiftKey ? () => void this.branchSelected() : () => void this.activate();
      case "n":
      case "N":
        return () => void this.branchSelected();
      case "t":
      case "T":
        return () => void this.startThread();
      case "c":
      case "C":
        return () => void this.continueSelected();
      case "Delete":
      case "Backspace":
        return () => this.armDelete();
      default:
        return null;
    }
  }

  /** Moves the selection, keeping focus and the drawn row together. */
  private move(delta: number): void {
    if (this.items.length === 0) return;
    const at = this.items.findIndex((item) => item.key === this.selectedKey);
    const next = Math.max(0, Math.min(this.items.length - 1, (at < 0 ? 0 : at) + delta));
    this.selectedKey = this.items[next]?.key ?? "";
    this.armedDelete = "";
    this.render();
    this.focusSelected();
  }

  /** Shows the next or previous section, wrapping. */
  private cycleTab(delta: number): void {
    const order: NavigatorSection[] = ["history", "realms", "portals"];
    const at = order.indexOf(this.section);
    this.section = order[(at + delta + order.length) % order.length] ?? "history";
    void this.load();
  }

  /** `⏎`: the selected row's one action. */
  private async activate(): Promise<void> {
    const item = this.selected();
    if (item === undefined) return;

    switch (item.kind) {
      case "row":
        await this.openRow(item.row);
        return;
      case "realm":
        await this.travel(item.contextId);
        return;
      case "offer":
        this.writeInto(item.occurrence.contextId);
        return;
      case "closed":
        return;
      case "record":
        await this.openRecord(item.path, item.row);
        return;
    }
  }

  /** Opens one row's thought, through the plugin's one travel boundary. */
  private async openRow(row: DailyRow): Promise<void> {
    const target = await this.refFor(row.path, row.n);
    if (target === null) {
      this.say("That thought is no longer in its note.");
      return;
    }
    this.close();
    if (!(await this.plugin.visitThought(target, false))) {
      this.plugin.log("navigator", `row ${row.path}#${row.n} was no longer there`);
    }
  }

  /** Travels to a Realm, which is the only thing a Realm row's Enter does. */
  private async travel(contextId: string): Promise<void> {
    this.close();
    await this.plugin.visitRealm(contextId);
  }

  /**
   * `Write here`: makes this Realm the draft's destination, without travelling.
   *
   * The move goes through the controller's proposal, so an unfinished draft is
   * never silently re-homed; with no words yet it applies at once.
   */
  private writeInto(contextId: string): void {
    this.close();
    this.plugin.openComposer({ contextId });
  }

  /** Follows a recorded opening to the entry it still truthfully names. */
  private async openRecord(path: string, row: PortalHistoryRow): Promise<void> {
    const source = await this.readNote(path);
    if (source === null) {
      this.say("That note could not be read.");
      return;
    }

    const index = parseEntries(source);
    const entry = linkedPortalEntry(row.record, index);
    if (entry === null) {
      this.say("That entry is no longer in its note.");
      return;
    }

    this.close();
    await this.plugin.visitThought(thoughtRefOf(index, entry, path), false);
  }

  /** `N` and `⇧⏎`: branch under the selected thought without writing anything. */
  private async branchSelected(): Promise<void> {
    const item = this.selected();
    if (item === undefined || item.kind !== "row") return;

    const target = await this.refFor(item.row.path, item.row.n);
    if (target === null) {
      this.say("That thought is no longer in its note.");
      return;
    }

    this.close();
    // `Branch` opens the draft under that parent; nothing is written until the
    // writer saves it, and no existing entry moves.
    await this.plugin.controller.branch(target);
    this.plugin.openComposer();
  }

  /** `C`: continue the selected thought's Thread, without travelling. */
  private async continueSelected(): Promise<void> {
    const item = this.selected();
    if (item === undefined || item.kind !== "row") return;

    const source = await this.readNote(item.row.path);
    if (source === null) return;
    const index = parseEntries(source);
    const entry = entryBySeq(index, item.row.n);
    if (entry === null) {
      this.say("That thought is no longer in its note.");
      return;
    }

    // Continuing a Thread opens its root: the branch is where it sits, but the
    // Thread is the whole subtree, and the composer reads it from there.
    const root = thoughtRefOf(index, rootEntryOf(index, entry), item.row.path);
    this.close();
    await this.plugin.controller.resumeThread(root);
    this.plugin.openComposer({ contextId: root.path === "" ? undefined : undefined });
  }

  /** `T`: a new Thread in the selected Realm, else the current one. */
  private async startThread(): Promise<void> {
    const item = this.selected();
    const contextId = item !== undefined && item.kind === "realm" ? item.contextId : undefined;
    this.close();
    this.plugin.openComposer(contextId === undefined ? {} : { contextId });
  }

  /** Arms the selected row's deletion; the second gesture confirms it. */
  private armDelete(): void {
    const item = this.selected();
    if (item === undefined || item.kind !== "row") return;
    if (this.armedDelete === item.key) {
      void this.removeRow(item.row);
      return;
    }
    this.armedDelete = item.key;
    this.render();
  }

  /** Removes the selected subtree, from the note that actually holds it. */
  private async removeRow(row: DailyRow): Promise<void> {
    const view = registeredEditorViews().find((candidate) => editorPathOf(candidate) === row.path);
    if (view === undefined) {
      this.say("Open that note to delete from it.");
      return;
    }

    const index = parseEntries(view.state.doc.toString());
    const entry = entryBySeq(index, row.n);
    if (entry === null) {
      this.say("That thought is no longer in its note.");
      return;
    }

    this.plugin.entries.deleteEntry(view, entry);
    this.armedDelete = "";
    await this.load();
  }

  /** The reference a row names, read from the note as it is now. */
  private async refFor(path: string, n: number): Promise<ThoughtRef | null> {
    const source = await this.readNote(path);
    if (source === null) return null;
    const index = parseEntries(source);
    const entry = entryBySeq(index, n);
    return entry === null ? null : thoughtRefOf(index, entry, path);
  }

  /** Says, in the card, why something could not happen. */
  private say(text: string): void {
    this.notice.textContent = text;
  }

  /** Draws the card, reconciling rather than rebuilding where it can. */
  private render(): void {
    if (this.destroyed || !this.opened) return;

    this.renderHeader();

    const signature = this.items.map((item) => item.key).join("|");
    if (signature !== this.signature) {
      this.signature = signature;
      this.list.textContent = "";
      for (const item of this.items) this.list.appendChild(this.renderItem(item));
    }
    // Selection and focus are applied after the rows exist, on every render: a
    // freshly built row must arrive already carrying the selection it joined.
    for (const item of this.items) this.updateItem(item);

    this.renderActions();

    if (this.loading) this.say("Reading the day…");
    else if (this.items.length === 0) this.say(this.emptyText());
    else if (this.log.errors.length > 0) this.say(this.log.errors[0]?.message ?? "");
    else if (this.armedDelete !== "") {
      this.say("Press Delete again to remove this subtree.");
    } else this.notice.textContent = "";
  }

  /** Tabs, filter and day, in the state the current selection implies. */
  private renderHeader(): void {
    for (const tab of Array.from(this.tabs.querySelectorAll("button"))) {
      const section = tab.getAttribute("data-section");
      const active = section === this.section;
      tab.setAttribute("aria-selected", String(active));
      tab.className = active ? "weaver-navigator-tab is-active" : "weaver-navigator-tab";
      tab.setAttribute("tabindex", active ? "0" : "-1");
    }

    const contexts = this.plugin.contexts();
    const names = new Map(contexts.map((context) => [context.id, context.name]));

    this.filter.textContent = "";
    const all = document.createElement("option");
    all.value = "all";
    all.textContent = "All Realms";
    this.filter.appendChild(all);
    for (const context of contexts) {
      const option = document.createElement("option");
      option.value = context.id;
      option.textContent = names.get(context.id) ?? context.id;
      this.filter.appendChild(option);
    }
    this.filter.value = this.filterBy;
    this.setVisible(this.filter, this.section === "history");

    this.dayInput.value = this.day;
    this.setVisible(this.dayInput, this.section === "history");
  }

  /** One row's element, built once per row key. */
  private renderItem(item: Item): HTMLElement {
    const row = document.createElement("div");
    row.className = "weaver-navigator-row";
    row.setAttribute("role", "option");
    row.setAttribute("data-key", item.key);
    row.addEventListener("click", () => this.select(item.key));

    switch (item.kind) {
      case "row":
        row.classList.add("weaver-navigator-entry");
        row.setAttribute("style", dimensionColorVars(item.row.d));
        row.appendChild(this.entryRow(item.row));
        return row;
      case "realm":
        row.classList.add("weaver-navigator-realm");
        row.appendChild(this.realmRow(item.contextId));
        return row;
      case "offer":
        row.classList.add("weaver-navigator-offer");
        row.appendChild(this.offerRow(item.occurrence, item.phase));
        return row;
      case "closed":
        row.classList.add("weaver-navigator-closed");
        row.appendChild(this.closedRow(item.occurrence));
        return row;
      case "record":
        row.classList.add("weaver-navigator-record");
        row.appendChild(this.recordRow(item.row));
        return row;
    }
  }

  /** Rewrites the text of a row that is still the same row. */
  private updateItem(item: Item): void {
    const row = this.list.querySelector<HTMLElement>(`[data-key="${cssEscape(item.key)}"]`);
    if (row === null) return;

    if (item.kind === "offer") {
      const state = row.querySelector<HTMLElement>(".weaver-navigator-offer-state");
      if (state !== null) state.textContent = offerState(item.occurrence, item.phase);
    }

    const selected = item.key === this.selectedKey;
    row.classList.toggle("is-selected", selected);
    row.setAttribute("aria-selected", String(selected));
    row.setAttribute("tabindex", selected ? "0" : "-1");
  }

  /** The entry row: its address, its moment, its words. */
  private entryRow(row: DailyRow): HTMLElement {
    const open = document.createElement("button");
    open.className = "weaver-navigator-open";
    open.setAttribute("type", "button");
    open.setAttribute("tabindex", "-1");
    open.addEventListener("click", (event: Event) => {
      event.stopPropagation();
      void this.openRow(row);
    });

    const dcn = document.createElement("span");
    dcn.className = "weaver-navigator-dcn";
    appendDigitRuns(dcn, `${row.b}.${row.d}.${row.n}`);
    open.appendChild(dcn);

    const time = document.createElement("span");
    time.className = "weaver-navigator-time";
    time.textContent = row.time ?? "—";
    open.appendChild(time);

    // One Realm's rows do not repeat its name: the filter already says it.
    if (this.filterBy === "all") {
      const tag = document.createElement("span");
      tag.className = "weaver-navigator-context-tag";
      tag.textContent = row.contextId === null ? "historical" : this.contextName(row.contextId);
      open.appendChild(tag);
    }

    const title = document.createElement("span");
    title.className = "weaver-navigator-title";
    title.textContent = row.whisper ?? row.excerpt;
    open.appendChild(title);
    return open;
  }

  /** The Realm row: its name, whether it is current, and its two acts. */
  private realmRow(contextId: string): HTMLElement {
    const name = this.contextName(contextId);
    const current = this.plugin.workspaces.viewing() === contextId;

    const body = document.createElement("div");
    body.className = "weaver-navigator-realm-body";

    const title = document.createElement("span");
    title.className = "weaver-navigator-realm-name";
    title.textContent = current ? `${name} · current` : name;
    body.appendChild(title);

    const travel = document.createElement("button");
    travel.className = "weaver-navigator-travel";
    travel.setAttribute("type", "button");
    travel.setAttribute("tabindex", "-1");
    travel.textContent = "Travel";
    travel.setAttribute("aria-label", `Travel to ${name}`);
    travel.addEventListener("click", (event: Event) => {
      event.stopPropagation();
      void this.travel(contextId);
    });
    body.appendChild(travel);

    const write = document.createElement("button");
    write.className = "weaver-navigator-weave";
    write.setAttribute("type", "button");
    write.setAttribute("tabindex", "-1");
    write.textContent = "Write here";
    write.setAttribute("aria-label", `Write a Thread into ${name} without travelling`);
    write.addEventListener("click", (event: Event) => {
      event.stopPropagation();
      this.writeInto(contextId);
    });
    body.appendChild(write);

    return body;
  }

  /** The offer row: where it writes, when it opens, and what is left. */
  private offerRow(occurrence: PortalOccurrence, phase: OfferedPhase): HTMLElement {
    const body = document.createElement("div");
    body.className = "weaver-navigator-offer-body";
    body.setAttribute("data-phase", phase);

    const opening = document.createElement("span");
    opening.className = "weaver-navigator-offer-opening";
    opening.textContent = `${pad2(occurrence.portal.hour)}:${pad2(occurrence.portal.minute)}`;
    body.appendChild(opening);

    const realm = document.createElement("span");
    realm.className = "weaver-navigator-context-tag";
    realm.textContent = this.contextName(occurrence.contextId);
    body.appendChild(realm);

    const state = document.createElement("span");
    state.className = "weaver-navigator-offer-state";
    state.textContent = offerState(occurrence, phase);
    body.appendChild(state);

    const write = document.createElement("button");
    write.className = "weaver-navigator-weave";
    write.setAttribute("type", "button");
    write.setAttribute("tabindex", "-1");
    write.textContent = "Write";
    write.setAttribute("aria-label", `Write a Thread through the ${pad2(occurrence.portal.hour)}:${pad2(occurrence.portal.minute)} opening`);
    write.addEventListener("click", (event: Event) => {
      event.stopPropagation();
      this.writeInto(occurrence.contextId);
    });
    body.appendChild(write);

    return body;
  }

  /** The closed row: what happened, with nothing to press. */
  private closedRow(occurrence: PortalOccurrence): HTMLElement {
    const body = document.createElement("div");
    body.className = "weaver-navigator-offer-body";

    const opening = document.createElement("span");
    opening.className = "weaver-navigator-offer-opening";
    opening.textContent = `${pad2(occurrence.portal.hour)}:${pad2(occurrence.portal.minute)}`;
    body.appendChild(opening);

    const realm = document.createElement("span");
    realm.className = "weaver-navigator-context-tag";
    realm.textContent = this.contextName(occurrence.contextId);
    body.appendChild(realm);

    const state = document.createElement("span");
    state.className = "weaver-navigator-offer-state";
    state.textContent = "closed";
    body.appendChild(state);

    return body;
  }

  /** The recorded row: the opening, the moment it began, and the entry the note holds. */
  private recordRow(row: PortalHistoryRow): HTMLElement {
    const open = document.createElement("button");
    open.className = "weaver-navigator-open";
    open.setAttribute("type", "button");
    open.setAttribute("tabindex", "-1");
    open.disabled = row.entry === null;
    open.setAttribute("aria-label", row.entry === null ? "Entry unavailable" : row.label);

    const opening = document.createElement("span");
    opening.className = "weaver-navigator-offer-opening";
    opening.textContent = `${pad2(row.portal.hour)}:${pad2(row.portal.minute)}`;
    open.appendChild(opening);

    const label = document.createElement("span");
    label.className = "weaver-navigator-portal-label";
    label.textContent = row.entry === null ? "Entry unavailable" : row.label;
    open.appendChild(label);

    const moment = document.createElement("span");
    moment.className = "weaver-navigator-portal-moment";
    moment.textContent = momentText(row.record.began);
    open.appendChild(moment);

    return open;
  }

  /** The actions that belong to the selected row, and nothing else. */
  private renderActions(): void {
    this.actions.textContent = "";
    const item = this.selected();
    if (item === undefined) return;

    if (item.kind === "row") {
      this.actions.appendChild(this.actionButton("Open", () => void this.openRow(item.row)));
      this.actions.appendChild(
        this.actionButton("Continue Thread", () => void this.continueSelected())
      );
      this.actions.appendChild(this.actionButton("Branch", () => void this.branchSelected()));
      this.actions.appendChild(
        this.actionButton(this.armedDelete === item.key ? "Delete again" : "Delete", () => this.armDelete(), "quiet")
      );
      return;
    }

    if (item.kind === "realm") {
      this.actions.appendChild(this.actionButton("Travel", () => void this.travel(item.contextId)));
      this.actions.appendChild(this.actionButton("Write here", () => this.writeInto(item.contextId)));
      return;
    }

    if (item.kind === "offer") {
      this.actions.appendChild(this.actionButton("Write", () => this.writeInto(item.occurrence.contextId)));
      return;
    }

    if (item.kind === "record") {
      this.actions.appendChild(
        this.actionButton("Open", () => void this.openRecord(item.path, item.row))
      );
    }
  }

  /** One action button. */
  private actionButton(label: string, run: () => void, className = ""): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = className === "" ? "weaver-navigator-action" : `weaver-navigator-action ${className}`;
    button.setAttribute("type", "button");
    button.textContent = label;
    button.addEventListener("click", run);
    return button;
  }

  /** Selects a row without acting on it. */
  private select(key: string): void {
    this.selectedKey = key;
    this.armedDelete = "";
    this.render();
    this.focusSelected();
  }

  /** Puts focus on the selected row, when focus is inside the card already. */
  private focusSelected(): void {
    if (!this.opened) return;
    // The owner document is the host's, when the element knows it.
    const owner = (this.root as { ownerDocument?: Document }).ownerDocument;
    const focused = owner?.activeElement ?? null;
    const inside = focused !== null && this.card.contains(focused);
    if (!inside && focused !== this.card) return;

    const row = this.list.querySelector<HTMLElement>(`[data-key="${cssEscape(this.selectedKey)}"]`);
    row?.focus();
  }

  /** What an empty section means. */
  private emptyText(): string {
    if (this.section === "history") return "No Threads for this day.";
    if (this.section === "realms") return "No Realms are configured.";
    return "No openings are live, and none were recorded here.";
  }

  /** One Realm's display name. */
  private contextName(contextId: string): string {
    return this.plugin.contexts().find((context) => context.id === contextId)?.name ?? contextId;
  }

  private setVisible(element: HTMLElement, visible: boolean): void {
    if (visible) element.removeAttribute("hidden");
    else element.setAttribute("hidden", "");
  }
}

/** The two states an opening can be in and still be entered. */
type OfferedPhase = "approaching" | "available";

/** `opens in 06:05`, or `open · 00:39 left`. */
function offerState(occurrence: PortalOccurrence, phase: OfferedPhase): string {
  const now = Date.now();
  if (phase === "approaching") {
    return `opens in ${countdown(occurrence.portal.opensAt - now)}`;
  }
  return `open · ${countdown(occurrence.portal.opensAt + 60_000 - now)} left`;
}

/** Whole minutes and seconds, floored. */
function countdown(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(seconds / 60))}:${pad2(seconds % 60)}`;
}

/** `22:55:00 -08:00` — the actual moment, with the offset it happened at. */
function momentText(began: string): string {
  const match = /T(\d{2}:\d{2}:\d{2})([+-]\d{2}:\d{2})$/.exec(began);
  return match === null ? began : `${match[1]} ${match[2]}`;
}

/** `YYYY-MM-DD` for today, in the local calendar. */
function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** True when the key was pressed where text or a picker owns it. */
function isEditable(target: unknown): boolean {
  const tag = tagNameOf(target);
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (!isPlainObject(target)) return false;
  return Reflect.get(target, "isContentEditable") === true;
}

/** The lower-cased tag name of an event target, or the empty string. */
function tagNameOf(target: unknown): string {
  if (!isPlainObject(target) || !("tagName" in target)) return "";
  const tag = target["tagName"];
  return typeof tag === "string" ? tag.toLowerCase() : "";
}

/** A plain object, narrowed without a cast. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A key escaped for use in a selector, when the host has no `CSS.escape`. */
function cssEscape(value: string): string {
  const host = globalThis as unknown as { CSS?: { escape?: (text: string) => string } };
  if (typeof host.CSS?.escape === "function") return host.CSS.escape(value);
  return value.replace(/["\\\]]/g, "\\$&");
}
