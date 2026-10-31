import { beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { editorInfoField, TFile, type MarkdownFileInfo } from "obsidian";

import WeaverPlugin from "../src/main";
import { parseEntries } from "../src/core/entries";
import { dayNotePath } from "../src/core/day";
import { entryIndexField } from "../src/editor/entry-field";
import { registerEditorView, unregisterEditorView } from "../src/editor/view-registry";
import { NOTICE_NEEDS_EDITING, NOTICE_NEEDS_ENTRY, noticeLegacyFormat } from "../src/notices";
import { DEFAULT_SETTINGS } from "../src/settings";
import { FakeEditor } from "../test-support/editor";
import {
  addLeafWithView,
  clearNotices,
  createApp,
  createFile,
  createView,
  fileContent,
  instantiatePlugin,
  liveEditor,
  noticeMessages,
  resetHarness
} from "../test-support/harness";

const AT_1337 = new Date(2026, 9, 27, 13, 27, 43);
// The default day-note format is dotted, so the day note is not the day key.
const DAY = "Chronomancer/2026.10.27.md";

async function start(files: TFile[]): Promise<{ plugin: WeaverPlugin; app: ReturnType<typeof createApp> }> {
  const app = createApp(files);
  const plugin = instantiatePlugin(WeaverPlugin, app);
  await plugin.onload();
  return { plugin, app };
}

/** The stub vault writes synchronously, so the read is the assertion. */
function reading(app: ReturnType<typeof createApp>, path: string): string {
  const file = app.vault.getAbstractFileByPath(path);
  return file instanceof TFile ? fileContent(file) : "";
}

/** A CodeMirror view double over `doc`: `afterEdit` reads the state, nothing else. */
function viewOf(path: string, doc: string, anchor = 0): EditorView {
  const state = EditorState.create({
    doc,
    selection: { anchor },
    extensions: [
      entryIndexField,
      editorInfoField.init(() => ({ file: createFile(path, "") }) as unknown as MarkdownFileInfo)
    ]
  });
  return { state, dispatch: () => {}, focus: () => {} } as unknown as EditorView;
}

beforeEach(() => {
  resetHarness();
  clearNotices();
});

describe("starting an entry", () => {
  it("creates today's note and writes the first entry at its tip", async () => {
    const { plugin, app } = await start([]);

    await plugin.entries.startEntry(AT_1337);

    expect(app.vault.getAbstractFileByPath(DAY)).not.toBeNull();
    expect(reading(app, DAY)).toContain("travels: 0");
    expect(reading(app, DAY)).toContain("{ 1.1.1 }\n\n13:27:43 - 00:00:00");

    plugin.onunload();
  });

  it("starts in the note that already holds one", async () => {
    const existing = createFile(DAY, ["{ 1.1.1 }", "first", "09:00:00 + 00:01:00"].join("\n"));
    const { plugin, app } = await start([existing]);

    await plugin.entries.startEntry(AT_1337);

    const text = reading(app, DAY);
    expect(text).toContain("{ 1.2.2 }");
    expect(text.startsWith("{ 1.1.1 }")).toBe(true);

    plugin.onunload();
  });

  it("leaves the clock stopped on the entry it just wrote", async () => {
    const { plugin, app } = await start([]);

    await plugin.entries.startEntry(AT_1337);

    // No clock before the first keystroke: a write is not typing.
    expect(plugin.session.active()).toBeNull();
    expect(reading(app, DAY)).toContain("{ 1.1.1 }\n\n13:27:43 - 00:00:00");

    plugin.onunload();
  });

  it("lands at the file's real end when the note grew under a stale read", async () => {
    // A sync, a terminal, another device: the file holds two more entries than
    // the note the starter was looking at. The plan is built from the text
    // being written, so `N` counts the file's entries, not the stale ones.
    const stale = ["{ 1.1.1 }", "first", "09:00:00 + 00:01:00"].join("\n");
    const grown = [stale, "", "", "{ 1.2.2 }", "second", "09:30:00 + 00:02:00", ""].join("\n");
    const file = createFile(DAY, stale);
    const { plugin, app } = await start([file]);

    (file as unknown as { content: string }).content = grown;

    await plugin.entries.startEntry(AT_1337);

    const text = reading(app, DAY);
    expect(text).toContain("{ 1.3.3 }");
    expect(text.endsWith("13:27:43 - 00:00:00\n")).toBe(true);
    expect(text.startsWith("{ 1.1.1 }")).toBe(true);

    plugin.onunload();
  });

  it("writes through the vault when the note is not in editing mode", async () => {
    const file = createFile(DAY, "");
    const { plugin, app } = await start([file]);
    const view = createView(app, file, new FakeEditor(""), "preview");
    (app.workspace as unknown as { activeView: unknown }).activeView = view;

    await plugin.entries.startEntry(AT_1337);

    expect(reading(app, DAY)).toContain("{ 1.1.1 }");

    plugin.onunload();
  });
});

describe("deleting the entry being written", () => {
  it("settles the session, writes nothing, and starts the next entry clean", async () => {
    // The editor's deletion already reached the vault: the note no longer holds
    // the entry the clock was running on.
    const file = createFile(DAY, "");
    const { plugin, app } = await start([file]);

    plugin.session.start(DAY, 1, 65_000, AT_1337.getTime());
    plugin.entries.afterEdit(viewOf(DAY, ""), false);

    expect(plugin.session.active()).toBeNull();
    expect(reading(app, DAY)).toBe("");

    await plugin.entries.startEntry(AT_1337);

    expect(reading(app, DAY)).toContain("{ 1.1.1 }");
    // No clock before the first keystroke in the new entry.
    expect(plugin.session.active()).toBeNull();

    plugin.onunload();
  });

  it("leaves the file alone when the entry it would settle is gone", async () => {
    const survived = ["{ 1.1.1 }", "first", "09:00:00 + 00:01:00"].join("\n");
    const file = createFile(DAY, survived);
    const { plugin, app } = await start([file]);

    plugin.session.start(DAY, 2, 65_000, AT_1337.getTime());
    plugin.entries.afterEdit(viewOf(DAY, survived, survived.indexOf("first")), false);

    expect(plugin.session.active()).toBeNull();
    expect(reading(app, DAY)).toBe(survived);

    plugin.onunload();
  });
});

describe("when the clock may start", () => {
  const DRAFT = ["{ 1.1.1 }", "prose", "10:00:00 - 00:01:00"].join("\n");

  it("starts on the writer's own typing, at the file's stored time", async () => {
    const { plugin } = await start([createFile(DAY, DRAFT)]);

    plugin.entries.afterEdit(viewOf(DAY, DRAFT, DRAFT.indexOf("prose")), true);

    expect(plugin.session.active()?.seq).toBe(1);
    expect(plugin.session.active()?.baselineMs).toBe(60_000);

    plugin.onunload();
  });

  it("starts nothing when the vault reloads a draft nobody typed into", async () => {
    const { plugin, app } = await start([createFile(DAY, DRAFT)]);

    plugin.entries.afterEdit(viewOf(DAY, DRAFT, DRAFT.indexOf("prose")), false);

    expect(plugin.session.active()).toBeNull();
    // Nothing running means nothing written, however long the window is open.
    plugin.entries.pause(AT_1337);
    expect(reading(app, DAY)).toBe(DRAFT);

    plugin.onunload();
  });
});

describe("writing a duration", () => {
  it("rewrites the clock row through the vault", async () => {
    const file = createFile(DAY, ["{ 1.1.1 }", "prose", "10:00:00 - 00:01:00"].join("\n"));
    const { plugin, app } = await start([file]);

    plugin.entries.publish(DAY, 1, "+", 342_000, true);

    expect(reading(app, DAY)).toContain("+ 00:05:42");

    plugin.onunload();
  });

  it("skips the write when the entry it aimed at is gone", async () => {
    const source = ["{ 1.1.1 }", "prose", "10:00:00 - 00:01:00"].join("\n");
    const file = createFile(DAY, source);
    const { plugin, app } = await start([file]);

    plugin.entries.publish(DAY, 9, "+", 1000, true);

    expect(reading(app, DAY)).toBe(source);

    plugin.onunload();
  });

  it("pauses the live session onto the draft's own line", async () => {
    const file = createFile(DAY, ["{ 1.1.1 }", "prose", "10:00:00 - 00:00:00"].join("\n"));
    const { plugin, app } = await start([file]);

    plugin.session.start(DAY, 1, 4000, AT_1337.getTime());
    plugin.entries.pause(AT_1337);

    expect(plugin.session.active()).toBeNull();
    expect(reading(app, DAY)).toContain("= 00:00:04");

    plugin.onunload();
  });

  it("writes the settings' own day frontmatter when the note is created", async () => {
    const { plugin } = await start([]);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      dayNoteFolder: "Journal",
      dayNoteFormat: "YYYY-MM-DD"
    };

    await plugin.entries.startEntry(AT_1337);

    expect(plugin.app.vault.getAbstractFileByPath("Journal/2026-10-27.md")).not.toBeNull();

    plugin.onunload();
  });
});

