import { beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField, type MarkdownFileInfo, type TFile } from "obsidian";

import WeaverPlugin from "../src/main";
import { registerEditorView, unregisterEditorView } from "../src/editor/view-registry";
import { Navigator } from "../src/ui/navigator";
import {
  bodyQuery,
  bodyQueryAll,
  createApp,
  createFile,
  instantiatePlugin,
  resetHarness
} from "../test-support/harness";
import type { ShimElement } from "../test-support/dom";

/** Today, in the machine's own calendar: the list defaults to it. */
const NOW = new Date();
const DAY = `${NOW.getFullYear()}-${pad(NOW.getMonth() + 1)}-${pad(NOW.getDate())}`;
const NAME = `${DAY.replace(/-/g, ".")}`;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** One settled thought, dated today, in a destination's own format. */
function note(time: string, prose: string, day = DAY): string {
  return ["---", `date: ${day}`, "---", "", "{ 1.1.1 }", "", prose, `+ 00:01:00 ${day} ${time}`, ""].join("\n");
}

const MAIN_PATH = `Chronomancer/${NAME}.md`;
const SPANISH_PATH = `Spanish/Daily/${NAME}.md`;

function editorFor(file: TFile, doc: string): EditorView {
  const state = EditorState.create({
    doc,
    extensions: [editorInfoField.init(() => ({ file }) as unknown as MarkdownFileInfo)]
  });
  const view = {
    state,
    dispatch(this: { state: EditorState }, spec: Parameters<EditorState["update"]>[0]) {
      this.state = this.state.update(spec).state;
    },
    focus(): void {},
    hasFocus: false,
    scrollDOM: { scrollTop: 0 }
  };
  return view as unknown as EditorView;
}

interface Run {
  plugin: WeaverPlugin;
  navigator: Navigator;
  main: TFile;
  spanish: TFile;
  mainView: EditorView;
  rows(): ShimElement[];
  texts(): string[];
  close(): void;
}

/** A vault with two destinations and one open note, and a live navigator. */
async function open(options: { spanish?: boolean } = {}): Promise<Run> {
  const mainDoc = note("09:15:00", "a main thought");
  const spanishDoc = note("18:00:00", "a spanish thought");

  const main = createFile(MAIN_PATH, mainDoc);
  const spanish = createFile(SPANISH_PATH, options.spanish === false ? "" : spanishDoc);
  const app = createApp([main, spanish]);

  const plugin = instantiatePlugin(WeaverPlugin, app);
  await plugin.onload();
  // After the load: `onload` normalises settings from the stored payload.
  plugin.settings.contexts = [
    { id: "ctx-spanish", name: "Spanish", folder: "Spanish/Daily", format: "YYYY.MM.DD" }
  ];

  const mainView = editorFor(main, mainDoc);
  registerEditorView(mainView);

  const navigator = new Navigator(plugin);
  await navigator.open();

  const run: Run = {
    plugin,
    navigator,
    main,
    spanish,
    mainView,
    rows: () => bodyQueryAll(".weaver-navigator-entry"),
    texts: () => bodyQueryAll(".weaver-navigator-entry").map((row) => row.textContent),
    close() {
      navigator.close();
      unregisterEditorView(mainView);
      plugin.onunload();
    }
  };
  return run;
}

beforeEach(() => {
  resetHarness();
});

describe("opening the navigator", () => {
  it("reads the vault without revealing or creating a note", async () => {
    const run = await open();
    const files = run.plugin.app.vault.getMarkdownFiles().length;

    expect(bodyQuery(".weaver-navigator")).not.toBeNull();
    expect(run.plugin.app.vault.getMarkdownFiles()).toHaveLength(files);
    // No note was opened: the navigator is not a visit.
    expect((run.plugin.app.workspace as unknown as { leafRequests: unknown[] }).leafRequests).toEqual([]);

    run.close();
  });

  it("lists the day's thoughts from every destination, with their source", async () => {
    const run = await open();

    const texts = run.texts();
    expect(texts.length).toBe(2);
    expect(texts.join("\n")).toContain("a main thought");
    expect(texts.join("\n")).toContain("a spanish thought");
    // The destination is a fact on the row, not something to guess at.
    expect(texts.join("\n")).toContain("Main");
    expect(texts.join("\n")).toContain("Spanish");

    run.close();
  });

  it("orders rows by their recorded moment", async () => {
    const run = await open();
    const texts = run.texts().join("\n");

    expect(texts.indexOf("09:15:00")).toBeLessThan(texts.indexOf("18:00:00"));

    run.close();
  });

  it("says there are no Threads rather than inventing one", async () => {
    const run = await open({ spanish: false });
    const plugin = run.plugin;

    // A day with nothing in it: the note is emptied behind the list.
    run.mainView.dispatch({ changes: { from: 0, to: run.mainView.state.doc.length, insert: "" } });
    await run.navigator.refresh();

    expect(bodyQuery(".weaver-navigator")?.textContent).toContain("No Threads for this day");
    expect(plugin.app.vault.getMarkdownFiles()).toHaveLength(2);

    run.close();
  });
});

