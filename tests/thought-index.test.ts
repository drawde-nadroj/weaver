import { describe, expect, it } from "vitest";

import { contextList } from "../src/entries/day-note";
import { ThoughtIndex, type ThoughtIndexPorts } from "../src/entries/thought-index";
import type { WeavingContext } from "../src/core/contexts";
import { recognisePath, type ReferenceQuery } from "../src/core/reference";
import { createApp } from "../test-support/harness";
import { DEFAULT_SETTINGS } from "../src/settings";

const SPANISH = { id: "ctx-spanish", name: "Spanish", folder: "Spanish/Daily", format: "YYYY.MM.DD" };

function contexts(): readonly WeavingContext[] {
  return contextList(createApp(), { ...DEFAULT_SETTINGS, contexts: [SPANISH] }).contexts;
}

interface Row {
  b?: number;
  d?: number;
  n: number;
  prose: string;
  day?: string | null;
  time?: string | null;
}

/** One note's text with the rows given, each carrying its own clock row. */
function note(date: string, rows: Row[]): string {
  const body = rows.flatMap(({ b = 1, d = 1, n, prose, day = date, time = "09:00:00" }) => {
    const stamp = `+ 00:01:00${day === null ? "" : ` ${day}`}${time === null ? "" : ` ${time}`}`;
    return [`{ ${b}.${d}.${n} }`, prose, stamp, ""];
  });
  return ["---", `date: ${date}`, "---", "", ...body].join("\n");
}

interface TestPorts extends ThoughtIndexPorts {
  files: Record<string, string>;
  bump(): void;
}

function ports(files: Record<string, string>): TestPorts {
  let generation = 0;
  const test: TestPorts = {
    files,
    paths: () => Object.keys(test.files),
    read: async (path) => test.files[path] ?? null,
    generation: () => generation,
    contexts,
    bump: () => {
      generation += 1;
    }
  };
  return test;
}

const allTime: ReferenceQuery = {
  scope: { kind: "history", tapestryId: null },
  order: "time",
  search: { kind: "none" }
};

describe("recognising a path", () => {
  it("reads a configured destination's path back, and refuses anything else", () => {
    expect(recognisePath("Spanish/Daily/2026.11.05.md", contexts())).toEqual({
      contextId: "ctx-spanish",
      day: "2026-11-05"
    });
    expect(recognisePath("Old/2026.11.05.md", contexts())).toEqual({ contextId: null, day: "2026-11-05" });
    expect(recognisePath("Meeting notes.md", contexts())).toBeNull();
  });
});

