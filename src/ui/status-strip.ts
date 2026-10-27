/**
 * The strip: one line above the editor that answers "what is this note, and
 * what is unfinished".
 *
 * It is a reading, so it writes nothing. It never scrolls with the text, and it
 * is never a modal — clicking it opens the Tapestry at the matching scope.
 */

import { MarkdownView, debounce } from "obsidian";

import { dayKey, resolveDayNote } from "../core/day-note";
import { countUntitled } from "../core/day-counters";
import { buildAncestors, findCurrentHeading, parseHeadings, type Heading, type HeadingIndex } from "../core/headings";
import { parseMarks } from "../core/marks";
import { dimensionLabel } from "../core/vocabulary";
import type WeaverPlugin from "../main";
import { dayLabel } from "./calendar";
import { isPhone } from "./platform";

export interface StripState {
  kind: "day" | "note" | "none";
  /** Already formatted, so no test depends on the machine's locale. */
  dateLabel: string;
  noteLabel: string;
  /** Ancestor chain plus the current dimension, outermost first, e.g. ["1D Breaking Free", "2D Why now"]. */
  chain: string[];
  drafts: number;
  untitled: number;
  closedAt: string | null;
  /**
   * Whether the note has recorded anything at all. The chain is empty whenever
   * the caret sits above the first dimension, so this is what separates a day
   * that recorded nothing from a day whose caret is simply at the top.
   */
  hasMarks: boolean;
}

const STRIP_DEBOUNCE_MS = 300;

/** The chain separator: one glyph, one meaning, in both strip forms. */
const CHAIN_SEPARATOR = " ▸ ";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The clock without seconds: the strip is a summary, not a log. */
function shortClock(time: string | null): string | null {
  return time === null ? null : time.slice(0, 5);
}

/** `1D Breaking Free`; an empty title still names its place in the note. */
function segmentOf(heading: Heading): string {
  const title = heading.title.trim();
  return `${dimensionLabel(heading.level)} ${title === "" ? "Untitled" : title}`;
}

/** The chain from the outermost ancestor to the dimension the caret sits in. */
export function chainOf(index: HeadingIndex, caretLine: number): string[] {
  const current = findCurrentHeading(index, caretLine);
  if (current === null) return [];
  return [...buildAncestors(index, current), current].map(segmentOf);
}

/** The flags that follow the chain, in order, each only when it is set. */
function flagsOf(state: StripState): string[] {
  const flags: string[] = [];
  if (state.untitled > 0) flags.push(plural(state.untitled, "untitled", "untitled"));
  if (state.drafts > 0) flags.push(plural(state.drafts, "draft", "drafts"));
  const closed = shortClock(state.closedAt);
  if (closed !== null) flags.push(`closed ${closed}`);
  return flags;
}

/** What to name when the caret is above the note's first dimension. */
function labelOf(state: StripState): string {
  if (state.kind === "note") return state.noteLabel;
  return state.hasMarks ? state.dateLabel : `${state.dateLabel} · no marks yet`;
}

/** The exact text the strip shows; pure, so it is testable without a note. */
export function stripText(state: StripState): string {
  if (state.kind === "none") return "";

  const flags = flagsOf(state);
  const chain = state.chain.join(CHAIN_SEPARATOR);
  if (chain !== "") return [chain, ...flags].join(" · ");
  return [labelOf(state), ...flags].join(" · ");
}

/**
 * The phone form: the same reading, squeezed to one short line. The innermost
 * segment survives because it is the one the caret is in.
 */
export function phoneStripText(state: StripState): string {
  if (state.kind === "none") return "";

  const flags = flagsOf(state);
  const head = state.chain[state.chain.length - 1] ?? labelOf(state);
  return [head, ...flags].join(" · ");
}

