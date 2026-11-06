/* An in-repo stand-in for the `obsidian` module, used only by vitest.
 *
 * The real package ships types with no runtime, so any module that imports
 * `obsidian` cannot be unit-tested directly. `vitest.config.ts` aliases the
 * module here. Behaviour that matters to Weaver (Scope key matching, Modal
 * lifecycle, Platform flags) mirrors the shipped app: `Scope.handleKey`
 * iterates handlers in registration order, a `false` return means "handled"
 * (preventDefault + stopPropagation), and `modifiers: null` matches any
 * modifier combination while `[]` matches only unmodified keys.
 */

import { installDom, ShimElement } from "./dom";
import { StateField } from "@codemirror/state";

installDom();

const WINDOW = globalThis as unknown as Record<string, unknown>;
void WINDOW;

export type EventRef = { name: string; callback: (...args: never[]) => unknown; fired?: boolean };
export type ResolvedFile = { path: string; name: string; basename: string; stat: { mtime: number; size: number } };

export class TFile {
  path: string;
  name: string;
  basename: string;
  extension = "md";
  stat: { mtime: number; size: number };
  content: string;

  constructor(path: string, content = "", mtime = 1) {
    this.path = path;
    this.name = path.split("/").pop() ?? path;
    this.basename = this.name.replace(/\.[^.]+$/, "");
    this.stat = { mtime, size: content.length };
    this.content = content;
  }
}

export class Component {
  registerEvent(): void {}
  registerDomEvent(): void {}
  registerInterval(): void {}
  addChild<T>(child: T): T {
    return child;
  }
  load(): void {}
  unload(): void {}
  onload(): void {}
  onunload(): void {}
}

export class ComponentClass extends Component {}

/**
 * The public Markdown renderer.
 *
 * The stub writes the prose as text: a test cares that the thought was rendered
 * into the element, not how Obsidian's own parser spells an emphasis span.
 */
export class MarkdownRenderer {
  static async render(
    app: unknown,
    markdown: string,
    element: unknown,
    sourcePath: string,
    component: unknown
  ): Promise<void> {
    void app;
    void sourcePath;
    void component;
    const target = element as { textContent: string };
    target.textContent = markdown;
  }
}

export const Platform = {
  isDesktop: true,
  isDesktopApp: true,
  isMobile: false,
  isMobileApp: false,
  isPhone: false,
  isTablet: false,
  isMacOS: true,
  isWin: false,
  isLinux: false
};

/** Matches `reloadApp`-independent behaviour of `editorInfoField`. */
export const editorInfoField = StateField.define<{ file: TFile | null; app: unknown }>({
  create: () => ({ file: null, app: null }),
  update: (value) => value
});

export const editorLivePreviewField = StateField.define<boolean>({
  create: () => true,
  update: (value) => value
});

type KeyHandler = {
  scope: Scope;
  modifiers: string | null;
  key: string | null;
  func: (event: KeyboardEvent, context: { modifiers: string; key: string; vkey: string }) => boolean | void;
};

const MODIFIER_ORDER = ["Ctrl", "Meta", "Alt", "Shift"];

function compileModifiers(modifiers: readonly string[]): string {
  return modifiers
    .map((modifier) => (modifier === "Mod" ? "Meta" : modifier))
    .sort((left, right) => MODIFIER_ORDER.indexOf(left) - MODIFIER_ORDER.indexOf(right))
    .join(",");
}

export interface SimulatedKey {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export class Scope {
  parent: Scope | null;
  keys: KeyHandler[] = [];

  constructor(parent?: Scope) {
    this.parent = parent ?? null;
  }

  register(
    modifiers: readonly string[] | null,
    key: string | null,
    func: KeyHandler["func"]
  ): KeyHandler {
    const handler: KeyHandler = {
      scope: this,
      modifiers: modifiers === null ? null : compileModifiers(modifiers),
      key,
      func
    };
    this.keys.push(handler);
    return handler;
  }

  unregister(handler: KeyHandler): void {
    const index = this.keys.indexOf(handler);
    if (index >= 0) this.keys.splice(index, 1);
  }

