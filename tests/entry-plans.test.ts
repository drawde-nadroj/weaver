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
  planWhisper,
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
    expect(next).toBe("{ 1.1.1 }\n\n- 00:00:00 2026-10-27 13:27:43\n");

    // The caret sits on the blank prose line, where the writing happens.
    expect(next.slice(0, plan.selection.from)).toBe("{ 1.1.1 }\n");
    expect(plan.selection.to).toBe(plan.selection.from);
  });

  it("appends a second root after the existing one", () => {
    const source = ["{ 1.1.1 }", "prose", "+ 00:01:00 10:00:00"].join("\n");
    const plan = planStartEntry(source, parseEntries(source), AT_1337);
    if (plan === null) throw new Error("expected a plan");

    const next = applied(source, plan);
    expect(next).toContain("{ 2.1.2 }");
    expect(next).toContain("- 00:00:00 2026-10-27 13:27:43");
  });

  it("writes the creation day from the one `now`, not the note's older entries", () => {
    // The note is a past day's; the entry being written is today's. The row
    // records the day it was actually created, and the old row keeps its own.
    const source = ["{ 1.1.1 }", "yesterday", "+ 00:01:00 2026-10-26 23:00:00"].join("\n");
    const plan = planStartEntry(source, parseEntries(source), AT_1337);
    if (plan === null) throw new Error("expected a plan");

    const next = applied(source, plan);
    expect(next).toContain("+ 00:01:00 2026-10-26 23:00:00");
    expect(next).toContain("- 00:00:00 2026-10-27 13:27:43");

    const [old, written] = parseEntries(next).entries;
    expect(old?.day).toBe("2026-10-26");
    expect(written?.day).toBe("2026-10-27");
    expect(written?.time).toBe("13:27:43");
  });
});