describe("a note in the old format", () => {
  // The old duration line still parses as a clock row, so the parser would
  // happily read this note as an entry — and settle would rewrite one field of
  // it. The flag exists to refuse the note whole.
  const LEGACY = ["{ 1.1.1 } - 10:00:00", "prose", "- 00:01:00"].join("\n");

  it("refuses a settle and says why, leaving every byte alone", () => {
    const file = createFile(DAY, LEGACY);
    return start([file]).then(({ plugin }) => {
      const view = liveEditor(file, LEGACY, LEGACY.indexOf("prose"));
      const entry = parseEntries(LEGACY).entries[0];
      if (entry === undefined) throw new Error("expected an entry");

      plugin.entries.settle(view, entry);

      expect(view.state.doc.toString()).toBe(LEGACY);
      expect(noticeMessages()).toEqual([noticeLegacyFormat("settling this entry")]);
      plugin.onunload();
    });
  });

  it("refuses a start and says why", async () => {
    const file = createFile(DAY, LEGACY);
    const { plugin, app } = await start([file]);

    await plugin.entries.startEntry(AT_1337);

    expect(reading(app, DAY)).toBe(LEGACY);
    expect(noticeMessages()).toEqual([noticeLegacyFormat("starting an entry")]);

    plugin.onunload();
  });
});

