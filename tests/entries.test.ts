import { describe, expect, it } from "vitest";

import {
  childrenOf,
  entryBySeq,
  findCurrentEntry,
  findEntryAtLine,
  findEntryAtOffset,
  formatMarker,
  nextSeq,
  nextBranch,
  parseEntries,
  repairBranches
} from "../src/core/entries";

const SINGLE = ["{ 2.1.3 }", "the title line", "+ 00:04:12 13:27:43"].join("\n");

describe("parseEntries", () => {
  it("reads the marker's three numbers and its clocks", () => {
    const index = parseEntries(SINGLE);
    const entry = index.entries[0];

    expect(entry?.d).toBe(1);
    expect(entry?.b).toBe(2);
    expect(entry?.n).toBe(3);
    expect(entry?.time).toBe("13:27:43");
    expect(entry?.state).toBe("settled");
    expect(entry?.duration).toEqual({ sigil: "+", ms: 252_000 });
    expect(entry?.clockLine).toBe(2);
  });

  it("accepts a bare marker and a two-field moment", () => {
    const entry = parseEntries("{2.1.3}\n9:14").entries[0];

    expect(entry?.time).toBe("09:14:00");
    expect(entry?.markerEnd).toBe("{2.1.3}".length);
    expect(entry?.duration).toBeNull();
  });

  it("turns a title written after the marker into the first prose line", () => {
    const source = "{ 1.2.4 } spoke about the breath\nand then more";
    const entry = parseEntries(source).entries[0];

    expect(entry?.title).toBe("spoke about the breath");
    expect(source.slice(entry?.proseFrom)).toBe("spoke about the breath\nand then more");
    expect(entry?.firstProseLine).toBe(0);
  });

  it("ignores a marker inside frontmatter or a fenced code block", () => {
    const source = [
      "---",
      "{ 9.9.9 }",
      "---",
      "```",
      "{ 8.8.8 }",
      "```",
      "{ 1.1.1 }",
      "12:00:00"
    ].join("\n");

    const index = parseEntries(source);
    expect(index.entries.length).toBe(1);
    expect(index.entries[0]?.n).toBe(1);
  });

  it("reads the sigil as the entry's state", () => {
    const states = ["- 00:00:10", "+ 00:00:10", "= 00:00:10", null].map((clock) => {
      const lines = ["{ 1.1.1 }", "prose"];
      if (clock !== null) lines.push(clock);
      return parseEntries(lines.join("\n")).entries[0];
    });

    // `+` alone is settled: `-` is being written and `=` is paused, and both are
    // open. An entry with no clock row has no duration to settle, so it is
    // settled too.
    expect(states[0]?.state).toBe("draft");
    expect(states[1]?.state).toBe("settled");
    expect(states[2]?.state).toBe("draft");
    expect(states[3]?.state).toBe("settled");
    expect(states[2]?.duration?.ms).toBe(10_000);
    expect(states[3]?.duration).toBeNull();
    expect(states[3]?.clockLine).toBeNull();
  });

  it("gives a parent the whole subtree as its block", () => {
    const source = [
      "{ 1.1.1 }",
      "root",
      "+ 00:00:00",
      "{ 1.2.2 }",
      "child",
      "+ 00:00:00",
      "{ 1.3.3 }",
      "grandchild",
      "+ 00:00:00",
      "{ 2.2.4 }",
      "sibling",
      "+ 00:00:00",
      "{ 2.1.5 }"
    ].join("\n");

    const index = parseEntries(source);
    expect(index.entries.map((entry) => entry.parent)).toEqual([null, 0, 1, 0, null]);
    // A block ends on the line before the next entry that is not deeper.
    expect(index.entries[0]?.blockEnd).toBe(11);
    expect(index.entries[1]?.blockEnd).toBe(8);
    expect(index.maxD).toBe(3);
    expect(index.maxN).toBe(5);
  });

  it("addresses entries by line, offset and sequence", () => {
    const source = ["{ 1.1.1 }", "first", "", "{ 2.1.2 }", "second"].join("\n");
    const index = parseEntries(source);

    expect(findEntryAtLine(index, 0)?.n).toBe(1);
    expect(findEntryAtLine(index, 1)).toBeNull();
    expect(findCurrentEntry(index, 2)?.n).toBe(1);
    expect(findEntryAtOffset(index, 0)?.n).toBe(1);
    expect(findEntryAtOffset(index, source.indexOf("second"))?.n).toBe(2);
    expect(entryBySeq(index, 2)?.title).toBe("second");
  });

  it("counts children and the next branch", () => {
    const source = ["{ 1.1.1 }", "{ 1.2.2 }", "{ 2.2.3 }"].join("\n");
    const index = parseEntries(source);
    const root = index.entries[0] ?? null;

    expect(childrenOf(index, root).length).toBe(2);
    expect(nextBranch(index)).toBe(2);
    expect(nextSeq(index)).toBe(4);
  });

  it("formats a marker with one space inside each brace", () => {
    expect(formatMarker(2, 1, 3)).toBe("{ 2.1.3 }");
  });

  it("gives every entry in a branch its branch id", () => {
    // Crooked on purpose: the markers agree on nothing, and the branch is read
    // from the tree, never from the digits.
    const source = [
      "{ 5.2.1 }",
      "root",
      "+ 00:00:00",
      "{ 9.3.2 }",
      "child",
      "+ 00:00:00",
      "{ 7.4.3 }",
      "grandchild",
      "+ 00:00:00",
      "{ 2.3.4 }",
      "second child",
      "+ 00:00:00",
      "{ 9.1.5 }",
      "second root",
      "+ 00:00:00"
    ].join("\n");

    const index = parseEntries(source);
    expect(index.entries.map((entry) => entry.branch)).toEqual([1, 1, 1, 1, 2]);
    // The file's own `B` values are reported as they are, not repaired.
    expect(index.entries.map((entry) => entry.b)).toEqual([5, 9, 7, 2, 9]);

    // Repairing rewrites every drifted `B` onto its branch's id.
    const changes = repairBranches(index);
    expect(changes.map((change) => change.text)).toEqual(["1", "1", "1", "1", "2"]);

    const next = changes.reduce(
      (text, change) => text.slice(0, change.from) + change.text + text.slice(change.to),
      source
    );
    expect(next.split("\n")[0]).toBe("{ 1.2.1 }");
    expect(next.split("\n")[3]).toBe("{ 1.3.2 }");
    expect(next.split("\n")[6]).toBe("{ 1.4.3 }");
    expect(next.split("\n")[9]).toBe("{ 1.3.4 }");
    expect(next.split("\n")[12]).toBe("{ 2.1.5 }");
  });

  it("rewrites nothing when every branch already carries its branch id", () => {
    const source = [
      "{ 1.1.1 }",
      "first",
      "{ 1.2.2 }",
      "child",
      "{ 2.1.3 }",
      "second"
    ].join("\n");

    expect(repairBranches(parseEntries(source))).toEqual([]);
  });

  it("reports an unclosed frontmatter instead of guessing", () => {
    const index = parseEntries("---\ndate: 2026-10-26\n{ 1.1.1 }");
    expect(index.unclosedFrontmatter).toBe(true);
    expect(index.entries.length).toBe(0);
  });

  it("reports a note that still carries the old marker, before it is misread", () => {
    const index = parseEntries("{ 1.1.1 } - 10:00:00\nprose\n+ 00:00:00");
    expect(index.legacyFormat).toBe(true);
  });
});
