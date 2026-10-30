import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";

import { parseEntries } from "../src/core/entries";
import {
  applyPlanToSource,
  cmChanges,
  planChildEntry,
  planDeleteEntry,
  planDuration,
  planStartEntry,
  type InsertPlan
} from "../src/core/insert";

const AT_1337 = new Date(2026, 9, 27, 13, 27, 43);

function applied(source: string, plan: InsertPlan): string {
  return applyPlanToSource(source, plan).source;
}

describe("planStartEntry", () => {
  it("writes a root marker, a blank line and a draft clock row", () => {
    const source = "";
    const plan = planStartEntry(source, parseEntries(source), AT_1337);
    expect(plan).not.toBeNull();
    if (plan === null) return;

    const next = applied(source, plan);
    expect(next).toBe("{ 1.1.1 }\n\n13:27:43 - 00:00:00\n");

    // The caret sits on the blank prose line, where the writing happens.
    expect(next.slice(0, plan.selection.from)).toBe("{ 1.1.1 }\n");
    expect(plan.selection.to).toBe(plan.selection.from);
  });

  it("appends a second root after the existing one", () => {
    const source = ["{ 1.1.1 }", "prose", "10:00:00 + 00:01:00"].join("\n");
    const plan = planStartEntry(source, parseEntries(source), AT_1337);
    if (plan === null) throw new Error("expected a plan");

    const next = applied(source, plan);
    expect(next).toContain("{ 1.2.2 }");
    expect(next).toContain("13:27:43 - 00:00:00");
  });
});

describe("planChildEntry", () => {
  const SOURCE = [
    "{ 1.1.1 }",
    "root",
    "10:00:00 + 00:01:00",
    "{ 2.1.2 }",
    "first child",
    "10:01:00 + 00:00:00",
    "{ 2.2.3 }",
    "second child",
    "10:02:00 - 00:00:00"
  ].join("\n");

  it("goes one dimension deeper on the same thread, next in the sequence", () => {
    const index = parseEntries(SOURCE);
    const parent = index.entries[0];
    if (parent === undefined) throw new Error("expected a parent");

    const plan = planChildEntry(SOURCE, index, parent, AT_1337);
    if (plan === null) throw new Error("expected a plan");

    const next = applied(SOURCE, plan);
    expect(next).toContain("{ 2.1.4 }");
    expect(next).toContain("13:27:43 - 00:00:00");
    expect(next.split("\n").length).toBe(SOURCE.split("\n").length + 4);
    // One change, one undo: an insert renumbers nothing.
    expect(plan.changes.length).toBe(1);
  });

  it("keeps a crooked branch's C when inserting under it", () => {
    const crooked = [
      "{ 1.1.1 }",
      "root",
      "10:00:00 + 00:01:00",
      "{ 2.5.2 }",
      "crooked child",
      "10:01:00 + 00:00:00"
    ].join("\n");

    const index = parseEntries(crooked);
    const parent = index.entries[0];
    if (parent === undefined) throw new Error("expected a parent");

    const plan = planChildEntry(crooked, index, parent, AT_1337);
    if (plan === null) throw new Error("expected a plan");

    const next = applied(crooked, plan);
    // The child inherits the parent's written `C`: the branch stays uniform.
    expect(next).toContain("{ 2.1.3 }");
    // The existing child is left exactly as the writer typed it.
    expect(next).toContain("{ 2.5.2 }");
    expect(next).toContain("10:01:00 + 00:00:00");
  });
});

describe("writing a plan through CodeMirror", () => {
  it("uses CodeMirror's change shape, then places a caret past the old document", () => {
    const source = "w";
    const plan = planStartEntry(source, parseEntries(source), AT_1337);
    if (plan === null) throw new Error("expected a plan");

    // `text` is not a ChangeSpec key, so a plan handed to a view as-is writes
    // nothing at all and throws nothing: this is the shape the engine sends.
    const state = EditorState.create({ doc: source });
    const written = state.update({ changes: cmChanges(plan.changes) }).state;
    expect(written.doc.toString()).toBe(applied(source, plan));

    // The caret sits past the end of the *old* document. Obsidian's CodeMirror
    // maps a spec's selection through its own changes, so that caret cannot ride
    // along with the change: the write and the caret are two updates.
    expect(plan.selection.from).toBeGreaterThan(source.length);
    const placed = written.update({ selection: { anchor: plan.selection.from } }).state;
    expect(placed.selection.main.head).toBe(plan.selection.from);
    expect(placed.doc.lineAt(placed.selection.main.head).text).toBe("");
  });
});