  /**
   * Reproduces `Scope.handleKey`: registration order, `false` means handled,
   * and a `null/null` handler falls through.
   */
  dispatch(key: SimulatedKey): boolean | void {
    const modifiers = compileModifiers(
      [
        key.ctrl === true ? "Ctrl" : "",
        key.meta === true ? "Meta" : "",
        key.alt === true ? "Alt" : "",
        key.shift === true ? "Shift" : ""
      ].filter(Boolean)
    );
    const context = {
      modifiers,
      key: key.key,
      vkey: /^[a-z]$/i.test(key.key) ? `Key${key.key.toUpperCase()}` : key.key
    };

    for (const handler of this.keys) {
      const matchesModifiers = handler.modifiers === null || handler.modifiers === modifiers;
      // Mirrors Obsidian's `isMatch`: a null key matches everything, otherwise
      // the virtual key code or a case-insensitive key name must agree.
      const matchesKey =
        handler.key === null ||
        handler.key === context.vkey ||
        (context.key !== "" && handler.key.toLowerCase() === context.key.toLowerCase());
      if (!matchesModifiers || !matchesKey) continue;

      const result = handler.func(key as unknown as KeyboardEvent, context);
      if (result !== undefined) return result;
      if (handler.key !== null || handler.modifiers !== null) return result;
    }

    return this.parent?.dispatch(key);
  }
}

export class Keymap {
  rootScope = new Scope();
  scope: Scope = this.rootScope;
  private readonly previous: Scope[] = [];

  pushScope(scope: Scope): void {
    if (this.scope === scope) return;
    this.previous.push(this.scope);
    this.scope = scope;
  }

  popScope(scope: Scope): void {
    if (this.scope === scope) this.scope = this.previous.pop() ?? this.rootScope;
    else {
      const index = this.previous.indexOf(scope);
      if (index >= 0) this.previous.splice(index, 1);
    }
  }

  /** Simulates a keydown through the active scope. */
  dispatch(key: SimulatedKey): boolean | void {
    return this.scope.dispatch(key);
  }
}

export class Notice {
  static messages: string[] = [];
  message: string;

  constructor(message: string) {
    this.message = message;
    Notice.messages.push(message);
  }
}

export class Modal {
  static instances: Modal[] = [];

  app: unknown;
  containerEl: ShimElement;
  modalEl: ShimElement;
  titleEl: ShimElement;
  contentEl: ShimElement;
  scope: Scope;
  isOpen = false;

  constructor(app: unknown) {
    this.app = app;
    this.containerEl = new ShimElement("div");
    this.modalEl = new ShimElement("div").addClass("modal");
    this.titleEl = new ShimElement("div").addClass("modal-title");
    this.contentEl = new ShimElement("div").addClass("modal-content");
    this.modalEl.appendChild(this.contentEl);
    this.containerEl.appendChild(this.modalEl);
    this.scope = new Scope();
    Modal.instances.push(this);
  }

  open(): void {
    this.isOpen = true;
    this.onOpen();
  }

  close(): void {
    this.isOpen = false;
    this.onClose();
  }

  onOpen(): void {}
  onClose(): void {}
}

export class ItemView extends Component {
  leaf: unknown;
  containerEl = new ShimElement("div");
  contentEl = new ShimElement("div");
  viewType = "item";

  constructor(leaf: unknown) {
    super();
    this.leaf = leaf;
    this.containerEl.appendChild(this.contentEl);
  }

  getViewType(): string {
    return this.viewType;
  }

  getDisplayText(): string {
    return "item";
  }

  getIcon(): string {
    return "file";
  }

  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
}

export class MarkdownView extends Component {
  app: unknown;
  file: TFile | null;
  editor: unknown;
  mode: "source" | "preview" = "source";
  contentEl = new ShimElement("div");
  containerEl = new ShimElement("div");
  rerenders = 0;
  previewMode = { rerender: () => { this.rerenders += 1; } };

  constructor(app: unknown, file: TFile | null, editor: unknown) {
    super();
    this.app = app;
    this.file = file;
    this.editor = editor;
  }

  getMode(): "source" | "preview" {
    return this.mode;
  }

