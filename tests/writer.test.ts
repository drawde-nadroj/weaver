import { beforeEach, describe, expect, it } from "vitest";
import { readAlignments } from "../src/core/alignments";
import { parseEntries } from "../src/core/entries";
import { planCaptureEntry, planDuration } from "../src/core/insert";
import { portalAt } from "../src/core/portals";
import { captureInstantAt, type CaptureRequest } from "../src/core/capture";

/** A capture request for one root, so the writer tests speak the real shape. */
function capture(text: string, began: Date, portal = null as ReturnType<typeof portalAt> | null): CaptureRequest {
  return {
    contextId: "main",
    parent: null,
    text,
    beginning: captureInstantAt(began.getTime()),
    durationMs: 0,
    portal
  };
}
import { minimalChange, planRewrite, registerWrite, rewriteDay, waitForWrite } from "../src/entries/writer";
import { registerEditorView, unregisterEditorView } from "../src/editor/view-registry";
import {
  createApp,
  createFile,
  fileContent,
  liveEditor,
  resetHarness
} from "../test-support/harness";

const DAY = "Chronomancer/2026.10.27.md";

function withStats(source: string): string {
  return `---\ntravels: 1\ndepth: 1\nduration: 00:01:00\n---\n${source}`;
}

beforeEach(() => {
  resetHarness();
});

describe("the one writer", () => {
  it("writes into the open editor and leaves the file on disk alone", async () => {
    const source = ["{ 1.1.1 }", "prose", "+ 00:01:00 10:00:00"].join("\n");
    const file = createFile(DAY, source);
    const app = createApp([file]);

    // The buffer holds a sentence the file has not seen yet: this is exactly the
    // state a debounced stats write used to clobber.
    const typed = ["{ 1.1.1 }", "prose typed a moment ago", "+ 00:01:00 10:00:00"].join("\n");
    const view = liveEditor(file, typed);
    registerEditorView(view);

    // The bug this reader exists for: a second writer reaching the vault while
    // the editor holds the same note. Not one call may get through.
    let vaultWrites = 0;
    const process = app.vault.process.bind(app.vault);
    app.vault.process = (target, transform) => {
      vaultWrites += 1;
      return process(target, transform);
    };

    try {
      const result = await rewriteDay(
        app,
        file,
        (current) => {
          const next = withStats(current);
          const changes = minimalChange(current, next);
          return changes.length === 0 ? null : { changes, source: next, caret: null };
        },
        false
      );

      expect(result).not.toBeNull();
      expect(vaultWrites).toBe(0);
      expect(fileContent(file)).toBe(source);
      expect(view.state.doc.toString()).toBe(withStats(typed));
    } finally {
      unregisterEditorView(view);
    }
  });

  it("writes through the vault when no editor holds the file", async () => {
    const source = ["{ 1.1.1 }", "first", "+ 00:01:00 09:00:00"].join("\n");
    const file = createFile(DAY, source);
    const app = createApp([file]);

    const result = await rewriteDay(
      app,
      file,
      planRewrite((data) => planCaptureEntry(data, parseEntries(data), capture("a new thought", new Date(2026, 10, 5, 9, 0, 0)))),
      true
    );

    expect(result).not.toBeNull();
    expect(fileContent(file)).toBe(result?.source);
    expect(fileContent(file)).toContain("{ 2.1.2 }");
  });

  it("writes nothing when the rewrite declines", async () => {
    const source = ["{ 1.1.1 }", "prose", "- 00:00:00 10:00:00"].join("\n");
    const file = createFile(DAY, source);
    const app = createApp([file]);

    const result = await rewriteDay(
      app,
      file,
      planRewrite((data) => {
        const index = parseEntries(data);
        const entry = index.entries[0];
        return entry === undefined ? null : planDuration(data, index, entry, "-", 0);
      }),
      true
    );

    expect(result).toBeNull();
    expect(fileContent(file)).toBe(source);
  });

  it("does not dispatch an empty change into the editor", async () => {
    const file = createFile(DAY, "");
    const app = createApp([file]);
    const view = liveEditor(file, "unchanged");
    registerEditorView(view);

    try {
      const result = await rewriteDay(
        app,
        file,
        (current) => ({ changes: [], source: current, caret: null }),
        false
      );

      expect(result).toBeNull();
      expect(view.dispatches).toBe(0);
    } finally {
      unregisterEditorView(view);
    }
  });
});