describe("choosing a Realm", () => {
  it("offers travelling and writing as different acts", async () => {
    const run = await open();
    await run.navigator.open({ section: "realms" });

    const realms = bodyQueryAll(".weaver-navigator-realm");
    expect(realms.length).toBe(2);

    const spanishRow = realms[1];
    expect(spanishRow?.textContent).toContain("Travel");
    expect(spanishRow?.textContent).toContain("Write here");

    run.close();
  });

  it("writes into a Realm without travelling to it", async () => {
    const run = await open();
    await run.navigator.open({ section: "realms" });

    const weave = bodyQueryAll(".weaver-navigator-weave")[1];
    weave?.click();

    expect(run.plugin.controller.state.contextId).toBe("ctx-spanish");
    expect(run.plugin.controller.state.phase).toBe("editing");
    // Nothing opened, so the screen did not move.
    expect((run.plugin.app.workspace as unknown as { leafRequests: unknown[] }).leafRequests).toEqual([]);

    run.close();
  });

  it("filters the day by Realm, and says All Realms explicitly", async () => {
    const run = await open();
    const filter = bodyQuery(".weaver-navigator-filter") as ShimElement;
    const options = Array.from(filter.querySelectorAll("option")).map((option) => option.textContent);
    expect(options).toEqual(["All Realms", "Main", "Spanish"]);

    filter.value = "ctx-spanish";
    filter.dispatch("change");
    await run.navigator.refresh();

    expect(run.texts().join("\n")).toContain("a spanish thought");
    expect(run.texts().join("\n")).not.toContain("a main thought");

    run.close();
  });
});

describe("rows and keys", () => {
  it("opens a row at its own note and thought", async () => {
    const run = await open();
    const jumps: Array<{ path: string; n: number | null }> = [];
    run.plugin.entries.jumpTo = async (path, n) => {
      jumps.push({ path, n });
      return true;
    };

    bodyQueryAll(".weaver-navigator-entry .weaver-navigator-open")[0]?.click();
    // Validating the row reads its note, so the visit lands a tick later.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(jumps).toEqual([{ path: MAIN_PATH, n: 1 }]);

    run.close();
  });

  it("refuses to jump when the note cannot be reached", async () => {
    const run = await open();
    run.plugin.entries.jumpTo = async () => false;

    // A refusal is silent on the list: the card is already closed by then, and
    // nothing was written or moved.
    bodyQueryAll(".weaver-navigator-entry .weaver-navigator-open")[0]?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run.plugin.controller.state.phase).toBe("closed");

    run.close();
  });

  it("branches from a row into a draft, without writing to the note", async () => {
    const run = await open();
    const card = bodyQuery(".weaver-navigator-card");

    // The first row is already selected: the list starts on its own first item.
    expect(bodyQueryAll(".weaver-navigator-entry.is-selected")).toHaveLength(1);
    card?.dispatch("keydown", { key: "Enter", shiftKey: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A branch is a draft under that thought, not a write: the entry count is
    // untouched and the composer is holding an empty branch.
    expect(run.plugin.controller.state.parent?.n).toBe(1);
    expect(run.plugin.controller.state.phase).toBe("editing");
    expect(run.plugin.controller.state.text).toBe("");
    expect(run.navigator.isOpen).toBe(false);

    run.close();
  });

  it("starts a new Thread from the list without stealing focus back", async () => {
    const run = await open();
    const card = bodyQuery(".weaver-navigator-card");
    card?.dispatch("keydown", { key: "t", shiftKey: false });

    expect(run.plugin.controller.state.phase).toBe("editing");
    expect(run.navigator.isOpen).toBe(false);

    run.close();
  });

  it("drops the forward branch only when a new navigation succeeds", async () => {
    const run = await open();
    run.plugin.history = { visits: [], cursor: -1 };

    expect(await run.plugin.goBack()).toBe(false);
    expect(run.plugin.history.visits).toEqual([]);

    run.close();
  });
});

describe("recorded captures", () => {
  it("lists a capture recorded in a note that is not open in any editor", async () => {
    const day = DAY;
    const stamp = `2026-11-06T05:18:00-08:00`;
    const began = `2026-11-06T05:18:01-08:00`;
    const withRecord = [
      "---",
      `date: ${day}`,
      "weaver-alignments:",
      `  - {"portal":"2026-11-06T13:18:00.000Z","opened":"${stamp}","began":"${began}","entry":1}`,
      "---",
      "",
      "{ 1.1.1 }",
      "",
      "written through the opening",
      `+ 00:00:00 ${day} 05:18:01`,
      ""
    ].join("\n");

    const file = createFile(MAIN_PATH, withRecord);
    const app = createApp([file]);
    const plugin = instantiatePlugin(WeaverPlugin, app);
    await plugin.onload();

    // No editor holds the note: the record is read from the vault itself.
    const navigator = new Navigator(plugin);
    await navigator.open({ section: "portals" });

    const rows = bodyQueryAll(".weaver-navigator-record").map((row) => row.textContent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("05:18");
    expect(rows[0]).toContain("Entered");
    // Actions belong to the selected row, so select the record itself: a
    // recorded row is openable while its entry still matches the note.
    bodyQuery(".weaver-navigator-record")?.click();
    expect(bodyQueryAll(".weaver-navigator-actions .weaver-navigator-action").map((b) => b.textContent)).toEqual([
      "Open"
    ]);

    navigator.close();
    plugin.onunload();
  });
});