  getViewType(): string {
    return "markdown";
  }
}

export class Vault {
  files: TFile[];
  handlers = new Map<string, EventRef[]>();

  constructor(files: TFile[] = []) {
    this.files = files;
  }

  getMarkdownFiles(): TFile[] {
    return this.files;
  }

  getAbstractFileByPath(path: string): TFile | null {
    return this.files.find((file) => file.path === path) ?? null;
  }

  async cachedRead(file: TFile): Promise<string> {
    return file.content;
  }

  async read(file: TFile): Promise<string> {
    return file.content;
  }

  folders: string[] = [];

  /** Mirrors the real vault: creating an existing path is an error. */
  async create(path: string, data = ""): Promise<TFile> {
    if (this.files.some((file) => file.path === path)) {
      throw new Error(`File already exists: ${path}`);
    }
    const file = new TFile(path, data);
    this.files.push(file);
    return file;
  }

  async createFolder(path: string): Promise<{ path: string }> {
    if (!this.folders.includes(path)) this.folders.push(path);
    return { path };
  }

  getFiles(): TFile[] {
    return this.files;
  }

  /** Atomic read-modify-write, like the real `Vault.process`. */
  async process(file: TFile, transform: (data: string) => string): Promise<string> {
    const next = transform(file.content);
    if (next !== file.content) {
      file.content = next;
      file.stat.size = next.length;
      file.stat.mtime += 1;
    }
    return next;
  }

  on(name: string, callback: (...args: never[]) => unknown): EventRef {
    const ref: EventRef = { name, callback };
    const list = this.handlers.get(name) ?? [];
    list.push(ref);
    this.handlers.set(name, list);
    return ref;
  }

  offref(ref: EventRef): void {
    const list = this.handlers.get(ref.name) ?? [];
    this.handlers.set(ref.name, list.filter((candidate) => candidate !== ref));
  }

  trigger(name: string, ...args: unknown[]): void {
    for (const ref of this.handlers.get(name) ?? []) {
      (ref.callback as unknown as (...a: unknown[]) => unknown)(...args);
    }
  }
}

export class WorkspaceLeaf {
  view: unknown = null;
  viewState: Record<string, unknown> = {};

  setViewState(state: Record<string, unknown>): Promise<void> {
    this.viewState = state;
    return Promise.resolve();
  }

  async openFile(file: TFile): Promise<void> {
    this.openedFile = file;
    // The real workspace renders the file in this leaf; a test that supplies a
    // view for the file keeps it, so the caret path stays reachable.
    if (this.view === null) return;
    const view = this.view as { file?: TFile | null };
    if (view.file !== undefined) view.file = file;
  }

  openedFile: TFile | null = null;

  getViewState(): Record<string, unknown> {
    return this.viewState;
  }
}

export class Workspace {
  activeView: unknown = null;
  leaves: WorkspaceLeaf[] = [];
  handlers = new Map<string, EventRef[]>();
  rightLeaf = new WorkspaceLeaf();

  getActiveViewOfType<T>(type: abstract new (...args: never[]) => T): T | null {
    return this.activeView instanceof (type as unknown as new () => T) ? (this.activeView as T) : null;
  }

  getActiveFile(): TFile | null {
    const view = this.activeView as { file?: TFile | null } | null;
    return view?.file ?? null;
  }

  getLeavesOfType(type: string): WorkspaceLeaf[] {
    return this.leaves.filter(
      (leaf) => (leaf.view as { getViewType?: () => string } | null)?.getViewType?.() === type
    );
  }

  getRightLeaf(): WorkspaceLeaf {
    return this.rightLeaf;
  }

  /** The argument each `getLeaf` call asked for, so a test can see `"tab"`. */
  leafRequests: Array<string | boolean | undefined> = [];
  /** Leaves handed out by `getLeaf`, newest last. */
  openedLeaves: WorkspaceLeaf[] = [];

  getLeaf(newLeaf?: "tab" | "split" | "window" | boolean): WorkspaceLeaf {
    this.leafRequests.push(newLeaf);
    // `true` is the deprecated spelling of `"tab"`: both mean a leaf of its own.
    if (newLeaf === true || typeof newLeaf === "string") {
      const leaf = new WorkspaceLeaf();
      this.leaves.push(leaf);
      this.openedLeaves.push(leaf);
      return leaf;
    }
    return this.rightLeaf;
  }

