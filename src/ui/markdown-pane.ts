/**
 * A persistent, fileless Obsidian Markdown editor and read-only native rendering.
 *
 * The native editor owns formatting, history, suggestions and toolbar commands.
 * Its MarkdownView never receives a file: autosave has no note to write, and
 * publishing remains the capture controller's decision. A bound editor context
 * registers the focused draft with Obsidian without activating another leaf.
 * Read-only rendering retains the editor, its source, history and selection.
 */
import {
  Annotation, Compartment, EditorSelection, EditorState, StateEffect, Transaction
} from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import {
  Component, Keymap, MarkdownRenderer, MarkdownView, Notice,
  type App, type MarkdownFileInfo
} from "obsidian";
import { dispatchDraftChange } from "../entries/writer";

/** A caret or selected range in the pane's Markdown source. */
export interface PaneSelection {
  /** The start offset, inclusive. */
  from: number;
  /** The end offset, exclusive. */
  to: number;
}

/** Mounting dependencies and callbacks for a persistent Markdown pane. */
export interface MarkdownPaneOptions {
  /** The element the pane mounts itself into. */
  parent: HTMLElement;
  /** The application supplying the native editor and Markdown renderer. */
  app: App;
  /** The accessible name of the editable surface. */
  label: string;
  /** User edits and selection moves, never programmatic synchronization. */
  onChange?: (text: string, selection: PaneSelection) => void;
  /** Returning true consumes a key before the native editor handles it. */
  onKey?: (event: KeyboardEvent) => boolean;
  /** Reports when an IME owns the uncommitted text. */
  onComposition?: (active: boolean) => void;
  /** Reports possible geometry changes, throttled to an animation frame. */
  onMeasure?: () => void;
}

/** Marks synchronization, which must not become user input or draft history. */
const External = Annotation.define<true>();

/** The native command router also asks fileless contexts which mode they use. */
type DraftContext = MarkdownFileInfo & { getMode(): "source" };

/** A native fileless editor whose lifetime survives saving and hiding. */
export class MarkdownPane {
  /** The persistent root, owned and mounted by this pane. */
  readonly dom: HTMLElement;
  private readonly doc: Document;
  private readonly win: Window;
  private readonly native: MarkdownView;
  private readonly context: DraftContext;
  private previousEditor: MarkdownFileInfo | null = null;
  private view: EditorView;
  private readonly editorHost: HTMLElement;
  private readonly reading: HTMLElement;
  private readonly readOnlyCompartment = new Compartment();
  private readonly editableCompartment = new Compartment();
  private readonly resizeObserver: ResizeObserver | null;
  private readOnly = false;
  private composing = false;
  private syncing = false;
  private destroyed = false;
  private readingReady = false;
  private rendered: { text: string; path: string } | null = null;
  private rendering: { text: string; path: string } | null = null;
  private renderGeneration = 0;
  private renderComponent: Component | null = null;
  private measureFrame: number | null = null;
  private snapshot: { text: string; from: number; to: number } | null = null;

