/**
 * One renderer for the Tapestry, in two modes.
 *
 * The pointer mode adds the keyboard model: list cursors, filters, `Tab` between
 * the note's two lists. The touch mode renders the same sections in the same
 * order with the same words, and every row is a tap target. Nothing here reads
 * or writes a file — the caller supplies the state.
 */

import { draftElapsed } from "../core/drafts";
import type { DayCounts } from "../core/day-counters";
import type { Heading } from "../core/headings";
import type { ThreadRow } from "../core/threads";
import { dimensionLabel } from "../core/vocabulary";
import type { DraftEntry } from "../drafts/vault-index";
import type { SparkTarget } from "../settings";
import { groupDraftsByFile } from "../drafts/vault-index";
import { dayLabel, renderCalendar, type CalendarDay } from "./calendar";
import { renderDimensionList } from "./dimension-list";
import type { CursorSection } from "./tapestry-cursor";
import type { DayRow, Scope } from "./tapestry-data";

export type TapestryMode = "pointer" | "touch";

const BODY_SNIPPET_LENGTH = 80;
const SCOPE_LABELS: Record<Scope, string> = {
  note: "Note",
  day: "Day",
  month: "Month",
  all: "All"
};

export interface TapestryState {
  scope: Scope;
  counts: DayCounts;
  /** Every thread today, for the empty message. */
  threads: ThreadRow[];
  dimensions: Heading[];
  drafts: DraftEntry[];
  days: DayRow[];
  weeks: CalendarDay[][];
  /** The filters applied to each list. */
  queries: Record<CursorSection, string>;
  /** The cursor each list is on. */
  selection: Record<CursorSection, number>;
  /** The rows each list shows after filtering. */
  visibleThreads: ThreadRow[];
  visibleDimensions: Heading[];
  visibleDrafts: DraftEntry[];
  noteLabel: string;
  countText: string;
  sparkTarget: SparkTarget;
  draftsLoaded: boolean;
  hasDayNote: boolean;
  /** 1D dimensions with no title yet: unfinished, never repaired. */
  untitled: number;
  /** Sources loaded into the shuttle and not yet woven in. */
  loadedSources: number;
  /** Path of the note being looked at, so its draft group is marked. */
  activePath: string | null;
  rail: { indentMaxLevel: number };
}

export interface TapestryHandlers {
  onScope(scope: Scope): void;
  onThread(row: ThreadRow): void;
  onDimension(heading: Heading): void;
  onDraft(entry: DraftEntry): void;
  onDay(row: DayRow): void;
  onQuery(section: CursorSection, value: string): void;
  onListKey(section: CursorSection, event: KeyboardEvent): void;
  onFilterKey(section: CursorSection, event: KeyboardEvent): void;
  onSparkTarget(): void;
  onRefresh(): void;
  onCloseDay(): void;
  /** Lead to the first untitled 1D in the day note. */
  onUntitled(): void;
  /** Open the shuttle, where the loaded sources already are. */
  onShuttle(): void;
}

/** Renders the whole scope. The caller re-renders on every state change. */
export function renderTapestry(
  container: HTMLElement,
  state: TapestryState,
  handlers: TapestryHandlers,
  mode: TapestryMode
): void {
  container.empty();
  container.addClass("weaver-panel");
  container.addClass("weaver-tapestry");
  if (mode === "touch") container.addClass("weaver-tapestry-touch");

  renderHeader(container, state, handlers);

  // One grid, one wrapping rule: two columns at width, one in a narrow window,
  // with no measurement code.
  const grid = container.createDiv({ cls: "weaver-tapestry-grid" });
  if (state.scope === "note") renderNoteScope(grid, state, handlers, mode);
  if (state.scope === "day") renderDayScope(grid, state, handlers, mode);
  if (state.scope === "month" || state.scope === "all") {
    renderTotalsScope(grid, state, handlers, mode);
  }
}