  revealLeaf(leaf?: WorkspaceLeaf): Promise<void> {
    if (leaf !== undefined && leaf.view !== null) this.activeView = leaf.view;
    return Promise.resolve();
  }

  setActiveLeaf(leaf: WorkspaceLeaf, params?: { focus?: boolean } | boolean): void {
    this.activeLeafCalls.push(leaf);
    if (typeof params === "boolean") return;
    if (leaf.view !== null) this.activeView = leaf.view;
  }

  activeLeafCalls: WorkspaceLeaf[] = [];

  onLayoutReady(callback: () => void): void {
    callback();
  }

  on(name: string, callback: (...args: never[]) => unknown): EventRef {
    const ref: EventRef = { name, callback };
    const list = this.handlers.get(name) ?? [];
    list.push(ref);
    this.handlers.set(name, list);
    return ref;
  }

  offref(ref: EventRef): void {
    const list = this.handlers.get(ref.name) ?? [];
    this.handlers.set(ref.name, list.filter((candidate) => candidate !== ref));
  }

  trigger(name: string, ...args: unknown[]): void {
    for (const ref of this.handlers.get(name) ?? []) {
      (ref.callback as unknown as (...a: unknown[]) => unknown)(...args);
    }
  }

  updateOptions(): void {}
}

export class App {
  vault: Vault;
  workspace = new Workspace();
  keymap = new Keymap();
  scope = new Scope();
  /** Present but empty by default, like a vault with no Daily Notes options. */
  internalPlugins: unknown = null;
  /** The vault-local storage the shipped app exposes to plugins. */
  private readonly local = new Map<string, unknown>();

  constructor(files: TFile[] = []) {
    this.vault = new Vault(files);
  }

  loadLocalStorage(key: string): unknown | null {
    return this.local.has(key) ? this.local.get(key) : null;
  }

  saveLocalStorage(key: string, value: unknown): void {
    if (value === null) this.local.delete(key);
    else this.local.set(key, value);
  }
}

export class Plugin extends Component {
  app: App;
  manifest: { version: string } & Record<string, unknown>;
  commands: Array<Record<string, unknown>> = [];
  ribbonIcons: Array<{ icon: string; title: string; callback: () => unknown }> = [];
  settingTabs: unknown[] = [];
  views = new Map<string, unknown>();
  postProcessors: Array<(element: ShimElement, context: unknown) => void> = [];
  editorExtensions: unknown[] = [];
  stored: unknown = null;

  constructor(app: App, manifest: { version: string } & Record<string, unknown>) {
    super();
    this.app = app;
    this.manifest = manifest;
  }

  addCommand(command: Record<string, unknown>): Record<string, unknown> {
    this.commands.push(command);
    return command;
  }

  addRibbonIcon(icon: string, title: string, callback: () => unknown): ShimElement {
    this.ribbonIcons.push({ icon, title, callback });
    return new ShimElement("div");
  }

  addSettingTab(tab: unknown): void {
    this.settingTabs.push(tab);
  }

  registerView(type: string, factory: unknown): void {
    this.views.set(type, factory);
  }

  registerMarkdownPostProcessor(processor: (element: ShimElement, context: unknown) => void): unknown {
    this.postProcessors.push(processor);
    return processor;
  }

  registerEditorExtension(extension: unknown): void {
    const list = Array.isArray(extension) ? extension : [extension];
    this.editorExtensions.push(...list);
  }

  async loadData(): Promise<unknown> {
    return this.stored;
  }

  async saveData(data: unknown): Promise<void> {
    this.stored = JSON.parse(JSON.stringify(data));
  }
}

export class MarkdownRenderChild extends Component {
  containerEl: ShimElement;

  constructor(containerEl: ShimElement) {
    super();
    this.containerEl = containerEl;
  }
}

export class PluginSettingTab {
  app: App;
  plugin: Plugin;
  containerEl = new ShimElement("div");

  constructor(app: App, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
  }

