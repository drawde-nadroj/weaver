import { describe, expect, it } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { history, redo, undo } from "@codemirror/commands";

import { readAlignments } from "../src/core/alignments";
import { formatClock } from "../src/core/clock";
import { dayKey } from "../src/core/day";
import { parseEntries } from "../src/core/entries";
import {
  applyPlanToSource,
  cmChanges,
  planChildEntry,
  planDeleteEntry,
  planDuration,
  planEntryBeginning,
  planCaptureEntry,
  planSettleEntry,
  planWhisper,
  type InsertPlan
} from "../src/core/insert";
import { captureInstantAt, thoughtRefOf, type CaptureRequest } from "../src/core/capture";
import { portalAt, type PortalInstant } from "../src/core/portals";

const AT_1337 = new Date(2026, 9, 27, 13, 27, 43);

function applied(source: string, plan: InsertPlan): string {
  return applyPlanToSource(source, plan).source;
}

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

    const plan = planChildEntry(SOURCE, index, parent);
    if (plan === null) throw new Error("expected a plan");

    const next = applied(SOURCE, plan);
    expect(next).toContain("{ 1.2.4 }");
    expect(next).toContain("- 00:00:00");
    expect(next.split("\n").length).toBe(SOURCE.split("\n").length + 4);
    // One change, one undo: an insert renumbers nothing.
    expect(plan.changes.length).toBe(1);

    // The child is awaiting its own first input: no day borrowed from the note
    // or from the parent.
    const child = parseEntries(next).entries.find((candidate) => candidate.n === 4);
    expect(child?.day).toBeNull();
    expect(child?.time).toBeNull();

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

    const plan = planChildEntry(childless, index, parent);
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

    const plan = planChildEntry(crooked, index, parent);
    if (plan === null) throw new Error("expected a plan");

    const next = applied(crooked, plan);
    // The child inherits the parent's written `B`: the branch stays uniform.
    expect(next).toContain("{ 1.2.3 }");
    // The existing child is left exactly as the writer typed it.
    expect(next).toContain("{ 5.2.2 }");
    expect(next).toContain("+ 00:00:00 10:01:00");
  });

  it("leaves a child under an old parent awaiting its own beginning", () => {
    const source = ["{ 1.1.1 }", "parent", "+ 00:01:00 2026-11-04 23:58:00"].join("\n");
    const index = parseEntries(source);
    const parent = index.entries[0];
    if (parent === undefined) throw new Error("expected a parent");

    const plan = planChildEntry(source, index, parent);
    if (plan === null) throw new Error("expected a plan");

    const next = applied(source, plan);
    expect(next).toContain("- 00:00:00");
    // The parent's moment is its own and is copied byte for byte.
    expect(next).toContain("+ 00:01:00 2026-11-04 23:58:00");

    const [, child] = parseEntries(next).entries;
    expect(child?.day).toBeNull();
    expect(child?.time).toBeNull();
  });
});

