/* Typed access to the runtime stub. Tests import from here instead of poking
 * at stub-only members through the real `obsidian` typings. */

import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { editorInfoField, type App, type MarkdownFileInfo, type MarkdownView, type TFile } from "obsidian";

import { resetDom, shimDocument, ShimElement } from "./dom";
import {
  App as StubApp,
  Setting,
  Keymap,
  MarkdownView as StubMarkdownView,
  Modal,
  Notice,
  TFile as StubTFile,
  WorkspaceLeaf,
  type SimulatedKey
} from "./obsidian-stub";

export function createApp(files: TFile[] = []): App {
  return new StubApp(files as unknown as never[]) as unknown as App;
}

export function createFile(path: string, content: string): TFile {
  return new StubTFile(path, content) as unknown as TFile;
}

/** A CodeMirror view double that really applies what it is dispatched. */
export interface LiveEditor {
  state: EditorState;
  dispatches: number;
  dispatch(spec: Parameters<EditorState["update"]>[0]): void;
  focus(): void;
  hasFocus: boolean;
  scrollDOM: { scrollTop: number };
}

/** The view a live editor would be, over `doc`, holding `file`. Register it with
 * `registerEditorView` for the paths that look a view up by file. */
export function liveEditor(file: TFile, doc: string, anchor = 0): EditorView & LiveEditor {
  const initial = EditorState.create({
    doc,
    selection: { anchor },
    extensions: [editorInfoField.init(() => ({ file }) as unknown as MarkdownFileInfo)]
  });

  const view = {
    state: initial,
    dispatches: 0,
    dispatch(this: LiveEditor, spec: Parameters<EditorState["update"]>[0]) {
      this.state = this.state.update(spec).state;
      this.dispatches += 1;
    },
    focus() {},
    hasFocus: true,
    scrollDOM: { scrollTop: 0 }
  };

  return view as unknown as EditorView & LiveEditor;
}

/** The stub vault keeps a file's text on the `TFile` itself, not behind `read`. */
export function fileContent(file: TFile | null | undefined): string {
  return (file as unknown as { content?: string } | null)?.content ?? "";
}

export function createView(
  app: App,
  file: TFile,
  editor: unknown,
  mode: "source" | "preview" = "source"
): MarkdownView {
  const view = new StubMarkdownView(app as never, file as never, editor) as unknown as MarkdownView & {
    mode: "source" | "preview";
  };
  view.mode = mode;
  return view;
}

export function setActiveView(app: App, view: MarkdownView): void {
  const workspace = app.workspace as unknown as { activeView: unknown; leaves: unknown[] };
  workspace.activeView = view;
  workspace.leaves.push(new WorkspaceLeaf());
}

export function addLeafWithView(app: App, view: MarkdownView): void {
  const workspace = app.workspace as unknown as { leaves: unknown[] };
  const leaf = new WorkspaceLeaf();
  (leaf as unknown as { view: unknown }).view = view;
  workspace.leaves.push(leaf);
}

export function setRect(
  element: unknown,
  top: number,
  height = 20,
  left = 0,
  width = 100
): void {
  (element as ShimElement).rect = {
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height
  };
}

export function rerenderCount(view: MarkdownView): number {
  return (view as unknown as { rerenders: number }).rerenders;
}

export interface RegisteredCommand {
  id: string;
  name?: string;
  icon?: string;
  hotkeys?: Array<{ modifiers: string[]; key: string }>;
}

/** The stub records registered commands, views and post processors. */
interface PluginInternals {
  commands?: RegisteredCommand[];
  postProcessors?: Array<(element: ShimElement, context: unknown) => void>;
  editorExtensions?: unknown[];
}

function internals(plugin: object): PluginInternals {
  return plugin as unknown as PluginInternals;
}

export function registeredCommands(plugin: object): RegisteredCommand[] {
  return [...(internals(plugin).commands ?? [])];
}

export function postProcessors(plugin: object): Array<(element: ShimElement, context: unknown) => void> {
  return [...(internals(plugin).postProcessors ?? [])];
}

export function editorExtensions(plugin: object): unknown[] {
  return [...(internals(plugin).editorExtensions ?? [])];
}

/** Every modal opened since the last reset, oldest first. */
export function openedModals(): unknown[] {
  return [...(Modal as unknown as { instances: unknown[] }).instances];
}

