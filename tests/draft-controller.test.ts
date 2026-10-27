import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform, type App, type MarkdownView } from "obsidian";

import { parseHeadings } from "../src/core/headings";
import WeaverPlugin from "../src/main";
import { FakeEditor } from "../test-support/editor";
import {
  createApp,
  createFile,
  createView,
  instantiatePlugin,
  noticeMessages,
  rerenderCount,
  resetHarness,
  setActiveView
} from "../test-support/harness";

const NOW = new Date(2024, 0, 2, 16, 37, 4);
const OPENED = "2024-01-02 16:37:04";

interface Context {
  plugin: WeaverPlugin;
  app: App;
  view: MarkdownView;
  editor: FakeEditor;
}

async function startPlugin(
  source: string,
  options: { mode?: "source" | "preview" } = {}
): Promise<Context> {
  const file = createFile("note.md", source);
  const app = createApp([file]);
  const editor = new FakeEditor(source);
  const view = createView(app, file, editor, options.mode ?? "source");
  setActiveView(app, view);

  const plugin = instantiatePlugin(WeaverPlugin, app);
  await plugin.onload();

  return { plugin, app, view, editor };
}

function markers(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => line.includes("⟪draft") || line.includes("⟪/draft"))
    .map((line) => line.trim());
}

beforeEach(() => {
  resetHarness();
  Platform.isPhone = false;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

describe("DraftController.createDraft", () => {
  it("inserts the exact block at a blank line and leaves the caret on the title line", async () => {
    const { plugin, editor } = await startPlugin("# 09:00 Root\n\n");

    editor.setCursor({ line: 1, ch: 0 });
    plugin.drafts.createDraft(NOW);

    expect(editor.getValue()).toBe(
      `# 09:00 Root\n⟪draft 2.1 ${OPENED}⟫\n\n⟪/draft 2.1⟫\n`
    );
    expect(editor.transactions).toBe(1);
    expect(editor.selection.from).toEqual({ line: 2, ch: 0 });
  });

  it("numbers drafts by the position of their level at the insert site", async () => {
    const { plugin, editor } = await startPlugin("# 09:00 Root\n## 09:01 first\n\n");

    editor.setCursor({ line: 2, ch: 0 });
    plugin.drafts.createDraft(NOW);

    expect(markers(editor.getValue())).toEqual([
      `⟪draft 3.1 ${OPENED}⟫`,
      "⟪/draft 3.1⟫"
    ]);
  });

  it("bumps the ordinal when an open draft already uses the id", async () => {
    const { plugin, editor } = await startPlugin(
      `# Root\n⟪draft 2.1 ${OPENED}⟫\ntaken\n⟪/draft 2.1⟫\n\n`
    );

    editor.setCursor({ line: 5, ch: 0 });
    plugin.drafts.createDraft(NOW);

    expect(markers(editor.getValue())).toEqual([
      `⟪draft 2.1 ${OPENED}⟫`,
      "⟪/draft 2.1⟫",
      `⟪draft 2.2 ${OPENED}⟫`,
      "⟪/draft 2.2⟫"
    ]);
  });

  it("refuses inside an unclosed fence and in reading view", async () => {
    const fenced = await startPlugin("# Root\n```\ncode");
    fenced.editor.setCursor({ line: 2, ch: 0 });
    fenced.plugin.drafts.createDraft(NOW);

    expect(noticeMessages()).toEqual([
      "Weaver: close the code block before starting a draft. Nothing was written."
    ]);
    expect(fenced.editor.transactions).toBe(0);

    resetHarness();
    const reading = await startPlugin("# Root\n\n", { mode: "preview" });
    reading.plugin.drafts.createDraft(NOW);

    expect(noticeMessages()).toEqual([
      "Weaver: this needs an editable note. Nothing was written."
    ]);
    expect(reading.editor.transactions).toBe(0);
  });
});

describe("DraftController.weaveDraft", () => {
  it("replaces both markers with a heading in one transaction, and one undo restores it", async () => {
    const source = `# 09:00 Root\n⟪draft 3.1 ${OPENED}⟫\nTitle\nbody\n⟪/draft 3.1⟫\n`;
    const { plugin, editor } = await startPlugin(source);

    plugin.drafts.weaveDraft("3.1");

    expect(editor.getValue()).toBe("# 09:00 Root\n### 16:37:04 - Title\nbody\n");
    expect(editor.transactions).toBe(1);

    editor.undo();
    expect(editor.getValue()).toBe(source);
  });

  it("keeps a trailing space and appends the body when there is no title", async () => {
    const { plugin, editor } = await startPlugin(
      `# Root\n⟪draft 2.1 ${OPENED}⟫\n\nsome body\n⟪/draft 2.1⟫`
    );

    plugin.drafts.weaveDraft("2.1");

    expect(editor.getValue()).toBe("# Root\n## 16:37:04 \nsome body");
  });

  it("refuses an empty draft without touching the note", async () => {
    const source = `# Root\n⟪draft 2.1 ${OPENED}⟫\n\n⟪/draft 2.1⟫`;
    const { plugin, editor } = await startPlugin(source);

    plugin.drafts.weaveDraft("2.1");

    expect(noticeMessages()).toEqual([
      "Weaver: type something before weaving this draft. Nothing was written."
    ]);
    expect(editor.getValue()).toBe(source);
    expect(editor.transactions).toBe(0);
  });

  it("ignores an unknown id", async () => {
    const { plugin, editor } = await startPlugin("# Root\n\n");
    plugin.drafts.weaveDraft("9.9");
    expect(editor.transactions).toBe(0);
  });
});

describe("DraftController.weaveDraftAtCursor", () => {
  it("weaves the draft the caret sits inside", async () => {
    const { plugin, editor } = await startPlugin(
      `# Root\n⟪draft 2.1 ${OPENED}⟫\nTitle\n⟪/draft 2.1⟫\ntail`
    );

    editor.setCursor({ line: 2, ch: 2 });
    expect(plugin.drafts.draftAtCursor()?.id).toBe("2.1");

    plugin.drafts.weaveDraftAtCursor(NOW);
    expect(editor.getValue()).toBe("# Root\n## 16:37:04 - Title\ntail");
  });

  it("does nothing when the caret is outside every draft", async () => {
    const { plugin, editor } = await startPlugin(
      `# Root\n⟪draft 2.1 ${OPENED}⟫\nTitle\n⟪/draft 2.1⟫\ntail`
    );

    editor.setCursor({ line: 4, ch: 0 });
    expect(plugin.drafts.draftAtCursor()).toBeNull();
    plugin.drafts.weaveDraftAtCursor(NOW);
    expect(editor.transactions).toBe(0);
  });
});

describe("DraftController.discardDraft", () => {
  it("removes the block and collapses the leftover blank line", async () => {
    const { plugin, editor } = await startPlugin(
      `# Root\n\n⟪draft 2.1 ${OPENED}⟫\nTitle\n⟪/draft 2.1⟫\n\nnext`
    );

    plugin.drafts.discardDraft("2.1");

    expect(editor.getValue()).toBe("# Root\n\nnext");
    expect(editor.transactions).toBe(1);
  });

  it("leaves a normal paragraph break alone", async () => {
    const { plugin, editor } = await startPlugin(
      `# Root\n⟪draft 2.1 ${OPENED}⟫\nTitle\n⟪/draft 2.1⟫\nnext`
    );

    plugin.drafts.discardDraft("2.1");

    expect(editor.getValue()).toBe("# Root\nnext");
  });
});

describe("DraftController.setDraftLevel", () => {
  it("rewrites both marker ids in one transaction", async () => {
    const { plugin, editor } = await startPlugin(
      `# Root\n⟪draft 2.1 ${OPENED}⟫\nTitle\n⟪/draft 2.1⟫\n\n## 10:00 sibling`
    );

    plugin.drafts.setDraftLevel("2.1", 3);

    expect(markers(editor.getValue())).toEqual([`⟪draft 3.1 ${OPENED}⟫`, "⟪/draft 3.1⟫"]);
    expect(editor.transactions).toBe(1);
  });

  it("bumps the ordinal when the new level is already taken", async () => {
    const { plugin, editor } = await startPlugin(
      [
        "# Root",
        `⟪draft 3.1 ${OPENED}⟫`,
        "first",
        "⟪/draft 3.1⟫",
        "",
        `⟪draft 2.1 ${OPENED}⟫`,
        "second",
        "⟪/draft 2.1⟫"
      ].join("\n")
    );

    plugin.drafts.setDraftLevel("2.1", 3);

    expect(markers(editor.getValue())).toEqual([
      `⟪draft 3.1 ${OPENED}⟫`,
      "⟪/draft 3.1⟫",
      `⟪draft 3.2 ${OPENED}⟫`,
      "⟪/draft 3.2⟫"
    ]);
  });

  it("clamps to the allowed range and ignores a no-op", async () => {
    const { plugin, editor } = await startPlugin(
      `# Root\n⟪draft 2.1 ${OPENED}⟫\nTitle\n⟪/draft 2.1⟫`
    );

    plugin.drafts.setDraftLevel("2.1", 2);
    expect(editor.transactions).toBe(0);

    plugin.drafts.setDraftLevel("2.1", 99);
    expect(markers(editor.getValue())[0]).toBe(`⟪draft 12.1 ${OPENED}⟫`);
  });
});

describe("drafts and headings stay separate", () => {
  it("never indexes a draft as a heading", async () => {
    const { plugin, editor } = await startPlugin("# Root\n\n");
    editor.setCursor({ line: 1, ch: 0 });
    plugin.drafts.createDraft(NOW);

    const index = parseHeadings(editor.getValue(), { maxDepth: 12 });
    expect(index.headings).toHaveLength(1);
    expect(index.drafts).toHaveLength(1);
  });
});

describe("end to end: start, type, weave", () => {
  it("turns a drafted thought into a finished heading", async () => {
    const { plugin, editor } = await startPlugin("# 09:00 Root\n\n");

    editor.setCursor({ line: 1, ch: 0 });
    plugin.drafts.createDraft(NOW);
    expect(editor.getValue()).toBe(
      `# 09:00 Root\n⟪draft 2.1 ${OPENED}⟫\n\n⟪/draft 2.1⟫\n`
    );

    // The user types a title and a body into the note itself.
    const lines = editor.getValue().split("\n");
    lines[2] = "Title";
    lines.splice(3, 0, "body");
    editor.value = lines.join("\n");

    expect(plugin.drafts.draftAtCursor()?.title).toBe("Title");

    plugin.drafts.weaveDraft("2.1");

    expect(editor.getValue()).toBe("# 09:00 Root\n## 16:37:04 - Title\nbody\n");
    expect(editor.transactions).toBe(2);
  });
});

describe("reading view commit path", () => {
  it("writes through the file when there is no editor", async () => {
    const source = `# Root\n⟪draft 2.1 ${OPENED}⟫\nTitle\n⟪/draft 2.1⟫`;
    const { plugin, app, view } = await startPlugin(source, { mode: "preview" });

    plugin.drafts.weaveDraft("2.1");
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();

    const files = (app.vault as unknown as { files: Array<{ content: string }> }).files;
    expect(files[0]?.content).toBe("# Root\n## 16:37:04 - Title");
    expect(rerenderCount(view)).toBeGreaterThan(0);
  });
});
