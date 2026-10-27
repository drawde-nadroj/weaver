import { MarkdownView, Notice, Scope } from "obsidian";
import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from "@codemirror/view";

import type { DraftBlock } from "../core/drafts";
import { findHeadingAtLine, type Heading, type HeadingIndex } from "../core/headings";
import {
  childTarget,
  draftTravelLabel,
  findDraft,
  firstDraftTarget,
  firstTarget,
  initialDraftTarget,
  initialTravelTarget,
  lastDraftTarget,
  lastTarget,
  levelTargets,
  moveDraftTarget,
  moveTravelTarget,
  orderedDrafts,
  parentTarget,
  travelLabel,
  travelLineSpecs,
  type LevelFilter,
  type TravelDirection,
  type TravelKind,
  type TravelSelection
} from "../core/travel";
import type WeaverPlugin from "../main";
import {
  NOTICE_NO_DRAFTS,
  NOTICE_NO_DIMENSIONS,
  NOTICE_NOOP_MS,
  NOTICE_PARTIAL_MS,
  NOTICE_REFUSAL_MS,
  NOTICE_TRAVEL_EDITING_ONLY,
  NOTICE_TRAVEL_KEYS
} from "../notices";
import { isPhone } from "../ui/platform";
import { TravelBar, TravelHud, type TravelActions, type TravelSurfaceState } from "../ui/travel-bar";
import { headingIndexField } from "./index-field";
import { findActiveEditorView, findEditorViewForFile } from "./view-registry";

const INACTIVE: TravelSelection = {
  active: false,
  kind: "headings",
  level: "all",
  targetLine: null,
  draftId: null
};

export const enterTravel = StateEffect.define<{
  level: LevelFilter;
  targetLine: number | null;
}>();
export const exitTravel = StateEffect.define<void>();
export const setTravelLevel = StateEffect.define<{
  level: LevelFilter;
  targetLine: number | null;
  draftId: string | null;
}>();
export const setTravelTarget = StateEffect.define<{
  targetLine: number | null;
  draftId: string | null;
}>();
/** `Tab`: switches between headings and drafts without changing the level. */
export const setTravelKind = StateEffect.define<{
  kind: TravelKind;
  level: LevelFilter;
  targetLine: number | null;
  draftId: string | null;
}>();

export const travelField = StateField.define<TravelSelection>({
  create: () => INACTIVE,
  update: (value, transaction) => {
    let next = value;

    for (const effect of transaction.effects) {
      if (effect.is(enterTravel)) {
        next = {
          active: true,
          kind: "headings",
          level: effect.value.level,
          targetLine: effect.value.targetLine,
          draftId: null
        };
      } else if (effect.is(exitTravel)) {
        next = INACTIVE;
      } else if (effect.is(setTravelLevel)) {
        next = {
          ...next,
          level: effect.value.level,
          targetLine: effect.value.targetLine,
          draftId: effect.value.draftId
        };
      } else if (effect.is(setTravelTarget)) {
        next = { ...next, targetLine: effect.value.targetLine, draftId: effect.value.draftId };
      } else if (effect.is(setTravelKind)) {
        next = {
          ...next,
          kind: effect.value.kind,
          level: effect.value.level,
          targetLine: effect.value.targetLine,
          draftId: effect.value.draftId
        };
      }
    }

    return next;
  }
});

function buildTravelDecorations(view: EditorView): DecorationSet {
  const index = view.state.field(headingIndexField, false);
  const travel = view.state.field(travelField, false);
  if (index === undefined || travel === undefined || !travel.active) return Decoration.none;

  const specs = travelLineSpecs(index, travel);
  if (specs.length === 0) return Decoration.none;

  const builder = new RangeSetBuilder<Decoration>();
  for (const spec of specs) {
    builder.add(spec.from, spec.from, Decoration.line({ class: spec.classes.join(" ") }));
  }
  return builder.finish();
}