describe("moving the caret", () => {
  const TWO = [
    "{ 1.1.1 }",
    "first",
    "10:00:00 + 00:01:00",
    "",
    "{ 1.2.2 }",
    "second",
    "10:05:00 + 00:02:00",
    ""
  ].join("\n");

  it("jumps without writing and without starting a clock", async () => {
    // `jumpTo` reveals *today's* note, which is the machine's date, not the
    // fixture's: the path has to be today's for the file to be the day note.
    const today = dayNotePath(new Date(), {
      folder: DEFAULT_SETTINGS.dayNoteFolder,
      format: DEFAULT_SETTINGS.dayNoteFormat
    });
    const file = createFile(today, TWO);
    const { plugin, app } = await start([file]);
    // The note is on screen, and the editor holding it is the writer's own.
    addLeafWithView(app, createView(app, file, new FakeEditor(TWO)));
    const view = liveEditor(file, TWO, 0);
    registerEditorView(view);

    try {
      plugin.session.start(today, 1, 60_000, AT_1337.getTime());
      await plugin.entries.jumpTo(2);

      expect(plugin.session.active()).toBeNull();
      expect(view.state.selection.main.head).toBe(TWO.indexOf("second"));
      expect(reading(app, today)).toBe(TWO);
      // The place it left is the first row of the return stack.
      expect(plugin.stack.stops.map((stop) => stop.n)).toEqual([1]);
    } finally {
      unregisterEditorView(view);
      plugin.onunload();
    }
  });

  it("descends without starting a clock, on the parent's branch", () => {
    const source = ["{ 1.1.1 }", "first", "10:00:00 + 00:01:00"].join("\n");
    const file = createFile(DAY, source);
    return start([file]).then(({ plugin }) => {
      const view = liveEditor(file, source, source.indexOf("first"));
      const parent = parseEntries(source).entries[0];
      if (parent === undefined) throw new Error("expected an entry");

      plugin.entries.descend(view, parent);

      expect(plugin.session.active()).toBeNull();
      expect(view.state.doc.toString()).toContain("{ 2.1.2 }");
      expect(plugin.stack.stops.map((stop) => stop.n)).toEqual([1]);

      plugin.onunload();
    });
  });
});

describe("the descent command", () => {
  const SETTLED = ["{ 1.1.1 }", "first", "10:00:00 + 00:01:00"].join("\n");
  const OPEN = ["{ 1.1.1 }", "first", "10:00:00 - 00:00:00"].join("\n");

  it("opens a child under the caret's settled entry, and starts no clock", async () => {
    const file = createFile(DAY, SETTLED);
    const { plugin } = await start([file]);
    const view = liveEditor(file, SETTLED, SETTLED.indexOf("first"));
    registerEditorView(view);

    try {
      plugin.entries.descendAtCaret();

      expect(view.state.doc.toString()).toContain("{ 2.1.2 }");
      expect(plugin.session.active()).toBeNull();
    } finally {
      unregisterEditorView(view);
      plugin.onunload();
    }
  });

  it("settles an open entry first, then opens the child under it", async () => {
    const file = createFile(DAY, OPEN);
    const { plugin } = await start([file]);
    const view = liveEditor(file, OPEN, OPEN.indexOf("first"));
    registerEditorView(view);

    try {
      plugin.entries.descendAtCaret();

      const text = view.state.doc.toString();
      // The parent's own row settled; the child's row is a fresh draft.
      expect(text.split("\n")[2]).toBe("10:00:00 + 00:00:00");
      expect(text).toContain("{ 2.1.2 }");
      expect(plugin.session.active()).toBeNull();
    } finally {
      unregisterEditorView(view);
      plugin.onunload();
    }
  });

  it("refuses outside every entry, and writes nothing", async () => {
    // The caret sits on the blank line above the note's first marker, so no
    // entry's subtree holds it.
    const source = ["", "{ 1.1.1 }", "first", "10:00:00 + 00:01:00"].join("\n");
    const file = createFile(DAY, source);
    const { plugin } = await start([file]);
    const view = liveEditor(file, source, 0);
    registerEditorView(view);

    try {
      plugin.entries.descendAtCaret();

      expect(view.state.doc.toString()).toBe(source);
      expect(noticeMessages()).toEqual([NOTICE_NEEDS_ENTRY]);
    } finally {
      unregisterEditorView(view);
      plugin.onunload();
    }
  });

  it("refuses with no editor open, and writes nothing", async () => {
    const { plugin, app } = await start([createFile(DAY, SETTLED)]);

    plugin.entries.descendAtCaret();

    expect(reading(app, DAY)).toBe(SETTLED);
    expect(noticeMessages()).toEqual([NOTICE_NEEDS_EDITING]);

    plugin.onunload();
  });
});
