/**
 * One persistent Markdown surface, rich while editing and natively rendered while
 * reading.
 *
 * The pane owns exactly one CodeMirror 6 view for its whole life. Editing shows
 * that view with Markdown formatting applied in place — headings, emphasis,
 * strong text, inline code, links, quotes and lists are styled while their source
 * marks stay honest, and the line the caret is on always reveals its own syntax,
 * the way live preview does. Read-only presentation replaces the visible body
 * with real HTML rendered by Obsidian's `MarkdownRenderer`, so links resolve
 * against the pane's source path, tables become tables, and text can be selected
 * and copied naturally.
 *
 * The editor is never thrown away to switch modes. Hiding it keeps its document,
 * history, selection and DOM identity intact, which is what lets a saved thought
 * become read-only and then be branched from without losing undo.
 *
 * The pane is deliberately a leaf: it never writes a note, never opens an editor
 * for a file and never reaches into Obsidian's file or view machinery. Typing is
 * reported to the caller through `onChange`; saving is the caller's decision.
 */

import {
  defaultKeymap,
  history,
  historyKeymap,
  insertNewlineAndIndent
} from "@codemirror/commands";
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  Transaction,
  type Extension,
  type Range,
  type Text
} from "@codemirror/state";
import {
  drawSelection,
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  placeholder,
  type DecorationSet,
  type ViewUpdate
} from "@codemirror/view";
import { GFM, parser } from "@lezer/markdown";
import { Component, Keymap, MarkdownRenderer, Notice, type App } from "obsidian";

import { dispatchDraftChange } from "../entries/writer";

/** A caret or a selected range in the pane's document. */
export interface PaneSelection {
  /** The start offset, inclusive. */
  from: number;
  /** The end offset, exclusive. */
  to: number;
}

/** Everything a pane needs to mount and report back. */
export interface MarkdownPaneOptions {
  /** The element the pane mounts itself into. */
  parent: HTMLElement;
  /** The application, used only for rendering Markdown. */
  app: App;
  /** The accessible name of the editable surface. */
  label: string;
  /** Called for user edits and selection moves, never for programmatic updates. */
  onChange?: (text: string, selection: PaneSelection) => void;
  /** Called for every key that is not part of an IME composition; `true` consumes it. */
  onKey?: (event: KeyboardEvent) => boolean;
  /** Called when an IME composition starts or ends. */
  onComposition?: (active: boolean) => void;
  /** Called when the pane's height may have changed; already throttled to a frame. */
  onMeasure?: () => void;
}

/** The parser used for live formatting: CommonMark plus GFM tables, tasks and strikethrough. */
const MARKDOWN = parser.configure(GFM);

/** Marks transactions the pane dispatched itself, so they never look like typing. */
const External = Annotation.define<true>();

/** A range that is hidden from the formatted view. */
interface HiddenSpan {
  from: number;
  to: number;
}

/** A range that carries one formatting class. */
interface StyleSpan {
  from: number;
  to: number;
  cls: string;
}

/** Heading classes are explicit contracts shared with the stylesheet. */
const HEADING_CLASSES = [
  "weaver-md-h1", "weaver-md-h2", "weaver-md-h3",
  "weaver-md-h4", "weaver-md-h5", "weaver-md-h6"
] as const;

/** Whether `name` is an ATX or Setext heading, and its level when it is. */
function headingLevel(name: string): number {
  const match = /^(?:ATX|Setext)Heading([1-6])$/.exec(name);
  return match === null ? 0 : Number(match[1]);
}

/** Sorts and merges overlapping hidden ranges so no replacement decorates the same text twice. */
function mergeRanges(ranges: HiddenSpan[]): HiddenSpan[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: HiddenSpan[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.from <= last.to) {
      last.to = Math.max(last.to, range.to);
    } else {
      merged.push({ from: range.from, to: range.to });
    }
  }
  return merged;
}