function renderHeader(
  container: HTMLElement,
  state: TapestryState,
  handlers: TapestryHandlers
): void {
  const header = container.createDiv({ cls: "weaver-panel-header" });

  const chips = header.createDiv({ cls: "weaver-tapestry-scopes" });
  chips.setAttr("role", "tablist");
  chips.setAttr("aria-label", "Tapestry scope");
  for (const scope of ["note", "day", "month", "all"] as const) {
    const active = scope === state.scope;
    const chip = chips.createEl("button", {
      cls: `weaver-tapestry-scope${active ? " is-active" : ""}`,
      text: SCOPE_LABELS[scope]
    });
    chip.setAttr("data-scope", scope);
    chip.setAttr("role", "tab");
    chip.setAttr("aria-selected", active ? "true" : "false");
    chip.addEventListener("click", () => handlers.onScope(scope));
  }

  const target = header.createEl("button", {
    cls: "weaver-tapestry-target",
    text: state.sparkTarget === "today" ? "Spark: Today" : "Spark: This note"
  });
  target.setAttr("aria-label", "Spark target");
  target.addEventListener("click", () => handlers.onSparkTarget());

  header.createSpan({ cls: "weaver-panel-count", text: state.countText });

  const refresh = header.createEl("button", { cls: "weaver-panel-refresh", text: "↻" });
  refresh.setAttr("aria-label", "Refresh the Tapestry");
  refresh.addEventListener("click", () => handlers.onRefresh());
}

function sectionBox(container: HTMLElement, title: string): { section: HTMLElement; head: HTMLElement } {
  const element = container.createEl("section", { cls: "weaver-panel-section" });
  const head = element.createDiv({ cls: "weaver-panel-section-head" });
  head.createSpan({ cls: "weaver-panel-section-title", text: title });
  return { section: element, head };
}

function filterInput(
  head: HTMLElement,
  section: CursorSection,
  placeholder: string,
  state: TapestryState,
  handlers: TapestryHandlers,
  mode: TapestryMode
): void {
  if (mode === "touch") return;

  const input = head.createEl("input", {
    cls: "weaver-panel-filter",
    type: "search",
    placeholder,
    value: state.queries[section]
  });
  input.setAttr("aria-label", placeholder);
  input.setAttr("data-section", section);
  input.addEventListener("input", () => handlers.onQuery(section, input.value));
  input.addEventListener("keydown", (event) => handlers.onFilterKey(section, event));
}

function listBox(
  container: HTMLElement,
  section: CursorSection,
  label: string,
  mode: TapestryMode,
  handlers: TapestryHandlers
): HTMLElement {
  const list = container.createDiv({ cls: listClass(section) });
  list.setAttr("data-list-section", section);
  if (mode === "touch") return list;

  list.setAttr("tabindex", "0");
  list.setAttr("role", "listbox");
  list.setAttr("aria-label", label);
  list.addEventListener("keydown", (event) => handlers.onListKey(section, event));
  list.addEventListener("focusin", () => {
    for (const other of Array.from(container.querySelectorAll<HTMLElement>("[data-list-section]"))) {
      if (other !== list) other.removeClass("is-focused");
    }
    list.addClass("is-focused");
  });
  list.addEventListener("focusout", (event) => {
    const next = event.relatedTarget;
    if (next instanceof Node && list.contains(next)) return;
    list.removeClass("is-focused");
  });
  return list;
}

function listClass(section: CursorSection): string {
  if (section === "drafts") return "weaver-panel-groups";
  return section === "headings" ? "weaver-panel-dimensions" : "weaver-threads";
}

function renderNoteScope(
  container: HTMLElement,
  state: TapestryState,
  handlers: TapestryHandlers,
  mode: TapestryMode
): void {
  const drafts = sectionBox(container, "Drafts");
  filterInput(drafts.head, "drafts", "Filter drafts", state, handlers, mode);
  const draftList = listBox(drafts.section, "drafts", "Open drafts", mode, handlers);
  renderDrafts(draftList, state.visibleDrafts, state, handlers);

  const note = sectionBox(container, "This note");
  const noteEl = note.head.createSpan({ cls: "weaver-panel-note", text: state.noteLabel });
  noteEl.setText(state.noteLabel);
  filterInput(note.head, "headings", "Filter dimensions", state, handlers, mode);
  const headingList = listBox(note.section, "headings", "Dimensions in this note", mode, handlers);
  renderDimensions(headingList, state, handlers);

  const census = sectionBox(container, "Census");
  renderCensus(census.section, state);
}

