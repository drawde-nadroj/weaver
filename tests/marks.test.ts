import { describe, expect, it } from "vitest";

import { closeLine, parseCloseLine, parseMarks, parseSourceLine, sparkLine } from "../src/core/marks";

describe("parseSourceLine", () => {
  it("reads a linked source and its alias", () => {
    expect(parseSourceLine("✦ [[2026.10.26 - Note#^abc123|Living in the moment]]")).toEqual({
      target: "2026.10.26 - Note#^abc123",
      label: "Living in the moment",
      note: ""
    });
  });

  it("reads a link without an alias", () => {
    expect(parseSourceLine("✦ [[Note]]")).toEqual({
      target: "Note",
      label: null,
      note: ""
    });
  });

  it("keeps the reason after a separator", () => {
    expect(parseSourceLine("✦ [[Note]] - because of the orange")).toEqual({
      target: "Note",
      label: null,
      note: "because of the orange"
    });
  });

  it("reads a bare spark, which still counts as a spark", () => {
    expect(parseSourceLine("✦")).toEqual({ target: null, label: null, note: "" });
    expect(parseSourceLine("  ✦  ")).toEqual({ target: null, label: null, note: "" });
  });

  it("is not fooled by prose or a stray glyph", () => {
    expect(parseSourceLine("we spark things")).toBeNull();
    expect(parseSourceLine("- ✦ an indented bullet")).toBeNull();
    expect(parseSourceLine("")).toBeNull();
  });
});

describe("parseCloseLine", () => {
  it("accepts the note's two clock formats", () => {
    expect(parseCloseLine("✓ 23:41")).toBe("23:41");
    expect(parseCloseLine("✓ 23:41:07")).toBe("23:41:07");
  });

  it("rejects anything that is not a bare closing mark", () => {
    expect(parseCloseLine("✓ 23:41 with words")).toBeNull();
    expect(parseCloseLine("done ✓ 23:41")).toBeNull();
    expect(parseCloseLine("✓")).toBeNull();
  });
});

describe("parseMarks", () => {
  it("finds sources and the close mark in a day note", () => {
    const source = [
      "# 09:12:01 - first",
      "✦ [[Note#^abc123|first]]",
      "body",
      "# 10:02:00 - second",
      "✦",
      "✓ 21:29"
    ].join("\n");

    const marks = parseMarks(source);
    expect(marks.sources).toHaveLength(2);
    expect(marks.sources[0]?.line).toBe(1);
    expect(marks.sources[1]?.target).toBeNull();
    expect(marks.closedAt).toBe("21:29");
    // Offsets point at the line, so a caller can rewrite it in place.
    expect(source.slice(marks.sources[0]?.from ?? 0, marks.sources[0]?.to ?? 0)).toBe(
      "✦ [[Note#^abc123|first]]"
    );
  });

  it("keeps the last close when a note carries two", () => {
    expect(parseMarks("✓ 09:00\n\ntext\n\n✓ 23:41").closedAt).toBe("23:41");
  });

  it("ignores frontmatter, fenced code and draft bodies", () => {
    const source = [
      "---",
      "sources: 9",
      "---",
      "```",
      "✦ [[Not a mark]]",
      "✓ 09:00",
      "```",
      "⟪draft 2.1 2026-10-26 16:37:04⟫",
      "✦ [[Draft body]]",
      "⟪/draft 2.1⟫",
      "✦ [[Real]]"
    ].join("\n");

    const marks = parseMarks(source);
    expect(marks.sources.map((mark) => mark.target)).toEqual(["Real"]);
    expect(marks.closedAt).toBeNull();
  });

  it("writes the record formats it reads", () => {
    expect(sparkLine("Note#^abc123", "alias")).toBe("✦ [[Note#^abc123|alias]]");
    expect(closeLine("23:41")).toBe("✓ 23:41");
    expect(parseSourceLine(sparkLine("Note", "alias"))?.target).toBe("Note");
    expect(parseCloseLine(closeLine("23:41:07"))).toBe("23:41:07");
  });
});
