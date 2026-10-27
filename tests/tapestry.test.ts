import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarkdownView, Platform, WorkspaceLeaf, type App, type TFile } from "obsidian";

import { draftBlockText, parseDrafts, type DraftBlock } from "../src/core/drafts";
import { dayNotePath } from "../src/core/day-note";
import { DEFAULT_SETTINGS } from "../src/settings";
import { groupDraftsByFile, type DraftEntry } from "../src/drafts/vault-index";
import WeaverPlugin from "../src/main";
import { TapestryView, TAPESTRY_VIEW_TYPE } from "../src/ui/tapestry-view";
import { FakeEditor } from "../test-support/editor";
import {
  addLeafWithView,
  click,
  createApp,
  createFile,
  createView,
  fire,
  instantiatePlugin,
  node,
  nodes,
  registeredCommands,
  resetHarness,
  setActiveView,
  setValue,
  type ShimElement,
  textOf,
  valueOf
} from "../test-support/harness";

const HEADINGS = "# 09:00 Root\n## 09:05 Alpha\n";

interface Context {
  plugin: WeaverPlugin;
  app: App;
  view: MarkdownView;
  editor: FakeEditor;
  files: TFile[];
}

const openPanels: TapestryView[] = [];

function block(id: string, openedAt: string, title: string, body = ""): DraftBlock {
  return parseDrafts(draftBlockText({ id, openedAt, title, body }), 12)[0]!;
}

function entry(file: TFile, id: string, openedAt: string, title: string, body = ""): DraftEntry {
  return { file, draft: block(id, openedAt, title, body) };
}

async function startPlugin(
  source = HEADINGS,
  others: Array<[string, string]> = []
): Promise<Context> {
  const first = createFile("a.md", source);
  const extra = others.map(([path, content]) => createFile(path, content));
  const app = createApp([first, ...extra]);

  const editor = new FakeEditor(source);
  const view = createView(app, first, editor);
  setActiveView(app, view);
  addLeafWithView(app, view);

  const plugin = instantiatePlugin(WeaverPlugin, app);
  await plugin.onload();

  return { plugin, app, view, editor, files: [first, ...extra] };
}

/** Serves a fixed list of drafts instead of scanning the vault. */
function serve(plugin: WeaverPlugin, entries: DraftEntry[]): void {
  (plugin as unknown as { draftIndex: { openDrafts(): Promise<DraftEntry[]> } }).draftIndex = {
    openDrafts: () => Promise.resolve(entries)
  };
}

async function openPanel(plugin: WeaverPlugin): Promise<TapestryView> {
  const panel = new TapestryView(new WorkspaceLeaf(), plugin);
  openPanels.push(panel);
  await panel.onOpen();
  return panel;
}

function draftIds(panel: TapestryView): string[] {
  return nodes(panel.contentEl, ".weaver-draft-result").map((row) =>
    String(row.getAttr("data-draft-id"))
  );
}

function selectedDraft(panel: TapestryView): string | null {
  const row = node(panel.contentEl, ".weaver-draft-result.is-selected");
  const id = row?.getAttr("data-draft-id");
  return id === undefined || id === null ? null : String(id);
}

function filterInput(panel: TapestryView, index: number): ShimElement | null {
  return nodes(panel.contentEl, ".weaver-panel-filter")[index] ?? null;
}

function typeInto(panel: TapestryView, index: number, value: string): void {
  const input = filterInput(panel, index);
  setValue(input, value);
  fire(input, "input");
}

beforeEach(() => {
  resetHarness();
  Platform.isMobile = false;
  Platform.isPhone = false;
  Platform.isTablet = false;
});

afterEach(async () => {
  for (const panel of openPanels) await panel.onClose();
  openPanels.length = 0;
});

