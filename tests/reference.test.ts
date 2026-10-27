import { describe, expect, it } from "vitest";

import {
  basenameOfPath,
  collectBlockIds,
  linkTargetOf,
  newBlockId,
  planReference,
  referenceText,
  shortLabel,
  trailingBlockId,
  type Reference
} from "../src/core/reference";
import { applyPlanToSource } from "../src/core/insert";

const DIMENSION: Reference = {
  kind: "dimension",
  path: "Entries/Entry.md",
  basename: "Entry",
  headingText: "01:39 - Living in the Moment",
  headingTime: "01:39",
  headingTitle: "Living in the Moment",
  label: "Living in the Moment"
};

const WORDS: Reference = {
  kind: "words",
  path: "Entries/Entry.md",
  basename: "Entry",
  blockId: "abc123",
  label: "a passage worth keeping"
};

const NOTE: Reference = {
  kind: "note",
  path: "Entries/Entry.md",
  basename: "Entry",
  label: "Entry"
};

describe("shortLabel", () => {
  it("keeps five words and collapses whitespace", () => {
    expect(shortLabel("one   two\nthree four five six")).toBe("one two three four five");
  });

  it("stops at a readable width with an ellipsis", () => {
    const label = shortLabel("a".repeat(120));
    expect(label.length).toBeLessThanOrEqual(60);
    expect(label.endsWith("…")).toBe(true);
  });

  it("returns nothing for an empty passage", () => {
    expect(shortLabel("   \n ")).toBe("");
  });
});

describe("block ids", () => {
  it("mints six characters from a-z0-9 and avoids what is taken", () => {
    const taken = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const id = newBlockId(taken);
      expect(id).toMatch(/^[a-z0-9]{6}$/);
      taken.add(id);
    }
  });

  it("reads the ids a note already holds", () => {
    const ids = collectBlockIds("one ^abc123\ntwo ^zzz999\nthree");
    expect([...ids].sort()).toEqual(["abc123", "zzz999"]);
  });

  it("sees only a trailing id on a line", () => {
    expect(trailingBlockId("a line ^abc123")).toBe("abc123");
    expect(trailingBlockId("a line ^abc123 and more")).toBeNull();
    expect(trailingBlockId("no id here")).toBeNull();
  });
});

describe("referenceText", () => {
  it("writes the three forms", () => {
    expect(referenceText(DIMENSION)).toBe("[[Entry#01:39 - Living in the Moment|01:39 Living in the Moment]]");
    expect(referenceText(WORDS)).toBe("[[Entry#^abc123|a passage worth keeping]]");
    expect(referenceText(NOTE)).toBe("[[Entry]]");
  });

  it("adds an alias to a note only when the label says something new", () => {
    expect(referenceText({ ...NOTE, label: "the entry about breaking free" })).toBe(
      "[[Entry|the entry about breaking free]]"
    );
  });

  it("degrades to the plain note form when a words reference has no id", () => {
    expect(referenceText({ ...WORDS, blockId: undefined })).toBe("[[Entry]]");
  });

  it("names what a spark should link to, deriving the basename from the path", () => {
    expect(linkTargetOf({ kind: "note", path: "Entries/Entry.md" })).toBe("Entry");
    expect(
      linkTargetOf({ kind: "dimension", path: "Entries/Entry.md", headingText: "01:39 - x" })
    ).toBe("Entry#01:39 - x");
    expect(linkTargetOf({ kind: "words", path: "Entries/Entry.md", blockId: "abc123" })).toBe(
      "Entry#^abc123"
    );
    expect(basenameOfPath("Chronomancer/2026.10.27.md")).toBe("2026.10.27");
  });
});

describe("planReference", () => {
  it("inserts the link with a leading space after a word", () => {
    const source = "text here and";
    const plan = planReference(source, WORDS, source.length, source.length);
    const applied = applyPlanToSource(source, plan);

    expect(applied.source).toBe("text here and [[Entry#^abc123|a passage worth keeping]]");
    expect(applied.selection.from).toBe(applied.source.length);
  });

  it("does not double a space that is already there", () => {
    const source = "text here ";
    const plan = planReference(source, NOTE, source.length, source.length);
    expect(applyPlanToSource(source, plan).source).toBe("text here [[Entry]]");
  });

  it("replaces a selection instead of appending to it", () => {
    const source = "keep replace me";
    const plan = planReference(source, NOTE, 5, 15);
    expect(applyPlanToSource(source, plan).source).toBe("keep [[Entry]]");
  });
});