/** The parts of `[from, to)` that are not hidden, so a mark never overlaps a replacement. */
function visibleParts(from: number, to: number, hidden: HiddenSpan[]): HiddenSpan[] {
  let parts: HiddenSpan[] = [{ from, to }];
  for (const cut of hidden) {
    const next: HiddenSpan[] = [];
    for (const part of parts) {
      if (cut.to <= part.from || cut.from >= part.to) {
        next.push(part);
        continue;
      }
      if (cut.from > part.from) next.push({ from: part.from, to: cut.from });
      if (cut.to < part.to) next.push({ from: cut.to, to: part.to });
    }
    parts = next;
  }
  return parts.filter((part) => part.from < part.to);
}

/** Calls `visit` with the start of every line that `[from, to]` touches. */
function eachLine(doc: Text, from: number, to: number, visit: (start: number) => void): void {
  if (doc.length === 0) return;
  let line = doc.lineAt(Math.min(Math.max(from, 0), doc.length));
  const last = doc.lineAt(Math.min(Math.max(to, 0), doc.length));
  for (;;) {
    visit(line.from);
    if (line.number >= last.number) return;
    line = doc.line(line.number + 1);
  }
}

/** Renders a horizontal rule where its source line is not the caret's. */
class RuleWidget extends WidgetType {
  eq(other: WidgetType): boolean {
    return other instanceof RuleWidget;
  }

  toDOM(view: EditorView): HTMLElement {
    const rule = view.dom.ownerDocument.createElement("hr");
    rule.className = "weaver-md-hr";
    return rule;
  }
}

/** Which lines carry which formatting classes. */
type LineClasses = Map<number, Set<string>>;

/** Adds one class to a line, keeping insertion order stable for predictable class names. */
function addLineClass(lines: LineClasses, start: number, cls: string): void {
  const existing = lines.get(start);
  if (existing === undefined) {
    lines.set(start, new Set([cls]));
  } else {
    existing.add(cls);
  }
}

/**
 * Builds the whole formatted decoration set for a document.
 *
 * The caret's line is the only place raw source stays visible; everything else is
 * formatted with its syntax marks hidden. All work is synchronous and derived
 * from the current state, so a keystroke can never paint a stale document.
 */