describe("groupDraftsByFile", () => {
  it("groups by file in first-seen order and keeps row order", () => {
    const a = createFile("a.md", "");
    const b = createFile("b.md", "");

    const groups = groupDraftsByFile([
      { file: b, draft: block("2.1", "2026-10-26 17:00:00", "one") },
      { file: a, draft: block("2.2", "2026-10-26 16:00:00", "two") },
      { file: b, draft: block("2.3", "2026-10-26 15:00:00", "three") }
    ]);

    expect(groups.map((group) => group.file.path)).toEqual(["b.md", "a.md"]);
    expect(groups[0]?.entries.map((entry) => entry.draft.id)).toEqual(["2.1", "2.3"]);
    expect(groups[1]?.entries.map((entry) => entry.draft.id)).toEqual(["2.2"]);

    expect(groupDraftsByFile([])).toEqual([]);
  });
});

describe("Tapestry skeleton", () => {
  it("builds three sections, two filters, one grid and the empty count", async () => {
    const app = createApp();
    const plugin = instantiatePlugin(WeaverPlugin, app);
    await plugin.onload();

    const panel = await openPanel(plugin);

    expect(nodes(panel.contentEl, ".weaver-panel-section")).toHaveLength(3);
    expect(nodes(panel.contentEl, ".weaver-panel-filter")).toHaveLength(2);
    // The scope's sections share one grid; there is no row of verbs above them.
    expect(nodes(panel.contentEl, ".weaver-tapestry-grid")).toHaveLength(1);
    expect(nodes(panel.contentEl, ".weaver-tapestry-grid .weaver-panel-section")).toHaveLength(3);
    expect(nodes(panel.contentEl, ".weaver-panel-actions")).toHaveLength(0);
    expect(textOf(node(panel.contentEl, ".weaver-panel-count"))).toBe("No open drafts");
  });
});

describe("TapestryView drafts", () => {
  it("groups rows by note, newest file first, with ids, titles and elapsed", async () => {
    const context = await startPlugin(HEADINGS, [["b.md", "# Root\n"]]);
    serve(context.plugin, [
      entry(context.files[1]!, "2.2", "2026-10-26 17:00:00", "late"),
      entry(context.files[0]!, "2.1", "2026-10-26 16:37:04", "early", "a first thought")
    ]);

    const panel = await openPanel(context.plugin);

    expect(textOf(node(panel.contentEl, ".weaver-panel-count"))).toBe("2 drafts in 2 notes");

    const rows = nodes(panel.contentEl, ".weaver-draft-result");
    expect(rows.map((row) => row.getAttr("data-draft-id"))).toEqual(["2.2", "2.1"]);
    expect(rows.map((row) => row.getAttr("data-path"))).toEqual(["b.md", "a.md"]);

    expect(textOf(node(rows[1] ?? null, ".weaver-draft-result-id"))).toBe("draft 2.1");
    expect(textOf(node(rows[1] ?? null, ".weaver-draft-result-title"))).toBe("early");
    expect(textOf(node(rows[1] ?? null, ".weaver-draft-result-elapsed"))).not.toBe("");
    expect(nodes(rows[1] ?? null, ".weaver-draft-result-body")).toHaveLength(1);
    expect(nodes(rows[0] ?? null, ".weaver-draft-result-body")).toHaveLength(0);

    const files = nodes(panel.contentEl, ".weaver-panel-file");
    expect(textOf(node(files[0] ?? null, "span"))).toBe("b");
    expect(textOf(node(files[1] ?? null, "span"))).toBe("a");
    expect(textOf(node(files[0] ?? null, ".weaver-panel-file-count"))).toBe("1");
  });

  it("marks the active note's group", async () => {
    const context = await startPlugin(HEADINGS, [["b.md", "# Root\n"]]);
    serve(context.plugin, [
      entry(context.files[0]!, "2.1", "2026-10-26 17:00:00", "here"),
      entry(context.files[1]!, "2.2", "2026-10-26 16:37:04", "elsewhere")
    ]);

    const panel = await openPanel(context.plugin);

    const groups = nodes(panel.contentEl, ".weaver-panel-group");
    expect(groups.map((group) => group.hasClass("is-current-note"))).toEqual([true, false]);
  });
});

