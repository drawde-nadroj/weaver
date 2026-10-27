import { EditorState } from "@codemirror/state";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView, Platform, type App } from "obsidian";

import { headingIndexExtension } from "../src/editor/index-field";
import { TravelController, travelExtension, travelField } from "../src/editor/travel-mode";
import { DEFAULT_SETTINGS, type WeaverSettings } from "../src/settings";
import {
  activeScope,
  bodyHasClass,
  bodyQuery,
  bodyQueryAll,
  createApp,
  createFile,
  createView,
  dispatchKey,
  noticeMessages,
  resetHarness,
  rootScope,
  setActiveView
} from "../test-support/harness";

/** Mutable holder the module mock reads, so each test can supply its own view. */
const shared: { cm: unknown } = { cm: null };

vi.mock("../src/editor/view-registry", () => ({
  viewRegistryExtension: [],
  registeredEditorViews: () => (shared.cm === null ? [] : [shared.cm]),
  findEditorViewForFile: () => shared.cm,
  findActiveEditorView: () => shared.cm
}));

const SOURCE = [
  "# 00:00 root",
  "## 00:01 alpha",
  "## 00:02 beta",
  "### 00:03 child",
  "## 00:04 gamma"
].join("\n");

class FakeEditor {
  cursor: { line: number; ch: number } = { line: 0, ch: 0 };
  focusCalls = 0;
  blurCalls = 0;

  constructor(public value: string) {}

  getValue(): string {
    return this.value;
  }

  getCursor(): { line: number; ch: number } {
    return { ...this.cursor };
  }

  setCursor(position: { line: number; ch: number }): void {
    this.cursor = { ...position };
  }

  scrollIntoView(): void {}

  focus(): void {
    this.focusCalls += 1;
  }

  blur(): void {
    this.blurCalls += 1;
  }
}

class FakeCodeMirrorView {
  hasFocus = true;

  constructor(public state: EditorState) {}

  dispatch(spec: Parameters<EditorState["update"]>[0]): void {
    this.state = this.state.update(spec).state;
  }

  focus(): void {}

  get visibleRanges() {
    return [{ from: 0, to: this.state.doc.length }];
  }
}

interface Harness {
  controller: TravelController;
  plugin: Record<string, unknown>;
  app: App;
  view: MarkdownView;
  editor: FakeEditor;
  cm: FakeCodeMirrorView;
}

function harness(
  source = SOURCE,
  options: { settings?: Partial<WeaverSettings>; mode?: "source" | "preview" } = {}
): Harness {
  const app = createApp();
  const file = createFile("note.md", source);
  const editor = new FakeEditor(source);
  const view = createView(app, file, editor, options.mode ?? "source");
  setActiveView(app, view);

  const cm = new FakeCodeMirrorView(
    EditorState.create({
      doc: source,
      extensions: [headingIndexExtension(() => 12), travelExtension()]
    })
  );
  shared.cm = cm;

  const settings: WeaverSettings = { ...DEFAULT_SETTINGS, ...options.settings };
  const plugin = {
    app,
    settings,
    registerEvent: () => undefined,
    log: () => undefined,
    activeMarkdownView: () => app.workspace.getActiveViewOfType(MarkdownView)
  };

  const controller = new TravelController(plugin as never);
  return { controller, plugin, app, view, editor, cm };
}

function travel(context: Harness) {
  return context.cm.state.field(travelField);
}

beforeEach(() => {
  resetHarness();
  shared.cm = null;
  Platform.isPhone = false;
});

