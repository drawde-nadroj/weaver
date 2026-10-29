import { editorInfoField, type App, type TFile } from "obsidian";
import { EditorView, ViewPlugin } from "@codemirror/view";

/** Every live CodeMirror view, so controllers can find one without a leaf scan. */
const views = new Set<EditorView>();

/** The registry's only door in, so a test can stand a view in for a real one. */
export function registerEditorView(view: EditorView): void {
  views.add(view);
}

export function unregisterEditorView(view: EditorView): void {
  views.delete(view);
}

export const viewRegistryExtension = ViewPlugin.fromClass(
  class {
    constructor(private readonly view: EditorView) {
      registerEditorView(view);
    }

    destroy() {
      unregisterEditorView(this.view);
    }
  }
);

export function registeredEditorViews(): readonly EditorView[] {
  return [...views];
}

/** The editor showing `file`, preferring the focused one. */
export function findEditorViewForFile(file: TFile): EditorView | null {
  let fallback: EditorView | null = null;

  for (const view of views) {
    const info = view.state.field(editorInfoField, false);
    if (info === undefined || info.file !== file) continue;
    if (view.hasFocus) return view;
    fallback ??= view;
  }

  return fallback;
}

/** The focused editor, else the editor of the active file. */
export function findActiveEditorView(app: App): EditorView | null {
  for (const view of views) {
    if (view.hasFocus) return view;
  }

  const file = app.workspace.getActiveFile();
  return file === null ? null : findEditorViewForFile(file);
}
