import { beforeEach, describe, expect, it } from "vitest";
import { Platform, type App, type MarkdownView } from "obsidian";

import { draftBlockText, parseDrafts, type DraftBlock } from "../src/core/drafts";
import type { DraftEntry } from "../src/drafts/vault-index";
import WeaverPlugin from "../src/main";
import { DraftSearchModal } from "../src/ui/draft-search-modal";
import { FakeEditor } from "../test-support/editor";
import {
  addLeafWithView,
  click,
  createApp,
  createFile,
  createView,
  fire,
  instantiatePlugin,
  modalIsOpen,
  node,
  nodes,
  resetHarness,
  setActiveView,
  setValue,
  textOf
} from "../test-support/harness";
import type { TFile } from "obsidian";

interface Context {
  plugin: WeaverPlugin;
  app: App;
  view: MarkdownView;
  editor: FakeEditor;
  files: TFile[];
}

function block(id: string, openedAt: string, title: string, body = ""): DraftBlock {
  const source = draftBlockText({ id, openedAt, title, body });
  return parseDrafts(source, 12)[0]!;
}

function entry(file: TFile, id: string, openedAt: string, title: string, body = ""): DraftEntry {
  return { file, draft: block(id, openedAt, title, body) };
}

async function startPlugin(): Promise<Context> {
  const first = createFile("first.md", "# Root\n");
  const second = createFile("second.md", "# Root\n");
  const app = createApp([first, second]);

  const editor = new FakeEditor("# Root\n\nbody");
  const view = createView(app, first, editor);
  setActiveView(app, view);
  addLeafWithView(app, view);

  const plugin = instantiatePlugin(WeaverPlugin, app);
  await plugin.onload();

  return { plugin, app, view, editor, files: [first, second] };
}

function serve(context: Context, entries: DraftEntry[]): void {
  (context.plugin as unknown as { draftIndex: { openDrafts(): Promise<DraftEntry[]> } }).draftIndex =
    { openDrafts: () => Promise.resolve(entries) };
}

async function open(context: Context): Promise<DraftSearchModal> {
  const modal = new DraftSearchModal(context.app, context.plugin);
  modal.open();
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  return modal;
}

function rowIds(modal: DraftSearchModal): string[] {
  return nodes(modal.contentEl, ".weaver-draft-result").map(
    (row) => String(row.getAttr("data-draft-id"))
  );
}

function type(modal: DraftSearchModal, value: string): void {
  const input = node(modal.contentEl, ".weaver-draft-search-input");
  setValue(input, value);
  fire(input, "input");
}

beforeEach(() => {
  resetHarness();
  Platform.isPhone = false;
});

describe("DraftSearchModal filtering", () => {
  it("lists every open draft newest first", async () => {
    const context = await startPlugin();
    serve(context, [
      entry(context.files[0]!, "2.1", "2026-10-26 17:00:00", "later thought"),
      entry(context.files[1]!, "2.2", "2026-10-26 16:37:04", "earlier thought")
    ]);

    const modal = await open(context);

    expect(rowIds(modal)).toEqual(["2.1", "2.2"]);
    expect(textOf(node(modal.contentEl, ".weaver-draft-result-id"))).toBe("draft 2.1");
    expect(nodes(modal.contentEl, ".weaver-draft-result-file")).toHaveLength(2);
  });

  it("matches the id, the title and the body", async () => {
    const context = await startPlugin();
    serve(context, [
      entry(context.files[0]!, "2.1", "2026-10-26 17:00:00", "alpha", "first body"),
      entry(context.files[0]!, "2.2", "2026-10-26 16:37:04", "beta", "a remembered phrase")
    ]);

    const modal = await open(context);

    type(modal, "2.2");
    expect(rowIds(modal)).toEqual(["2.2"]);

    type(modal, "alpha");
    expect(rowIds(modal)).toEqual(["2.1"]);

    type(modal, "remembered");
    expect(rowIds(modal)).toEqual(["2.2"]);
    expect(nodes(modal.contentEl, ".weaver-draft-result-body")).toHaveLength(1);

    type(modal, "nothing here");
    expect(rowIds(modal)).toEqual([]);
    expect(textOf(node(modal.contentEl, ".weaver-draft-search-status"))).toBe("No drafts match.");
  });

  it("shows the empty state without any drafts", async () => {
    const context = await startPlugin();
    serve(context, []);

    const modal = await open(context);
    expect(textOf(node(modal.contentEl, ".weaver-draft-search-status"))).toBe("No open drafts.");
  });

  it("labels an untitled draft", async () => {
    const context = await startPlugin();
    serve(context, [entry(context.files[0]!, "2.1", "2026-10-26 17:00:00", "", "only a body")]);

    const modal = await open(context);
    expect(textOf(node(modal.contentEl, ".weaver-draft-result-title"))).toBe("(untitled draft)");
  });
});