describe("planEntryBeginning", () => {
  it("stamps the beginning of an awaiting root from the input timestamp", () => {
    const source = ["{ 1.1.1 }", "", "- 00:00:00"].join("\n");
    const index = parseEntries(source);
    const entry = index.entries[0];
    if (entry === undefined) throw new Error("expected an entry");

    const plan = planEntryBeginning(source, index, entry, AT_1337);
    if (plan === null) throw new Error("expected a beginning plan");

    const next = applied(source, plan);
    expect(next).toBe(
      ["{ 1.1.1 }", "", "- 00:00:00 2026-10-27 13:27:43"].join("\n")
    );
    // One change, one undo, and the caret stays in the prose.
    expect(plan.changes.length).toBe(1);
    expect(plan.selection.from).toBe(index.entries[0]?.proseFrom);

    const captured = parseEntries(next).entries[0];
    if (captured === undefined) throw new Error("expected the captured entry");
    expect(captured.day).toBe("2026-10-27");
    expect(captured.time).toBe("13:27:43");
    // Captured once: the same plan on the captured source is a no-op.
    expect(planEntryBeginning(next, parseEntries(next), captured, AT_1337)).toBeNull();
  });

  it("records a root and a child typed after midnight by the real day, not the note's", () => {
    // Both blocks are made before midnight; neither has a moment until the
    // writer types in it, so both record the day they were actually written.
    let source = ["{ 1.1.1 }", "yesterday", "+ 00:01:00 2026-11-04 23:58:00"].join("\n");

    const beforeMidnightIndex = parseEntries(source);
    const childOf = beforeMidnightIndex.entries[0];
    if (childOf === undefined) throw new Error("expected a root");

    const rootPlan = planChildEntry(source, beforeMidnightIndex, childOf);
    if (rootPlan === null) throw new Error("expected a root plan");
    source = applied(source, rootPlan);

    const createdIndex = parseEntries(source);
    const root = createdIndex.entries[1];
    if (root === undefined) throw new Error("expected the new root");
    expect(root.time).toBeNull();

    // The child is opened under the root while the row is still awaiting.
    const childPlan = planChildEntry(source, createdIndex, root);
    if (childPlan === null) throw new Error("expected a child plan");
    source = applied(source, childPlan);

    const typedAt = new Date(2026, 10, 5, 0, 1, 0);
    const pendingIndex = parseEntries(source);
    const pending = pendingIndex.entries[1];
    if (pending === undefined) throw new Error("expected the awaiting root");
    const rootBeginning = planEntryBeginning(source, pendingIndex, pending, typedAt);
    if (rootBeginning === null) throw new Error("expected a root beginning");
    source = applied(source, rootBeginning);

    const typedIndex = parseEntries(source);
    const pendingChild = typedIndex.entries[2];
    if (pendingChild === undefined) throw new Error("expected the awaiting child");
    const childBeginning = planEntryBeginning(source, typedIndex, pendingChild, typedAt);
    if (childBeginning === null) throw new Error("expected a child beginning");
    source = applied(source, childBeginning);

    expect(source).toContain("- 00:00:00 2026-11-05 00:01:00");
    expect(source).toContain("+ 00:01:00 2026-11-04 23:58:00");

    const [, writtenRoot, writtenChild] = parseEntries(source).entries;
    expect(writtenRoot?.day).toBe("2026-11-05");
    expect(writtenRoot?.time).toBe("00:01:00");
    expect(writtenChild?.day).toBe("2026-11-05");
    expect(writtenChild?.time).toBe("00:01:00");
  });

  it("keeps a paused duration's bytes while adding the beginning", () => {
    const source = ["{ 1.1.1 }", "prose", "= 00:00:05"].join("\n");
    const index = parseEntries(source);
    const entry = index.entries[0];
    if (entry === undefined) throw new Error("expected an entry");
    expect(entry.state).toBe("draft");

    const plan = planEntryBeginning(source, index, entry, AT_1337);
    if (plan === null) throw new Error("expected a beginning plan");

    expect(applied(source, plan)).toBe(
      ["{ 1.1.1 }", "prose", "= 00:00:05 2026-10-27 13:27:43"].join("\n")
    );
  });

  it("never replaces a moment, including a historical moment with no written day", () => {
    const sources = [
      ["{ 1.1.1 }", "prose", "- 00:00:01 2026-10-26 23:00:00"].join("\n"),
      ["{ 1.1.1 }", "prose", "- 00:00:01 23:00:00"].join("\n")
    ];

    for (const source of sources) {
      const index = parseEntries(source);
      const entry = index.entries[0];
      if (entry === undefined) throw new Error("expected an entry");
      expect(planEntryBeginning(source, index, entry, AT_1337)).toBeNull();
    }
  });

  it("refuses a settled entry, an entry with no duration, and an unreadable note", () => {
    const settled = ["{ 1.1.1 }", "prose", "+ 00:00:01 10:00:00"].join("\n");
    const settledIndex = parseEntries(settled);
    expect(
      planEntryBeginning(settled, settledIndex, settledIndex.entries[0] as never, AT_1337)
    ).toBeNull();

    const noClock = ["{ 1.1.1 }", "prose"].join("\n");
    const noClockIndex = parseEntries(noClock);
    expect(
      planEntryBeginning(noClock, noClockIndex, noClockIndex.entries[0] as never, AT_1337)
    ).toBeNull();

    const legacy = ["{ 1.1.1 } - 10:00:00", "prose", "- 00:00:00"].join("\n");
    const legacyIndex = parseEntries(legacy);
    expect(legacyIndex.legacyFormat).toBe(true);
    expect(
      planEntryBeginning(legacy, legacyIndex, legacyIndex.entries[0] as never, AT_1337)
    ).toBeNull();

    const unclosed = "{ 1.1.1 }\n```\n- 00:00:00";
    const unclosedIndex = parseEntries(unclosed);
    expect(unclosedIndex.unclosedFence).toBe(true);
    expect(
      planEntryBeginning(unclosed, unclosedIndex, unclosedIndex.entries[0] as never, AT_1337)
    ).toBeNull();
  });

  it("refuses a stale entry that no longer describes the parsed source", () => {
    const source = ["{ 1.1.1 }", "", "- 00:00:00"].join("\n");
    const stale = parseEntries(source).entries[0];
    if (stale === undefined) throw new Error("expected an entry");

    // A different source with an entry on the same line but a different body.
    const shifted = ["{ 1.1.1 }", "typed already", "- 00:00:00"].join("\n");
    const shiftedIndex = parseEntries(shifted);
    expect(planEntryBeginning(shifted, shiftedIndex, stale, AT_1337)).toBeNull();
  });
});