describe("planDeleteEntry", () => {
  const THREE = [
    "{ 1.1.1 }",
    "first",
    "10:00:00 + 00:01:00",
    "",
    "{ 1.2.2 }",
    "second",
    "10:05:00 + 00:02:00",
    "",
    "{ 1.3.3 }",
    "third",
    "10:10:00 + 00:03:00",
    ""
  ].join("\n");

  const entryAt = (source: string, n: number) => {
    const index = parseEntries(source);
    const entry = index.entries.find((candidate) => candidate.n === n);
    if (entry === undefined) throw new Error(`expected entry ${n}`);
    return { index, entry };
  };

  it("removes the block and renumbers the surviving siblings", () => {
    const { index, entry } = entryAt(THREE, 2);

    const plan = planDeleteEntry(THREE, index, entry);
    if (plan === null) throw new Error("expected a plan");

    expect(applied(THREE, plan)).toBe(
      [
        "{ 1.1.1 }",
        "first",
        "10:00:00 + 00:01:00",
        "",
        "{ 1.2.3 }",
        "third",
        "10:10:00 + 00:03:00",
        ""
      ].join("\n")
    );
  });

  it("takes the whole subtree with it", () => {
    const source = [
      "{ 1.1.1 }",
      "root",
      "10:00:00 + 00:01:00",
      "{ 2.1.2 }",
      "child",
      "10:01:00 + 00:01:00",
      "{ 3.1.3 }",
      "grandchild",
      "10:02:00 + 00:01:00",
      "",
      "{ 1.2.4 }",
      "sibling",
      "10:03:00 + 00:01:00",
      ""
    ].join("\n");
    const { index, entry } = entryAt(source, 1);

    const plan = planDeleteEntry(source, index, entry);
    if (plan === null) throw new Error("expected a plan");

    expect(applied(source, plan)).toBe(
      ["{ 1.1.4 }", "sibling", "10:03:00 + 00:01:00", ""].join("\n")
    );
  });

  it("leaves one trailing newline and no blank line when the last entry goes", () => {
    const source = ["{ 1.1.1 }", "first", "10:00:00 + 00:01:00", "", "{ 1.2.2 }", "second", "10:05:00 + 00:02:00", ""].join("\n");
    const { index, entry } = entryAt(source, 2);

    const plan = planDeleteEntry(source, index, entry);
    if (plan === null) throw new Error("expected a plan");

    expect(applied(source, plan)).toBe(
      ["{ 1.1.1 }", "first", "10:00:00 + 00:01:00", ""].join("\n")
    );
  });

  it("leaves an empty document when the only entry goes, caret at the top", () => {
    const source = ["{ 1.1.1 }", "prose", "10:00:00 - 00:00:00", ""].join("\n");
    const { index, entry } = entryAt(source, 1);

    const plan = planDeleteEntry(source, index, entry);
    if (plan === null) throw new Error("expected a plan");

    expect(applied(source, plan)).toBe("");
    expect(plan.selection).toEqual({ from: 0, to: 0 });
  });

  it("leaves the caret where the block was", () => {
    const { index, entry } = entryAt(THREE, 2);
    const plan = planDeleteEntry(THREE, index, entry);
    if (plan === null) throw new Error("expected a plan");

    expect(THREE.slice(plan.selection.from).startsWith("{ 1.2.2 }")).toBe(true);
    expect(plan.selection.to).toBe(plan.selection.from);
  });
});

