/* The widget's DOM is verified by the manual Obsidian check, not here: the test
 * harness never constructs an `EditorView`. What *is* covered: the pure model
 * (every decision about what gets committed), and the decoration set — built
 * from a real `EditorState`, which needs no DOM — because CodeMirror only
 * accepts a `block: true` widget from a state field, never from a plugin. */

import { describe, expect, it } from "vitest";
import { EditorState, type StateField } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";

import type WeaverPlugin from "../src/main";
import {
  closeInsertEffect,
  insertDecorationField,
  insertStateField,
  openInsertEffect
} from "../src/editor/inline-insert-field";

import { InlineInsertWidget } from "../src/editor/inline-insert-widget";
import { parseHeadings } from "../src/core/headings";
import { node, nodes, ShimElement, textOf } from "../test-support/harness";
import { planComposerInsert } from "../src/core/composer";
import { applyPlanToSource, type InsertOptions } from "../src/core/insert";
import {
  activeRowOf,
  addRow,
  beginInsert,
  commitPlan,
  everyRowEmpty,
  setLevel,
  setTitle,
  type InsertState
} from "../src/core/inline-insert";

const NOW = new Date(2024, 0, 2, 16, 37, 4);
const OPTIONS: InsertOptions = { maxDepth: 12, separator: " - ", format: "HH:mm:ss" };
const SOURCE = "# Root\nbody";

function row(level = 2): InsertState {
  return beginInsert({ at: 0, level, maxDepth: OPTIONS.maxDepth });
}

function plan(state: InsertState, source: string, cursorLine = 0) {
  return commitPlan(state, source, parseHeadings(source, { maxDepth: 12 }), cursorLine, NOW, OPTIONS);
}

describe("beginInsert", () => {
  it("starts with one empty row at the requested level", () => {
    const state = row(3);
    expect(state.rows).toHaveLength(1);
    expect(activeRowOf(state).level).toBe(3);
    expect(activeRowOf(state).title).toBe("");
    expect(state.focus).toBe("row");
  });

  it("clamps the level into the configured depth", () => {
    expect(activeRowOf(row(99)).level).toBe(12);
    expect(activeRowOf(row(-4)).level).toBe(1);
  });
});

describe("row editing", () => {
  it("steps the active level and stops at the depth cap", () => {
    let state = row(2);
    state = setLevel(state, 1, 3);
    expect(activeRowOf(state).level).toBe(3);

    state = setLevel(state, 1, 3);
    expect(activeRowOf(state).level).toBe(3);

    state = setLevel(state, -5, 3);
    expect(activeRowOf(state).level).toBe(1);
  });

  it("adds rows after the active one at the same level", () => {
    let state = row(2);
    state = setTitle(state, state.activeRow, "first");
    state = addRow(state, 12);

    expect(state.rows).toHaveLength(2);
    expect(state.rows[1]?.level).toBe(2);
    expect(activeRowOf(state).id).toBe(state.rows[1]?.id);
    expect(state.rows[0]?.title).toBe("first");
  });

  it("knows when nothing would be written", () => {
    const state = row(2);
    expect(everyRowEmpty(state)).toBe(true);
    expect(everyRowEmpty(setTitle(state, state.activeRow, "   "))).toBe(true);
    expect(everyRowEmpty(setTitle(state, state.activeRow, "a title"))).toBe(false);
  });
});

describe("commitPlan", () => {
  it("commits every non-empty row in one block", () => {
    let state = row(2);
    state = setTitle(state, state.activeRow, "first");
    state = addRow(state, 12);
    state = setTitle(state, state.activeRow, "second");

    const rows = state.rows.map((entry) => ({
      id: entry.id,
      level: entry.level,
      title: entry.title,
      body: "",
      time: null,
      pinned: false
    }));
    const expected = planComposerInsert(
      SOURCE,
      parseHeadings(SOURCE, { maxDepth: 12 }),
      1,
      rows,
      NOW,
      OPTIONS
    );

    expect(plan(state, SOURCE, 1)).toEqual(expected);
    expect(applyPlanToSource(SOURCE, plan(state, SOURCE, 1)!).source).toBe(
      "# Root\nbody\n## 16:37:04 - first\n\n## 16:37:04 - second"
    );
  });

  it("skips an empty row instead of writing a blank dimension", () => {
    let state = row(2);
    state = addRow(state, 12);
    state = setTitle(state, state.rows[1]?.id ?? "", "only");

    expect(applyPlanToSource(SOURCE, plan(state, SOURCE, 1)!).source).toBe(
      "# Root\nbody\n## 16:37:04 - only"
    );
  });

  it("refuses when every row is empty", () => {
    expect(plan(row(2), "# Root")).toBeNull();

    let weave = row(2);
    weave = addRow(weave, 12);
    expect(plan(weave, "# Root")).toBeNull();
  });

  it("uses the level each row carries", () => {
    let state = row(1);
    state = setTitle(state, state.activeRow, "root of it");
    state = addRow(state, 12);
    state = setLevel(state, 1, 12);
    state = setTitle(state, state.activeRow, "under it");

    expect(applyPlanToSource(SOURCE, plan(state, SOURCE, 1)!).source).toBe(
      "# Root\nbody\n# 16:37:04 - root of it\n\n## 16:37:04 - under it"
    );
  });
});