describe("writing a plan through CodeMirror", () => {
  it("uses CodeMirror's change shape, then places a caret past the old document", () => {
    const source = "w";
    const plan = planCaptureEntry(source, parseEntries(source), rootRequest("a thought", AT_1337));
    if (plan === null) throw new Error("expected a plan");

    // `text` is not a ChangeSpec key, so a plan handed to a view as-is writes
    // nothing at all and throws nothing: this is the shape the engine sends.
    const state = EditorState.create({ doc: source });
    const written = state.update({ changes: cmChanges(plan.changes) }).state;
    expect(written.doc.toString()).toBe(applied(source, plan));

    // The caret sits inside the entry the plan wrote, right after the prose that
    // was typed, so a caller can place it in one update after the write.
    const placed = written.update({ selection: { anchor: plan.selection.from } }).state;
    expect(placed.selection.main.head).toBe(plan.selection.from);
    expect(placed.doc.sliceString(0, plan.selection.from).endsWith("a thought")).toBe(true);
    expect(placed.doc.lineAt(placed.selection.main.head).text).toContain("a thought");
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

  it("plans nothing for a note that still carries the old address", () => {
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

    const child = planChildEntry(settledSource, settledIndex, parent);
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
        "- 00:00:00"
      ].join("\n")
    );
    expect(next.slice(0, child.selection.from).endsWith("{ 1.2.2 }\n")).toBe(true);
  });
});