describe("TapestryView filters", () => {
  it("filters each list independently", async () => {
    const context = await startPlugin(HEADINGS, [["b.md", "# Root\n"]]);
    serve(context.plugin, [
      entry(context.files[1]!, "2.2", "2026-10-26 17:00:00", "later", "a later thought"),
      entry(context.files[0]!, "2.1", "2026-10-26 16:37:04", "earlier", "another body")
    ]);

    const panel = await openPanel(context.plugin);
    expect(nodes(panel.contentEl, ".weaver-dimension-row")).toHaveLength(2);

    typeInto(panel, 0, "earlier");
    expect(draftIds(panel)).toEqual(["2.1"]);
    expect(nodes(panel.contentEl, ".weaver-dimension-row")).toHaveLength(2);

    typeInto(panel, 1, "alpha");
    expect(nodes(panel.contentEl, ".weaver-dimension-row")).toHaveLength(1);
    expect(draftIds(panel)).toEqual(["2.1"]);

    typeInto(panel, 0, "nothing here");
    expect(textOf(node(panel.contentEl, ".weaver-panel-groups .weaver-panel-empty"))).toBe(
      "No drafts match."
    );
    expect(nodes(panel.contentEl, ".weaver-dimension-row")).toHaveLength(1);

    typeInto(panel, 1, "nothing here");
    expect(textOf(node(panel.contentEl, ".weaver-panel-dimensions .weaver-panel-empty"))).toBe(
      "No dimensions match."
    );
    expect(draftIds(panel)).toEqual([]);
  });

  it("says so when there is nothing to list", async () => {
    const context = await startPlugin("");
    const panel = await openPanel(context.plugin);

    expect(textOf(node(panel.contentEl, ".weaver-panel-groups .weaver-panel-empty"))).toBe(
      "No open drafts."
    );
    expect(textOf(node(panel.contentEl, ".weaver-panel-dimensions .weaver-panel-empty"))).toBe(
      "No dimensions in this note."
    );
  });
});

describe("TapestryView headings", () => {
  it("lists the active note's headings with levels and the note name", async () => {
    const context = await startPlugin(HEADINGS);
    const panel = await openPanel(context.plugin);

    const rows = nodes(panel.contentEl, ".weaver-dimension-row");
    expect(rows).toHaveLength(2);
    expect(textOf(node(rows[0] ?? null, ".weaver-dimension-level"))).toBe("1D");
    expect(textOf(node(rows[1] ?? null, ".weaver-dimension-level"))).toBe("2D");
    expect(textOf(node(rows[1] ?? null, ".weaver-dimension-title"))).toBe("Alpha");
    expect(textOf(node(panel.contentEl, ".weaver-panel-note"))).toBe("a");
  });
});

describe("TapestryView navigation", () => {
  it("lands on a draft's title line from its row", async () => {
    const context = await startPlugin("# 09:00 Root\n\nsome text\n");
    serve(context.plugin, [entry(context.files[0]!, "2.1", "2026-10-26 17:00:00", "here")]);

    const panel = await openPanel(context.plugin);
    click(node(panel.contentEl, ".weaver-draft-result"));

    expect(context.editor.getCursor().line).toBe(1);
  });

  it("lands on a heading's line from its row", async () => {
    const context = await startPlugin(HEADINGS);
    const panel = await openPanel(context.plugin);

    click(nodes(panel.contentEl, ".weaver-dimension-row")[1] ?? null);

    expect(context.editor.getCursor().line).toBe(1);
  });

  it("opens the target note when the draft lives elsewhere", async () => {
    const context = await startPlugin(HEADINGS, [["b.md", "# Root\n"]]);
    serve(context.plugin, [
      entry(context.files[1]!, "2.1", "2026-10-26 17:00:00", "elsewhere")
    ]);

    const panel = await openPanel(context.plugin);
    click(node(panel.contentEl, ".weaver-draft-result"));
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();

    const leaf = context.app.workspace.getLeaf(false) as unknown as { openedFile: TFile | null };
    expect(leaf.openedFile).toBe(context.files[1]);
  });
});