  private readonly onFocus = (): void => {
    if (this.destroyed || this.readOnly) return;
    const workspace = this.options.app.workspace;
    if (workspace.activeEditor === this.context) return;
    this.previousEditor = workspace.activeEditor;
    workspace.activeEditor = this.context;
  };
  private readonly onBlur = (): void => this.releaseEditor();
  private readonly onKey = (event: KeyboardEvent): void => {
    if (this.destroyed || this.composing || event.isComposing || event.keyCode === 229) return;
    if (!this.options.onKey?.(event)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  private readonly onCompositionStart = (): void => {
    this.composing = true;
    this.dom.dataset.composing = "true";
    this.options.onComposition?.(true);
  };
  private readonly onCompositionEnd = (): void => {
    this.composing = false;
    delete this.dom.dataset.composing;
    this.options.onComposition?.(false);
    this.win.queueMicrotask(() => {
      if (!this.destroyed) this.emitChange();
    });
  };
  private readonly onReadingLink = (event: MouseEvent): void => {
    if (event.button !== 0 && event.button !== 1) return;
    const target = event.target as Node | null;
    const element = target?.nodeType === 1 ? target as Element : target?.parentElement;
    const anchor = element?.closest<HTMLAnchorElement>("a.internal-link");
    if (anchor == null || !this.reading.contains(anchor) || this.rendered === null) return;
    const link = anchor.getAttribute("data-href") ?? anchor.getAttribute("href");
    if (link === null) return;
    event.preventDefault();
    event.stopPropagation();
    void this.options.app.workspace.openLinkText(link, this.rendered.path, Keymap.isModEvent(event))
      .catch((error: unknown) => {
        new Notice(`Could not open link: ${error instanceof Error ? error.message : String(error)}`);
      });
  };

  constructor(private readonly options: MarkdownPaneOptions) {
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
    this.dom.append(this.editorHost, this.reading);
    options.parent.append(this.dom);

    this.native = new MarkdownView(options.app.workspace.getLeaf(false));
    this.native.allowNoFile = true;
    this.native.file = null;
    this.native.load();
    this.editorHost.append(this.native.containerEl);
    this.native.setViewData("", true);
    this.view = this.findView();
    // Obsidian ignores actual MarkdownView instances in the activeEditor setter.
    // A bound facade supplies the complete native context, including host menu
    // state, without pretending this embedded view is the workspace's leaf.
    const methods = new WeakMap<object, unknown>();
    this.context = new Proxy({} as DraftContext, {
      get: (_target, property) => {
        const value: unknown = Reflect.get(this.native, property, this.native);
        if (typeof value !== "function") return value;
        let bound = methods.get(value);
        if (bound === undefined) {
          bound = value.bind(this.native);
          methods.set(value, bound);
        }
        return bound;
      },
      set: (_target, property, value: unknown) => Reflect.set(this.native, property, value, this.native)
    });
    this.installExtensions();
    // Source mode and native Live Preview are selected through the public view API.
    // A fileless view must not inherit the reference note's Reading mode.
    void this.native.setState({ mode: "source", source: false }, { history: false }).then(() => {
      if (this.destroyed) return;
      this.view = this.findView();
      this.installExtensions();
      this.syncMode();
      this.queueMeasure();
    });
    this.dom.addEventListener("focusin", this.onFocus);
    this.dom.addEventListener("focusout", this.onBlur);
    this.dom.addEventListener("keydown", this.onKey, true);
    this.dom.addEventListener("compositionstart", this.onCompositionStart);
    this.dom.addEventListener("compositionend", this.onCompositionEnd);
    this.reading.addEventListener("click", this.onReadingLink);
    this.reading.addEventListener("auxclick", this.onReadingLink);
    this.resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.queueMeasure());
    this.resizeObserver?.observe(this.dom);
    this.captureSnapshot();
    this.queueMeasure();
  }

  /** The current native editing element, including after a new-draft history reset. */
  get contentDOM(): HTMLElement { return this.view.contentDOM; }
  /** The source, including an IME's uncommitted text. */
  get text(): string { return this.view.state.doc.toString(); }
  /** The persistent editor's main selection. */
  get selection(): PaneSelection {
    const main = this.view.state.selection.main;
    return { from: main.from, to: main.to };
  }
  /** True while the editing pane or its read-only reading owns focus. */
  get hasFocus(): boolean { return this.dom.contains(this.doc.activeElement); }
  /** The caret rectangle, used to reveal it inside the prose rather than pan the page. */
  get caretBounds(): { top: number; bottom: number } | null {
    return this.destroyed || this.readOnly ? null : this.view.coordsAtPos(this.view.state.selection.main.head);
  }

  /** Synchronizes source and mode without replacing the native editor or its history. */
  update(text: string, sourcePath: string, readOnly: boolean, selection?: PaneSelection, resetHistory?: boolean): void {
    if (this.destroyed) return;
    this.syncing = true;
    try {
      if (resetHistory) {
        this.native.setViewData(text, true);
        this.view = this.findView();
        this.installExtensions();
      } else if (text !== this.text) {
        dispatchDraftChange(this.view, {
          changes: { from: 0, to: this.text.length, insert: text },
          annotations: [External.of(true), Transaction.addToHistory.of(false)]
        });
      }
      if (selection !== undefined) this.setSelection(selection);
      if (this.readOnly !== readOnly) {
        this.readOnly = readOnly;
        this.view.dispatch({ effects: [
          this.readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
          this.editableCompartment.reconfigure(EditorView.editable.of(!readOnly))
        ] });
      }
      if (readOnly) this.releaseEditor();
      this.captureSnapshot();
    } finally { this.syncing = false; }
    if (readOnly) {
      const current = this.rendered?.text === text && this.rendered.path === sourcePath;
      if (!current && (this.rendering?.text !== text || this.rendering.path !== sourcePath)) {
        this.renderReading(text, sourcePath);
      }
      this.readingReady = current;
    }
    this.syncMode();
    this.queueMeasure();
  }

  /** Inserts ordinary undoable input; read-only panes and IME compositions refuse it. */
  insertText(text: string): void {
    if (this.destroyed || this.readOnly || this.composing || text === "") return;
    dispatchDraftChange(this.view, {
      ...this.view.state.replaceSelection(text), annotations: Transaction.userEvent.of("input")
    });
    this.focus();
  }
  /** Restores a caret before focusing the native editor, or focuses its saved reading. */
  focus(selection?: PaneSelection): void {
    if (this.destroyed) return;
    if (selection !== undefined) this.setSelection(selection);
    if (this.readOnly) this.reading.focus({ preventScroll: true });
    else { this.onFocus(); this.native.editor.focus(); }
  }
  /** Releases both DOM focus and native command ownership. */
  blur(): void {
    if (this.hasFocus) { this.view.contentDOM.blur(); this.reading.blur(); }
    this.releaseEditor();
  }
  /** Unloads the fileless native view, rendering children and all listeners. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.renderGeneration += 1;
    this.releaseEditor();
    if (this.measureFrame !== null) this.win.cancelAnimationFrame(this.measureFrame);
    this.resizeObserver?.disconnect();
    this.dom.removeEventListener("focusin", this.onFocus);
    this.dom.removeEventListener("focusout", this.onBlur);
    this.dom.removeEventListener("keydown", this.onKey, true);
    this.dom.removeEventListener("compositionstart", this.onCompositionStart);
    this.dom.removeEventListener("compositionend", this.onCompositionEnd);
    this.reading.removeEventListener("click", this.onReadingLink);
    this.reading.removeEventListener("auxclick", this.onReadingLink);
    this.renderComponent?.unload();
    this.native.unload();
    this.dom.remove();
  }

  private findView(): EditorView {
    const content = this.native.containerEl.querySelector<HTMLElement>(".cm-content");
    const view = content === null ? null : EditorView.findFromDOM(content);
    if (view === null) throw new Error("Obsidian did not mount the fileless Markdown editor.");
    return view;
  }
  private installExtensions(): void {
    if (this.readOnlyCompartment.get(this.view.state) !== undefined) return;
    this.view.dispatch({ effects: StateEffect.appendConfig.of([
      this.readOnlyCompartment.of(EditorState.readOnly.of(this.readOnly)),
      this.editableCompartment.of(EditorView.editable.of(!this.readOnly)),
      EditorView.contentAttributes.of({ "aria-label": this.options.label }),
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.docChanged || update.geometryChanged) this.queueMeasure();
        if (this.destroyed || this.syncing || this.composing) return;
        if (!update.docChanged && !update.selectionSet) return;
        if (update.transactions.some((transaction) => transaction.annotation(External) === true)) return;
        this.emitChange();
      })
    ]) });
  }
  private releaseEditor(): void {
    const workspace = this.options.app.workspace;
    if (workspace.activeEditor === this.context) {
      // Native views are the workspace getter's fallback, not an embedded override.
      workspace.activeEditor = this.previousEditor instanceof MarkdownView ? null : this.previousEditor;
    }
    this.previousEditor = null;
  }
  private setSelection(selection: PaneSelection): void {
    const from = Math.max(0, Math.min(selection.from, this.text.length));
    const to = Math.max(from, Math.min(selection.to, this.text.length));
    const current = this.selection;
    if (current.from === from && current.to === to) return;
    this.view.dispatch({ selection: EditorSelection.range(from, to), annotations: External.of(true) });
    this.captureSnapshot();
  }
  private captureSnapshot(): void { this.snapshot = { text: this.text, ...this.selection }; }
  private emitChange(): void {
    const text = this.text;
    const selection = this.selection;
    if (this.snapshot?.text === text && this.snapshot.from === selection.from && this.snapshot.to === selection.to) return;
    this.captureSnapshot();
    this.options.onChange?.(text, selection);
  }
  private syncMode(): void {
    const reading = this.readOnly && this.readingReady;
    this.dom.dataset.mode = reading ? "read" : "edit";
    this.dom.dataset.readonly = String(this.readOnly);
    this.editorHost.hidden = reading;
    this.reading.hidden = !reading;
    this.view.requestMeasure();
  }
  private renderReading(text: string, sourcePath: string): void {
    const generation = ++this.renderGeneration;
    this.rendering = { text, path: sourcePath };
    const component = new Component();
    component.load();
    const staging = this.doc.createElement("div");
    MarkdownRenderer.render(this.options.app, text, staging, sourcePath, component).then(() => {
      if (this.destroyed || generation !== this.renderGeneration) { component.unload(); return; }
      this.renderComponent?.unload();
      this.renderComponent = component;
      this.rendering = null;
      this.rendered = { text, path: sourcePath };
      this.reading.replaceChildren(...Array.from(staging.childNodes));
      this.reading.classList.remove("weaver-markdown-error");
      this.reading.removeAttribute("role");
      this.readingReady = true;
      this.syncMode();
      this.queueMeasure();
    }, (error: unknown) => {
      component.unload();
      if (this.destroyed || generation !== this.renderGeneration) return;
      this.renderComponent?.unload();
      this.renderComponent = null;
      this.rendering = null;
      this.rendered = { text, path: sourcePath };
      this.reading.classList.add("weaver-markdown-error");
      this.reading.setAttribute("role", "alert");
      const reason = error instanceof Error ? error.message : String(error);
      this.reading.textContent = `Markdown could not be rendered. Open the note to inspect its source. ${reason}`;
      this.readingReady = true;
      this.syncMode();
      this.queueMeasure();
    });
  }
  private queueMeasure(): void {
    if (this.destroyed || this.measureFrame !== null) return;
    this.measureFrame = this.win.requestAnimationFrame(() => {
      this.measureFrame = null;
      if (!this.destroyed) this.options.onMeasure?.();
    });
  }
}