describe("TravelController", () => {
  it("enters travel, focuses the current heading, and shows the HUD", () => {
    const context = harness();
    context.editor.cursor = { line: 3, ch: 0 };

    context.controller.enter();

    expect(context.controller.active).toBe(true);
    expect(activeScope(context.app)).not.toBe(rootScope(context.app));
    expect(bodyHasClass("weaver-traveling")).toBe(true);
    expect(bodyQuery(".weaver-travel-hud")).not.toBeNull();

    const state = travel(context);
    expect(state.active).toBe(true);
    expect(state.level).toBe("all");
    expect(state.targetLine).toBe(3);
    expect(context.editor.cursor.line).toBe(3);
    expect(context.editor.value).toBe(SOURCE);
  });

  it("filters by level with digits, 0 and a", () => {
    const context = harness();
    context.controller.enter();

    expect(dispatchKey(context.app, { key: "2" })).toBe(false);
    expect(travel(context).level).toBe(2);
    expect(travel(context).targetLine).toBe(1);
    expect(context.editor.cursor.line).toBe(1);

    dispatchKey(context.app, { key: "0" });
    expect(travel(context).level).toBe("all");

    dispatchKey(context.app, { key: "2" });
    dispatchKey(context.app, { key: "a" });
    expect(travel(context).level).toBe("all");
  });

  it("moves with arrows and j/k without wrapping", () => {
    const context = harness();
    context.controller.enter();
    dispatchKey(context.app, { key: "2" });

    dispatchKey(context.app, { key: "ArrowDown" });
    expect(travel(context).targetLine).toBe(2);

    dispatchKey(context.app, { key: "j" });
    expect(travel(context).targetLine).toBe(4);

    dispatchKey(context.app, { key: "ArrowDown" });
    expect(travel(context).targetLine).toBe(4);
    expect(context.editor.cursor.line).toBe(4);

    dispatchKey(context.app, { key: "k" });
    expect(travel(context).targetLine).toBe(2);
  });

  it("wraps when the setting is on", () => {
    const context = harness(SOURCE, { settings: { travelWrap: true } });
    context.controller.enter();
    dispatchKey(context.app, { key: "2" });
    dispatchKey(context.app, { key: "G", shift: true });
    expect(travel(context).targetLine).toBe(4);
    dispatchKey(context.app, { key: "ArrowDown" });
    expect(travel(context).targetLine).toBe(1);
  });

  it("moves to the parent and the first child", () => {
    const context = harness();
    context.controller.enter();
    dispatchKey(context.app, { key: "2" });
    expect(travel(context).targetLine).toBe(1);

    // The first H2 has no deeper heading before its sibling, so nothing moves.
    dispatchKey(context.app, { key: "ArrowRight" });
    expect(travel(context).targetLine).toBe(1);

    dispatchKey(context.app, { key: "ArrowDown" });
    expect(travel(context).targetLine).toBe(2);

    dispatchKey(context.app, { key: "l" });
    expect(travel(context).targetLine).toBe(3);

    dispatchKey(context.app, { key: "ArrowLeft" });
    expect(travel(context).targetLine).toBe(2);

    dispatchKey(context.app, { key: "h" });
    expect(travel(context).targetLine).toBe(0);

    dispatchKey(context.app, { key: "ArrowLeft" });
    expect(travel(context).targetLine).toBe(0);
  });

  it("jumps to the first and last heading with g/G and Home/End", () => {
    const context = harness();
    context.controller.enter();
    dispatchKey(context.app, { key: "2" });

    dispatchKey(context.app, { key: "G", shift: true });
    expect(travel(context).targetLine).toBe(4);
    dispatchKey(context.app, { key: "g" });
    expect(travel(context).targetLine).toBe(1);
    dispatchKey(context.app, { key: "End" });
    expect(travel(context).targetLine).toBe(4);
    dispatchKey(context.app, { key: "Home" });
    expect(travel(context).targetLine).toBe(1);
  });

  it("exits at the current heading without restoring the origin", () => {
    const context = harness();
    context.controller.enter();
    dispatchKey(context.app, { key: "2" });
    dispatchKey(context.app, { key: "ArrowDown" });
    expect(context.editor.cursor.line).toBe(2);

    expect(dispatchKey(context.app, { key: "Enter" })).toBe(false);

    expect(context.controller.active).toBe(false);
    expect(activeScope(context.app)).toBe(rootScope(context.app));
    expect(bodyHasClass("weaver-traveling")).toBe(false);
    expect(bodyQuery(".weaver-travel-hud")).toBeNull();
    expect(context.editor.cursor.line).toBe(2);
    expect(context.editor.value).toBe(SOURCE);
    expect(context.editor.focusCalls).toBeGreaterThan(0);
  });

  it("exits on Escape and q", () => {
    const first = harness();
    first.controller.enter();
    dispatchKey(first.app, { key: "Escape" });
    expect(first.controller.active).toBe(false);

    const second = harness();
    second.controller.enter();
    dispatchKey(second.app, { key: "q" });
    expect(second.controller.active).toBe(false);
  });

  it("never edits the document while travelling", () => {
    const context = harness();
    context.controller.enter();
    for (const key of ["2", "ArrowDown", "j", "ArrowLeft", "ArrowRight", "g", "x", "1"]) {
      dispatchKey(context.app, { key });
    }
    dispatchKey(context.app, { key: "G", shift: true });
    expect(context.editor.value).toBe(SOURCE);
    expect(context.cm.state.doc.toString()).toBe(SOURCE);
  });

  it("swallows unmodified keys but passes modifier combinations through", () => {
    const context = harness();
    context.controller.enter();

    expect(dispatchKey(context.app, { key: "j", meta: true })).toBe(true);
    expect(travel(context).targetLine).toBe(0);

    expect(dispatchKey(context.app, { key: "a", meta: true })).toBe(true);
    expect(travel(context).level).toBe("all");

    expect(dispatchKey(context.app, { key: "x" })).toBe(false);
    expect(context.editor.value).toBe(SOURCE);
  });

  it("shows the keymap on ?", () => {
    const context = harness();
    context.controller.enter();
    dispatchKey(context.app, { key: "?" });
    expect(noticeMessages().some((message) => message.includes("Weaver travel"))).toBe(true);
  });

  it("refuses in reading view with a notice", () => {
    const context = harness(SOURCE, { mode: "preview" });
    context.controller.enter();
    expect(context.controller.active).toBe(false);
    expect(noticeMessages()[0]).toBe(
      "Weaver: travel mode needs an editable note. Nothing was written."
    );
  });

  it("refuses when the note has no headings", () => {
    const context = harness("just body text\nmore text");
    context.controller.enter();
    expect(context.controller.active).toBe(false);
    expect(noticeMessages()[0]).toBe("Weaver: no dimensions in this note.");
  });

  it("falls back to all levels when the default level is empty", () => {
    const context = harness(SOURCE, { settings: { travelDefaultLevel: 5 } });
    context.controller.enter();
    expect(travel(context).level).toBe("all");
  });

  it("honours a default level that exists", () => {
    const context = harness(SOURCE, { settings: { travelDefaultLevel: 2 } });
    context.controller.enter();
    expect(travel(context).level).toBe(2);
    expect(travel(context).targetLine).toBe(1);
  });

  it("keeps an empty level filter without a target", () => {
    const context = harness();
    context.controller.enter();
    dispatchKey(context.app, { key: "5" });
    expect(travel(context).level).toBe(5);
    expect(travel(context).targetLine).toBeNull();
  });

  it("exits when the active leaf changes", () => {
    const context = harness();
    context.controller.enter();
    context.app.workspace.trigger("active-leaf-change");
    expect(context.controller.active).toBe(false);
  });

  it("exits cleanly twice", () => {
    const context = harness();
    context.controller.enter();
    context.controller.exit();
    context.controller.exit();
    expect(context.controller.active).toBe(false);
    expect(activeScope(context.app)).toBe(rootScope(context.app));
  });

  it("renders the phone bar instead of the HUD", () => {
    Platform.isPhone = true;
    const context = harness();
    context.controller.enter();

    expect(bodyQuery(".weaver-travel-hud")).toBeNull();
    const bar = bodyQuery(".weaver-travel-bar");
    expect(bar).not.toBeNull();
    expect(context.editor.blurCalls).toBe(1);

    const chips = bar?.querySelectorAll(".weaver-travel-chip") ?? [];
    expect(chips).toHaveLength(13);

    chips[2]?.click();
    expect(travel(context).level).toBe(2);

    const buttons = bar?.querySelectorAll(".weaver-travel-button") ?? [];
    buttons[buttons.length - 1]?.click();
    expect(context.controller.active).toBe(false);
    expect(bodyQuery(".weaver-travel-bar")).toBeNull();
  });
});