describe("TapestryView keyboard", () => {
  const SOURCE = [
    "# 09:00 Root",
    "## 09:05 Alpha",
    "⟪draft 2.1 2026-10-26 17:00:00⟫",
    "alpha",
    "⟪/draft 2.1⟫",
    "⟪draft 2.2 2026-10-26 16:37:04⟫",
    "beta",
    "⟪/draft 2.2⟫"
  ].join("\n");

  async function keyboardContext(): Promise<{ context: Context; panel: TapestryView }> {
    const context = await startPlugin(SOURCE);
    serve(
      context.plugin,
      parseDrafts(SOURCE, 12).map((draft) => ({ file: context.files[0]!, draft }))
    );

    return { context, panel: await openPanel(context.plugin) };
  }

  it("walks the draft rows and jumps on Enter", async () => {
    const { context, panel } = await keyboardContext();
    const list = node(panel.contentEl, ".weaver-panel-groups");
    if (list === null) throw new Error("missing drafts list");

    expect(selectedDraft(panel)).toBe("2.1");
    expect(nodes(panel.contentEl, ".weaver-draft-result")[0]?.getAttr("tabindex")).toBe("-1");

    fire(list, "keydown", { key: "ArrowDown" });
    expect(selectedDraft(panel)).toBe("2.2");
    expect(node(panel.contentEl, ".weaver-draft-result.is-selected")?.getAttr("aria-selected"))
      .toBe("true");

    fire(list, "keydown", { key: "j" });
    expect(selectedDraft(panel)).toBe("2.1");

    fire(list, "keydown", { key: "ArrowUp" });
    expect(selectedDraft(panel)).toBe("2.2");

    fire(list, "keydown", { key: "Enter" });
    expect(context.editor.getCursor().line).toBe(6);
  });

  it("starts the filter with a typed letter and clears it with Escape", async () => {
    const { panel } = await keyboardContext();
    const list = node(panel.contentEl, ".weaver-panel-groups");
    if (list === null) throw new Error("missing drafts list");

    fire(list, "keydown", { key: "b" });

    expect(valueOf(filterInput(panel, 0))).toBe("b");
    expect(draftIds(panel)).toEqual(["2.2"]);
    expect(selectedDraft(panel)).toBe("2.2");

    fire(list, "keydown", { key: "Escape" });

    expect(valueOf(filterInput(panel, 0))).toBe("");
    expect(draftIds(panel)).toEqual(["2.1", "2.2"]);
    expect(selectedDraft(panel)).toBe("2.1");
  });

  it("swaps lists with Tab and jumps from the heading list", async () => {
    const { context, panel } = await keyboardContext();
    const drafts = node(panel.contentEl, ".weaver-panel-groups");
    const headings = node(panel.contentEl, ".weaver-panel-dimensions");
    if (drafts === null || headings === null) throw new Error("missing list");

    fire(drafts, "keydown", { key: "Tab" });
    expect(headings.hasClass("is-focused")).toBe(true);
    expect(drafts.hasClass("is-focused")).toBe(false);

    fire(headings, "keydown", { key: "ArrowDown" });
    fire(headings, "keydown", { key: "Enter" });

    expect(context.editor.getCursor().line).toBe(1);
  });

  it("keeps rows out of the Tab order", async () => {
    const { panel } = await keyboardContext();

    for (const row of nodes(panel.contentEl, ".weaver-draft-result")) {
      expect(row.getAttr("tabindex")).toBe("-1");
      expect(row.getAttr("role")).toBe("option");
    }

    for (const row of nodes(panel.contentEl, ".weaver-dimension-row")) {
      expect(row.getAttr("tabindex")).toBe("-1");
      expect(row.getAttr("role")).toBe("option");
    }
  });
});