describe("DraftSearchModal scopes", () => {
  it("narrows to the active note and to open notes", async () => {
    const context = await startPlugin();
    serve(context, [
      entry(context.files[0]!, "2.1", "2026-10-26 17:00:00", "in the active note"),
      entry(context.files[1]!, "2.2", "2026-10-26 16:37:04", "in a closed note")
    ]);

    const modal = await open(context);
    expect(rowIds(modal)).toEqual(["2.1", "2.2"]);

    click(node(modal.contentEl, '[data-scope="note"]'));
    expect(rowIds(modal)).toEqual(["2.1"]);
    // The file name is redundant inside "This note".
    expect(nodes(modal.contentEl, ".weaver-draft-result-file")).toHaveLength(0);

    click(node(modal.contentEl, '[data-scope="open"]'));
    expect(rowIds(modal)).toEqual(["2.1"]);

    click(node(modal.contentEl, '[data-scope="all"]'));
    expect(rowIds(modal)).toEqual(["2.1", "2.2"]);
  });

  it("marks the active scope chip", async () => {
    const context = await startPlugin();
    serve(context, []);

    const modal = await open(context);
    const active = nodes(modal.contentEl, ".weaver-draft-scope.is-active");
    expect(active).toHaveLength(1);
    expect(active[0]?.getAttr("data-scope")).toBe("all");

    click(node(modal.contentEl, '[data-scope="note"]'));
    const next = nodes(modal.contentEl, ".weaver-draft-scope.is-active");
    expect(next[0]?.getAttr("data-scope")).toBe("note");
  });
});

describe("DraftSearchModal keyboard", () => {
  it("moves the selection with the arrows and jumps on Enter", async () => {
    const context = await startPlugin();
    serve(context, [
      entry(context.files[0]!, "2.1", "2026-10-26 17:00:00", "first"),
      entry(context.files[0]!, "2.2", "2026-10-26 16:37:04", "second")
    ]);

    const modal = await open(context);
    const selected = () => nodes(modal.contentEl, ".weaver-draft-result.is-selected");

    expect(selected()[0]?.getAttr("data-draft-id")).toBe("2.1");

    fire(modal.modalEl as never, "keydown", { key: "ArrowDown" });
    expect(selected()[0]?.getAttr("data-draft-id")).toBe("2.2");

    fire(modal.modalEl as never, "keydown", { key: "ArrowDown" });
    expect(selected()[0]?.getAttr("data-draft-id")).toBe("2.1");

    fire(modal.modalEl as never, "keydown", { key: "ArrowUp" });
    expect(selected()[0]?.getAttr("data-draft-id")).toBe("2.2");

    fire(modal.modalEl as never, "keydown", { key: "Enter" });

    // Title line of the isolated block text is line 1.
    expect(context.editor.getCursor().line).toBe(1);
    expect(modalIsOpen(modal)).toBe(false);
  });

  it("closes on Escape without jumping", async () => {
    const context = await startPlugin();
    serve(context, [entry(context.files[0]!, "2.1", "2026-10-26 17:00:00", "first")]);

    const modal = await open(context);
    fire(modal.modalEl as never, "keydown", { key: "Escape" });

    expect(modalIsOpen(modal)).toBe(false);
    expect(context.editor.focusCalls).toBe(0);
  });

  it("opens the target note when the draft lives elsewhere", async () => {
    const context = await startPlugin();
    serve(context, [entry(context.files[1]!, "2.1", "2026-10-26 17:00:00", "elsewhere")]);

    const modal = await open(context);
    click(node(modal.contentEl, ".weaver-draft-result"));
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();

    const leaf = context.app.workspace.getLeaf(false) as unknown as { openedFile: TFile | null };
    expect(leaf.openedFile).toBe(context.files[1]);
  });
});