function formatDocument(state: EditorState): DecorationSet {
  const doc = state.doc;

  const text = doc.toString();
  const active = doc.lineAt(state.selection.main.head);
  const touchesCaretLine = (from: number, to: number): boolean =>
    from <= active.to && to >= active.from;

  const hidden: HiddenSpan[] = [];
  const widgets: HiddenSpan[] = [];
  const marks: StyleSpan[] = [];
  const lines: LineClasses = new Map();
  const protectedRanges: HiddenSpan[] = [];

  const hide = (from: number, to: number): void => {
    // View-plugin replacements may not cross line breaks. Preserve each newline
    // even when a CommonMark link title spans several source lines.
    while (from < to) {
      const line = doc.lineAt(from);
      const end = Math.min(to, line.to);
      if (from < end) hidden.push({ from, to: end });
      from = line.to + 1;
    }
  };

  const mark = (from: number, to: number, cls: string): void => {
    if (from < to) marks.push({ from, to, cls });
  };

  const tree = MARKDOWN.parse(text);
  const stack: string[] = [];

  tree.iterate({
    enter: (node) => {
      const name = node.name;
      const parent = stack.length === 0 ? "" : stack[stack.length - 1];
      stack.push(name);

      const level = headingLevel(name);
      const headingClass = HEADING_CLASSES[level - 1];
      if (headingClass !== undefined) {
        eachLine(doc, node.from, node.to, (start) => addLineClass(lines, start, headingClass));
      }

      // Ranges whose contents must never be read as a wikilink or a link alias.
      if (
        name === "InlineCode" ||
        name === "CodeText" ||
        name === "URL" ||
        name === "LinkTitle" ||
        name === "HTMLBlock" ||
        name === "HTMLTag" ||
        name === "FencedCode" ||
        name === "CodeBlock" ||
        name === "CodeMark"
      ) {
        protectedRanges.push({ from: node.from, to: node.to });
      }

      switch (name) {
        case "HeaderMark":
          // A Setext underline is its own line; hiding it would leave a blank row.
          if (!parent.startsWith("SetextHeading") && !touchesCaretLine(node.from, node.to)) {
            hide(node.from, node.to);
          }
          break;
        case "EmphasisMark":
        case "StrikethroughMark":
        case "QuoteMark":
        case "LinkMark":
        case "LinkTitle":
          if (!touchesCaretLine(node.from, node.to)) hide(node.from, node.to);
          break;
        case "CodeMark":
          // Fence lines stay visible while editing; inline backticks do not.
          if (parent === "InlineCode" && !touchesCaretLine(node.from, node.to)) {
            hide(node.from, node.to);
          }
          break;
        case "URL":
          if (!touchesCaretLine(node.from, node.to)) {
            // An autolink's URL is its visible label; a paired link's URL is syntax.
            if (parent !== "Autolink") hide(node.from, node.to);
          } else {
            mark(node.from, node.to, "cm-url");
          }
          break;
        case "Emphasis":
          mark(node.from, node.to, "cm-em");
          break;
        case "StrongEmphasis":
          mark(node.from, node.to, "cm-strong");
          break;
        case "Strikethrough":
          mark(node.from, node.to, "cm-strikethrough");
          break;
        case "InlineCode":
          mark(node.from, node.to, "cm-inline-code");
          break;
        case "Link":
        case "Autolink":
          mark(node.from, node.to, "cm-link");
          break;
        case "Image":
          mark(node.from, node.to, "weaver-md-image");
          break;
        case "HorizontalRule":
          if (touchesCaretLine(node.from, node.to)) {
            mark(node.from, node.to, "weaver-md-mark");
          } else {
            widgets.push({ from: node.from, to: node.to });
          }
          break;
        case "Blockquote":
          eachLine(doc, node.from, node.to, (start) => addLineClass(lines, start, "weaver-md-quote"));
          break;
        case "ListItem":
          eachLine(doc, node.from, node.to, (start) => addLineClass(lines, start, "weaver-md-list-item"));
          break;
        case "ListMark":
        case "TaskMarker":
          mark(node.from, node.to, "weaver-md-mark");
          break;
        case "FencedCode":
        case "CodeBlock":
          eachLine(doc, node.from, node.to, (start) => addLineClass(lines, start, "weaver-md-codeblock"));
          break;
        case "Table":
        case "TableHeader":
        case "TableRow":
          eachLine(doc, node.from, node.to, (start) => addLineClass(lines, start, "weaver-md-table-row"));
          break;
        case "TableDelimiter": {
          // A whole-line delimiter is the rule between header and body; a shorter
          // one is a pipe inside a row.
          const line = doc.lineAt(node.from);
          if (line.from === node.from && line.to === node.to) {
            addLineClass(lines, line.from, "weaver-md-table-delimiter");
          } else {
            mark(node.from, node.to, "weaver-md-table-pipe");
          }
          break;
        }
        case "TableCell":
          mark(node.from, node.to, "weaver-md-table-cell");
          break;
        default:
          break;
      }
    },
    leave: () => {
      stack.pop();
    }
  });

  // Wikilinks are not CommonMark, so they are recognised on the text itself,
  // skipping code, URLs, HTML and link titles.
  const wikilink = /\[\[([^[\]\n]+)\]\]/g;
  for (let match = wikilink.exec(text); match !== null; match = wikilink.exec(text)) {
    const from = match.index;
    const to = from + match[0].length;
    if (protectedRanges.some((range) => from < range.to && to > range.from)) continue;

    const innerFrom = from + 2;
    const innerTo = to - 2;
    const bar = match[1].indexOf("|");
    const labelFrom = bar < 0 ? innerFrom : innerFrom + bar + 1;
    mark(labelFrom, innerTo, "weaver-md-wikilink");
    if (touchesCaretLine(from, to)) {
      mark(from, innerFrom, "weaver-md-mark");
      mark(innerTo, to, "weaver-md-mark");
    } else {
      hide(from, innerFrom);
      hide(innerTo, to);
      // `[[target|alias]]` reads as its alias, like live preview.
      if (bar >= 0) hide(innerFrom, labelFrom);
    }
  }

  const hiddenRanges = mergeRanges(hidden);
  const widgetRanges = mergeRanges(widgets);
  const occupied = mergeRanges([...hiddenRanges, ...widgetRanges]);

  const ranges: Range<Decoration>[] = [];
  for (const range of hiddenRanges) {
    ranges.push(Decoration.replace({}).range(range.from, range.to));
  }
  for (const range of widgetRanges) {
    ranges.push(Decoration.replace({ widget: new RuleWidget() }).range(range.from, range.to));
  }
  for (const span of marks) {
    for (const part of visibleParts(span.from, span.to, occupied)) {
      ranges.push(Decoration.mark({ class: span.cls }).range(part.from, part.to));
    }
  }
  for (const [start, classes] of lines) {
    ranges.push(Decoration.line({ class: [...classes].join(" ") }).range(start));
  }

  return Decoration.set(ranges, true);
}