describe("TapestryView review", () => {
  it("names what is unfinished, each row a way to it", async () => {
    const context = await startPlugin(HEADINGS, [[todayPath(), DAY_SOURCE]]);
    serve(context.plugin, [
      entry(context.files[1]!, "1.1", "2026-10-26 17:00:00", "unwoven")
    ]);
    context.plugin.shuttles.load({ kind: "note", path: "a.md", label: "a" });

    const panel = await scopePanel(context.plugin);
    await panel.setScope("day");

    expect(nodes(panel.contentEl, ".weaver-review-row").map((row) => textOf(row))).toEqual([
      "1 draft, unwoven",
      "1 loaded, not yet woven",
      "last mark 16:37"
    ]);
  });

  it("leads from the loaded row to the shuttle", async () => {
    const context = await startPlugin(HEADINGS, [[todayPath(), DAY_SOURCE]]);
    context.plugin.shuttles.load({ kind: "note", path: "a.md", label: "a" });

    const panel = await scopePanel(context.plugin);
    await panel.setScope("day");

    const row = nodes(panel.contentEl, ".weaver-review-row").find(
      (candidate) => textOf(candidate) === "1 loaded, not yet woven"
    );
    click(row ?? null);

    const palette = (context.plugin as unknown as { shuttlePalette: { isOpen: boolean } | null })
      .shuttlePalette;
    expect(palette?.isOpen).toBe(true);
  });

  it("counts untitled sparks and says so when nothing is pending", async () => {
    const untitledDay = DAY_SOURCE.replace("# 16:37:04 - second", "# 16:37:04 - ");
    const context = await startPlugin(HEADINGS, [[todayPath(), untitledDay]]);
    const panel = await scopePanel(context.plugin);
    await panel.setScope("day");

    expect(nodes(panel.contentEl, ".weaver-review-row").map((row) => textOf(row))).toContain(
      "1 spark untitled"
    );

    const clean = await startPlugin(HEADINGS, [[todayPath(), DAY_SOURCE]]);
    const other = await scopePanel(clean.plugin);
    await other.setScope("day");
    expect(textOf(node(other.contentEl, ".weaver-review-row"))).toBe("Nothing pending.");
  });

  it("leads from the untitled row to the untitled dimension", async () => {
    const untitledDay = [
      "---",
      "date: 2026-10-27",
      "---",
      "",
      "# 09:12:01 - first",
      "# 16:37:04 - "
    ].join("\n");
    const context = await startPlugin(HEADINGS, [[todayPath(), untitledDay]]);
    context.plugin.openTapestry("day");
    const panel = new TapestryView(new WorkspaceLeaf(), context.plugin);
    openPanels.push(panel);
    await panel.onOpen();

    const row = nodes(panel.contentEl, ".weaver-review-row").find(
      (candidate) => textOf(candidate) === "1 spark untitled"
    );
    click(row ?? null);
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();

    const leaf = context.app.workspace.getLeaf(false) as unknown as { openedFile: TFile | null };
    expect(leaf.openedFile?.path).toBe(todayPath());
  });
});

describe("TapestryView registration", () => {
  it("registers the view, its ribbon icon and its command", async () => {
    const context = await startPlugin("# Root\n");

    const views = (context.plugin as unknown as { views: Map<string, unknown> }).views;
    expect(views.has(TAPESTRY_VIEW_TYPE)).toBe(true);

    const panel = new TapestryView(new WorkspaceLeaf(), context.plugin);
    expect(panel.getViewType()).toBe("weaver-tapestry");
    expect(panel.getDisplayText()).toBe("Tapestry");
    expect(panel.getIcon()).toBe("waypoints");

    // The Tapestry is a tab of its own, not a sidebar panel.
    context.plugin.openTapestry("day");
    const workspace = context.app.workspace as unknown as {
      leafRequests: Array<string | boolean | undefined>;
      openedLeaves: WorkspaceLeaf[];
    };
    expect(workspace.leafRequests).toContain("tab");
    const leaf = workspace.openedLeaves.at(-1);
    expect(leaf?.getViewState().type).toBe(TAPESTRY_VIEW_TYPE);

    // A fresh view from the registered factory opens at the requested scope.
    const factory = (
      context.plugin as unknown as { views: Map<string, (leaf: WorkspaceLeaf) => TapestryView> }
    ).views.get(TAPESTRY_VIEW_TYPE);
    const view = factory?.(leaf as WorkspaceLeaf);
    expect(view?.getScope()).toBe("day");

    const command = registeredCommands(context.plugin).find(
      (candidate) => candidate.id === "tapestry"
    );
    expect(command?.name).toBe("Open Tapestry");
    expect((command as unknown as { icon?: string } | undefined)?.icon).toBe("waypoints");
    expect(JSON.stringify(command?.hotkeys ?? null)).toBe(
      '[{"modifiers":["Mod","Shift"],"key":"t"}]'
    );
  });

  it("moves travel to the command-palette chord and Spark onto the freed k", async () => {
    const context = await startPlugin("# Root\n");
    const commands = registeredCommands(context.plugin);

    const travel = commands.find((command) => command.id === "travel");
    expect(JSON.stringify(travel?.hotkeys ?? null)).toBe(
      '[{"modifiers":["Mod","Shift"],"key":"p"}]'
    );

    // `Mod+Shift+K` was freed when travel moved to `p`; Spark is now the only
    // command on it, and the retired `append-h1` chord is claimed by nobody.
    const onK = commands.filter((command) =>
      JSON.stringify(command.hotkeys ?? []).includes('"key":"k"')
    );
    expect(onK.map((command) => command.id)).toEqual(["spark"]);
    expect(
      commands.filter((command) => JSON.stringify(command.hotkeys ?? []).includes('"key":"b"'))
    ).toEqual([]);
  });
});