function renderDayScope(
  container: HTMLElement,
  state: TapestryState,
  handlers: TapestryHandlers,
  mode: TapestryMode
): void {
  const threads = sectionBox(container, "Threads");
  const noteEl = threads.head.createSpan({ cls: "weaver-panel-note", text: state.noteLabel });
  noteEl.setText(state.noteLabel);
  filterInput(threads.head, "threads", "Filter threads", state, handlers, mode);
  const threadList = listBox(threads.section, "threads", "Threads today", mode, handlers);
  renderThreads(threadList, state, handlers);

  const census = sectionBox(container, "Census");
  renderCensus(census.section, state);

  const review = sectionBox(container, "Review");
  renderReview(review.section, state, handlers);

  const drafts = sectionBox(container, "Drafts");
  filterInput(drafts.head, "drafts", "Filter drafts", state, handlers, mode);
  const draftList = listBox(drafts.section, "drafts", "Open drafts", mode, handlers);
  renderDrafts(draftList, state.visibleDrafts, state, handlers);
}

function renderTotalsScope(
  container: HTMLElement,
  state: TapestryState,
  handlers: TapestryHandlers,
  mode: TapestryMode
): void {
  const census = sectionBox(container, "Census");
  renderCensus(census.section, state);

  const days = sectionBox(container, "Days");
  const list = days.section.createDiv({ cls: "weaver-day-list" });
  renderDays(list, state, mode, handlers);

  const calendar = sectionBox(container, "Calendar");
  const host = calendar.section.createDiv({ cls: "weaver-cal-host" });
  renderCalendar(host, state.weeks, (key) => {
    const row = state.days.find((day) => day.key === key);
    if (row !== undefined) handlers.onDay(row);
  });

  if (state.scope !== "all") return;
  const horizon = sectionBox(container, "Past horizon");
  renderHorizon(horizon.section, state);
}

function renderDrafts(
  container: HTMLElement,
  visible: DraftEntry[],
  state: TapestryState,
  handlers: TapestryHandlers
): void {
  if (!state.draftsLoaded) {
    container.createDiv({ cls: "weaver-panel-empty", text: "Loading drafts…" });
    return;
  }

  if (state.drafts.length === 0) {
    container.createDiv({ cls: "weaver-panel-empty", text: "No open drafts." });
    return;
  }

  if (visible.length === 0) {
    container.createDiv({ cls: "weaver-panel-empty", text: "No drafts match." });
    return;
  }

  const now = new Date();
  let position = 0;

  for (const group of groupDraftsByFile(visible)) {
    const block = container.createDiv({
      cls: `weaver-panel-group${group.file.path === state.activePath ? " is-current-note" : ""}`
    });

    const fileRow = block.createDiv({ cls: "weaver-panel-file" });
    fileRow.createSpan({ text: group.file.basename });
    fileRow.createSpan({ cls: "weaver-panel-file-count", text: String(group.entries.length) });

    for (const entry of group.entries) {
      const index = position;
      position += 1;
      const selected = index === state.selection.drafts;

      const row = block.createEl("button", {
        cls: `weaver-draft-result${selected ? " is-selected" : ""}`
      });
      row.setAttr("data-draft-id", entry.draft.id);
      row.setAttr("data-opened-at", entry.draft.openedAt);
      row.setAttr("data-path", group.file.path);
      row.setAttr("role", "option");
      row.setAttr("aria-selected", selected ? "true" : "false");
      row.setAttr("tabindex", "-1");

      const head = row.createDiv({ cls: "weaver-draft-result-head" });
      head.createSpan({ cls: "weaver-draft-result-id", text: `draft ${entry.draft.id}` });
      const title = entry.draft.title.trim();
      head.createSpan({
        cls: "weaver-draft-result-title",
        text: title === "" ? "(untitled draft)" : title
      });
      head.createSpan({
        cls: "weaver-draft-result-elapsed",
        text: draftElapsed(entry.draft, now)
      });

      if (entry.draft.body !== "") {
        row.createDiv({
          cls: "weaver-draft-result-body",
          text: entry.draft.body.slice(0, BODY_SNIPPET_LENGTH)
        });
      }

      row.addEventListener("click", () => handlers.onDraft(entry));
    }
  }

}