/** Rebuilds formatting when the document changes or the caret crosses into another line. */
class FormattedMarkdown {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = formatDocument(view.state);
  }

  update(update: ViewUpdate): void {
    const before = update.startState.doc.lineAt(update.startState.selection.main.head).number;
    const after = update.state.doc.lineAt(update.state.selection.main.head).number;
    if (update.docChanged || before !== after) {
      this.decorations = formatDocument(update.state);
    }
  }
}

/**
 * Structural editor styles only: inherited type, no editor padding and no inner
 * scrolling. Colours, sizes, frames and spacing stay with the caller's stylesheet,
 * which targets the classes this pane exposes.
 */
const STRUCTURE = EditorView.theme({
  "&": { fontSize: "inherit", color: "inherit", backgroundColor: "transparent" },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "inherit",
    height: "auto",
    overflow: "visible"
  },
  ".cm-content": { padding: "0" },
  ".cm-line": { padding: "0" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "currentColor" }
});

/** A snapshot of what the caller was last told, used to suppress duplicate callbacks. */
interface PaneSnapshot {
  text: string;
  from: number;
  to: number;
}

/** The persistent rich Markdown editor and read-only renderer. */
export class MarkdownPane {
  /** The pane root; the caller mounts nothing itself and styles this element. */
  readonly dom: HTMLElement;
  /** The CodeMirror content element, for key handling and field detection. */
  readonly contentDOM: HTMLElement;

  private readonly options: MarkdownPaneOptions;
  private readonly doc: Document;
  private readonly win: Window;
  private readonly view: EditorView;
  private readonly editorHost: HTMLElement;
  private readonly reading: HTMLElement;
  private readonly readOnlyCompartment = new Compartment();
  private readonly editableCompartment = new Compartment();
  private readonly onCompositionStart: () => void;
  private readonly onCompositionEnd: () => void;
  private readonly resizeObserver: ResizeObserver | null;

  private readOnly = false;
  private composing = false;
  private pendingChange = false;
  private destroyed = false;
  private readingReady = false;
  private rendered: { text: string; path: string } | null = null;
  private rendering: { text: string; path: string } | null = null;
  private renderGeneration = 0;
  private renderComponent: Component | null = null;
  private measureFrame: number | null = null;
  private snapshotState: PaneSnapshot | null = null;

