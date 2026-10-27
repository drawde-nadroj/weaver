import { editorLivePreviewField } from "obsidian";
import {
  RangeSetBuilder,
  StateField,
  type EditorState,
  type Extension
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet
} from "@codemirror/view";

import { type DraftBlock } from "../core/drafts";
import type { WeaverSettings } from "../settings";
import {
  buildDraftBadge,
  refreshDraftElapsed,
  type DraftBadgeHandlers
} from "../ui/draft-badge";
import { headingIndexField, refreshHeadingsEffect } from "./index-field";

const TICK_MS = 1000;

/**
 * Replaces an open marker line with the draft badge. The badge ticks its own
 * elapsed time locally and never writes to the document.
 */
class DraftBadgeWidget extends WidgetType {
  private timer: number | null = null;

  constructor(
    private readonly draft: DraftBlock,
    private readonly opened: number,
    private readonly handlers: DraftBadgeHandlers
  ) {
    super();
  }

  eq(other: DraftBadgeWidget): boolean {
    return (
      other.draft.id === this.draft.id &&
      other.draft.openedAt === this.draft.openedAt &&
      other.draft.title === this.draft.title &&
      other.draft.level === this.draft.level &&
      other.handlers.maxDepth === this.handlers.maxDepth
    );
  }

  toDOM(): HTMLElement {
    // `toDOM` may be called more than once for one widget instance.
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }

    const host = document.createElement("div");
    host.className = "weaver-draft-host";

    const badge = buildDraftBadge(this.draft, new Date(this.opened), this.handlers);
    host.appendChild(badge);

    this.timer = window.setInterval(() => {
      refreshDraftElapsed(host, this.draft, new Date());
    }, TICK_MS);

    return host;
  }

  destroy(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/** Zero-height placeholder that removes the close marker from the layout. */
class DraftEndWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const element = document.createElement("div");
    element.className = "weaver-draft-end";
    return element;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/** True when the caret or selection touches this line, so the marker stays raw. */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  const selection = state.selection.main;
  return selection.from <= to && selection.to >= from;
}

function blockEnd(state: EditorState, lineTo: number): number {
  return lineTo < state.doc.length ? lineTo + 1 : lineTo;
}

/**
 * The decoration set for one state. Exported so the ranges can be asserted
 * without a live `EditorView`, which needs a real browser to measure.
 */
export function draftDecorationSet(
  state: EditorState,
  settings: WeaverSettings,
  handlers: DraftBadgeHandlers
): DecorationSet {
  const index = state.field(headingIndexField, false);
  if (index === undefined || index.drafts.length === 0) return Decoration.none;
  if (!settings.inPageDrafts) return Decoration.none;
  // Source mode is never decorated: the markers are the point of it.
  if (state.field(editorLivePreviewField, false) !== true) return Decoration.none;

  const builder = new RangeSetBuilder<Decoration>();
  const now = Date.now();

  for (const draft of index.drafts) {
    const openLine = state.doc.line(draft.openLine + 1);
    const closeLine = state.doc.line(draft.closeLine + 1);

    if (!selectionTouches(state, openLine.from, openLine.to)) {
      builder.add(
        openLine.from,
        blockEnd(state, openLine.to),
        Decoration.replace({ block: true, widget: new DraftBadgeWidget(draft, now, handlers) })
      );
    } else {
      builder.add(openLine.from, openLine.from, Decoration.line({ class: "weaver-draft-marker" }));
    }

    if (draft.titleLine < draft.closeLine) {
      addLineClass(state, builder, draft.titleLine, "weaver-draft-title");
      for (let line = draft.bodyFrom; line < draft.bodyTo; line += 1) {
        addLineClass(state, builder, line, "weaver-draft-body");
      }
    }

    if (!selectionTouches(state, closeLine.from, closeLine.to)) {
      builder.add(
        closeLine.from,
        blockEnd(state, closeLine.to),
        Decoration.replace({ block: true, widget: new DraftEndWidget() })
      );
    } else {
      builder.add(closeLine.from, closeLine.from, Decoration.line({ class: "weaver-draft-marker" }));
    }
  }

  return builder.finish();
}

function addLineClass(
  state: EditorState,
  builder: RangeSetBuilder<Decoration>,
  line: number,
  className: string
): void {
  if (line + 1 > state.doc.lines) return;
  const target = state.doc.line(line + 1);
  builder.add(target.from, target.from, Decoration.line({ class: className }));
}

/**
 * Renders draft blocks as cards in Live Preview. The markers stay visible and
 * editable whenever the caret is inside them.
 */
export function draftDecorationsExtension(
  getSettings: () => WeaverSettings,
  getHandlers: () => DraftBadgeHandlers
): Extension {
  const draftField = StateField.define<DecorationSet>({
    create: (state) => draftDecorationSet(state, getSettings(), getHandlers()),
    update: (value, transaction) => {
      if (
        transaction.docChanged ||
        transaction.selection !== undefined ||
        transaction.effects.some((effect) => effect.is(refreshHeadingsEffect))
      ) {
        return draftDecorationSet(transaction.state, getSettings(), getHandlers());
      }
      return value;
    }
  });

  return [draftField, EditorView.decorations.from(draftField)];
}