describe("planChildEntry", () => {
  const SOURCE = [
    "{ 1.1.1 }",
    "root",
    "+ 00:01:00 10:00:00",
    "{ 1.2.2 }",
    "first child",
    "+ 00:00:00 10:01:00",
    "{ 2.2.3 }",
    "second child",
    "- 00:00:00 10:02:00"
  ].join("\n");

  it("goes one dimension deeper on the same branch, next in the sequence", () => {
    const index = parseEntries(SOURCE);
    const parent = index.entries[0];
    if (parent === undefined) throw new Error("expected a parent");

    const plan = planChildEntry(SOURCE, index, parent, AT_1337);
    if (plan === null) throw new Error("expected a plan");

    const next = applied(SOURCE, plan);
    expect(next).toContain("{ 1.2.4 }");
    expect(next).toContain("- 00:00:00 2026-10-27 13:27:43");
    expect(next.split("\n").length).toBe(SOURCE.split("\n").length + 4);
    // One change, one undo: an insert renumbers nothing.
    expect(plan.changes.length).toBe(1);

    // Directly under the parent's own block, above the older siblings: the
    // newest branch is the closest one to what it descends from.
    const lines = next.split("\n");
    const parentClock = lines.indexOf("+ 00:01:00 10:00:00");
    expect(lines[parentClock + 2]).toBe("{ 1.2.4 }");
    expect(lines.indexOf("{ 1.2.4 }")).toBeLessThan(lines.indexOf("{ 1.2.2 }"));
  });

  it("inserts after the parent's own clock row when it has no children yet", () => {
    const childless = ["{ 1.1.1 }", "root", "+ 00:01:00 10:00:00"].join("\n");
    const index = parseEntries(childless);
    const parent = index.entries[0];
    if (parent === undefined) throw new Error("expected a parent");

    const plan = planChildEntry(childless, index, parent, AT_1337);
    if (plan === null) throw new Error("expected a plan");

    const lines = applied(childless, plan).split("\n");
    const parentClock = lines.indexOf("+ 00:01:00 10:00:00");
    expect(lines[parentClock + 2]).toBe("{ 1.2.2 }");
  });

  it("keeps a crooked branch's B when inserting under it", () => {
    const crooked = [
      "{ 1.1.1 }",
      "root",
      "+ 00:01:00 10:00:00",
      "{ 5.2.2 }",
      "crooked child",
      "+ 00:00:00 10:01:00"
    ].join("\n");

    const index = parseEntries(crooked);
    const parent = index.entries[0];
    if (parent === undefined) throw new Error("expected a parent");

    const plan = planChildEntry(crooked, index, parent, AT_1337);
    if (plan === null) throw new Error("expected a plan");

    const next = applied(crooked, plan);
    // The child inherits the parent's written `B`: the branch stays uniform.
    expect(next).toContain("{ 1.2.3 }");
    // The existing child is left exactly as the writer typed it.
    expect(next).toContain("{ 5.2.2 }");
    expect(next).toContain("+ 00:00:00 10:01:00");
  });

  it("dates a child after midnight by its own creation, not its parent's day", () => {
    const source = ["{ 1.1.1 }", "parent", "+ 00:01:00 2026-11-04 23:58:00"].join("\n");
    const index = parseEntries(source);
    const parent = index.entries[0];
    if (parent === undefined) throw new Error("expected a parent");

    const afterMidnight = new Date(2026, 10, 5, 0, 1, 0);
    const plan = planChildEntry(source, index, parent, afterMidnight);
    if (plan === null) throw new Error("expected a plan");

    const next = applied(source, plan);
    expect(next).toContain("- 00:00:00 2026-11-05 00:01:00");

    const [, child] = parseEntries(next).entries;
    expect(child?.day).toBe("2026-11-05");
    expect(child?.time).toBe("00:01:00");
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
    "+ 00:01:00 10:00:00",
    "",
    "{ 2.1.2 }",
    "second",
    "+ 00:02:00 10:05:00",
    "",
    "{ 3.1.3 }",
    "third",
    "+ 00:03:00 10:10:00",
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
        "+ 00:01:00 10:00:00",
        "",
        "{ 2.1.3 }",
        "third",
        "+ 00:03:00 10:10:00",
        ""
      ].join("\n")
    );
  });

  it("takes the whole subtree with it", () => {
    const source = [
      "{ 1.1.1 }",
      "root",
      "+ 00:01:00 10:00:00",
      "{ 1.2.2 }",
      "child",
      "+ 00:01:00 10:01:00",
      "{ 1.3.3 }",
      "grandchild",
      "+ 00:01:00 10:02:00",
      "",
      "{ 2.1.4 }",
      "sibling",
      "+ 00:01:00 10:03:00",
      ""
    ].join("\n");
    const { index, entry } = entryAt(source, 1);

    const plan = planDeleteEntry(source, index, entry);
    if (plan === null) throw new Error("expected a plan");

    expect(applied(source, plan)).toBe(
      ["{ 1.1.4 }", "sibling", "+ 00:01:00 10:03:00", ""].join("\n")
    );
  });

  it("leaves one trailing newline and no blank line when the last entry goes", () => {
    const source = ["{ 1.1.1 }", "first", "+ 00:01:00 10:00:00", "", "{ 2.1.2 }", "second", "+ 00:02:00 10:05:00", ""].join("\n");
    const { index, entry } = entryAt(source, 2);

    const plan = planDeleteEntry(source, index, entry);
    if (plan === null) throw new Error("expected a plan");

    expect(applied(source, plan)).toBe(
      ["{ 1.1.1 }", "first", "+ 00:01:00 10:00:00", ""].join("\n")
    );
  });

  it("leaves an empty document when the only entry goes, caret at the top", () => {
    const source = ["{ 1.1.1 }", "prose", "- 00:00:00 10:00:00", ""].join("\n");
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

    expect(THREE.slice(plan.selection.from).startsWith("{ 2.1.2 }")).toBe(true);
    expect(plan.selection.to).toBe(plan.selection.from);
  });
});

