import { beforeEach, describe, expect, it } from "vitest";
import { MarkdownView, Platform, type App, type TFile } from "obsidian";

import { dayNotePath } from "../src/core/day-note";
import { DEFAULT_SETTINGS } from "../src/settings";
import WeaverPlugin from "../src/main";
import { phoneStripText, stripText, type StripState } from "../src/ui/status-strip";
import { FakeEditor } from "../test-support/editor";
import {
  addLeafWithView,
  createApp,
  createFile,
  createView,
  instantiatePlugin,
  node,
  resetHarness,
  setActiveView,
  textOf
} from "../test-support/harness";

function state(patch: Partial<StripState>): StripState {
  return {
    kind: "day",
    dateLabel: "Tue 27 Oct",
    noteLabel: "Entry",
    chain: [],
    drafts: 0,
    untitled: 0,
    closedAt: null,
    hasMarks: false,
    ...patch
  };
}

describe("stripText", () => {
  it("names where the caret is, then what is unfinished", () => {
    expect(
      stripText(
        state({
          chain: ["1D Breaking Free", "2D Why now"],
          untitled: 1,
          drafts: 2,
          closedAt: "21:29:10"
        })
      )
    ).toBe("1D Breaking Free ▸ 2D Why now · 1 untitled · 2 drafts · closed 21:29");
  });

  it("counts an untitled spark instead of hiding it", () => {
    expect(stripText(state({ chain: ["1D Untitled"], untitled: 1, hasMarks: true }))).toBe(
      "1D Untitled · 1 untitled"
    );
  });

  it("says there are no marks rather than showing zeros", () => {
    expect(stripText(state({}))).toBe("Tue 27 Oct · no marks yet");
  });

  it("names only the date when the caret is above a day that has marks", () => {
    expect(stripText(state({ hasMarks: true }))).toBe("Tue 27 Oct");
  });

  it("describes another note by its chain and its own drafts", () => {
    expect(
      stripText(
        state({ kind: "note", noteLabel: "Entry", chain: ["1D Root", "2D Alpha"], drafts: 3 })
      )
    ).toBe("1D Root ▸ 2D Alpha · 3 drafts");
    expect(stripText(state({ kind: "note", noteLabel: "Entry" }))).toBe("Entry");
  });

  it("uses singular units", () => {
    expect(
      stripText(state({ kind: "note", noteLabel: "Entry", chain: ["1D Root"], drafts: 1 }))
    ).toBe("1D Root · 1 draft");
  });

  it("shows nothing at all when there is no note", () => {
    expect(stripText(state({ kind: "none" }))).toBe("");
  });
});

describe("phoneStripText", () => {
  it("keeps the innermost segment and drops the ancestors", () => {
    expect(
      phoneStripText(
        state({
          chain: ["1D Breaking Free", "2D Why now"],
          untitled: 1,
          drafts: 2,
          closedAt: "21:29"
        })
      )
    ).toBe("2D Why now · 1 untitled · 2 drafts · closed 21:29");
  });

  it("summarizes another note and says when a day is bare", () => {
    expect(
      phoneStripText(state({ kind: "note", noteLabel: "Entry", chain: ["1D Root"], drafts: 3 }))
    ).toBe("1D Root · 3 drafts");
    expect(phoneStripText(state({}))).toBe("Tue 27 Oct · no marks yet");
    expect(phoneStripText(state({ kind: "none" }))).toBe("");
  });
});

describe("the strip on a live view", () => {
  beforeEach(() => {
    resetHarness();
    Platform.isPhone = false;
  });

  async function start(source: string, path = "Chronomancer/day.md"): Promise<{
    plugin: WeaverPlugin;
    app: App;
    file: TFile;
    editor: FakeEditor;
  }> {
    const dayPath = dayNotePath(new Date(), {
      folder: DEFAULT_SETTINGS.dayNoteFolder,
      format: DEFAULT_SETTINGS.dayNoteFormat
    });
    const file = createFile(path === "Chronomancer/day.md" ? dayPath : path, source);
    const app = createApp([file]);
    const editor = new FakeEditor(source);
    const view = createView(app, file, editor);
    setActiveView(app, view);
    addLeafWithView(app, view);

    const plugin = instantiatePlugin(WeaverPlugin, app);
    await plugin.onload();
    return { plugin, app, file, editor };
  }

  it("is one line above the editor, naming the dimension the caret is in", async () => {
    const { plugin, app, editor } = await start(
      "---\ndate: 2026-10-27\n---\n\n# 09:12:01 - first\n✦ [[Note]]\n\n## 10:00:00 - deep\n"
    );
    editor.setCursor({ line: 7, ch: 0 });

    await plugin.strip?.update();

    const view = app.workspace.getActiveViewOfType(MarkdownView);
    const strip = node(view?.containerEl ?? null, ".weaver-strip");
    expect(strip).not.toBeNull();
    expect(textOf(strip)).toBe("1D first ▸ 2D deep");
    expect(strip?.getAttr("contenteditable")).toBe("false");
  });

  it("flags an untitled 1D and the day's close", async () => {
    const { plugin, app, editor } = await start(
      "# 09:12:01 - \n✦\n## 10:00:00 - deep\n✓ 21:29\n"
    );
    editor.setCursor({ line: 0, ch: 0 });

    await plugin.strip?.update();

    const view = app.workspace.getActiveViewOfType(MarkdownView);
    expect(textOf(node(view?.containerEl ?? null, ".weaver-strip"))).toBe(
      "1D Untitled · 1 untitled · closed 21:29"
    );
  });

  it("describes any other note by its chain and drafts", async () => {
    const { plugin, app, editor } = await start(
      "# 09:00 - Root\n## 09:05 - Alpha\n\n⟪draft 2.1 2026-10-26 16:37:04⟫\nidea\n⟪/draft 2.1⟫\n",
      "notes/Entry.md"
    );
    editor.setCursor({ line: 1, ch: 0 });

    await plugin.strip?.update();

    const view = app.workspace.getActiveViewOfType(MarkdownView);
    expect(textOf(node(view?.containerEl ?? null, ".weaver-strip"))).toBe(
      "1D Root ▸ 2D Alpha · 1 draft"
    );
  });
});