function renderDimensions(
  container: HTMLElement,
  state: TapestryState,
  handlers: TapestryHandlers
): void {
  const visible = state.visibleDimensions;
  if (visible.length === 0) {
    container.createDiv({
      cls: "weaver-panel-empty",
      text: state.dimensions.length === 0 ? "No dimensions in this note." : "No dimensions match."
    });
    return;
  }

  const selected = visible[state.selection.headings] ?? null;
  renderDimensionList(container, visible, state.rail, (heading) => handlers.onDimension(heading), selected?.line ?? null);

  // `renderDimensionList` sets no role or tabindex, so rows stay out of the Tab
  // order and the container keeps owning the cursor.
  for (const row of Array.from(container.querySelectorAll<HTMLElement>("button"))) {
    row.setAttr("tabindex", "-1");
    row.setAttr("role", "option");
    row.setAttr(
      "aria-selected",
      selected !== null && String(selected.line) === row.getAttr("data-line") ? "true" : "false"
    );
  }

}

function renderThreads(
  container: HTMLElement,
  state: TapestryState,
  handlers: TapestryHandlers
): void {
  const visible = state.visibleThreads;
  if (visible.length === 0) {
    container.createDiv({
      cls: "weaver-panel-empty",
      text: state.threads.length === 0 ? "No threads today." : "No threads match."
    });
    return;
  }

  visible.forEach((thread, index) => {
    const selected = index === state.selection.threads;
    const row = container.createEl("button", {
      cls: `weaver-thread${selected ? " is-selected" : ""}`
    });
    row.setAttr("data-line", String(thread.heading.line));
    row.setAttr("role", "option");
    row.setAttr("aria-selected", selected ? "true" : "false");
    row.setAttr("tabindex", "-1");

    row.createSpan({ cls: "weaver-thread-level", text: dimensionLabel(thread.heading.level) });
    row.createSpan({ cls: "weaver-thread-time", text: thread.heading.time ?? "" });
    row.createSpan({
      cls: "weaver-thread-title",
      text: thread.heading.title.trim() || thread.heading.text.trim()
    });
    if (thread.hasSource) row.createSpan({ cls: "weaver-thread-mark", text: "✦" });
    row.createSpan({ cls: "weaver-thread-count", text: String(thread.children) });

    row.addEventListener("click", () => handlers.onThread(thread));
  });

}

function renderCensus(container: HTMLElement, state: TapestryState): void {
  const list = container.createDiv({ cls: "weaver-census" });

  for (const [level, count] of censusLevels(state)) {
    const row = list.createDiv({ cls: "weaver-census-row" });
    row.createSpan({ cls: "weaver-census-level", text: dimensionLabel(level) });
    row.createSpan({ cls: "weaver-census-count", text: String(count) });
  }

  const total = list.createDiv({ cls: "weaver-census-row weaver-census-total" });
  total.createSpan({ cls: "weaver-census-level", text: "total" });
  total.createSpan({
    cls: "weaver-census-count",
    text: String(censusLevels(state).reduce((sum, [, count]) => sum + count, 0))
  });
}