describe("planDuration", () => {
  const DRAFT = ["{ 1.1.1 }", "prose", "10:00:00 - 00:00:01"].join("\n");
  const PAUSED = ["{ 1.1.1 }", "prose", "10:00:00 = 00:00:01"].join("\n");
  const SETTLED = ["{ 1.1.1 }", "prose", "10:00:00 + 00:00:01"].join("\n");

  const first = (source: string) => {
    const index = parseEntries(source);
    const entry = index.entries[0];
    if (entry === undefined) throw new Error("expected an entry");
    return { index, entry };
  };

  it("rewrites the duration half and leaves the moment alone", () => {
    const { index, entry } = first(DRAFT);

    const plan = planDuration(DRAFT, index, entry, "+", 342_000);
    if (plan === null) throw new Error("expected a plan");

    expect(applied(DRAFT, plan)).toBe(
      ["{ 1.1.1 }", "prose", "10:00:00 + 00:05:42"].join("\n")
    );
  });

  it("keeps a moment the writer typed short", () => {
    const source = ["{ 1.1.1 }", "prose", "9:14 - 00:00:01"].join("\n");
    const { index, entry } = first(source);

    const plan = planDuration(source, index, entry, "+", 342_000);
    if (plan === null) throw new Error("expected a plan");

    // The moment is not normalised on the way out: only the tail is written.
    expect(applied(source, plan)).toBe(
      ["{ 1.1.1 }", "prose", "9:14 + 00:05:42"].join("\n")
    );
  });

  it("pauses an open entry at `=`, whichever open sigil it held", () => {
    for (const source of [DRAFT, PAUSED]) {
      const { index, entry } = first(source);

      const plan = planDuration(source, index, entry, "=", 60_000);
      if (plan === null) throw new Error("expected a plan");

      expect(applied(source, plan)).toBe(
        ["{ 1.1.1 }", "prose", "10:00:00 = 00:01:00"].join("\n")
      );
    }
  });

  it("plans nothing for a settled entry, whatever the sigil", () => {
    const { index, entry } = first(SETTLED);

    for (const sigil of ["-", "=", "+"] as const) {
      expect(planDuration(SETTLED, index, entry, sigil, 60_000)).toBeNull();
    }
  });

  it("plans nothing for an entry that carries no clock row", () => {
    const source = ["{ 1.1.1 }", "prose"].join("\n");
    const { index, entry } = first(source);

    expect(planDuration(source, index, entry, "+", 60_000)).toBeNull();
  });

  it("plans nothing for a note that still carries the old marker", () => {
    // The old duration line still parses as a clock row, so without the flag the
    // plan would rewrite one field of a note the migration has not touched.
    const source = ["{ 1.1.1 } - 10:00:00", "prose", "- 00:00:01"].join("\n");
    const { index, entry } = first(source);

    expect(index.legacyFormat).toBe(true);
    expect(planDuration(source, index, entry, "+", 60_000)).toBeNull();
  });

  it("plans nothing when the bytes would not change", () => {
    const { index, entry } = first(DRAFT);

    expect(planDuration(DRAFT, index, entry, "-", 1300)).toBeNull();
  });

  it("writes the same bytes when the same duration is written twice", () => {
    const { index, entry } = first(DRAFT);

    const firstPlan = planDuration(DRAFT, index, entry, "+", 5000);
    if (firstPlan === null) throw new Error("expected a plan");

    const once = applied(DRAFT, firstPlan);
    const again = first(once);

    expect(planDuration(once, again.index, again.entry, "+", 5000)).toBeNull();
  });
});

describe("settling and descending", () => {
  const SOURCE = ["{ 1.1.1 }", "prose", "10:00:00 - 00:00:00"].join("\n");

  it("settles to `+` and touches nothing else", () => {
    const index = parseEntries(SOURCE);
    const entry = index.entries[0];
    if (entry === undefined) throw new Error("expected an entry");

    const duration = planDuration(SOURCE, index, entry, "+", 240_000);
    if (duration === null) throw new Error("expected a duration plan");

    expect(applied(SOURCE, duration)).toBe(
      ["{ 1.1.1 }", "prose", "10:00:00 + 00:04:00"].join("\n")
    );
  });

  it("opens a child under the settled entry, holding the caret", () => {
    const index = parseEntries(SOURCE);
    const entry = index.entries[0];
    if (entry === undefined) throw new Error("expected an entry");

    const duration = planDuration(SOURCE, index, entry, "+", 240_000);
    if (duration === null) throw new Error("expected a duration plan");
    const settledSource = applied(SOURCE, duration);

    const settledIndex = parseEntries(settledSource);
    const parent = settledIndex.entries[0];
    if (parent === undefined) throw new Error("expected a parent");
    expect(parent.state).toBe("settled");

    const child = planChildEntry(settledSource, settledIndex, parent, AT_1337);
    if (child === null) throw new Error("expected a child plan");
    const next = applied(settledSource, child);

    expect(next).toBe(
      [
        "{ 1.1.1 }",
        "prose",
        "10:00:00 + 00:04:00",
        "",
        "{ 2.1.2 }",
        "",
        "13:27:43 - 00:00:00"
      ].join("\n")
    );
    expect(next.slice(0, child.selection.from).endsWith("{ 2.1.2 }\n")).toBe(true);
  });
});