describe("planRewrite", () => {
  it("plans against the text it is handed, not an earlier read", () => {
    const earlier = ["{ 1.1.1 }", "first", "+ 00:01:00 09:00:00"].join("\n");
    const current = [
      earlier,
      "",
      "{ 2.1.2 }",
      "second",
      "+ 00:02:00 09:30:00",
      ""
    ].join("\n");

    // The read the writer made a moment ago knew one entry; the file now holds
    // two. The append must still land after the file's own last line, numbered
    // from the file.
    expect(parseEntries(earlier).maxN).toBe(1);

    const rewrite = planRewrite((source) =>
      planCaptureEntry(source, parseEntries(source), capture("third", new Date(2026, 10, 5, 9, 0, 0)))
    );
    const result = rewrite(current);
    if (result === null) throw new Error("expected a rewrite");

    expect(result.source).toContain("{ 3.1.3 }");
    expect(result.source.indexOf("third")).toBeGreaterThan(result.source.indexOf("second"));
    expect(result.changes.length).toBe(1);
  });

  it("passes a declined plan straight through", () => {
    const rewrite = planRewrite(() => null);
    expect(rewrite("anything")).toBeNull();
  });
});

describe("minimalChange", () => {
  it("is nothing when the text did not move", () => {
    expect(minimalChange("same", "same")).toEqual([]);
  });

  it("is one change spanning only what differs", () => {
    expect(minimalChange("abc", "abd")).toEqual([{ from: 2, to: 3, text: "d" }]);
    expect(minimalChange("ab", "abc")).toEqual([{ from: 2, to: 2, text: "c" }]);
    expect(minimalChange("abc", "ab")).toEqual([{ from: 2, to: 3, text: "" }]);
  });

  it("applies back to the text it was computed from", () => {
    const before = "---\ntravels: 0\n---\n{ 1.1.1 }\nprose";
    const after = "---\ntravels: 7\n---\n{ 1.1.1 }\nprose";

    const [change] = minimalChange(before, after);
    expect(change).toBeDefined();
    if (change === undefined) return;

    expect(before.slice(0, change.from) + change.text + before.slice(change.to)).toBe(after);
  });
});

describe("portals through the one writer", () => {
  it("writes the entry and its record in a single vault write", async () => {
    const source = ["---", "travels: 1", "---", "{ 1.1.1 }", "prose", "+ 00:01:00 10:00:00"].join("\n");
    const file = createFile(DAY, source);
    const app = createApp([file]);

    const opened = new Date(2026, 10, 5, 22, 55, 0);
    const began = new Date(2026, 10, 5, 22, 55, 0, 250);
    const portal = portalAt(opened.getTime());

    let vaultWrites = 0;
    const process = app.vault.process.bind(app.vault);
    app.vault.process = (target, transform) => {
      vaultWrites += 1;
      return process(target, transform);
    };

    const result = await rewriteDay(
      app,
      file,
      planRewrite((current) =>
        planCaptureEntry(current, parseEntries(current), capture("through the door", began, portal))
      ),
      true
    );

    expect(result).not.toBeNull();
    expect(vaultWrites).toBe(1);
    expect(fileContent(file)).toBe(result?.source);

    const content = fileContent(file);
    expect(content).toContain("{ 2.1.2 }");
    expect(content).toContain("through the door");
    expect(content).toMatch(/\+ 00:00:00 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\n/);
    // The stats block keeps its own key and gains the record beside it.
    expect(content).toContain("travels: 1");

    const records = readAlignments(content);
    if (!records.ok) throw new Error(records.error);
    expect(records.records).toHaveLength(1);
    expect(records.records[0]?.entry).toBe(2);
    expect(records.records[0]?.portal).toBe(portal.id);
  });
});

describe("the in-flight write registry", () => {
  it("awaits a registered write until it settles, then becomes a no-op", async () => {
    let finish: () => void = () => {};
    const flight = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const release = registerWrite("op-registry", flight);

    let settled = false;
    const waiting = waitForWrite(null as never, "op-registry").then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finish();
    await waiting;
    expect(settled).toBe(true);

    release();
    await expect(waitForWrite(null as never, "op-registry")).resolves.toBeUndefined();
  });
});