/** Owns the strip element and keeps it attached to the active note. */
export class StatusStrip {
  private element: HTMLElement | null = null;
  private view: MarkdownView | null = null;
  private state: StripState = {
    kind: "none",
    dateLabel: "",
    noteLabel: "",
    chain: [],
    drafts: 0,
    untitled: 0,
    closedAt: null,
    hasMarks: false
  };
  private readonly scheduleUpdate = debounce(() => {
    void this.update();
  }, STRIP_DEBOUNCE_MS);

  constructor(private readonly plugin: WeaverPlugin) {}

  /** Follows the active leaf: one strip, on the note being looked at. */
  start(): void {
    const workspace = this.plugin.app.workspace;
    this.plugin.registerEvent(workspace.on("active-leaf-change", () => this.follow()));
    this.plugin.registerEvent(workspace.on("editor-change", () => this.scheduleUpdate()));
    this.plugin.registerEvent(this.plugin.app.vault.on("modify", () => this.scheduleUpdate()));
    this.follow();
  }

  /** Attaches to the active Markdown view, or hides when there is none. */
  follow(): void {
    const view = this.plugin.activeMarkdownView();
    if (view === null) {
      this.detach();
      return;
    }
    if (view !== this.view) this.attach(view);
    this.scheduleUpdate();
  }

  attach(view: MarkdownView): void {
    this.detach();
    this.view = view;

    const strip = view.containerEl.createDiv({ cls: "weaver-strip" });
    strip.setAttr("contenteditable", "false");
    view.containerEl.addClass("weaver-strip-host");
    // Before `.view-content`, so the line sits above the text and never moves
    // with it.
    if (view.contentEl.parentElement === view.containerEl) {
      view.containerEl.insertBefore(strip, view.contentEl);
    }

    strip.addEventListener("click", () => {
      this.plugin.openTapestry(this.state.kind === "day" ? "day" : "note");
    });
    this.element = strip;
  }

  detach(): void {
    this.element?.remove();
    this.element = null;
    this.view?.containerEl.removeClass("weaver-strip-host");
    this.view = null;
  }

  /** Re-reads the active note and re-renders the line. */
  async update(): Promise<void> {
    const view = this.plugin.activeMarkdownView();
    if (view === null || view.file === null || view !== this.view) {
      this.detach();
      return;
    }

    this.state = await this.readState(view);
    const element = this.element;
    if (element === null) return;

    if (this.state.kind === "none") {
      element.addClass("is-hidden");
      element.setText("");
      return;
    }

    const text = isPhone() ? phoneStripText(this.state) : stripText(this.state);
    element.removeClass("is-hidden");
    element.setText(text);
    element.setAttr("aria-label", `Weaver strip: ${text}`);
    element.toggleClass("weaver-strip-day", this.state.kind === "day");
    element.toggleClass("weaver-strip-note", this.state.kind === "note");
  }

  destroy(): void {
    this.detach();
  }

  private async readState(view: MarkdownView): Promise<StripState> {
    const file = view.file;
    if (file === null) {
      return {
        kind: "none",
        dateLabel: "",
        noteLabel: "",
        chain: [],
        drafts: 0,
        untitled: 0,
        closedAt: null,
        hasMarks: false
      };
    }

    const now = new Date();
    const app = this.plugin.app;
    const source = await app.vault.cachedRead(file);
    const index = parseHeadings(source, { maxDepth: this.plugin.settings.maxDepth });
    // Reading view has no caret, so the strip names the note rather than a place.
    const caretLine = view.getMode() === "source" ? view.editor.getCursor().line : 0;

    const day = resolveDayNote(app, this.plugin.settings, now);
    const base: StripState = {
      kind: day.file !== null && day.file.path === file.path ? "day" : "note",
      dateLabel: dayLabel(dayKey(now)),
      noteLabel: file.basename,
      chain: chainOf(index, caretLine),
      drafts: index.drafts.length,
      untitled: countUntitled(index),
      closedAt: null,
      hasMarks: index.headings.length > 0
    };

    if (base.kind === "note") return base;
    return { ...base, closedAt: parseMarks(source).closedAt };
  }
}