/** Lets pending promises and timers run so an async view refresh has settled. */
async function settleMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** `YYYY.MM.DD` for today, so a day-note fixture is always the live day note. */
function todayPath(): string {
  return dayNotePath(new Date(), {
    folder: DEFAULT_SETTINGS.dayNoteFolder,
    format: DEFAULT_SETTINGS.dayNoteFormat
  });
}

const DAY_SOURCE = [
  "---",
  "date: 2026-10-27",
  "sparks: 2",
  "dimensions: 3",
  "sources: 1",
  "---",
  "",
  "# 09:12:01 - first",
  "✦ [[Note#^abc123|first source]]",
  "## 10:00:00 - deeper",
  "# 16:37:04 - second"
].join("\n");

async function scopePanel(plugin: WeaverPlugin): Promise<TapestryView> {
  const panel = new TapestryView(new WorkspaceLeaf(), plugin);
  openPanels.push(panel);
  await panel.onOpen();
  return panel;
}

describe("Tapestry scopes", () => {
  it("renders only the sections a scope owns", async () => {
    const context = await startPlugin(HEADINGS, [[todayPath(), DAY_SOURCE]]);
    const panel = await scopePanel(context.plugin);
    const count = (selector: string): number => nodes(panel.contentEl, selector).length;

    // Note scope: drafts, dimensions and the note's own census.
    expect(count(".weaver-tapestry-scope")).toBe(4);
    expect(count(".weaver-panel-section")).toBe(3);
    expect(count(".weaver-census")).toBe(1);
    expect(count(".weaver-cal")).toBe(0);

    await panel.setScope("day");
    expect(count(".weaver-threads")).toBe(1);
    expect(count(".weaver-census")).toBe(1);
    expect(count(".weaver-review")).toBe(1);
    expect(count(".weaver-panel-dimensions")).toBe(0);
    expect(count(".weaver-cal")).toBe(0);

    await panel.setScope("month");
    expect(count(".weaver-census")).toBe(1);
    expect(count(".weaver-cal")).toBe(1);
    expect(count(".weaver-horizon")).toBe(0);

    await panel.setScope("all");
    expect(count(".weaver-cal")).toBe(1);
    expect(count(".weaver-horizon")).toBe(1);
  });

  it("reads the day note live for threads, census and the review", async () => {
    const context = await startPlugin(HEADINGS, [[todayPath(), DAY_SOURCE]]);
    const panel = await scopePanel(context.plugin);
    await panel.setScope("day");

    const threads = nodes(panel.contentEl, ".weaver-thread");
    expect(threads).toHaveLength(2);
    expect(textOf(node(threads[0] ?? null, ".weaver-thread-count"))).toBe("1");
    expect(textOf(node(threads[0] ?? null, ".weaver-thread-mark"))).toBe("✦");
    expect(textOf(node(threads[1] ?? null, ".weaver-thread-mark"))).toBe("");

    const census = nodes(panel.contentEl, ".weaver-census-row").map((row) => textOf(row));
    expect(census).toEqual(["1D2", "2D1", "total3"]);

    expect(nodes(panel.contentEl, ".weaver-review-row").map((row) => textOf(row))).toContain(
      "last mark 16:37"
    );
  });

  it("closes the day from the review and then says so", async () => {
    const context = await startPlugin(HEADINGS, [[todayPath(), DAY_SOURCE]]);
    const panel = await scopePanel(context.plugin);
    await panel.setScope("day");

    const close = node(panel.contentEl, ".weaver-review-close");
    expect(textOf(close)).toBe("Close the day");
    close?.click();
    await settleMicrotasks();

    expect(context.files[1]?.path).toBe(todayPath());
    expect(nodes(panel.contentEl, ".weaver-review-row").map((row) => textOf(row)).join("\n")).toContain(
      "closed"
    );
    expect(textOf(node(panel.contentEl, ".weaver-review-close"))).toBe("Day closed");
    expect(node(panel.contentEl, ".weaver-review-close")?.disabled).toBe(true);
  });

  it("counts month and all scopes from the cache without opening a file", async () => {
    const context = await startPlugin(HEADINGS, [
      [todayPath(), DAY_SOURCE],
      ["Chronomancer/2026.09.01.md", "---\ndate: 2026-09-01\nsparks: 4\ndimensions: 6\n---\n"],
      ["Chronomancer/2026.09.02.md", "---\ndate: 2026-09-02\nsparks: 1\ndimensions: 2\n---\n"]
    ]);

    const cache = new Map<string, unknown>([
      [todayPath(), { frontmatter: { date: "2026-10-27", sparks: 2, dimensions: 3 } }],
      ["Chronomancer/2026.09.01.md", { frontmatter: { date: "2026-09-01", sparks: 4, dimensions: 6 } }],
      ["Chronomancer/2026.09.02.md", { frontmatter: { date: "2026-09-02", sparks: 1, dimensions: 2 } }]
    ]);
    const asked: string[] = [];
    (context.app as unknown as { metadataCache: unknown }).metadataCache = {
      getFileCache: (file: TFile) => {
        asked.push(file.path);
        return cache.get(file.path) ?? null;
      }
    };

    let reads = 0;
    const vault = context.app.vault as unknown as { cachedRead: (file: TFile) => Promise<string> };
    const originalCachedRead = vault.cachedRead.bind(context.app.vault);
    vault.cachedRead = (file: TFile) => {
      reads += 1;
      return originalCachedRead(file);
    };

    // Opening the panel at Note scope legitimately reads the active note; the
    // assertion is that the cached scopes add no reads of their own.
    const panel = await scopePanel(context.plugin);
    reads = 0;
    asked.length = 0;
    await panel.setScope("all");

    expect(asked.length).toBeGreaterThan(0);
    expect(reads).toBe(0);
    // 53 weeks of seven days, all drawn from the cache.
    expect(nodes(panel.contentEl, ".weaver-cal-cell")).toHaveLength(53 * 7);
    expect(nodes(panel.contentEl, ".weaver-day-row")).toHaveLength(3);
  });

  it("re-scopes and reveals the Tapestry it already has", async () => {
    const context = await startPlugin("# Root\n");
    const panel = await openPanel(context.plugin);
    addLeafWithView(context.app, panel as unknown as MarkdownView);

    const workspace = context.app.workspace as unknown as {
      leafRequests: Array<string | boolean | undefined>;
      activeLeafCalls: Array<{ view: unknown }>;
    };
    const before = workspace.leafRequests.length;

    context.plugin.openTapestry("month");

    // One Tapestry, one tab: no second leaf, and the open one takes the scope.
    expect(workspace.leafRequests).toHaveLength(before);
    expect(panel.getScope()).toBe("month");
    expect(workspace.activeLeafCalls.some((leaf) => leaf.view === panel)).toBe(true);
  });

  it("opens a new view at the scope the caller asked for", async () => {
    const context = await startPlugin();
    context.plugin.openTapestry("day");

    const fresh = new TapestryView(new WorkspaceLeaf(), context.plugin);
    expect(fresh.getScope()).toBe("day");

    context.plugin.openTapestry("all");
    expect(new TapestryView(new WorkspaceLeaf(), context.plugin).getScope()).toBe("all");
  });
});
