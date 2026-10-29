import { beforeEach, describe, expect, it } from "vitest";
import { parseEntries } from "../src/core/entries";
import { planDuration, planStartEntry } from "../src/core/insert";
import { minimalChange, planRewrite, rewriteDay } from "../src/entries/writer";
import { registerEditorView, unregisterEditorView } from "../src/editor/view-registry";
import {
  createApp,
  createFile,
  fileContent,
  liveEditor,
  resetHarness
} from "../test-support/harness";

const AT_1337 = new Date(2026, 9, 27, 13, 27, 43);
const DAY = "Chronomancer/2026.10.27.md";

function withStats(source: string): string {
  return `---\ntravels: 1\ndepth: 1\nduration: 00:01:00\n---\n${source}`;
}

beforeEach(() => {
  resetHarness();
});

describe("the one writer", () => {
  it("writes into the open editor and leaves the file on disk alone", async () => {
    const source = ["{ 1.1.1 } - 10:00:00", "prose", "+ 00:01:00"].join("\n");
    const file = createFile(DAY, source);
    const app = createApp([file]);

    // The buffer holds a sentence the file has not seen yet: this is exactly the
    // state a debounced stats write used to clobber.
    const typed = ["{ 1.1.1 } - 10:00:00", "prose typed a moment ago", "+ 00:01:00"].join("\n");
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
    const source = ["{ 1.1.1 } - 09:00:00", "first", "+ 00:01:00"].join("\n");
    const file = createFile(DAY, source);
    const app = createApp([file]);

    const result = await rewriteDay(
      app,
      file,
      planRewrite((data) => planStartEntry(data, parseEntries(data), AT_1337)),
      true
    );

    expect(result).not.toBeNull();
    expect(fileContent(file)).toBe(result?.source);
    expect(fileContent(file)).toContain("{ 1.2.2 } - 13:27:43");
  });

  it("writes nothing when the rewrite declines", async () => {
    const source = ["{ 1.1.1 } - 10:00:00", "prose", "- 00:00:00"].join("\n");
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
    const earlier = ["{ 1.1.1 } - 09:00:00", "first", "+ 00:01:00"].join("\n");
    const current = [
      earlier,
      "",
      "{ 1.2.2 } - 09:30:00",
      "second",
      "+ 00:02:00",
      ""
    ].join("\n");

    // The read the writer made a moment ago knew one entry; the file now holds
    // two. The append must still land after the file's own last line, numbered
    // from the file.
    expect(parseEntries(earlier).maxN).toBe(1);

    const rewrite = planRewrite((source) =>
      planStartEntry(source, parseEntries(source), AT_1337)
    );
    const result = rewrite(current);
    if (result === null) throw new Error("expected a rewrite");

    expect(result.source).toContain("{ 1.3.3 } - 13:27:43");
    expect(result.source.indexOf("13:27:43")).toBeGreaterThan(result.source.indexOf("second"));
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
    const before = "---\ntravels: 0\n---\n{ 1.1.1 } - 10:00:00\nprose";
    const after = "---\ntravels: 7\n---\n{ 1.1.1 } - 10:00:00\nprose";

    const [change] = minimalChange(before, after);
    expect(change).toBeDefined();
    if (change === undefined) return;

    expect(before.slice(0, change.from) + change.text + before.slice(change.to)).toBe(after);
  });
});