describe("planDuration", () => {
  const DRAFT = ["{ 1.1.1 }", "prose", "- 00:00:01 10:00:00"].join("\n");
  const PAUSED = ["{ 1.1.1 }", "prose", "= 00:00:01 10:00:00"].join("\n");
  const SETTLED = ["{ 1.1.1 }", "prose", "+ 00:00:01 10:00:00"].join("\n");

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
      ["{ 1.1.1 }", "prose", "+ 00:05:42 10:00:00"].join("\n")
    );
  });

  it("keeps the written day and moment when a duration is written", () => {
    const source = ["{ 1.1.1 }", "prose", "- 00:00:01 2026-11-05 10:00:00"].join("\n");
    const { index, entry } = first(source);

    const plan = planDuration(source, index, entry, "+", 342_000);
    if (plan === null) throw new Error("expected a plan");

    const next = applied(source, plan);
    expect(next).toBe(
      ["{ 1.1.1 }", "prose", "+ 00:05:42 2026-11-05 10:00:00"].join("\n")
    );

    const written = parseEntries(next).entries[0];
    expect(written?.day).toBe("2026-11-05");
    expect(written?.time).toBe("10:00:00");
  });

  it("keeps a moment the writer typed short", () => {
    const source = ["{ 1.1.1 }", "prose", "- 00:00:01 9:14"].join("\n");
    const { index, entry } = first(source);

    const plan = planDuration(source, index, entry, "+", 342_000);
    if (plan === null) throw new Error("expected a plan");

    // The moment is not normalised on the way out: only the tail is written.
    expect(applied(source, plan)).toBe(
      ["{ 1.1.1 }", "prose", "+ 00:05:42 9:14"].join("\n")
    );
  });

  it("pauses an open entry at `=`, whichever open sigil it held", () => {
    for (const source of [DRAFT, PAUSED]) {
      const { index, entry } = first(source);

      const plan = planDuration(source, index, entry, "=", 60_000);
      if (plan === null) throw new Error("expected a plan");

      expect(applied(source, plan)).toBe(
        ["{ 1.1.1 }", "prose", "= 00:01:00 10:00:00"].join("\n")
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
  const SOURCE = ["{ 1.1.1 }", "prose", "- 00:00:00 10:00:00"].join("\n");

  it("settles to `+` and touches nothing else", () => {
    const index = parseEntries(SOURCE);
    const entry = index.entries[0];
    if (entry === undefined) throw new Error("expected an entry");

    const duration = planDuration(SOURCE, index, entry, "+", 240_000);
    if (duration === null) throw new Error("expected a duration plan");

    expect(applied(SOURCE, duration)).toBe(
      ["{ 1.1.1 }", "prose", "+ 00:04:00 10:00:00"].join("\n")
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
        "+ 00:04:00 10:00:00",
        "",
        "{ 1.2.2 }",
        "",
        "- 00:00:00 2026-10-27 13:27:43"
      ].join("\n")
    );
    expect(next.slice(0, child.selection.from).endsWith("{ 1.2.2 }\n")).toBe(true);
  });
});

describe("planWhisper", () => {
  const SOURCE = [
    "{ 1.1.1 }",
    "the marker row's own words",
    "+ 00:01:00 10:00:00"
  ].join("\n");

  it("inserts above the first prose line, keeping the clock row last", () => {
    const index = parseEntries(SOURCE);
    const entry = index.entries[0];
    if (entry === undefined) throw new Error("expected an entry");

    const plan = planWhisper(SOURCE, index, entry, [
      { type: "name", text: "a pricing decision" },
      { type: "next", text: "read it once more" }
    ]);
    if (plan === null) throw new Error("expected a whisper plan");

    const next = applied(SOURCE, plan);
    expect(next).toBe(
      [
        "{ 1.1.1 }",
        "~ a pricing decision",
        "~ next: read it once more",
        "the marker row's own words",
        "+ 00:01:00 10:00:00"
      ].join("\n")
    );
    // One insertion: the selection is the empty range past the new rows.
    expect(plan.changes.length).toBe(1);
    expect(plan.changes[0]?.from).toBe(plan.changes[0]?.to);
    expect(plan.selection.from).toBe(SOURCE.indexOf("the marker row's own words") + "~ a pricing decision\n~ next: read it once more\n".length);
    expect(parseEntries(next).entries[0]?.title).toBe("the marker row's own words");
  });

  it("lands above a prose line that sits after a blank one", () => {
    const source = ["{ 1.1.1 }", "", "written prose", "+ 00:01:00 10:00:00"].join("\n");
    const index = parseEntries(source);
    const entry = index.entries[0];
    if (entry === undefined) throw new Error("expected an entry");

    const plan = planWhisper(source, index, entry, [{ type: "name", text: "written prose, read" }]);
    if (plan === null) throw new Error("expected a whisper plan");

    expect(applied(source, plan)).toBe(
      [
        "{ 1.1.1 }",
        "",
        "~ written prose, read",
        "written prose",
        "+ 00:01:00 10:00:00"
      ].join("\n")
    );
  });

  it("refuses an entry that already has a whisper", () => {
    const source = ["{ 1.1.1 }", "~ a reading", "prose", "10:00:00"].join("\n");
    const index = parseEntries(source);
    const entry = index.entries[0];
    if (entry === undefined) throw new Error("expected an entry");

    expect(planWhisper(source, index, entry, [{ type: "name", text: "another" }])).toBeNull();
  });

  it("refuses a marker row the writer already named", () => {
    const index = parseEntries(SOURCE);
    const entry = index.entries[0];
    if (entry === undefined) throw new Error("expected an entry");

    const titled = "{ 1.1.1 } a title of my own\nprose\n10:00:00";
    const titledIndex = parseEntries(titled);
    const titledEntry = titledIndex.entries[0];
    if (titledEntry === undefined) throw new Error("expected an entry");
    expect(planWhisper(titled, titledIndex, titledEntry, [{ type: "name", text: "x" }])).toBeNull();

    // The same entry without a name on the marker row is writable.
    expect(planWhisper(SOURCE, index, entry, [{ type: "name", text: "x" }])).not.toBeNull();
  });

  it("refuses an entry with no prose and an entry with no clock row", () => {
    const empty = "{ 1.1.1 }\n\n10:00:00";
    const emptyIndex = parseEntries(empty);
    const emptyEntry = emptyIndex.entries[0];
    if (emptyEntry === undefined) throw new Error("expected an entry");
    expect(emptyEntry.firstProseLine).toBeNull();
    expect(planWhisper(empty, emptyIndex, emptyEntry, [{ type: "name", text: "x" }])).toBeNull();

    const unclosed = "{ 1.1.1 }\nprose";
    const unclosedIndex = parseEntries(unclosed);
    const unclosedEntry = unclosedIndex.entries[0];
    if (unclosedEntry === undefined) throw new Error("expected an entry");
    expect(unclosedEntry.clockLine).toBeNull();
    expect(planWhisper(unclosed, unclosedIndex, unclosedEntry, [{ type: "name", text: "x" }])).toBeNull();
  });

  it("refuses an empty answer, an essay, and a legacy note", () => {
    const index = parseEntries(SOURCE);
    const entry = index.entries[0];
    if (entry === undefined) throw new Error("expected an entry");

    expect(planWhisper(SOURCE, index, entry, [])).toBeNull();
    expect(
      planWhisper(SOURCE, index, entry, [
        { type: "name", text: "a" },
        { type: "learn", text: "b" },
        { type: "next", text: "c" },
        { type: "name", text: "d" }
      ])
    ).toBeNull();

    const legacy = "{ 1.1.1 } - 10:00:00\nprose";
    const legacyIndex = parseEntries(legacy);
    expect(legacyIndex.legacyFormat).toBe(true);
    expect(planWhisper(legacy, legacyIndex, legacyIndex.entries[0] as never, [{ type: "name", text: "x" }])).toBeNull();
  });
});
