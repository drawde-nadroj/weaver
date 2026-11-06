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
  planPortalEntry,
  planStartEntry,
  planWhisper,
  type InsertPlan
} from "../src/core/insert";
import { portalInstants, type PortalInstant } from "../src/core/portals";

const AT_1337 = new Date(2026, 9, 27, 13, 27, 43);

function applied(source: string, plan: InsertPlan): string {
  return applyPlanToSource(source, plan).source;
}

describe("planStartEntry", () => {
  it("writes a root marker, a blank line and an awaiting clock row", () => {
    const source = "";
    const plan = planStartEntry(source, parseEntries(source));
    expect(plan).not.toBeNull();
    if (plan === null) return;

    const next = applied(source, plan);
    expect(next).toBe("{ 1.1.1 }\n\n- 00:00:00\n");

    // The caret sits on the blank prose line, where the writing happens.
    expect(next.slice(0, plan.selection.from)).toBe("{ 1.1.1 }\n");
    expect(plan.selection.to).toBe(plan.selection.from);

    // A duration with no moment: a draft that has not begun, not one begun at
    // whatever time the block happened to be made.
    const [entry] = parseEntries(next).entries;
    expect(entry?.state).toBe("draft");
    expect(entry?.duration?.ms).toBe(0);
    expect(entry?.time).toBeNull();
    expect(entry?.day).toBeNull();
  });

  it("appends a second root after the existing one", () => {
    const source = ["{ 1.1.1 }", "prose", "+ 00:01:00 10:00:00"].join("\n");
    const plan = planStartEntry(source, parseEntries(source));
    if (plan === null) throw new Error("expected a plan");

    const next = applied(source, plan);
    expect(next).toContain("{ 2.1.2 }");
    expect(next).toContain("- 00:00:00");
  });

  it("implies no beginning, so an older note's days stay the only written ones", () => {
    // The note is a past day's; a root appended to it has not been written in.
    // Its row records nothing, so no surface can claim it started that day.
    const source = ["{ 1.1.1 }", "yesterday", "+ 00:01:00 2026-10-26 23:00:00"].join("\n");
    const plan = planStartEntry(source, parseEntries(source));
    if (plan === null) throw new Error("expected a plan");

    const next = applied(source, plan);
    expect(next).toContain("+ 00:01:00 2026-10-26 23:00:00");

    const [old, written] = parseEntries(next).entries;
    expect(old?.day).toBe("2026-10-26");
    expect(written?.day).toBeNull();
    expect(written?.time).toBeNull();
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

    const rootPlan = planStartEntry(source, parseEntries(source));
    if (rootPlan === null) throw new Error("expected a root plan");
    source = applied(source, rootPlan);

    const beforeMidnightIndex = parseEntries(source);
    const root = beforeMidnightIndex.entries[1];
    if (root === undefined) throw new Error("expected the new root");
    expect(root.time).toBeNull();

    // The child is opened under the root while the row is still awaiting.
    const childPlan = planChildEntry(source, beforeMidnightIndex, root);
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
    const plan = planStartEntry(source, parseEntries(source));
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

/** An opening at a whole local minute. */
function portalAt(ms: number): PortalInstant {
  const [instant] = portalInstants(ms, ms);
  if (instant === undefined) throw new Error("expected an opening");
  return instant;
}

/** A local ISO timestamp with a numeric offset, at whole-second precision. */
function expectInstant(value: string | undefined, ms: number): void {
  expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  expect(Date.parse(value ?? "")).toBe(Math.floor(ms / 1000) * 1000);
}

describe("planPortalEntry", () => {
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
  const BEGAN = new Date(2026, 10, 5, 22, 55, 0, 200);
  const PORTAL = portalAt(OPENED.getTime());

  it("writes the prose, the actual clock row and the record as one plan", () => {
    const plan = planPortalEntry(NOTE, parseEntries(NOTE), PORTAL, BEGAN, "saw the eleven");
    if (plan === null) throw new Error("expected a plan");

    const next = applied(NOTE, plan);
    // Unrelated bytes survive, including their own order.
    expect(next).toContain("mood: quiet");
    expect(next.startsWith("---\ntravels: 1\nmood: quiet\n")).toBe(true);

    expect(
      next.endsWith(`\n\n{ 2.1.2 }\n\nsaw the eleven\n- 00:00:00 ${dayKey(BEGAN)} ${formatClock(BEGAN)}\n`)
    ).toBe(true);

    // The entry began at the input, not at the opening and not at a rounded second.
    const entry = parseEntries(next).entries.find((candidate) => candidate.n === 2);
    expect(entry?.state).toBe("draft");
    expect(entry?.day).toBe(dayKey(BEGAN));
    expect(entry?.time).toBe(formatClock(BEGAN));
    expect(entry?.duration?.ms).toBe(0);

    // The caret lands on the prose, right after what was typed.
    expect(next.slice(0, plan.selection.from).endsWith("saw the eleven")).toBe(true);
    expect(plan.selection.to).toBe(plan.selection.from);

    const records = readAlignments(next);
    if (!records.ok) throw new Error(records.error);
    expect(records.records).toHaveLength(1);
    const [record] = records.records;
    expect(record?.portal).toBe(PORTAL.id);
    expect(record?.entry).toBe(2);
    expectInstant(record?.opened, OPENED.getTime());
    expectInstant(record?.began, BEGAN.getTime());

    // Body append and frontmatter record are two edits to one document; the plan
    // sends both without one offset standing in for the other.
    expect(plan.changes).toHaveLength(2);
    expect(cmChanges(plan.changes).map((change) => change.insert)).toEqual([
      expect.stringContaining("weaver-alignments"),
      expect.stringContaining("saw the eleven")
    ]);
  });

  it("keeps both records when two openings are written on one day", () => {
    const empty = "";
    const first = planPortalEntry(empty, parseEntries(empty), PORTAL, BEGAN, "one");
    if (first === null) throw new Error("expected a plan");
    const afterFirst = applied(empty, first);

    const secondOpening = new Date(2026, 10, 5, 23, 23, 0);
    const secondBegan = new Date(2026, 10, 5, 23, 23, 11, 900);
    const second = planPortalEntry(
      afterFirst,
      parseEntries(afterFirst),
      portalAt(secondOpening.getTime()),
      secondBegan,
      "two"
    );
    if (second === null) throw new Error("expected a plan");

    const next = applied(afterFirst, second);
    // A truly empty note is all new text: one change, still one undo.
    expect(first.changes).toHaveLength(1);

    const records = readAlignments(next);
    if (!records.ok) throw new Error(records.error);
    expect(records.records.map((record) => record.entry)).toEqual([1, 2]);
    expect(records.records.map((record) => record.portal)).toEqual([
      PORTAL.id,
      portalAt(secondOpening.getTime()).id
    ]);
    expectInstant(records.records[1]?.began, secondBegan.getTime());

    const entries = parseEntries(next).entries;
    expect(entries.map((entry) => entry.n)).toEqual([1, 2]);
    expect(entries.map((entry) => entry.day)).toEqual([dayKey(BEGAN), dayKey(secondBegan)]);
  });

  it("refuses unreadable metadata and notes before changing a byte", () => {
    const malformed = "---\nweaver-alignments:\n  - {oops}\n---\n";
    expect(planPortalEntry(malformed, parseEntries(malformed), PORTAL, BEGAN, "x")).toBeNull();

    const duplicate = "---\nweaver-alignments:\nweaver-alignments:\n---\n";
    expect(planPortalEntry(duplicate, parseEntries(duplicate), PORTAL, BEGAN, "x")).toBeNull();

    const unclosed = "---\ntravels: 1\n";
    expect(planPortalEntry(unclosed, parseEntries(unclosed), PORTAL, BEGAN, "x")).toBeNull();

    const fenced = "{ 1.1.1 }\n```\n";
    expect(planPortalEntry(fenced, parseEntries(fenced), PORTAL, BEGAN, "x")).toBeNull();

    const legacy = "{ 1.1.1 } - 10:00:00\nprose";
    expect(parseEntries(legacy).legacyFormat).toBe(true);
    expect(planPortalEntry(legacy, parseEntries(legacy), PORTAL, BEGAN, "x")).toBeNull();
  });

  it("refuses an empty first input: a portal is entered by deliberate text", () => {
    const ok = "---\ntravels: 1\n---\n";
    expect(planPortalEntry(ok, parseEntries(ok), PORTAL, BEGAN, "")).toBeNull();
    expect(planPortalEntry(ok, parseEntries(ok), PORTAL, BEGAN, "   ")).toBeNull();
    expect(planPortalEntry(ok, parseEntries(ok), PORTAL, BEGAN, "\n \t\n")).toBeNull();
    expect(planPortalEntry(ok, parseEntries(ok), PORTAL, BEGAN, "x")).not.toBeNull();
  });

  it("records the moment that was typed, even after the opening minute", () => {
    const late = new Date(2026, 10, 5, 22, 56, 15, 700);
    const plan = planPortalEntry(NOTE, parseEntries(NOTE), PORTAL, late, "held too long");
    if (plan === null) throw new Error("expected a plan");

    const next = applied(NOTE, plan);
    const entry = parseEntries(next).entries.find((candidate) => candidate.n === 2);
    expect(entry?.time).toBe(formatClock(late));
    expect(entry?.day).toBe(dayKey(late));

    const records = readAlignments(next);
    if (!records.ok) throw new Error(records.error);
    expectInstant(records.records[0]?.began, late.getTime());
    expectInstant(records.records[0]?.opened, OPENED.getTime());
  });

  it("keeps the opening's frozen local facts after a timezone change", () => {
    // A portal announced at 22:55-08:00. Whatever timezone the machine is in
    // when the text is typed, the record must still name 22:55, not the local
    // rendering of the same epoch.
    const opensAt = Date.UTC(2026, 10, 6, 6, 55, 0);
    const machineOffset = -new Date(opensAt).getTimezoneOffset();
    // A zone the machine is not in, so the frozen facts and a live rendering of
    // the same epoch cannot coincide.
    const offsetMinutes = machineOffset === 540 ? -480 : 540;
    const wall = new Date(opensAt + offsetMinutes * 60_000);
    const pad = (value: number) => String(value).padStart(2, "0");
    const day = `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}`;
    const hour = wall.getUTCHours();
    const minute = wall.getUTCMinutes();
    const portal: PortalInstant = {
      id: new Date(opensAt).toISOString(),
      opensAt,
      day,
      hour,
      minute,
      offsetMinutes
    };

    const began = new Date(2026, 10, 5, 23, 0, 7, 100);
    const plan = planPortalEntry(NOTE, parseEntries(NOTE), portal, began, "arrived late");
    if (plan === null) throw new Error("expected a plan");

    const records = readAlignments(applied(NOTE, plan));
    if (!records.ok) throw new Error(records.error);
    const opened = records.records[0]?.opened ?? "";
    const expectedOffset = `${offsetMinutes < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
    expect(opened).toBe(`${day}T${pad(hour)}:${pad(minute)}:00${expectedOffset}`);

    // Same instant as the portal, and still the announced local minute.
    expect(Date.parse(opened)).toBe(opensAt);

    // The beginning is the machine's own local wall clock, not the portal's.
    expectInstant(records.records[0]?.began, began.getTime());
  });

  it("keeps multi-line first text as prose above the clock row", () => {
    const plan = planPortalEntry(NOTE, parseEntries(NOTE), PORTAL, BEGAN, "first line\nsecond line");
    if (plan === null) throw new Error("expected a plan");

    const next = applied(NOTE, plan);
    const entry = parseEntries(next).entries.find((candidate) => candidate.n === 2);
    expect(entry?.proseLines).toHaveLength(2);
    expect(entry?.title).toBe("first line");
    expect(next).toContain("first line\nsecond line");
    expect(next.slice(0, plan.selection.from).endsWith("second line")).toBe(true);
  });

  it("refuses first text that would turn the block into something else", () => {
    const refused = [
      // Leaves a fence open, so the generated row would sit inside code.
      "```\nsaw this",
      // Writes another marker, so the allocated entry ends above its own row.
      "saw this\n{ 9.1.9 }\nand this",
      // Ends the prose with a clock row, which the parser would take as the row.
      "saw this\n- 00:00:00 2026-01-02 03:04:05"
    ];

    for (const text of refused) {
      expect(planPortalEntry(NOTE, parseEntries(NOTE), PORTAL, BEGAN, text)).toBeNull();

      // No plan, so no partial capture: the day's history is still empty.
      const records = readAlignments(NOTE);
      if (!records.ok) throw new Error(records.error);
      expect(records.records).toHaveLength(0);
    }
  });

  it("refuses text whose clock row reads exactly like the planned one", () => {
    // The first clock-shaped line in the block wins, so a copy of the generated
    // row typed as prose would label the entry in place of the planned row.
    const forged = `saw this\n- 00:00:00 ${dayKey(BEGAN)} ${formatClock(BEGAN)}`;
    expect(planPortalEntry(NOTE, parseEntries(NOTE), PORTAL, BEGAN, forged)).toBeNull();
  });

  it("keeps a balanced code fence as the entry's prose", () => {
    const text = "```\nconst ticket = 11;\n```";
    const plan = planPortalEntry(NOTE, parseEntries(NOTE), PORTAL, BEGAN, text);
    if (plan === null) throw new Error("expected a plan");

    const next = applied(NOTE, plan);
    const entry = parseEntries(next).entries.find((candidate) => candidate.n === 2);
    expect(entry?.proseLines).toHaveLength(3);
    expect(entry?.title).toBe("```");
    expect(entry?.day).toBe(dayKey(BEGAN));
    expect(entry?.time).toBe(formatClock(BEGAN));

    // The fence is text; the row that labels the entry is still the generated
    // one, below the closed fence, with the same clock and the same record.
    expect(next.endsWith(`${text}\n- 00:00:00 ${dayKey(BEGAN)} ${formatClock(BEGAN)}\n`)).toBe(true);

    const records = readAlignments(next);
    if (!records.ok) throw new Error(records.error);
    expect(records.records).toHaveLength(1);
    expect(records.records[0]?.entry).toBe(2);
    expectInstant(records.records[0]?.began, BEGAN.getTime());
  });

  it("accepts ordinary multi-paragraph text, spacing and all", () => {
    for (const text of ["first paragraph\n\nsecond paragraph", "breathe\n", "\nsteady"]) {
      const plan = planPortalEntry(NOTE, parseEntries(NOTE), PORTAL, BEGAN, text);
      if (plan === null) throw new Error(`expected a plan for ${JSON.stringify(text)}`);

      const next = applied(NOTE, plan);
      expect(
        next.endsWith(`\n\n{ 2.1.2 }\n\n${text}\n- 00:00:00 ${dayKey(BEGAN)} ${formatClock(BEGAN)}\n`)
      ).toBe(true);
      expect(parseEntries(next).entries.find((candidate) => candidate.n === 2)?.title).toBe(
        text.split("\n").find((line) => line.trim() !== "")?.trim()
      );
    }
  });
});

describe("portal history through a delete", () => {
  const OPENED = new Date(2026, 10, 5, 22, 55, 0);
  const BEGAN = new Date(2026, 10, 5, 22, 55, 22, 0);

  /** A note whose newest entry, `{ 3.1.3 }`, is a captured portal. */
  function capturedNote(): string {
    const base = [
      "---",
      "travels: 1",
      "---",
      "{ 1.1.1 }",
      "first",
      "+ 00:01:00 10:00:00"
    ].join("\n");

    const ordinary = planStartEntry(base, parseEntries(base));
    if (ordinary === null) throw new Error("expected a plan");
    const withOrdinary = applied(base, ordinary);

    const portal = planPortalEntry(
      withOrdinary,
      parseEntries(withOrdinary),
      portalAt(OPENED.getTime()),
      BEGAN,
      "through the door"
    );
    if (portal === null) throw new Error("expected a plan");
    return applied(withOrdinary, portal);
  }

  it("nulls the deleted entry's association and keeps the event", () => {
    const source = capturedNote();
    const index = parseEntries(source);
    const entry = index.entries.find((candidate) => candidate.n === 3);
    if (entry === undefined) throw new Error("expected the portal entry");

    const before = readAlignments(source);
    if (!before.ok) throw new Error(before.error);
    expect(before.records[0]?.entry).toBe(3);

    const plan = planDeleteEntry(source, index, entry);
    if (plan === null) throw new Error("expected a plan");

    const next = applied(source, plan);
    expect(next).not.toContain("through the door");

    const after = readAlignments(next);
    if (!after.ok) throw new Error(after.error);
    expect(after.records).toHaveLength(1);
    expect(after.records[0]?.entry).toBeNull();
    expect(after.records[0]?.portal).toBe(before.records[0]?.portal);
    expect(after.records[0]?.opened).toBe(before.records[0]?.opened);
    expect(after.records[0]?.began).toBe(before.records[0]?.began);
    expect(plan.changes).toHaveLength(2);
  });

  it("reusing the freed number never links the old event to a new entry", () => {
    const source = capturedNote();
    const index = parseEntries(source);
    const entry = index.entries.find((candidate) => candidate.n === 3);
    if (entry === undefined) throw new Error("expected the portal entry");

    const plan = planDeleteEntry(source, index, entry);
    if (plan === null) throw new Error("expected a plan");
    const afterDelete = applied(source, plan);

    // `N` is one past the largest remaining number, so the deleted 3 comes back.
    const restarted = planStartEntry(afterDelete, parseEntries(afterDelete));
    if (restarted === null) throw new Error("expected a plan");
    const next = applied(afterDelete, restarted);

    const written = parseEntries(next).entries.find((candidate) => candidate.n === 3);
    expect(written).toBeDefined();

    const records = readAlignments(next);
    if (!records.ok) throw new Error(records.error);
    expect(records.records[0]?.entry).toBeNull();
  });

  it("refuses to delete an entry when the day's history cannot be read", () => {
    const malformed = [
      "---",
      "weaver-alignments:",
      "  - {oops}",
      "---",
      "{ 1.1.1 }",
      "prose",
      "- 00:00:00"
    ].join("\n");
    const index = parseEntries(malformed);
    const entry = index.entries[0];
    if (entry === undefined) throw new Error("expected an entry");

    // Removing the text while leaving unreadable history behind would be a
    // half-write of the day: the whole delete is refused instead.
    expect(planDeleteEntry(malformed, index, entry)).toBeNull();
  });

  it("takes the associations of a whole subtree and spares the survivors", () => {
    const rows = [2, 3].map(
      (entry) =>
        `  - {"portal":"2026-11-06T06:55:00.000Z","opened":"2026-11-05T22:55:00-08:00","began":"2026-11-05T22:55:22-08:00","entry":${entry}}`
    );
    const source = [
      "---",
      "travels: 2",
      "weaver-alignments:",
      ...rows,
      "---",
      "{ 1.1.1 }",
      "root",
      "+ 00:01:00 10:00:00",
      "{ 1.2.2 }",
      "child",
      "+ 00:00:30 10:01:00",
      "{ 2.1.3 }",
      "sibling",
      "+ 00:00:20 10:02:00",
      ""
    ].join("\n");

    const index = parseEntries(source);
    const root = index.entries.find((candidate) => candidate.n === 1);
    if (root === undefined) throw new Error("expected the root");

    const plan = planDeleteEntry(source, index, root);
    if (plan === null) throw new Error("expected a plan");
    const next = applied(source, plan);

    // The child went with its root; the sibling kept its own association.
    expect(next).not.toContain("child");
    expect(next).toContain("sibling");

    const records = readAlignments(next);
    if (!records.ok) throw new Error(records.error);
    expect(records.records.map((entry) => entry.entry)).toEqual([null, 3]);
    expect(records.records.map((entry) => entry.began)).toEqual([
      "2026-11-05T22:55:22-08:00",
      "2026-11-05T22:55:22-08:00"
    ]);
  });
});

describe("portal plans through real CodeMirror history", () => {
  const OPENED = new Date(2026, 10, 5, 22, 55, 0);
  const BEGAN = new Date(2026, 10, 5, 22, 55, 0, 400);
  const SOURCE = [
    "---",
    "travels: 1",
    "---",
    "{ 1.1.1 }",
    "first",
    "+ 00:01:00 10:00:00"
  ].join("\n");

  it("undoes the entry and its record together, then redoes both", () => {
    const plan = planPortalEntry(SOURCE, parseEntries(SOURCE), portalAt(OPENED.getTime()), BEGAN, "entered");
    if (plan === null) throw new Error("expected a plan");
    const written = applied(SOURCE, plan);

    const view = historyView(SOURCE);
    view.dispatch({ changes: cmChanges(plan.changes), selection: { anchor: plan.selection.from } });
    expect(view.state.doc.toString()).toBe(written);
    expect(view.state.selection.main.head).toBe(plan.selection.from);

    expect(undo({ state: view.state, dispatch: (transaction) => view.dispatch(transaction) })).toBe(true);
    expect(view.state.doc.toString()).toBe(SOURCE);
    expect(readAlignments(SOURCE).ok).toBe(true);

    expect(redo({ state: view.state, dispatch: (transaction) => view.dispatch(transaction) })).toBe(true);
    expect(view.state.doc.toString()).toBe(written);
    const records = readAlignments(view.state.doc.toString());
    if (!records.ok) throw new Error(records.error);
    expect(records.records[0]?.entry).toBe(2);
  });

  it("restores a deleted portal entry's association with one undo", () => {
    const plan = planPortalEntry(SOURCE, parseEntries(SOURCE), portalAt(OPENED.getTime()), BEGAN, "entered");
    if (plan === null) throw new Error("expected a plan");
    const captured = applied(SOURCE, plan);

    const index = parseEntries(captured);
    const entry = index.entries.find((candidate) => candidate.n === 2);
    if (entry === undefined) throw new Error("expected the portal entry");
    const deletion = planDeleteEntry(captured, index, entry);
    if (deletion === null) throw new Error("expected a plan");
    const deleted = applied(captured, deletion);

    const view = historyView(captured);
    view.dispatch({ changes: cmChanges(deletion.changes), selection: { anchor: deletion.selection.from } });
    expect(view.state.doc.toString()).toBe(deleted);

    expect(undo({ state: view.state, dispatch: (transaction) => view.dispatch(transaction) })).toBe(true);
    expect(view.state.doc.toString()).toBe(captured);

    const restored = readAlignments(view.state.doc.toString());
    if (!restored.ok) throw new Error(restored.error);
    expect(restored.records[0]?.entry).toBe(2);
    expect(parseEntries(view.state.doc.toString()).entries.map((candidate) => candidate.n)).toEqual([1, 2]);
  });
});