describe("the control row's decorations", () => {
  /** Only the members the decoration path touches; the view adds the rest. */
  function fakePlugin(): WeaverPlugin {
    return {
      settings: { maxDepth: 12, timestampFormat: "HH:mm:ss" },
      insertOptions: () => OPTIONS
    } as unknown as WeaverPlugin;
  }

  function opened(): { state: EditorState; field: StateField<DecorationSet> } {
    const plugin = fakePlugin();
    const field = insertDecorationField(plugin);
    const state = EditorState.create({
      doc: "# A\nbody\nmore",
      extensions: [insertStateField, field]
    }).update({
      effects: openInsertEffect.of({ at: 4, level: 2, maxDepth: 12 })
    }).state;

    return { state, field };
  }

  it("comes from a state field, so a block widget is allowed at all", () => {
    // CodeMirror refuses `block: true` decorations from a *function* source
    // (a ViewPlugin) with `RangeError: Block decorations may not be specified
    // via plugins`. Reading the set off a plain `EditorState` proves the source
    // is a field, which is the only shape the real editor accepts.
    const { state, field } = opened();

    const decorations: Array<{ block: boolean }> = [];
    state.field(field).between(0, state.doc.length + 1, (_from, _to, deco) => {
      decorations.push({ block: (deco as unknown as { block: boolean }).block });
    });

    expect(decorations).toHaveLength(1);
    expect(decorations[0]?.block).toBe(true);
  });

  it("drops the widget when the row is cancelled", () => {
    const plugin = fakePlugin();
    const field = insertDecorationField(plugin);
    const state = EditorState.create({
      doc: "# A\nbody",
      extensions: [insertStateField, field]
    }).update({
      effects: closeInsertEffect.of(null)
    }).state;

    let count = 0;
    state.field(field).between(0, state.doc.length + 1, () => {
      count += 1;
    });
    expect(count).toBe(0);
  });

  it("keeps its anchor on the same line when text above it changes", () => {
    const state = EditorState.create({
      doc: "# A\nbody\nmore",
      extensions: [insertStateField]
    }).update({
      effects: openInsertEffect.of({ at: 4, level: 2, maxDepth: 12 })
    }).state;

    // Someone types a line above the caret.
    const next = state.update({ changes: { from: 0, to: 0, insert: "new line\n" } }).state;
    const anchor = next.field(insertStateField)?.at ?? -1;
    expect(next.doc.lineAt(anchor).text).toBe("body");
  });
});

describe("the control row's DOM", () => {
  /** Only what `toDOM` touches: the handlers, and a root to query for focus. */
  function render(state: InsertState): { root: ShimElement; actions: string[] } {
    const actions: string[] = [];
    const widget = new InlineInsertWidget(state, { settings: { maxDepth: 12 } } as unknown as WeaverPlugin, () => ({
      maxDepth: 12,
      onTitle: () => undefined,
      onFocus: () => undefined,
      onStepLevel: () => undefined,
      onAddRow: () => actions.push("add"),
      onCommit: () => actions.push("commit"),
      onCancel: () => actions.push("cancel")
    }));

    const host = new ShimElement("div");
    host.appendChild(widget.toDOM({ dom: host } as never) as unknown as ShimElement);
    return { root: host, actions };
  }

  it("is a level stepper and one title field, with the empty footer", () => {
    const { root } = render(row(2));

    expect(nodes(root, ".weaver-inline-row")).toHaveLength(1);
    expect(nodes(root, ".weaver-inline-step")).toHaveLength(2);
    expect(textOf(nodes(root, ".weaver-inline-step")[0] ?? null)).toBe("◂");
    expect(textOf(nodes(root, ".weaver-inline-step")[1] ?? null)).toBe("▸");
    expect(textOf(node(root, ".weaver-inline-level-label"))).toBe("2D");

    const inputs = nodes(root, "input");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.getAttr("aria-label")).toBe("Title for the 2D dimension");

    // Nothing typed: the empty state is prevention, not a toast.
    expect(node(root, ".weaver-inline-commit")?.disabled).toBe(true);
    expect(textOf(node(root, ".weaver-inline-hint"))).toBe("type a title to weave");
  });

  it("enables Weave once a title is typed, without rebuilding the row", () => {
    const { root } = render(row(2));
    const input = nodes(root, "input")[0] ?? null;
    if (input === null) throw new Error("missing title input");

    input.value = "a title";
    input.dispatch("input");

    expect(node(root, ".weaver-inline-commit")?.disabled).toBe(false);
    expect(textOf(node(root, ".weaver-inline-hint"))).toBe("⌘⏎ weave · Esc cancel");
  });

  it("adds a row on Enter, commits on ⌘⏎, and cancels on Escape", () => {
    const { root, actions } = render(row(2));
    const input = nodes(root, "input")[0] ?? null;
    if (input === null) throw new Error("missing title input");

    input.dispatch("keydown", { key: "Enter", preventDefault: () => undefined });
    input.dispatch("keydown", { key: "Enter", metaKey: true, preventDefault: () => undefined });
    input.dispatch("keydown", { key: "Escape", preventDefault: () => undefined });

    expect(actions).toEqual(["add", "commit", "cancel"]);
  });
});