describe("planWhisper", () => {
  const SOURCE = [
    "{ 1.1.1 }",
    "the address row's own words",
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
        "the address row's own words",
        "+ 00:01:00 10:00:00"
      ].join("\n")
    );
    // One insertion: the selection is the empty range past the new rows.
    expect(plan.changes.length).toBe(1);
    expect(plan.changes[0]?.from).toBe(plan.changes[0]?.to);
    expect(plan.selection.from).toBe(SOURCE.indexOf("the address row's own words") + "~ a pricing decision\n~ next: read it once more\n".length);
    expect(parseEntries(next).entries[0]?.title).toBe("the address row's own words");
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

  it("refuses an address row the writer already named", () => {
    const index = parseEntries(SOURCE);
    const entry = index.entries[0];
    if (entry === undefined) throw new Error("expected an entry");

    const titled = "{ 1.1.1 } a title of my own\nprose\n10:00:00";
    const titledIndex = parseEntries(titled);
    const titledEntry = titledIndex.entries[0];
    if (titledEntry === undefined) throw new Error("expected an entry");
    expect(planWhisper(titled, titledIndex, titledEntry, [{ type: "name", text: "x" }])).toBeNull();

    // The same entry without a name on the address row is writable.
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

/** A real CodeMirror history stack, so undo and redo run as an editor runs them. */
function historyView(doc: string): EditorView & { state: EditorState } {
  let state = EditorState.create({ doc, extensions: [history()] });

  const view = {
    get state(): EditorState {
      return state;
    },
    dispatch(spec: Transaction | Parameters<EditorState["update"]>[0]): void {
      state = spec instanceof Transaction ? spec.state : state.update(spec).state;
    },
    focus(): void {}
  };

  return view as unknown as EditorView & { state: EditorState };
}

/** A local ISO timestamp with a numeric offset, at whole-second precision. */
function expectInstant(value: string | undefined, ms: number): void {
  expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  expect(Date.parse(value ?? "")).toBe(Math.floor(ms / 1000) * 1000);
}

/** A capture request for one root, with its beginning frozen at `began`. */
function rootRequest(text: string, began: Date, portal: PortalInstant | null = null): CaptureRequest {
  return {
    contextId: "main",
    parent: null,
    text,
    beginning: captureInstantAt(began.getTime()),
    durationMs: 4200,
    portal
  };
}

describe("planCaptureEntry", () => {
  const NOTE = [
    "---",
    "travels: 1",
    "mood: quiet",
    "---",
    "{ 1.1.1 }",
    "first",
    "+ 00:01:00 10:00:00"
  ].join("\n");

  const OPENED = new Date(2026, 10, 5, 22, 55, 0);
  const BEGAN = new Date(2026, 10, 5, 22, 55, 7, 200);
  const PORTAL = portalAt(OPENED.getTime());

  it("writes a settled root, the prose and its record as one plan", () => {
    const plan = planCaptureEntry(NOTE, parseEntries(NOTE), rootRequest("saw the eleven", BEGAN, PORTAL));
    if (plan === null) throw new Error("expected a plan");

    const next = applied(NOTE, plan);
    // Unrelated bytes survive, including their own order.
    expect(next).toContain("mood: quiet");
    expect(next.startsWith("---\ntravels: 1\nmood: quiet\n")).toBe(true);

    // One record, already settled: the composer timed it, so nothing is left to
    // begin or to fill in later.
    expect(
      next.endsWith(`\n\n{ 2.1.2 }\n\nsaw the eleven\n+ 00:00:04 ${dayKey(BEGAN)} ${formatClock(BEGAN)}\n`)
    ).toBe(true);

    const entry = parseEntries(next).entries.find((candidate) => candidate.n === 2);
    expect(entry?.state).toBe("settled");
    expect(entry?.day).toBe(dayKey(BEGAN));
    expect(entry?.time).toBe(formatClock(BEGAN));
    // The row records whole seconds: a clock may only show a second that happened.
    expect(entry?.duration?.ms).toBe(4000);

    // The caret lands on the prose, right after what was typed.
    expect(next.slice(0, plan.selection.from).endsWith("saw the eleven")).toBe(true);
    expect(next.slice(plan.selection.from)).toContain(`${"\n"}${"+"} 00:00:04`);

    const records = readAlignments(next);
    if (!records.ok) throw new Error(records.error);
    expect(records.records).toHaveLength(1);
    expect(records.records[0]?.entry).toBe(2);
    expectInstant(records.records[0]?.opened, OPENED.getTime());
    expectInstant(records.records[0]?.began, BEGAN.getTime());

    // Body append and frontmatter record are two edits to one document; the plan
    // sends both without one offset standing in for the other.
    expect(plan.changes).toHaveLength(2);
  });

  it("writes a branch under its parent, one dimension deeper and on its branch", () => {
    const index = parseEntries(NOTE);
    const parentEntry = index.entries[0];
    if (parentEntry === undefined) throw new Error("expected a parent");
    const parent = thoughtRefOf(index, parentEntry, "Chronomancer/2026.11.05.md");

    const plan = planCaptureEntry(NOTE, index, {
      ...rootRequest("a branch", BEGAN, PORTAL),
      parent
    });
    if (plan === null) throw new Error("expected a plan");

    const next = applied(NOTE, plan);
    const entries = parseEntries(next).entries;
    const child = entries.find((candidate) => candidate.n === 2);
    expect(child?.d).toBe(2);
    expect(child?.b).toBe(1);
    expect(child?.parent).toBe(0);

    // A branch never carries the invitation's evidence.
    const records = readAlignments(next);
    if (!records.ok) throw new Error(records.error);
    expect(records.records).toHaveLength(0);
  });

  it("places the newest branch above older siblings", () => {
    const withChild = `${NOTE}\n\n{ 1.2.2 }\n\nan older branch\n+ 00:00:01 ${dayKey(BEGAN)} 09:00:00`;
    const index = parseEntries(withChild);
    const parentEntry = index.entries[0];
    if (parentEntry === undefined) throw new Error("expected a parent");

    const plan = planCaptureEntry(withChild, index, {
      ...rootRequest("the newest branch", BEGAN),
      parent: thoughtRefOf(index, parentEntry, "Chronomancer/2026.11.05.md")
    });
    if (plan === null) throw new Error("expected a plan");

    const entries = parseEntries(applied(withChild, plan)).entries;
    expect(entries.map((entry) => entry.n)).toEqual([1, 3, 2]);
    expect(entries.map((entry) => entry.d)).toEqual([1, 2, 2]);
  });

  it("records no evidence for a draft begun before its opening", () => {
    const early = new Date(2026, 10, 5, 22, 54, 30);
    const plan = planCaptureEntry(NOTE, parseEntries(NOTE), rootRequest("too early", early, PORTAL));
    if (plan === null) throw new Error("expected a plan");

    const records = readAlignments(applied(NOTE, plan));
    if (!records.ok) throw new Error(records.error);
    expect(records.records).toHaveLength(0);
  });

  it("keeps the opening's frozen local facts after a timezone change", () => {
    const opensAt = Date.UTC(2026, 10, 6, 6, 55, 0);
    const machineOffset = -new Date(opensAt).getTimezoneOffset();
    const offsetMinutes = machineOffset === 540 ? -480 : 540;
    const wall = new Date(opensAt + offsetMinutes * 60_000);
    const pad = (value: number) => String(value).padStart(2, "0");
    const day = `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}`;
    const portal: PortalInstant = {
      id: new Date(opensAt).toISOString(),
      opensAt,
      day,
      hour: wall.getUTCHours(),
      minute: wall.getUTCMinutes(),
      offsetMinutes
    };

    // Inside the opening's own minute: the beginning is what qualifies, and the
    // frozen local facts are the opening's, not the machine's current zone's.
    const began = new Date(opensAt + 7_100);
    const plan = planCaptureEntry(NOTE, parseEntries(NOTE), rootRequest("arrived late", began, portal));
    if (plan === null) throw new Error("expected a plan");

    const records = readAlignments(applied(NOTE, plan));
    if (!records.ok) throw new Error(records.error);
    const opened = records.records[0]?.opened ?? "";
    const expectedOffset = `${offsetMinutes < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
    expect(opened).toBe(`${day}T${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:00${expectedOffset}`);
    expect(Date.parse(opened)).toBe(opensAt);
    expectInstant(records.records[0]?.began, began.getTime());
  });

  it("keeps multi-line prose, spacing and all", () => {
    for (const text of ["first line\nsecond line", "first paragraph\n\nsecond paragraph", "breathe\n", "\nsteady"]) {
      const plan = planCaptureEntry(NOTE, parseEntries(NOTE), rootRequest(text, BEGAN));
      if (plan === null) throw new Error(`expected a plan for ${JSON.stringify(text)}`);

      const next = applied(NOTE, plan);
      const entry = parseEntries(next).entries.find((candidate) => candidate.n === 2);
      if (entry === undefined) throw new Error("expected the captured entry");
      // Blank lines at the edges are spacing; what was typed is kept byte for byte.
      expect(next.slice(entry.proseFrom, entry.proseTo)).toBe(text.trim());
      expect(next.slice(0, plan.selection.from).endsWith(text)).toBe(true);
    }
  });

  it("keeps a balanced code fence as the entry's prose", () => {
    const text = "```\nconst ticket = 11;\n```";
    const plan = planCaptureEntry(NOTE, parseEntries(NOTE), rootRequest(text, BEGAN, PORTAL));
    if (plan === null) throw new Error("expected a plan");

    const next = applied(NOTE, plan);
    const entry = parseEntries(next).entries.find((candidate) => candidate.n === 2);
    expect(entry?.proseLines).toHaveLength(3);
    expect(entry?.day).toBe(dayKey(BEGAN));
    expect(entry?.time).toBe(formatClock(BEGAN));

    const records = readAlignments(next);
    if (!records.ok) throw new Error(records.error);
    expect(records.records[0]?.entry).toBe(2);
  });

  it("refuses text that would turn the block into something else", () => {
    const refused = [
      "```\nsaw this",
      "saw this\n{ 9.1.9 }\nand this",
      `saw this\n- 00:00:00 ${dayKey(BEGAN)} ${formatClock(BEGAN)}`,
      `saw this\n+ 00:00:04 ${dayKey(BEGAN)} ${formatClock(BEGAN)}`
    ];

    for (const text of refused) {
      expect(planCaptureEntry(NOTE, parseEntries(NOTE), rootRequest(text, BEGAN, PORTAL))).toBeNull();
      const records = readAlignments(NOTE);
      if (!records.ok) throw new Error(records.error);
      expect(records.records).toHaveLength(0);
    }
  });

  it("refuses an empty or whitespace-only thought", () => {
    for (const text of ["", "   ", "\n \t\n"]) {
      expect(planCaptureEntry(NOTE, parseEntries(NOTE), rootRequest(text, BEGAN))).toBeNull();
    }
    expect(planCaptureEntry(NOTE, parseEntries(NOTE), rootRequest("x", BEGAN))).not.toBeNull();
  });

  it("refuses a parent that is no longer in the note", () => {
    const index = parseEntries(NOTE);
    const stale = { ...thoughtRefOf(index, index.entries[0]!, "Chronomancer/2026.11.05.md"), prose: "gone" };
    expect(planCaptureEntry(NOTE, index, { ...rootRequest("child", BEGAN), parent: stale })).toBeNull();
  });

  it("refuses unreadable metadata and notes before changing a byte", () => {
    const malformed = "---\nweaver-alignments:\n  - {oops}\n---\n";
    expect(planCaptureEntry(malformed, parseEntries(malformed), rootRequest("x", BEGAN, PORTAL))).toBeNull();

    // An unreadable history refuses only when a record would join it.
    const duplicate = "---\nweaver-alignments:\nweaver-alignments:\n---\n";
    expect(planCaptureEntry(duplicate, parseEntries(duplicate), rootRequest("x", BEGAN, PORTAL))).toBeNull();
    expect(planCaptureEntry(duplicate, parseEntries(duplicate), rootRequest("x", BEGAN))).not.toBeNull();

    const unclosed = "---\ntravels: 1\n";
    expect(planCaptureEntry(unclosed, parseEntries(unclosed), rootRequest("x", BEGAN))).toBeNull();

    const fenced = "{ 1.1.1 }\n```\n";
    expect(planCaptureEntry(fenced, parseEntries(fenced), rootRequest("x", BEGAN))).toBeNull();

    const legacy = "{ 1.1.1 } - 10:00:00\nprose";
    expect(parseEntries(legacy).legacyFormat).toBe(true);
    expect(planCaptureEntry(legacy, parseEntries(legacy), rootRequest("x", BEGAN))).toBeNull();
  });

  it("keeps both records when two openings are written on one day", () => {
    const empty = "";
    const first = planCaptureEntry(empty, parseEntries(empty), rootRequest("one", BEGAN, PORTAL));
    if (first === null) throw new Error("expected a plan");
    const afterFirst = applied(empty, first);

    const secondOpening = new Date(2026, 10, 5, 23, 23, 0);
    const secondBegan = new Date(2026, 10, 5, 23, 23, 11, 900);
    const second = planCaptureEntry(
      afterFirst,
      parseEntries(afterFirst),
      rootRequest("two", secondBegan, portalAt(secondOpening.getTime()))
    );
    if (second === null) throw new Error("expected a plan");

    const next = applied(afterFirst, second);
    const records = readAlignments(next);
    if (!records.ok) throw new Error(records.error);
    expect(records.records.map((record) => record.entry)).toEqual([1, 2]);
    expect(records.records.map((record) => record.portal)).toEqual([
      PORTAL.id,
      portalAt(secondOpening.getTime()).id
    ]);
  });
});

describe("a captured entry through a delete", () => {
  const BEGAN = new Date(2026, 10, 5, 22, 55, 22, 0);

  /** A note whose newest entry is a captured root, with its record. */
  function capturedNote(): string {
    const base = ["---", "travels: 1", "---", "{ 1.1.1 }", "first", "+ 00:01:00 10:00:00"].join("\n");
    const plan = planCaptureEntry(
      base,
      parseEntries(base),
      rootRequest("through the door", BEGAN, portalAt(new Date(2026, 10, 5, 22, 55, 0).getTime()))
    );
    if (plan === null) throw new Error("expected a plan");
    return applied(base, plan);
  }

  it("nulls the deleted entry's association and keeps the event", () => {
    const source = capturedNote();
    const index = parseEntries(source);
    const entry = index.entries.find((candidate) => candidate.n === 2);
    if (entry === undefined) throw new Error("expected the captured entry");

    const before = readAlignments(source);
    if (!before.ok) throw new Error(before.error);

    const plan = planDeleteEntry(source, index, entry);
    if (plan === null) throw new Error("expected a plan");

    const next = applied(source, plan);
    expect(next).not.toContain("through the door");

    const after = readAlignments(next);
    if (!after.ok) throw new Error(after.error);
    expect(after.records).toHaveLength(1);
    expect(after.records[0]?.entry).toBeNull();
    expect(after.records[0]?.portal).toBe(before.records[0]?.portal);
    expect(after.records[0]?.began).toBe(before.records[0]?.began);
  });
});

describe("a capture through real CodeMirror history", () => {
  const BEGAN = new Date(2026, 10, 5, 22, 55, 0, 400);
  const SOURCE = ["---", "travels: 1", "---", "{ 1.1.1 }", "first", "+ 00:01:00 10:00:00"].join("\n");

  it("undoes the entry and its record together, then redoes both", () => {
    const opened = new Date(2026, 10, 5, 22, 55, 0);
    const plan = planCaptureEntry(SOURCE, parseEntries(SOURCE), rootRequest("entered", BEGAN, portalAt(opened.getTime())));
    if (plan === null) throw new Error("expected a plan");
    const written = applied(SOURCE, plan);

    const view = historyView(SOURCE);
    view.dispatch({ changes: cmChanges(plan.changes), selection: { anchor: plan.selection.from } });
    expect(view.state.doc.toString()).toBe(written);

    expect(undo({ state: view.state, dispatch: (transaction) => view.dispatch(transaction) })).toBe(true);
    expect(view.state.doc.toString()).toBe(SOURCE);

    expect(redo({ state: view.state, dispatch: (transaction) => view.dispatch(transaction) })).toBe(true);
    expect(view.state.doc.toString()).toBe(written);
    const records = readAlignments(view.state.doc.toString());
    if (!records.ok) throw new Error(records.error);
    expect(records.records[0]?.entry).toBe(2);
  });
});

describe("planCaptureEntry and an unwritable record", () => {
  const NOTE = [
    "---",
    "travels: 1",
    "---",
    "{ 1.1.1 }",
    "first",
    "+ 00:01:00 10:00:00"
  ].join("\n");

  it("writes the thought without evidence when the record cannot be added", () => {
    // An opening whose id is not a whole minute cannot be named by a record. The
    // thought is the record and the evidence is extra, so the words still land —
    // losing a written thought to an unwritable detail would be the worse trade.
    const opened = new Date(2026, 10, 5, 22, 55, 0);
    const portal = portalAt(opened.getTime() + 4_000);
    const plan = planCaptureEntry(
      NOTE,
      parseEntries(NOTE),
      rootRequest("the words still land", new Date(opened.getTime() + 4_500), portal)
    );
    if (plan === null) throw new Error("expected a plan");

    const written = applied(NOTE, plan);
    expect(written).toContain("the words still land");

    const records = readAlignments(written);
    if (!records.ok) throw new Error(records.error);
    expect(records.records).toHaveLength(0);
  });
});

describe("planSettleEntry", () => {
  it("adds the day and moment at settle when the row has neither", () => {
    const source = ["{ 1.1.1 }", "", "prose", "- 00:00:05"].join("\n");
    const index = parseEntries(source);
    const plan = planSettleEntry(source, index, index.entries[0]!, 5000, new Date(2026, 10, 5, 9, 0, 0));
    expect(plan).not.toBeNull();
    const next = applyPlanToSource(source, plan!).source;
    expect(next).toContain("+ 00:00:05 2026-11-05 09:00:00");
  });

  it("keeps a moment the row already recorded", () => {
    const source = ["{ 1.1.1 }", "", "prose", "- 00:00:05 2026-01-01 10:00:00"].join("\n");
    const index = parseEntries(source);
    const plan = planSettleEntry(source, index, index.entries[0]!, 5000, new Date(2026, 10, 5, 9, 0, 0));
    const next = applyPlanToSource(source, plan!).source;
    expect(next).toContain("+ 00:00:05 2026-01-01 10:00:00");
  });
});