/**
 * Document order is 2.1 then 2.2, but 2.2 was opened first, so chronological
 * order is the reverse — exactly the case a drafts axis exists for.
 */
const DRAFT_SOURCE = [
  "# 00:00 root",
  "## 00:01 alpha",
  "⟪draft 2.1 2026-10-26 16:40:00⟫",
  "later",
  "⟪/draft 2.1⟫",
  "⟪draft 2.2 2026-10-26 16:37:04⟫",
  "earlier",
  "⟪/draft 2.2⟫",
  "## 00:04 gamma"
].join("\n");

describe("TravelController drafts axis", () => {
  it("switches kind with Tab and keeps the level filter", () => {
    const context = harness(DRAFT_SOURCE);
    context.controller.enter();

    expect(travel(context).kind).toBe("headings");

    expect(dispatchKey(context.app, { key: "Tab" })).toBe(false);
    expect(travel(context).kind).toBe("drafts");
    expect(travel(context).level).toBe("all");
    expect(travel(context).draftId).toBe("2.2");
    expect(travel(context).targetLine).toBeNull();
    expect(context.editor.cursor).toEqual({ line: 6, ch: 0 });

    dispatchKey(context.app, { key: "Tab" });
    expect(travel(context).kind).toBe("headings");
    expect(travel(context).draftId).toBeNull();
    expect(travel(context).targetLine).toBe(1);
  });

  it("walks drafts chronologically with j/k and the arrows", () => {
    const context = harness(DRAFT_SOURCE);
    context.controller.enter();
    dispatchKey(context.app, { key: "Tab" });
    expect(travel(context).draftId).toBe("2.2");

    dispatchKey(context.app, { key: "j" });
    expect(travel(context).draftId).toBe("2.1");
    expect(context.editor.cursor.line).toBe(3);

    // No wrap by default: the last draft is the edge.
    dispatchKey(context.app, { key: "ArrowDown" });
    expect(travel(context).draftId).toBe("2.1");

    dispatchKey(context.app, { key: "ArrowUp" });
    expect(travel(context).draftId).toBe("2.2");
    dispatchKey(context.app, { key: "k" });
    expect(travel(context).draftId).toBe("2.2");
  });

  it("jumps to the first and last draft with g/G", () => {
    const context = harness(DRAFT_SOURCE);
    context.controller.enter();
    dispatchKey(context.app, { key: "Tab" });

    dispatchKey(context.app, { key: "G", shift: true });
    expect(travel(context).draftId).toBe("2.1");

    dispatchKey(context.app, { key: "g" });
    expect(travel(context).draftId).toBe("2.2");

    dispatchKey(context.app, { key: "End" });
    expect(travel(context).draftId).toBe("2.1");

    dispatchKey(context.app, { key: "Home" });
    expect(travel(context).draftId).toBe("2.2");
  });

  it("filters drafts by level with digits", () => {
    const context = harness(DRAFT_SOURCE);
    context.controller.enter();
    dispatchKey(context.app, { key: "Tab" });

    dispatchKey(context.app, { key: "3" });
    expect(travel(context).level).toBe(3);
    expect(travel(context).draftId).toBeNull();

    dispatchKey(context.app, { key: "2" });
    expect(travel(context).level).toBe(2);
    expect(travel(context).draftId).toBe("2.2");

    dispatchKey(context.app, { key: "a" });
    expect(travel(context).level).toBe("all");
    expect(travel(context).draftId).toBe("2.2");
  });

  it("exits at the draft's title line", () => {
    const context = harness(DRAFT_SOURCE);
    context.controller.enter();
    dispatchKey(context.app, { key: "Tab" });
    dispatchKey(context.app, { key: "j" });

    expect(dispatchKey(context.app, { key: "Enter" })).toBe(false);

    expect(context.controller.active).toBe(false);
    expect(context.editor.cursor).toEqual({ line: 3, ch: 0 });
    expect(context.editor.value).toBe(DRAFT_SOURCE);
  });

  it("treats parent and child as no-ops in drafts mode", () => {
    const context = harness(DRAFT_SOURCE);
    context.controller.enter();
    dispatchKey(context.app, { key: "Tab" });

    dispatchKey(context.app, { key: "ArrowLeft" });
    dispatchKey(context.app, { key: "ArrowRight" });
    dispatchKey(context.app, { key: "h" });
    dispatchKey(context.app, { key: "l" });

    expect(travel(context).kind).toBe("drafts");
    expect(travel(context).draftId).toBe("2.2");
    expect(context.editor.cursor.line).toBe(6);
  });

  it("reads the draft position in the HUD", () => {
    const context = harness(DRAFT_SOURCE);
    context.controller.enter();
    dispatchKey(context.app, { key: "Tab" });

    expect(bodyQuery(".weaver-hud-state")?.textContent).toBe("DRAFT · 2D · draft 2.2 · 1/2");

    dispatchKey(context.app, { key: "j" });
    expect(bodyQuery(".weaver-hud-state")?.textContent).toBe("DRAFT · 2D · draft 2.1 · 2/2");
  });

  it("refuses to switch when the note has no drafts", () => {
    const context = harness();
    context.controller.enter();

    expect(dispatchKey(context.app, { key: "Tab" })).toBe(false);

    expect(travel(context).kind).toBe("headings");
    expect(noticeMessages()).toContain("Weaver: no drafts in this note.");
  });

  it("keeps heading behaviour unchanged when drafts exist", () => {
    const context = harness(DRAFT_SOURCE);
    context.controller.enter();

    // Heading mode still walks headings, never draft lines.
    dispatchKey(context.app, { key: "ArrowDown" });
    expect(travel(context).kind).toBe("headings");
    expect(travel(context).targetLine).toBe(1);
    expect(context.editor.cursor.line).toBe(1);
  });

  it("offers a kind toggle on the phone bar", () => {
    Platform.isPhone = true;
    const context = harness(DRAFT_SOURCE);
    context.controller.enter();

    const toggle = bodyQuery(".weaver-travel-kind");
    expect(toggle?.textContent).toBe("Dimensions");

    toggle?.click();
    expect(travel(context).kind).toBe("drafts");
    expect(bodyQuery(".weaver-travel-kind")?.textContent).toBe("Drafts");

    const buttons = bodyQueryAll(".weaver-travel-button");
    // Parent and child are disabled in drafts mode; up/down still work.
    expect(buttons[0]?.disabled).toBe(true);
    expect(buttons[3]?.disabled).toBe(true);

    buttons[2]?.click();
    expect(travel(context).draftId).toBe("2.1");
  });
});
