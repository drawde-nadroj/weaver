import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TFile } from "obsidian";

import { parseEntries } from "../src/core/entries";
import { whisperKey, type WhisperItem } from "../src/core/whisper";
import { registerEditorView, unregisterEditorView } from "../src/editor/view-registry";
import WeaverPlugin from "../src/main";
import {
  NOTICE_WHISPERING,
  NOTICE_WHISPER_UNREACHABLE,
  noticeWhispered
} from "../src/notices";
import {
  NoModel,
  type WhisperFailure,
  type WhisperModel,
  type WhisperReply,
  type WhisperRequest
} from "../src/model/whisper-model";
import { WhisperRunner } from "../src/model/whisper-runner";
import {
  clearNotices,
  createApp,
  createFile,
  createView,
  fileContent,
  instantiatePlugin,
  liveEditor,
  noticeMessages,
  resetHarness,
  setActiveView
} from "../test-support/harness";

const DAY = "Chronomancer/2026.10.27.md";
const DRAFT = ["{ 1.1.1 }", "wrote a thing about it", "- 00:01:00 10:00:00"].join("\n");
const SETTLED = ["{ 1.1.1 }", "wrote a thing about it", "+ 00:01:00 10:00:00"].join("\n");
const WHISPERED = ["{ 1.1.1 }", "~ a thing, written", "wrote a thing about it", "+ 00:01:00 10:00:00"].join("\n");

const WHISPER: WhisperItem[] = [{ type: "name", text: "a thing, written" }];
const ANSWER = JSON.stringify({ whisper: WHISPER });

/** The input the engine builds for the fixture entry, as the key is taken over it. */
const INPUT = { address: "{ 1.1.1 }", prose: "wrote a thing about it", ancestors: [] };

/** A model that answers by job: a reading, or a placement in the day. */
class Fixed implements WhisperModel {
  readonly id = "fixed";
  asked = 0;
  /** The user message of the last request, so a prompt can be asserted. */
  prompt = "";
  /** The system prompt of the last request, which names the job. */
  job = "";

  constructor(
    private readonly text: string,
    private readonly thread: string | null = null
  ) {}

  complete(request: WhisperRequest): Promise<WhisperReply> {
    this.asked += 1;
    this.prompt = request.user;
    this.job = request.system.includes("place one entry of a day") ? "thread" : "reading";
    if (this.job === "thread") {
      return Promise.resolve({
        ok: true,
        text: this.thread ?? JSON.stringify({ whisper: [] })
      });
    }
    return Promise.resolve({ ok: true, text: this.text });
  }
}

/** A model behind an endpoint that produces no text at all. */
class Broken implements WhisperModel {
  readonly id = "broken";
  asked = 0;

  constructor(private readonly failure: WhisperFailure) {}

  complete(): Promise<WhisperReply> {
    this.asked += 1;
    return Promise.resolve({ ok: false, failure: this.failure });
  }
}

/** A model whose answers are resolved by the test, one at a time. */
class Held implements WhisperModel {
  readonly id = "held";
  asked = 0;
  private readonly waiting: Array<(value: WhisperReply) => void> = [];

  complete(): Promise<WhisperReply> {
    this.asked += 1;
    // The executor form, because this project's `lib` predates
    // `Promise.withResolvers` — a held answer is exactly what a test needs.
    return new Promise<WhisperReply>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  answer(text: string): void {
    this.waiting.shift()?.({ ok: true, text });
  }
}

interface Running {
  plugin: WeaverPlugin;
  app: ReturnType<typeof createApp>;
  /** The file in the vault: the one the writer writes. */
  file: TFile;
}

/** Starts the plugin over one note, with `model` standing in for oMLX. */
async function start(doc: string, model: WhisperModel): Promise<Running> {
  const file = createFile(DAY, doc);
  const app = createApp([file]);
  const plugin = instantiatePlugin(WeaverPlugin, app);
  await plugin.onload();

  // Portal invitations belong to the portal suite: switching them off here keeps
  // a wall-clock boundary from adding a notice or a timer to what a pass reports.
  plugin.settings.portalsEnabled = false;
  plugin.portals.reconcile();
  clearNotices();

  plugin.whisper = new WhisperRunner({
    model: () => (plugin.settings.whisperEnabled ? model : NoModel),
    land: (path, n, key, whisper) => plugin.entries.landWhisper(path, n, key, whisper),
    log: () => {},
    onChange: () => plugin.repaintFrames()
  });

  return { plugin, app, file };
}

/** Lets every queued microtask run: the runner's answers are promises. */
function flush(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve());
}