  display(): void {}
  hide(): void {}
}

class FakeComponent {
  kind: string;
  el: ShimElement;
  value: unknown;
  disabled = false;
  options = new Map<string, string>();
  changeHandler?: (value: unknown) => void;
  clickHandler?: () => void;

  constructor(kind: string, el: ShimElement) {
    this.kind = kind;
    this.el = el;
    this.value = kind === "toggle" ? false : "";
  }

  setValue(value: unknown): this {
    this.value = value;
    return this;
  }

  getValue(): unknown {
    return this.value;
  }

  setPlaceholder(): this {
    return this;
  }

  setLimits(): this {
    return this;
  }

  setDynamicTooltip(): this {
    return this;
  }

  addOption(key: string, label: string): this {
    this.options.set(String(key), label);
    return this;
  }

  addOptions(options: Record<string, string>): this {
    for (const [key, label] of Object.entries(options)) this.options.set(key, label);
    return this;
  }

  setButtonText(): this {
    return this;
  }

  setCta(): this {
    return this;
  }

  setIcon(): this {
    return this;
  }

  setTooltip(): this {
    return this;
  }

  onChange(callback: (value: unknown) => void): this {
    this.changeHandler = callback;
    return this;
  }

  onClick(callback: () => void): this {
    this.clickHandler = callback;
    return this;
  }

  then(callback: (component: FakeComponent) => void): this {
    callback(this);
    return this;
  }
}

export class Setting {
  static instances: Setting[] = [];
  containerEl: ShimElement;
  controlEl: ShimElement;
  components: FakeComponent[] = [];
  name = "";
  desc = "";
  heading = false;

  constructor(containerEl: ShimElement) {
    this.containerEl = containerEl;
    this.controlEl = containerEl.createDiv({ cls: "setting-item-control" });
    Setting.instances.push(this);
  }

  setName(name: string): this {
    this.name = name;
    return this;
  }

  setDesc(desc: string): this {
    this.desc = desc;
    return this;
  }

  setHeading(): this {
    this.heading = true;
    return this;
  }

  addText(callback: (component: FakeComponent) => void): this {
    return this.addComponent("text", callback);
  }

  addTextArea(callback: (component: FakeComponent) => void): this {
    return this.addComponent("textarea", callback);
  }

  addToggle(callback: (component: FakeComponent) => void): this {
    return this.addComponent("toggle", callback);
  }

  addDropdown(callback: (component: FakeComponent) => void): this {
    return this.addComponent("dropdown", callback);
  }

  addSlider(callback: (component: FakeComponent) => void): this {
    return this.addComponent("slider", callback);
  }

  addButton(callback: (component: FakeComponent) => void): this {
    return this.addComponent("button", callback);
  }

  addExtraButton(callback: (component: FakeComponent) => void): this {
    return this.addComponent("extra", callback);
  }

  private addComponent(kind: string, callback: (component: FakeComponent) => void): this {
    const el = this.controlEl.createDiv({ cls: `setting-item-control setting-${kind}` });
    const component = new FakeComponent(kind, el);
    this.components.push(component);
    callback(component);
    return this;
  }
}

/** Every request the stub was asked to make, in order. */
export const requestUrlCalls: Array<Record<string, unknown>> = [];

/**
 * What the stub's `requestUrl` answers, by default an unreachable endpoint: a
 * `599` with no payload. A test that needs a real status and a real body replaces
 * this, which is how the model port is exercised without a socket.
 */
export const requestUrlReply: { status: number; json: unknown; text: string } = {
  status: 599,
  json: null,
  text: ""
};

/** `requestUrl`: records the request, then answers whatever `requestUrlReply` says. */
export async function requestUrl(request: Record<string, unknown>): Promise<{
  status: number;
  json: unknown;
  text: string;
}> {
  requestUrlCalls.push(request);
  return { ...requestUrlReply };
}

export function debounce<T extends (...args: never[]) => unknown>(fn: T): T {
  return fn;
}

export function setTooltip(el: { setAttr(name: string, value: unknown): unknown }, tooltip: string): void {
  el.setAttr("aria-label", tooltip);
}

export function setIcon(): void {}

export function normalizePath(path: string): string {
  return path;
}

export { ShimElement };