/** Per level where a file was parsed; the day totals where only counters were read. */
export function censusLevels(state: TapestryState): Array<[number, number]> {
  if (state.scope === "month" || state.scope === "all") {
    const sparks = state.counts.sparks;
    const rest = state.counts.dimensions - sparks;
    return rest > 0 ? [[1, sparks], [2, rest]] : [[1, sparks]];
  }

  const counts = new Map<number, number>();
  for (const heading of state.dimensions) {
    counts.set(heading.level, (counts.get(heading.level) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => left[0] - right[0]);
}

/**
 * What is unfinished, in the order the writer works through it. Every pending
 * row is a button that lands somewhere; the day's own marks are plain rows, so
 * the difference between "waiting for you" and "recorded" is visible.
 */
function renderReview(
  container: HTMLElement,
  state: TapestryState,
  handlers: TapestryHandlers
): void {
  const list = container.createDiv({ cls: "weaver-review" });
  const pending: Array<{ text: string; run: () => void }> = [];

  if (state.visibleDrafts.length > 0) {
    const count = state.visibleDrafts.length;
    pending.push({
      text: `${count} ${count === 1 ? "draft" : "drafts"}, unwoven`,
      run: () => handlers.onScope("note")
    });
  }

  if (state.loadedSources > 0) {
    pending.push({
      text: `${state.loadedSources} loaded, not yet woven`,
      run: () => handlers.onShuttle()
    });
  }

  if (state.untitled > 0) {
    pending.push({
      text: `${state.untitled} ${state.untitled === 1 ? "spark" : "sparks"} untitled`,
      run: () => handlers.onUntitled()
    });
  }

  if (pending.length === 0) {
    list.createDiv({ cls: "weaver-review-row", text: "Nothing pending." });
  }
  for (const row of pending) {
    const button = list.createEl("button", { cls: "weaver-review-row", text: row.text });
    button.addEventListener("click", row.run);
  }

  list.createDiv({
    cls: "weaver-review-row",
    text: state.counts.lastMark === null ? "last mark —" : `last mark ${state.counts.lastMark.slice(0, 5)}`
  });
  if (state.counts.closedAt !== null) {
    list.createDiv({
      cls: "weaver-review-row",
      text: `closed ${state.counts.closedAt.slice(0, 5)}`
    });
  }

  const close = container.createEl("button", { cls: "weaver-review-close" });
  if (state.counts.closedAt === null) {
    close.setText(state.hasDayNote ? "Close the day" : "Create today's note");
    close.addEventListener("click", () => handlers.onCloseDay());
    return;
  }
  close.setText("Day closed");
  close.disabled = true;
}

function renderDays(
  container: HTMLElement,
  state: TapestryState,
  mode: TapestryMode,
  handlers: TapestryHandlers
): void {
  if (state.days.length === 0) {
    container.createDiv({ cls: "weaver-panel-empty", text: "No days recorded yet." });
    return;
  }

  for (const day of state.days) {
    const row = container.createEl("button", { cls: "weaver-day-row" });
    row.createSpan({ cls: "weaver-day-label", text: dayLabel(day.key) });
    row.createSpan({
      cls: "weaver-day-count",
      text: day.count === 1 ? "1 spark" : `${day.count} sparks`
    });
    if (mode === "pointer") row.setAttr("tabindex", "0");
    row.addEventListener("click", () => handlers.onDay(day));
  }
}

function renderHorizon(container: HTMLElement, state: TapestryState): void {
  const list = container.createDiv({ cls: "weaver-horizon" });
  const months = new Map<string, { days: number; sparks: number }>();

  for (const day of state.days) {
    const month = day.key.slice(0, 7);
    const entry = months.get(month) ?? { days: 0, sparks: 0 };
    entry.days += 1;
    entry.sparks += day.count;
    months.set(month, entry);
  }

  if (months.size === 0) {
    list.createDiv({ cls: "weaver-panel-empty", text: "No months recorded yet." });
    return;
  }

  for (const [month, entry] of [...months.entries()].sort((left, right) =>
    right[0].localeCompare(left[0])
  )) {
    const row = list.createDiv({ cls: "weaver-horizon-row" });
    row.createSpan({ cls: "weaver-horizon-month", text: month });
    row.createSpan({
      cls: "weaver-horizon-count",
      text: `${entry.days} ${entry.days === 1 ? "day" : "days"} · ${entry.sparks} ${
        entry.sparks === 1 ? "spark" : "sparks"
      }`
    });
  }
}

/** The header's count, in the same words on both surfaces. */
export function countLabel(
  scope: Scope,
  visibleDrafts: DraftEntry[],
  draftsLoaded: boolean,
  days: DayRow[]
): string {
  if (scope !== "note" && scope !== "day") {
    return `${days.length} ${days.length === 1 ? "day" : "days"}`;
  }
  if (!draftsLoaded) return "Loading drafts…";
  if (visibleDrafts.length === 0) return "No open drafts";

  const notes = new Set(visibleDrafts.map((entry) => entry.file.path)).size;
  return `${visibleDrafts.length} ${visibleDrafts.length === 1 ? "draft" : "drafts"} in ${notes} ${
    notes === 1 ? "note" : "notes"
  }`;
}