function reading(app: Running["app"], file: TFile): string {
  return fileContent(app.vault.getAbstractFileByPath(file.path) as TFile | null);
}

beforeEach(() => {
  resetHarness();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("settling with no model", () => {
  it("writes exactly the bytes it wrote before whispers existed", async () => {
    const model = new Fixed(ANSWER);
    const { plugin, file } = await start(DRAFT, model);
    // The default settings leave whisper off, so the plugin asks `NoModel`.
    expect(plugin.settings.whisperEnabled).toBe(false);

    const view = liveEditor(file, DRAFT, DRAFT.indexOf("wrote"));
    registerEditorView(view);

    const entry = parseEntries(DRAFT).entries[0];
    if (entry === undefined) throw new Error("expected an entry");

    try {
      plugin.entries.settle(view, entry);

      expect(view.state.doc.toString()).toBe(SETTLED);
      expect(model.asked).toBe(0);
      expect(view.state.doc.toString()).not.toContain("~");
    } finally {
      unregisterEditorView(view);
      plugin.onunload();
    }
  });
});

describe("settling with a warm whisper", () => {
  it("puts the rows and `+` in one transaction", async () => {
    const model = new Fixed(ANSWER);
    const { plugin, file } = await start(DRAFT, model);
    plugin.settings.whisperEnabled = true;

    vi.useFakeTimers();
    plugin.whisper.arm(DAY, 1, INPUT);
    await vi.advanceTimersByTimeAsync(1000);
    expect(model.asked).toBe(1);

    const view = liveEditor(file, DRAFT, 0);
    registerEditorView(view);

    const entry = parseEntries(DRAFT).entries[0];
    if (entry === undefined) throw new Error("expected an entry");

    try {
      const before = view.dispatches;
      plugin.entries.settle(view, entry);

      expect(view.dispatches - before).toBe(1);
      expect(view.state.doc.toString()).toBe(WHISPERED);
      // The cache held the answer, so settle asked for nothing more.
      expect(model.asked).toBe(1);
    } finally {
      unregisterEditorView(view);
      plugin.onunload();
    }
  });
});

describe("settling with a cold whisper", () => {
  it("writes `+` alone, then lands the rows as their own write", async () => {
    const model = new Held();
    const DOC = `${DRAFT}\n`;
    const { plugin, file } = await start(DOC, model);
    plugin.settings.whisperEnabled = true;

    // The caret is in the entry while `+` lands, then leaves: a landing never
    // moves the text under the caret, so it waits for the writer to move on.
    const view = liveEditor(file, DOC, DOC.indexOf("wrote"));
    registerEditorView(view);

    const entry = parseEntries(DOC).entries[0];
    if (entry === undefined) throw new Error("expected an entry");

    try {
      plugin.entries.settle(view, entry);

      // Nothing waits: `+` is in, the model is still thinking.
      expect(view.state.doc.toString()).toBe(`${SETTLED}\n`);
      expect(model.asked).toBe(1);

      // The caret goes to the note's last line, past the entry's own block.
      view.dispatch({ selection: { anchor: DOC.length } });
      model.answer(ANSWER);
      await flush();

      expect(view.state.doc.toString()).toBe(`${WHISPERED}\n`);
    } finally {
      unregisterEditorView(view);
      plugin.onunload();
    }
  });

  it("lands into the vault when no editor holds the file", async () => {
    const { plugin, app, file } = await start(SETTLED, new Fixed(ANSWER));

    plugin.entries.landWhisper(DAY, 1, whisperKey(INPUT), WHISPER);
    await flush();

    // No editor, so no caret to protect: the vault's own write is the landing.
    expect(reading(app, file)).toBe(WHISPERED);
    plugin.onunload();
  });

  it("refuses a landing whose key no longer matches the prose", async () => {
    const { plugin, file } = await start(SETTLED, new Fixed(ANSWER));
    const view = liveEditor(file, SETTLED, 0);
    registerEditorView(view);

    try {
      plugin.entries.landWhisper(DAY, 1, "00000000", WHISPER);
      await flush();

      expect(view.state.doc.toString()).toBe(SETTLED);
    } finally {
      unregisterEditorView(view);
      plugin.onunload();
    }
  });

  it("holds the rows back while the caret is inside the entry", async () => {
    const { plugin, file } = await start(SETTLED, new Fixed(ANSWER));
    const view = liveEditor(file, SETTLED, SETTLED.indexOf("wrote"));
    registerEditorView(view);

    try {
      plugin.entries.landWhisper(DAY, 1, whisperKey(INPUT), WHISPER);
      await flush();

      // A line arriving above the caret moves the text being read.
      expect(view.state.doc.toString()).toBe(SETTLED);
    } finally {
      unregisterEditorView(view);
      plugin.onunload();
    }
  });

  it("lands once the caret has left the entry", async () => {
    const { plugin, file } = await start(`${SETTLED}\n`, new Fixed(ANSWER));
    // The file ends with a newline, so the caret's own line is below the entry.
    const view = liveEditor(file, `${SETTLED}\n`, SETTLED.length + 1);
    registerEditorView(view);

    try {
      plugin.entries.landWhisper(DAY, 1, whisperKey(INPUT), WHISPER);
      await flush();

      expect(view.state.doc.toString()).toBe(`${WHISPERED}\n`);
    } finally {
      unregisterEditorView(view);
      plugin.onunload();
    }
  });
});

describe("the entry's view of the model", () => {
  it("gives an ancestor's own title, and its name once it has one", async () => {
    const source = [
      "{ 1.1.1 }",
      "~ the root's name",
      "the root's first line",
      "+ 00:01:00 10:00:00",
      "{ 1.2.2 }",
      "the child's line",
      "- 00:00:30 10:01:00"
    ].join("\n");
    const model = new Fixed(ANSWER);

    const { plugin, file } = await start(source, model);
    plugin.settings.whisperEnabled = true;

    const view = liveEditor(file, source, source.indexOf("the child's line"));
    const child = parseEntries(source).entries[1];
    if (child === undefined) throw new Error("expected a child");

    plugin.entries.settle(view, child);
    await flush();

    expect(model.asked).toBe(1);
    // Settling asks one question — the reading. Placements belong to the day pass.
    expect(model.asked).toBe(1);
    expect(model.prompt).toBe(
      [
        "{ 1.2.2 }",
        "names already in this branch, never reuse one:",
        "  the root's name",
        "note:",
        "the child's line"
      ].join("\n")
    );
    plugin.onunload();
  });
});

describe("whispering the day", () => {
  const NOTE = [
    "{ 1.1.1 }",
    "the first thought of the day",
    "+ 00:01:00 09:00:00",
    "",
    "{ 2.1.2 }",
    "~ an existing name",
    "the second thought of the day",
    "+ 00:02:00 09:05:00",
    "",
    "{ 3.1.3 } a name the writer gave it",
    "the third thought of the day",
    "+ 00:03:00 09:10:00",
    "",
    "{ 4.1.4 }",
    "still open",
    "- 00:00:30 09:15:00",
    "",
    "{ 5.1.5 }",
    "the last thought of the day",
    "+ 00:04:00 09:20:00",
    ""
  ].join("\n");

  /** Pins the clock, so "today" is the fixture's day. */
  async function startingOnTheDay(model: WhisperModel): Promise<Running> {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 27, 13, 27, 43));
    const running = await start(NOTE, model);
    running.plugin.settings.whisperEnabled = true;
    // The day pass asks the plugin for a model; the runner serves the settle path.
    running.plugin.whisperModel = () => model;
    return running;
  }

  it("writes every settled entry that has neither a whisper nor a name", async () => {
    const model = new Fixed(
      ANSWER,
      JSON.stringify({ whisper: [{ type: "thread", text: "repeats a thing, written" }] })
    );
    const { plugin, app, file } = await startingOnTheDay(model);

    await plugin.entries.whisperDay();

    const written = reading(app, file);
    expect(parseEntries(written).entries.map((entry) => entry.whisper[0]?.text ?? null)).toEqual([
      "a thing, written",
      "an existing name",
      null,
      null,
      "a thing, written"
    ]);

    // Two entries were asked about: the open one, the already-whispered one and
    // the one the writer named are not candidates. Placements are off by default,
    // so no day-level question is asked at all.
    expect(model.asked).toBe(2);
    expect(model.job).toBe("reading");
    expect(noticeMessages()).toEqual([
      NOTICE_WHISPERING,
      noticeWhispered({ targets: 2, written: 2, rejected: 0, failure: null, threads: 0 })
    ]);

    plugin.onunload();
  });

  it("whispers the day note on screen, not today's", async () => {
    // A past day is a day: the pass follows the reader.
    const PAST = "Chronomancer/2026.10.24.md";
    const pastBody = [
      "{ 1.1.1 }",
      "a thought from four days ago",
      "+ 00:01:00 09:00:00"
    ].join("\n");

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 27, 13, 27, 43));

    const past = createFile(PAST, pastBody);
    const today = createFile(DAY, NOTE);
    const model = new Fixed(ANSWER);
    const app = createApp([past, today]);
    const plugin = instantiatePlugin(WeaverPlugin, app);
    await plugin.onload();
    plugin.settings.whisperEnabled = true;
    plugin.whisperModel = () => model;

    // The past note is the one on screen.
    setActiveView(app, createView(app, past, { getValue: () => pastBody }));

    await plugin.entries.whisperDay();

    expect(parseEntries(fileContent(past)).entries[0]?.whisper[0]?.text).toBe("a thing, written");
    // Today's note was not touched, even though it has candidates of its own.
    expect(fileContent(today)).toBe(NOTE);
    expect(model.asked).toBe(1);
    plugin.onunload();
  });

  it("falls back to today when the open note is not a day note", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 27, 13, 27, 43));

    const stray = createFile("Chronomancer/some notes.md", "not a day note");
    const today = createFile(DAY, NOTE);
    const model = new Fixed(ANSWER);
    const app = createApp([stray, today]);
    const plugin = instantiatePlugin(WeaverPlugin, app);
    await plugin.onload();
    plugin.settings.whisperEnabled = true;
    plugin.whisperModel = () => model;

    setActiveView(app, createView(app, stray, { getValue: () => "" }));

    await plugin.entries.whisperDay();

    expect(fileContent(stray)).toBe("not a day note");
    expect(parseEntries(fileContent(today)).entries[0]?.whisper[0]?.text).toBe("a thing, written");
    plugin.onunload();
  });

  it("places entries in the day when the setting is on", async () => {
    const model = new Fixed(
      ANSWER,
      JSON.stringify({ whisper: [{ type: "thread", text: "repeats a thing, written" }] })
    );
    const { plugin, app, file } = await startingOnTheDay(model);
    plugin.settings.whisperThreads = true;

    await plugin.entries.whisperDay();

    const written = parseEntries(reading(app, file));
    // Two readings, then two placements: entry 1 is first, so it has nothing
    // earlier to point at.
    expect(model.asked).toBe(4);
    // The reading that already existed gets one row appended and nothing else.
    const second = written.entries[1];
    expect(second?.whisper.map((row) => row.type)).toEqual(["name", "thread"]);
    expect(second?.whisper[0]?.text).toBe("an existing name");
    expect(noticeMessages().at(-1)).toBe(
      noticeWhispered({ targets: 2, written: 2, rejected: 0, failure: null, threads: 2 })
    );
    plugin.onunload();
  });

  it("writes one transaction for the whole day", async () => {
    const { plugin, file } = await startingOnTheDay(new Fixed(ANSWER));
    const view = liveEditor(file, NOTE, 0);
    // The editor holds the note, so the pass dispatches into it once.
    registerEditorView(view);

    try {
      await plugin.entries.whisperDay();

      const dispatches = (view as unknown as { dispatches: number }).dispatches;
      expect(dispatches).toBe(1);
    } finally {
      unregisterEditorView(view);
      plugin.onunload();
    }
  });

  it("puts a child's reading after its parent's new name", async () => {
    const parentChild = [
      "{ 1.1.1 }",
      "a parent thought",
      "+ 00:01:00 09:00:00",
      "",
      "{ 1.2.2 }",
      "the child thought",
      "+ 00:00:30 09:01:00"
    ].join("\n");

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 27, 13, 27, 43));
    const prompts: string[] = [];
    const model: WhisperModel = {
      id: "fake",
      complete: (request) => {
        prompts.push(request.user);
        return Promise.resolve({
          ok: true,
          text: JSON.stringify({ whisper: [{ type: "name", text: `name ${prompts.length}` }] })
        });
      }
    };

    const file = createFile(DAY, parentChild);
    const app = createApp([file]);
    const plugin = instantiatePlugin(WeaverPlugin, app);
    await plugin.onload();
    plugin.settings.whisperEnabled = true;
    plugin.settings.whisperThreads = true;
    plugin.whisperModel = () => model;

    await plugin.entries.whisperDay();

    // Two readings, then one placement: the parent is first, the child is not.
    expect(prompts.length).toBe(3);
    expect(prompts[1]).toBe(
      [
        "{ 1.2.2 }",
        "names already in this branch, never reuse one:",
        "  name 1",
        "note:",
        "the child thought"
      ].join("\n")
    );
    plugin.onunload();
  });

  it("says the endpoint refused it, and stops asking after two refusals", async () => {
    // The case that produced the lie: 21 settled entries, every request 401.
    const model = new Broken({ kind: "refused", status: 401, detail: "API key required" });
    const { plugin, app, file } = await startingOnTheDay(model);

    await plugin.entries.whisperDay();

    expect(model.asked).toBe(2);
    expect(reading(app, file)).toBe(NOTE);
    expect(noticeMessages()).toEqual([
      NOTICE_WHISPERING,
      "No whisper was written: the endpoint refused this device (HTTP 401): API key required."
    ]);

    plugin.onunload();
  });

  it("names a thinking model's silence as what it is", async () => {
    const model = new Broken({ kind: "empty", finish: "length" });
    const { plugin } = await startingOnTheDay(model);

    await plugin.entries.whisperDay();

    expect(noticeMessages().at(-1)).toBe(
      "No whisper was written: the model used the whole answer on its reasoning (finish: length) — turn thinking off for that model, or use a non-thinking one."
    );
    plugin.onunload();
  });

  it("does not call a server-side failure a refusal", async () => {
    // 507 is the server saying it cannot run the model, not this device being
    // turned away: the sentence has to name the difference.
    const model = new Broken({
      kind: "refused",
      status: 507,
      detail: "Model 'x' (2.97GB) does not fit under the dynamic memory ceiling (815.98MB)."
    });
    const { plugin } = await startingOnTheDay(model);

    await plugin.entries.whisperDay();

    expect(noticeMessages().at(-1)).toBe(
      "No whisper was written: the endpoint failed (HTTP 507): Model 'x' (2.97GB) does not fit under the dynamic memory ceiling (815.98MB)."
    );
    plugin.onunload();
  });

  it("says the endpoint did not answer when the socket refused", async () => {
    const model = new Broken({ kind: "unreachable" });
    const { plugin } = await startingOnTheDay(model);

    await plugin.entries.whisperDay();

    expect(noticeMessages().at(-1)).toBe("No whisper was written: the endpoint did not answer.");
    plugin.onunload();
  });

  it("counts what it wrote out of what it tried when answers are refused", async () => {
    // One entry answers in the register, one answers with a negation, and the
    // pass keeps asking: a validation failure is not a dead endpoint.
    const answers = [
      JSON.stringify({ whisper: [{ type: "name", text: "a thing, written" }] }),
      JSON.stringify({ whisper: [{ type: "name", text: "a thing, not portable" }] })
    ];
    const model: WhisperModel = {
      id: "mixed",
      complete: (request) => {
        // A placement is never part of this test's subject.
        if (request.system.includes("place one entry of a day")) {
          return Promise.resolve({ ok: true, text: JSON.stringify({ whisper: [] }) });
        }
        const text = answers.shift();
        return Promise.resolve(
          text === undefined
            ? { ok: false, failure: { kind: "unreachable" } as const }
            : { ok: true, text }
        );
      }
    };

    const { plugin, app, file } = await startingOnTheDay(model);
    await plugin.entries.whisperDay();

    expect(noticeMessages().at(-1)).toBe(
      "Whispered 1 of 2 entries: 1 answer did not fit the register."
    );
    expect(parseEntries(reading(app, file)).entries.filter((e) => e.whisper.length > 0).length).toBe(
      2
    );
    plugin.onunload();
  });

  it("says nothing was written when the device cannot reach an endpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 27, 13, 27, 43));
    const file = createFile(DAY, NOTE);
    const app = createApp([file]);
    const plugin = instantiatePlugin(WeaverPlugin, app);
    await plugin.onload();
    clearNotices();

    await plugin.entries.whisperDay();

    expect(noticeMessages()).toEqual([NOTICE_WHISPER_UNREACHABLE]);
    expect(reading(app, file)).toBe(NOTE);
    plugin.onunload();
  });
});