describe("querying the index", () => {
  it("reads recognised notes and orders them by Time", async () => {
    const index = new ThoughtIndex(
      ports({
        "Chronomancer/2026.11.05.md": note("2026-11-05", [
          { n: 1, prose: "late", time: "11:00:00" },
          { n: 2, prose: "early", time: "08:00:00" }
        ])
      })
    );
    const sequence = await index.query(allTime);
    expect(sequence.errors).toEqual([]);
    expect(sequence.members.map((record) => record.thought.n)).toEqual([2, 1]);
  });

  it("scopes to one Tapestry, excluding unassigned historical notes", async () => {
    const files = {
      "Chronomancer/2026.11.05.md": note("2026-11-05", [{ n: 1, prose: "main" }]),
      "Other/2026.11.05.md": note("2026-11-05", [{ n: 1, prose: "old" }])
    };
    const index = new ThoughtIndex(ports(files));

    const all = await index.query(allTime);
    expect(all.members).toHaveLength(2);

    const main = await index.query({ ...allTime, scope: { kind: "history", tapestryId: "main" } });
    expect(main.members.map((record) => record.thought.prose)).toEqual(["main"]);
  });

  it("includes a future-filename note whose entry is recorded inside the range", async () => {
    const index = new ThoughtIndex(
      ports({
        "Chronomancer/2027.01.01.md": note("2027-01-01", [
          { n: 1, prose: "written earlier", day: "2026-11-05", time: "09:00:00" }
        ])
      })
    );
    const sequence = await index.query({
      scope: { kind: "range", tapestryId: "main", from: "2026-11-01", through: "2026-11-30" },
      order: "time",
      search: { kind: "none" }
    });
    expect(sequence.members.map((record) => record.thought.prose)).toEqual(["written earlier"]);
  });

  it("matches an exact address and named words", async () => {
    const index = new ThoughtIndex(
      ports({
        "Chronomancer/2026.11.05.md": note("2026-11-05", [
          { n: 1, prose: "alpha beta" },
          { n: 2, prose: "gamma" }
        ])
      })
    );
    const address = await index.query({ ...allTime, search: { kind: "address", b: 1, d: 1, n: 2 } });
    expect(address.members.map((record) => record.thought.prose)).toEqual(["gamma"]);

    const words = await index.query({ ...allTime, search: { kind: "words", terms: ["alpha", "beta"] } });
    expect(words.members.map((record) => record.thought.prose)).toEqual(["alpha beta"]);
  });

  it("names a failed file instead of claiming an empty scope", async () => {
    const test = ports({
      "Chronomancer/2026.11.05.md": note("2026-11-05", [{ n: 1, prose: "readable" }]),
      "Chronomancer/2026.11.04.md": "unreadable"
    });
    test.read = async (path) =>
      path === "Chronomancer/2026.11.04.md" ? null : (test.files[path] ?? null);

    const index = new ThoughtIndex(test);
    const sequence = await index.query(allTime);
    expect(sequence.members).toHaveLength(1);
    expect(sequence.errors.map((error) => error.path)).toEqual(["Chronomancer/2026.11.04.md"]);
  });

  it("discards a query whose generation was superseded mid-read", async () => {
    const test = ports({
      "Chronomancer/2026.11.05.md": note("2026-11-05", [{ n: 1, prose: "hi" }])
    });
    const originalRead = test.read;
    let bumped = false;
    test.read = async (path) => {
      const value = await originalRead(path);
      if (!bumped) {
        bumped = true;
        test.bump();
      }
      return value;
    };

    const sequence = await new ThoughtIndex(test).query(allTime);
    expect(sequence.members).toEqual([]);
  });

  it("re-reads exactly the invalidated path", async () => {
    const files = {
      "Chronomancer/2026.11.05.md": note("2026-11-05", [{ n: 1, prose: "before" }])
    };
    const test = ports(files);
    const index = new ThoughtIndex(test);

    expect((await index.query(allTime)).members.map((record) => record.thought.prose)).toEqual(["before"]);

    files["Chronomancer/2026.11.05.md"] = note("2026-11-05", [
      { n: 1, prose: "after" },
      { n: 2, prose: "new" }
    ]);
    index.invalidate("Chronomancer/2026.11.05.md");

    expect((await index.query(allTime)).members.map((record) => record.thought.prose)).toEqual(["after", "new"]);
  });
});

describe("loading a thought", () => {
  it("returns the authored text, its block and its ancestry", async () => {
    const index = new ThoughtIndex(
      ports({
        "Chronomancer/2026.11.05.md": note("2026-11-05", [
          { b: 1, d: 1, n: 1, prose: "root" },
          { b: 1, d: 2, n: 2, prose: "  indented child  ", time: "10:00:00" }
        ])
      })
    );
    const sequence = await index.query(allTime);
    const child = sequence.members.find((record) => record.thought.n === 2);
    expect(child).toBeDefined();

    const result = await index.loadThought(child!.thought);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.snapshot.text).toBe("  indented child  ");
    expect(result.snapshot.originalBlock.startsWith("{ 1.2.2 }")).toBe(true);
    expect(result.snapshot.originalBlock).toContain("+ 00:01:00");
    expect(result.snapshot.ancestry.map((ref) => ref.n)).toEqual([1, 2]);
    expect(result.snapshot.root.n).toBe(1);
  });

  it("reports a thought whose note changed rather than returning a stale snapshot", async () => {
    const test = ports({
      "Chronomancer/2026.11.05.md": note("2026-11-05", [{ n: 1, prose: "present" }])
    });
    const index = new ThoughtIndex(test);
    const [record] = (await index.query(allTime)).members;
    expect(record).toBeDefined();

    test.files["Chronomancer/2026.11.05.md"] = note("2026-11-05", [{ n: 1, prose: "changed" }]);
    const result = await index.loadThought(record!.thought);
    expect(result.kind).toBe("unavailable");
  });
});