  /** Fileless rendered panes route internal links through the public workspace API. */
  private readonly onReadingLink = (event: MouseEvent): void => {
    if (event.button !== 0 && event.button !== 1) return;
    const target = event.target as Node | null;
    const element = target?.nodeType === 1 ? target as Element : target?.parentElement;
    const anchor = element?.closest<HTMLAnchorElement>("a.internal-link");
    if (anchor === undefined || anchor === null || !this.reading.contains(anchor)) return;
    const link = anchor.getAttribute("data-href") ?? anchor.getAttribute("href");
    if (link === null || this.rendered === null) return;
    event.preventDefault();
    event.stopPropagation();
    void this.options.app.workspace.openLinkText(
      link, this.rendered.path, Keymap.isModEvent(event)
    ).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      new Notice(`Could not open link: ${reason}`);
    });
  };

  constructor(options: MarkdownPaneOptions) {
    this.options = options;
    this.doc = options.parent.ownerDocument;
    this.win = this.doc.defaultView ?? window;

    this.dom = this.doc.createElement("div");
    this.dom.className = "weaver-markdown";
    this.dom.dataset.mode = "edit";

    this.editorHost = this.doc.createElement("div");
    this.editorHost.className = "weaver-markdown-editor-host";

    this.reading = this.doc.createElement("div");
    this.reading.className = "markdown-rendered weaver-markdown-reading";
    this.reading.tabIndex = -1;
    this.reading.hidden = true;
    this.reading.addEventListener("click", this.onReadingLink);
    this.reading.addEventListener("auxclick", this.onReadingLink);

    this.view = new EditorView({
      state: this.createState(""),
      parent: this.editorHost
    });
    this.contentDOM = this.view.contentDOM;

    this.dom.append(this.editorHost, this.reading);
    options.parent.append(this.dom);
    this.view.requestMeasure();

    this.onCompositionStart = () => {
      this.composing = true;
      this.dom.dataset.composing = "true";
      this.options.onComposition?.(true);
    };
    this.onCompositionEnd = () => {
      this.composing = false;
      delete this.dom.dataset.composing;
      this.options.onComposition?.(false);
      // The final composition text lands in the state after the event; report it
      // once, outside the composition, so a caller never saves mid-IME.
      this.win.queueMicrotask(() => {
        if (this.destroyed || this.composing || !this.pendingChange) return;
        this.pendingChange = false;
        this.emitChange();
      });
    };
    this.contentDOM.addEventListener("compositionstart", this.onCompositionStart);
    this.contentDOM.addEventListener("compositionend", this.onCompositionEnd);

    this.resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => this.queueMeasure());
    this.resizeObserver?.observe(this.dom);

    this.captureSnapshot();
    this.queueMeasure();
  }

  /** The Markdown source as it stands, including any in-progress composition text. */
  get text(): string {
    return this.view.state.doc.toString();
  }

  /** The main selection of the persistent editor. */
  get selection(): PaneSelection {
    const main = this.view.state.selection.main;
    return { from: main.from, to: main.to };
  }

  /** True while the pane itself holds focus, in either mode. */
  get hasFocus(): boolean {
    return this.dom.contains(this.doc.activeElement);
  }

  /** The editing caret in viewport coordinates, for revealing it without window panning. */
  get caretBounds(): { top: number; bottom: number } | null {
    if (this.destroyed || this.readOnly) return null;
    return this.view.coordsAtPos(this.view.state.selection.main.head);
  }

  /**
   * Shows `text` in this pane.
   *
   * Repeating the same text, path and mode never resets history or selection.
   * `selection` is applied when given and otherwise preserved (clamped to the new
   * document). `resetHistory` starts a new document, deliberately discarding undo
   * for the previous one; use it only when the pane is being repurposed.
   */
  update(
    text: string,
    sourcePath: string,
    readOnly: boolean,
    selection?: PaneSelection,
    resetHistory?: boolean
  ): void {
    if (this.destroyed) return;

    const previous = this.text;
    const changed = text !== previous;

    if (resetHistory) {
      const target = this.clamp(selection ?? this.selection, text.length);
      this.view.setState(this.createState(text, target));
      this.captureSnapshot();
    } else if (changed) {
      const target = this.clamp(selection ?? this.selection, text.length);
      dispatchDraftChange(this.view, {
        changes: { from: 0, to: previous.length, insert: text },
        selection: EditorSelection.range(target.from, target.to),
        annotations: [External.of(true), Transaction.addToHistory.of(false)]
      });
      this.captureSnapshot();
    } else if (selection !== undefined) {
      const target = this.clamp(selection, text.length);
      const current = this.selection;
      if (target.from !== current.from || target.to !== current.to) {
        this.view.dispatch({
          selection: EditorSelection.range(target.from, target.to),
          annotations: External.of(true)
        });
      }
      this.captureSnapshot();
    }

    if (readOnly !== this.readOnly) {
      this.readOnly = readOnly;
      this.view.dispatch({
        effects: [
          this.readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
          this.editableCompartment.reconfigure(EditorView.editable.of(!readOnly))
        ],
        annotations: External.of(true)
      });
    }

    if (readOnly) {
      const pending = this.rendering;
      if (pending !== null && (pending.text !== text || pending.path !== sourcePath)) {
        // The document moved on; that render must never be adopted.
        this.renderGeneration += 1;
        this.rendering = null;
      }
      const rendered = this.rendered;
      const current =
        rendered !== null && rendered.text === text && rendered.path === sourcePath;
      if (!this.readingReady || !current) {
        this.readingReady = current;
        if (!current && this.rendering === null) this.renderReading(text, sourcePath);
      }
    }

    this.syncMode();
    this.queueMeasure();
  }

  /**
   * Inserts text from an explicit control, such as a New line button.
   *
   * This is real input, not a programmatic sync: it replaces the selection with
   * ordinary undoable history, moves the caret after the insertion, focuses the
   * editor and reports the change through `onChange`. It does nothing while
   * read-only, mid-composition or after destruction.
   */
  insertText(text: string): void {
    if (this.destroyed || this.readOnly || this.composing || text === "") return;
    dispatchDraftChange(this.view, {
      ...this.view.state.replaceSelection(text),
      annotations: Transaction.userEvent.of("input")
    });
    this.view.focus();
  }

  /** Focuses the editable surface, or the rendered body in read-only mode. */
  focus(selection?: PaneSelection): void {
    if (this.destroyed) return;
    if (selection !== undefined) {
      const target = this.clamp(selection, this.text.length);
      this.view.dispatch({
        selection: EditorSelection.range(target.from, target.to),
        annotations: External.of(true)
      });
      this.captureSnapshot();
    }
    if (this.readOnly) {
      this.reading.focus({ preventScroll: true });
    } else {
      this.view.focus();
    }
  }

  /** Releases focus if this pane owns it. */
  blur(): void {
    if (!this.dom.contains(this.doc.activeElement)) return;
    this.view.contentDOM.blur();
    this.reading.blur();
  }

  /** Unmounts the editor, cancels pending rendering and unloads every rendered child. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.renderGeneration += 1;

    if (this.measureFrame !== null) {
      this.win.cancelAnimationFrame(this.measureFrame);
      this.measureFrame = null;
    }
    this.resizeObserver?.disconnect();
    this.contentDOM.removeEventListener("compositionstart", this.onCompositionStart);
    this.contentDOM.removeEventListener("compositionend", this.onCompositionEnd);
    this.reading.removeEventListener("click", this.onReadingLink);
    this.reading.removeEventListener("auxclick", this.onReadingLink);

    this.renderComponent?.unload();
    this.renderComponent = null;
    this.reading.remove();
    this.view.destroy();
    this.dom.remove();
  }

  /** The state configuration for a fresh document, keeping the pane's compartments. */
  private createState(text: string, selection?: PaneSelection): EditorState {
    return EditorState.create({
      doc: text,
      selection:
        selection === undefined
          ? undefined
          : EditorSelection.range(selection.from, selection.to),
      extensions: this.extensions()
    });
  }

  /** Every extension this pane's editor runs with. */
  private extensions(): Extension[] {
    return [
      history(),
      drawSelection(),
      placeholder(this.options.label),
      EditorView.lineWrapping,
      STRUCTURE,
      ViewPlugin.fromClass(FormattedMarkdown, {
        decorations: (plugin) => plugin.decorations
      }),
      Prec.highest(
        EditorView.domEventHandlers({
          keydown: (event) => this.handleKey(event)
        })
      ),
      keymap.of([
        // Explicit, so a soft Return that saves can never swallow a newline.
        { key: "Shift-Enter", run: insertNewlineAndIndent },
        ...defaultKeymap,
        ...historyKeymap
      ]),
      EditorView.updateListener.of((update) => this.observe(update)),
      this.readOnlyCompartment.of(EditorState.readOnly.of(this.readOnly)),
      this.editableCompartment.of(EditorView.editable.of(!this.readOnly)),
      EditorView.editorAttributes.of({ class: "weaver-markdown-editor" }),
      EditorView.contentAttributes.of({
        class: "weaver-markdown-content",
        "aria-label": this.options.label
      })
    ];
  }

  /** Routes keys to the caller unless an IME composition owns them. */
  private handleKey(event: KeyboardEvent): boolean {
    if (this.destroyed || this.composing || event.isComposing || event.keyCode === 229) {
      return false;
    }
    const handler = this.options.onKey;
    if (handler === undefined) return false;
    if (!handler(event)) return false;

    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  /** Turns editor updates into caller callbacks, never for the pane's own writes. */
  private observe(update: ViewUpdate): void {
    if (update.docChanged || update.geometryChanged) this.queueMeasure();
    if (!update.docChanged && !update.selectionSet) return;
    if (update.transactions.some((transaction) => transaction.annotation(External) === true)) return;

    if (this.composing) {
      this.pendingChange = true;
      return;
    }
    this.emitChange();
  }

  /** Reports the current text and selection once, when it differs from the last report. */
  private emitChange(): void {
    const text = this.text;
    const selection = this.selection;
    const last = this.snapshotState;
    if (
      last !== null &&
      last.text === text &&
      last.from === selection.from &&
      last.to === selection.to
    ) {
      return;
    }
    this.captureSnapshot();
    this.options.onChange?.(text, selection);
  }

  /** Records what the caller has been told, so repeat calls stay silent. */
  private captureSnapshot(): void {
    const selection = this.selection;
    this.snapshotState = { text: this.text, from: selection.from, to: selection.to };
  }

  /** Clamps a selection to a document length. */
  private clamp(selection: PaneSelection, length: number): PaneSelection {
    const from = Math.max(0, Math.min(selection.from, length));
    const to = Math.max(0, Math.min(selection.to, length));
    return to < from ? { from: to, to: from } : { from, to };
  }

  /** Shows the editor or the rendered body, asking for a measure after the swap. */
  private syncMode(): void {
    const reading = this.readOnly && this.readingReady;
    this.dom.dataset.mode = reading ? "read" : "edit";
    this.dom.dataset.readonly = this.readOnly ? "true" : "false";
    if (this.editorHost.hidden !== reading) {
      this.editorHost.hidden = reading;
      this.reading.hidden = !reading;
      this.view.requestMeasure();
      this.queueMeasure();
    }
  }

  /**
   * Renders `text` into the read-only body, discarding any result that is no
   * longer current. Rendered children live in a fresh Component so nothing they
   * register outlives the content that needed it.
   */
  private renderReading(text: string, sourcePath: string): void {
    const generation = ++this.renderGeneration;
    this.rendering = { text, path: sourcePath };
    const component = new Component();
    component.load();
    const staging = this.doc.createElement("div");

    MarkdownRenderer.render(this.options.app, text, staging, sourcePath, component).then(
      () => {
        if (this.destroyed || generation !== this.renderGeneration) {
          component.unload();
          return;
        }
        this.rendering = null;
        this.renderComponent?.unload();
        this.renderComponent = component;
        this.reading.replaceChildren(...Array.from(staging.childNodes));
        this.reading.classList.remove("weaver-markdown-error");
        this.reading.removeAttribute("role");
        this.rendered = { text, path: sourcePath };
        this.readingReady = true;
        this.syncMode();
        this.view.requestMeasure();
        this.queueMeasure();
      },
      (error: unknown) => {
        component.unload();
        if (this.destroyed || generation !== this.renderGeneration) return;
        this.rendering = null;
        this.renderComponent?.unload();
        this.renderComponent = null;
        this.reading.classList.add("weaver-markdown-error");
        this.reading.setAttribute("role", "alert");
        const reason = error instanceof Error ? error.message : String(error);
        this.reading.textContent = `Markdown could not be rendered. Open the note to inspect its source. ${reason}`;
        this.rendered = { text, path: sourcePath };
        this.readingReady = true;
        this.syncMode();
        this.queueMeasure();
      }
    );
  }

  /** Asks for a single relayout callback per animation frame. */
  private queueMeasure(): void {
    if (this.destroyed || this.measureFrame !== null) return;
    this.measureFrame = this.win.requestAnimationFrame(() => {
      this.measureFrame = null;
      if (!this.destroyed) this.options.onMeasure?.();
    });
  }
}