/** Highlights headings that match the level filter and the current target. */
export function travelExtension(): Extension {
  class TravelDecorator {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildTravelDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.transactions.length > 0) {
        this.decorations = buildTravelDecorations(update.view);
      }
    }
  }

  return [
    travelField,
    ViewPlugin.fromClass(TravelDecorator, {
      decorations: (plugin) => plugin.decorations
    })
  ];
}

/**
 * Editor-only navigation. Keys are handled through an app-level `Scope`, which
 * Obsidian evaluates in a window capture listener, so a handled key is stopped
 * before Vim or the editor can see it.
 */
export class TravelController implements TravelActions {
  private view: MarkdownView | null = null;
  private cm: EditorView | null = null;
  private scope: Scope | null = null;
  private bar: TravelBar | null = null;
  private hud: TravelHud | null = null;

  constructor(private readonly plugin: WeaverPlugin) {
    plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", () => this.exit()));
  }

  get active(): boolean {
    return this.cm !== null;
  }

  enter(): void {
    if (this.cm !== null) this.exit();

    const view = this.plugin.activeMarkdownView();
    if (view === null) return;

    if (view.getMode() !== "source") {
      new Notice(NOTICE_TRAVEL_EDITING_ONLY, NOTICE_REFUSAL_MS);
      return;
    }

    const cm = (view.file === null ? null : findEditorViewForFile(view.file)) ?? findActiveEditorView(this.plugin.app);
    if (cm === null) return;

    const index = cm.state.field(headingIndexField, false);
    if (index === undefined || index.headings.length === 0) {
      new Notice(NOTICE_NO_DIMENSIONS, NOTICE_NOOP_MS);
      return;
    }

    const level = this.defaultLevel(index);
    const target = initialTravelTarget(index, view.editor.getCursor().line, level);

    this.view = view;
    this.cm = cm;

    cm.dispatch({ effects: enterTravel.of({ level, targetLine: target?.line ?? null }) });

    this.scope = new Scope(this.plugin.app.scope);
    this.registerKeys(this.scope);
    this.plugin.app.keymap.pushScope(this.scope);

    document.body.classList.add("weaver-traveling");

    if (isPhone()) {
      view.editor.blur();
      this.bar = new TravelBar(this, this.plugin.settings.maxDepth);
    } else {
      this.hud = new TravelHud();
    }

    if (target !== null) this.focusLine(target.line);
    else this.renderSurfaces();

    this.plugin.log("travel entered", { level, target: target?.line ?? null });
  }

  exit(): void {
    if (this.cm === null && this.scope === null) return;

    const cm = this.cm;
    const view = this.view;

    this.bar?.destroy();
    this.bar = null;
    this.hud?.destroy();
    this.hud = null;
    document.body.classList.remove("weaver-traveling");

    if (this.scope !== null) this.plugin.app.keymap.popScope(this.scope);
    this.scope = null;

    this.cm = null;
    this.view = null;

    cm?.dispatch({ effects: exitTravel.of(undefined) });
    view?.editor.focus();
  }

  destroy(): void {
    this.exit();
  }

  setLevel(level: LevelFilter): void {
    const cm = this.cm;
    if (cm === null) return;

    const index = cm.state.field(headingIndexField);
    const state = cm.state.field(travelField);

    if (state.kind === "drafts") {
      const anchor =
        findDraft(index, state.draftId)?.titleLine ?? this.view?.editor.getCursor().line ?? 0;
      const target = initialDraftTarget(index, anchor, level);
      cm.dispatch({
        effects: setTravelLevel.of({ level, targetLine: null, draftId: target?.id ?? null })
      });
      if (target !== null) this.focusDraft(target);
      else this.renderSurfaces();
      return;
    }

    const anchor = state.targetLine ?? this.view?.editor.getCursor().line ?? 0;
    const target = initialTravelTarget(index, anchor, level);
    cm.dispatch({
      effects: setTravelLevel.of({ level, targetLine: target?.line ?? null, draftId: null })
    });
    if (target !== null) this.focusLine(target.line);
    else this.renderSurfaces();
  }

