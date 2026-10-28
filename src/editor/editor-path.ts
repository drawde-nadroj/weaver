/** The file a live editor view is showing, or null when it is not a note. */

import { editorInfoField } from "obsidian";
import type { EditorView } from "@codemirror/view";

export function editorPathOf(view: EditorView): string | null {
  const info = view.state.field(editorInfoField, false);
  return info?.file?.path ?? null;
}