/** The most recent opened modal that is an instance of `ctor`. */
export function lastModal<T>(ctor: abstract new (...args: never[]) => T): T | null {
  const instances = openedModals();
  for (let index = instances.length - 1; index >= 0; index -= 1) {
    const candidate = instances[index];
    if (candidate instanceof (ctor as unknown as new () => T)) return candidate;
  }
  return null;
}

export function modalIsOpen(modal: unknown): boolean {
  return (modal as { isOpen?: boolean }).isOpen === true;
}

/** Shim DOM helpers: `root` is any Obsidian element. */
export function nodes(root: unknown, selector: string): ShimElement[] {
  return (root as ShimElement).querySelectorAll(selector);
}

export function node(root: unknown, selector: string, index = 0): ShimElement | null {
  return nodes(root, selector)[index] ?? null;
}

export function textOf(target: ShimElement | null): string {
  return target?.textContent ?? "";
}

export function valueOf(target: ShimElement | null): string {
  return target?.value ?? "";
}

export function setValue(target: ShimElement | null, value: string): void {
  if (target === null) throw new Error("setValue on a missing element");
  target.value = value;
}

export function fire(target: ShimElement | null, type: string, event: Record<string, unknown> = {}): void {
  if (target === null) throw new Error(`fire(${type}) on a missing element`);
  target.dispatch(type, event);
}

export function click(target: ShimElement | null): void {
  if (target === null) throw new Error("click on a missing element");
  target.click();
}

export function isDisabled(target: ShimElement | null): boolean {
  return target?.disabled === true;
}

export function instantiatePlugin<T>(ctor: new (app: never, manifest: never) => T, app: App): T {
  return new ctor(app as never, { version: "0.1.0" } as never);
}

export function noticeMessages(): string[] {
  return [...Notice.messages];
}

export function clearNotices(): void {
  Notice.messages.length = 0;
}

export function resetHarness(): void {
  resetDom();
  clearNotices();
  (Modal as unknown as { instances: unknown[] }).instances.length = 0;
  (Setting as unknown as { instances: unknown[] }).instances.length = 0;
}

export interface SettingControl {
  kind: string;
  value: unknown;
  options: Map<string, string>;
  change(value: unknown): void;
  click(): void;
}

export interface UiSetting {
  name: string;
  desc: string;
  controls: SettingControl[];
}

interface RawComponent {
  kind: string;
  value: unknown;
  options: Map<string, string>;
  changeHandler?: (value: unknown) => void;
  clickHandler?: () => void;
}

function toUiSetting(setting: unknown): UiSetting {
  const raw = setting as { name?: string; desc?: string; components?: RawComponent[] };
  return {
    name: raw.name ?? "",
    desc: raw.desc ?? "",
    controls: (raw.components ?? []).map((component) => ({
      kind: component.kind,
      value: component.value,
      options: component.options,
      change(value: unknown) {
        component.changeHandler?.(value);
      },
      click() {
        component.clickHandler?.();
      }
    }))
  };
}

/** Forgets every setting rendered so far, so a re-render can be read alone. */
export function clearUiSettings(): void {
  (Setting as unknown as { instances: unknown[] }).instances.length = 0;
}

export function uiSettings(): UiSetting[] {
  return (Setting as unknown as { instances: unknown[] }).instances.map(toUiSetting);
}

/** The most recently rendered setting with this name (tabs rebuild on change). */
export function uiSetting(name: string): UiSetting | null {
  const matches = uiSettings().filter((setting) => setting.name === name);
  return matches[matches.length - 1] ?? null;
}

/** Sends a key through the active scope, exactly as Obsidian's keymap does. */
export function dispatchKey(app: App, key: SimulatedKey): boolean | void {
  return (app.keymap as unknown as Keymap).dispatch(key);
}

export function activeScope(app: App): unknown {
  return (app.keymap as unknown as Keymap).scope;
}

export function rootScope(app: App): unknown {
  return (app.keymap as unknown as Keymap).rootScope;
}

export function bodyQuery(selector: string): ShimElement | null {
  return shimDocument.body.querySelectorAll(selector)[0] ?? null;
}

export function bodyQueryAll(selector: string): ShimElement[] {
  return shimDocument.body.querySelectorAll(selector);
}

export function bodyHasClass(name: string): boolean {
  return shimDocument.body.classes.has(name);
}

export function bodyText(): string {
  return shimDocument.body.textContent;
}

export function clickAll(elements: ShimElement[], index: number): void {
  elements[index]?.click();
}

export { ShimElement, shimDocument };