  /** `Tab`: headings ⇄ drafts. The level filter carries over. */
  toggleKind(): void {
    const cm = this.cm;
    if (cm === null) return;

    const index = cm.state.field(headingIndexField);
    const state = cm.state.field(travelField);
    const cursorLine = this.view?.editor.getCursor().line ?? 0;

    if (state.kind === "headings") {
      if (index.drafts.length === 0) {
        new Notice(NOTICE_NO_DRAFTS, NOTICE_NOOP_MS);
        return;
      }

      const target = initialDraftTarget(index, cursorLine, state.level);
      cm.dispatch({
        effects: setTravelKind.of({
          kind: "drafts",
          level: state.level,
          targetLine: null,
          draftId: target?.id ?? null
        })
      });
      if (target !== null) this.focusDraft(target);
      else this.renderSurfaces();
      return;
    }

    const anchor = findDraft(index, state.draftId)?.titleLine ?? cursorLine;
    const target = initialTravelTarget(index, anchor, state.level);
    cm.dispatch({
      effects: setTravelKind.of({
        kind: "headings",
        level: state.level,
        targetLine: target?.line ?? null,
        draftId: null
      })
    });
    if (target !== null) this.focusLine(target.line);
    else this.renderSurfaces();
  }

  move(direction: TravelDirection): void {
    const cm = this.cm;
    if (cm === null) return;

    const index = cm.state.field(headingIndexField);
    const state = cm.state.field(travelField);

    if (state.kind === "drafts") {
      const target = moveDraftTarget(
        index,
        findDraft(index, state.draftId),
        state.level,
        direction,
        this.plugin.settings.travelWrap
      );
      if (target !== null) this.focusDraft(target);
      return;
    }

    const current = state.targetLine === null ? null : findHeadingAtLine(index, state.targetLine);
    const target = moveTravelTarget(index, current, state.level, direction, this.plugin.settings.travelWrap);

    if (target !== null) this.focusLine(target.line);
  }

  /** Parent/child are heading-only moves; drafts are chronological. */
  parent(): void {
    if (this.kind() === "drafts") return;
    this.stepRelative(parentTarget);
  }

  child(): void {
    if (this.kind() === "drafts") return;
    this.stepRelative(childTarget);
  }

  goFirst(): void {
    const cm = this.cm;
    if (cm === null) return;

    const index = cm.state.field(headingIndexField);
    const state = cm.state.field(travelField);

    if (state.kind === "drafts") {
      const target = firstDraftTarget(index, state.level);
      if (target !== null) this.focusDraft(target);
      return;
    }

    const target = firstTarget(index, state.level);
    if (target !== null) this.focusLine(target.line);
  }

  goLast(): void {
    const cm = this.cm;
    if (cm === null) return;

    const index = cm.state.field(headingIndexField);
    const state = cm.state.field(travelField);

    if (state.kind === "drafts") {
      const target = lastDraftTarget(index, state.level);
      if (target !== null) this.focusDraft(target);
      return;
    }

    const target = lastTarget(index, state.level);
    if (target !== null) this.focusLine(target.line);
  }

  private kind(): TravelKind {
    return this.cm?.state.field(travelField, false)?.kind ?? "headings";
  }

  private stepRelative(next: (index: HeadingIndex, current: Heading) => Heading | null): void {
    const cm = this.cm;
    if (cm === null) return;

    const index = cm.state.field(headingIndexField);
    const state = cm.state.field(travelField);
    const current = state.targetLine === null ? null : findHeadingAtLine(index, state.targetLine);
    if (current === null) return;

    const target = next(index, current);
    if (target !== null) this.focusLine(target.line);
  }

  private focusLine(line: number): void {
    const view = this.view;
    const cm = this.cm;
    if (view === null || cm === null) return;

    const position = { line, ch: 0 };
    view.editor.setCursor(position);
    view.editor.scrollIntoView({ from: position, to: position }, true);
    cm.dispatch({ effects: setTravelTarget.of({ targetLine: line, draftId: null }) });
    this.renderSurfaces();
  }

  /** Drafts are addressed by their title line, so the caret lands in the words. */
  private focusDraft(draft: DraftBlock): void {
    const view = this.view;
    const cm = this.cm;
    if (view === null || cm === null) return;

    const position = { line: draft.titleLine, ch: 0 };
    view.editor.setCursor(position);
    view.editor.scrollIntoView({ from: position, to: position }, true);
    cm.dispatch({ effects: setTravelTarget.of({ targetLine: null, draftId: draft.id }) });
    this.renderSurfaces();
  }

  private renderSurfaces(): void {
    const cm = this.cm;
    if (cm === null) return;

    const state = cm.state.field(travelField);
    const index = cm.state.field(headingIndexField);
    const maxDepth = this.plugin.settings.maxDepth;

    if (state.kind === "drafts") {
      const drafts = orderedDrafts(index, state.level);
      const target = findDraft(index, state.draftId);
      const position =
        target === null ? 0 : drafts.findIndex((draft) => draft.id === target.id) + 1;

      const surface: TravelSurfaceState = {
        kind: "drafts",
        level: state.level,
        maxDepth,
        label: target === null ? "" : draftTravelLabel(target),
        canParent: false,
        canChild: false,
        position: Math.max(0, position),
        total: drafts.length,
        targetLevel: target?.level ?? null
      };

      this.hud?.render(surface);
      this.bar?.render(surface);
      return;
    }

    const target = state.targetLine === null ? null : findHeadingAtLine(index, state.targetLine);
    const surface: TravelSurfaceState = {
      kind: "headings",
      level: state.level,
      maxDepth,
      label: target === null ? "" : travelLabel(target),
      canParent: target !== null && parentTarget(index, target) !== null,
      canChild: target !== null && childTarget(index, target) !== null,
      position: 0,
      total: 0,
      targetLevel: null
    };

    this.hud?.render(surface);
    this.bar?.render(surface);
  }

  private defaultLevel(index: HeadingIndex): LevelFilter {
    const configured = this.plugin.settings.travelDefaultLevel;
    if (configured === "all") return "all";
    return levelTargets(index, configured).length > 0 ? configured : "all";
  }

  private registerKeys(scope: Scope): void {
    // `[]` (not `null`) so only *unmodified* keys are captured: with `null`,
    // Cmd+A, Cmd+C and friends would be swallowed too.
    const bind = (key: string, action: () => void): void => {
      scope.register([], key, () => {
        action();
        return false;
      });
    };

    for (let digit = 1; digit <= 9; digit += 1) bind(String(digit), () => this.setLevel(digit));
    bind("0", () => this.setLevel("all"));
    bind("a", () => this.setLevel("all"));

    bind("ArrowUp", () => this.move("prev"));
    bind("k", () => this.move("prev"));
    bind("ArrowDown", () => this.move("next"));
    bind("j", () => this.move("next"));
    bind("ArrowLeft", () => this.parent());
    bind("h", () => this.parent());
    bind("ArrowRight", () => this.child());
    bind("l", () => this.child());
    bind("g", () => this.goFirst());
    bind("Home", () => this.goFirst());
    // Shift is part of the binding: Obsidian's key matching is case-insensitive
    // for letters, so `G` is only distinguishable from `g` by its modifiers.
    scope.register(["Shift"], "G", () => {
      this.goLast();
      return false;
    });
    bind("End", () => this.goLast());

    bind("Tab", () => this.toggleKind());

    bind("Enter", () => this.exit());
    bind("Escape", () => this.exit());
    bind("q", () => this.exit());

    // `?` normally needs Shift on most layouts, so it is matched with any
    // modifiers rather than `[]`.
    scope.register(null, "?", () => {
      new Notice(NOTICE_TRAVEL_KEYS, NOTICE_PARTIAL_MS);
      return false;
    });

    // Registered last: modifier combinations pass through so global hotkeys
    // still work, while unmodified keys are swallowed instead of typing.
    scope.register(null, null, (_event, context) => context.modifiers !== "");
  }
}
