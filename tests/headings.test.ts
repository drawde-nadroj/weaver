import { describe, expect, it } from "vitest";

import {
  buildAncestors,
  findCurrentHeading,
  findHeadingAtLine,
  findSectionEndLine,
  maxHeadingLevel,
  parseHeadingLine,
  parseHeadings,
  type HeadingIndex
} from "../src/core/headings";

function parse(source: string, maxDepth = 12): HeadingIndex {
  return parseHeadings(source, { maxDepth });
}

function levels(index: HeadingIndex): number[] {
  return index.headings.map((heading) => heading.level);
}

describe("parseHeadings — structure", () => {
  it("indexes plain headings with levels and parents", () => {
    const index = parse("# A\n## B\n### C\n## D");
    expect(levels(index)).toEqual([1, 2, 3, 2]);
    expect(index.headings.map((heading) => heading.title)).toEqual(["A", "B", "C", "D"]);
    expect(index.headings[0]?.parent).toBeNull();
    expect(index.headings[1]?.parent).toBe(0);
    expect(index.headings[2]?.parent).toBe(1);
    expect(index.headings[3]?.parent).toBe(0);
    expect(index.maxLevel).toBe(3);
    expect(index.unclosedFence).toBe(false);
    expect(index.unclosedFrontmatter).toBe(false);
  });

  it("records absolute offsets for the line and the hash run", () => {
    const index = parse("# A\n  ## B");
    const b = index.headings[1];
    expect(b?.line).toBe(1);
    expect(b?.from).toBe(4);
    expect(b?.to).toBe(10);
    expect(b?.hashFrom).toBe(6);
    expect(b?.hashTo).toBe(8);
  });

  it("accepts up to three leading spaces and ignores four", () => {
    expect(levels(parse("   # three"))).toEqual([1]);
    expect(levels(parse("    # four"))).toEqual([]);
    expect(parse("   # three").headings[0]?.hashFrom).toBe(3);
  });

  it("requires a separator after the hash run", () => {
    expect(levels(parse("#notaheading"))).toEqual([]);
    expect(levels(parse("##no"))).toEqual([]);
    expect(levels(parse("#"))).toEqual([1]);
    expect(levels(parse("###"))).toEqual([3]);
    expect(parse("###").headings[0]?.text).toBe("");
    expect(parse("#").headings[0]?.text).toBe("");
  });

  it("right-trims heading text and keeps inner markers", () => {
    expect(parse("# Title   ").headings[0]?.text).toBe("Title");
    expect(parse("## ## inner").headings[0]?.text).toBe("## inner");
  });

  it("parses levels 1, 6, 7 and 12", () => {
    const index = parse("# a\n###### f\n####### g\n############ l");
    expect(levels(index)).toEqual([1, 6, 7, 12]);
    expect(index.maxLevel).toBe(12);
  });

  it("treats levels above maxDepth as text", () => {
    expect(levels(parse("####### g", 6))).toEqual([]);
    expect(levels(parse("# a\n####### g", 6))).toEqual([1]);
    expect(levels(parse("####### g", 7))).toEqual([7]);
  });

  it("does not index setext headings", () => {
    const index = parse("Title\n=====\n\nOther\n-----");
    expect(index.headings).toEqual([]);
  });

  it("handles an empty document", () => {
    const index = parse("");
    expect(index.headings).toEqual([]);
    expect(index.maxLevel).toBe(0);
    expect(index.codeFences).toEqual([]);
  });
});

describe("parseHeadings — timestamps", () => {
  it("splits a time from a separated title", () => {
    const heading = parse("## 16:37 - Bhartrhari").headings[0];
    expect(heading?.time).toBe("16:37");
    expect(heading?.title).toBe("Bhartrhari");
    expect(heading?.text).toBe("16:37 - Bhartrhari");
  });

  it("yields an empty title for a bare time", () => {
    const heading = parse("# 16:37:04").headings[0];
    expect(heading?.time).toBe("16:37:04");
    expect(heading?.title).toBe("");
  });

  it("keeps a title with no separator verbatim", () => {
    const heading = parse("## 16:37 Bhartrhari").headings[0];
    expect(heading?.time).toBe("16:37");
    expect(heading?.title).toBe(" Bhartrhari");
  });

  it("treats a heading without a clock as pure title", () => {
    const heading = parse("## Bhartrhari").headings[0];
    expect(heading?.time).toBeNull();
    expect(heading?.title).toBe("Bhartrhari");
  });
});

describe("parseHeadings — frontmatter", () => {
  it("skips a closed frontmatter block", () => {
    const index = parse("---\ntags: [a]\n# not a heading\n---\n# Real");
    expect(levels(index)).toEqual([1]);
    expect(index.headings[0]?.title).toBe("Real");
    expect(index.unclosedFrontmatter).toBe(false);
    expect(index.frontmatterEnd).toBe(3);
  });

  it("accepts ... as the closing delimiter", () => {
    const index = parse("---\ntags: [a]\n...\n# Real");
    expect(levels(index)).toEqual([1]);
    expect(index.frontmatterEnd).toBe(2);
  });

  it("reports no frontmatter block when the document does not open with one", () => {
    expect(parse("# Real").frontmatterEnd).toBeNull();
    expect(parse("").frontmatterEnd).toBeNull();
  });

  it("reports unclosed frontmatter and indexes nothing", () => {
    const index = parse("---\ntags: [a]\n# not indexed");
    expect(index.unclosedFrontmatter).toBe(true);
    expect(index.headings).toEqual([]);
  });

  it("does not treat a horizontal rule on line 0 as frontmatter when unclosed", () => {
    const index = parse("# Heading\n---\ntext");
    expect(index.unclosedFrontmatter).toBe(false);
    expect(levels(index)).toEqual([1]);
  });
});

describe("parseHeadings — fenced code", () => {
  it("ignores headings inside backtick fences", () => {
    const source = "# A\n```\n# hidden\n```\n## B";
    const index = parse(source);
    expect(levels(index)).toEqual([1, 2]);
    expect(index.codeFences).toEqual([{ start: 1, end: 3, closed: true }]);
    expect(index.unclosedFence).toBe(false);
  });

  it("ignores headings inside tilde fences", () => {
    const index = parse("# A\n~~~js\n# hidden\n~~~\n## B");
    expect(levels(index)).toEqual([1, 2]);
    expect(index.codeFences[0]?.closed).toBe(true);
  });

  it("requires a closing run of the same character and length", () => {
    const index = parse("# A\n````\n# hidden\n```\n# still hidden\n````\n## B");
    expect(levels(index)).toEqual([1, 2]);
    expect(index.codeFences).toEqual([{ start: 1, end: 5, closed: true }]);
  });

  it("reports an unclosed fence and keeps it open to EOF", () => {
    const index = parse("# A\n```\n# hidden\nmore");
    expect(levels(index)).toEqual([1]);
    expect(index.unclosedFence).toBe(true);
    expect(index.codeFences).toEqual([{ start: 1, end: 3, closed: false }]);
  });

  it("does not treat a fence inside frontmatter as a code fence", () => {
    const index = parse("---\nx: ```\n---\n# A");
    expect(levels(index)).toEqual([1]);
    expect(index.codeFences).toEqual([]);
  });
});

describe("lookups", () => {
  const index = parse("# A\n## B\n### C\n## D");

  it("finds a heading on the exact line only", () => {
    expect(findHeadingAtLine(index, 1)?.title).toBe("B");
    expect(findHeadingAtLine(index, 2)?.title).toBe("C");
    expect(findHeadingAtLine(index, 4)).toBeNull();
    expect(findHeadingAtLine(index, 0)?.title).toBe("A");
  });

  it("falls back to the nearest preceding heading", () => {
    expect(findCurrentHeading(index, 0)?.title).toBe("A");
    expect(findCurrentHeading(index, 2)?.title).toBe("C");
    expect(findCurrentHeading(index, 99)?.title).toBe("D");
    expect(findCurrentHeading(parse("body only"), 0)).toBeNull();
  });

  it("returns ancestors root-first", () => {
    const ancestors = buildAncestors(index, index.headings[2] ?? null);
    expect(ancestors.map((heading) => heading.title)).toEqual(["A", "B"]);
    expect(buildAncestors(index, index.headings[0] ?? null)).toEqual([]);
    expect(buildAncestors(index, null)).toEqual([]);
  });
});

describe("findSectionEndLine", () => {
  it("returns the last content line before the next heading of the same or higher level", () => {
    const lines = ["# A", "alpha", "## B", "beta", "", "# C"];
    const index = parseHeadings(lines.join("\n"), { maxDepth: 12 });
    const a = index.headings[0];
    expect(a).toBeDefined();
    expect(findSectionEndLine(lines, index, a)).toBe(3);
  });

  it("walks to the end of a subtree that runs to EOF", () => {
    const lines = ["# A", "## B", "beta"];
    const index = parseHeadings(lines.join("\n"), { maxDepth: 12 });
    expect(findSectionEndLine(lines, index, index.headings[0])).toBe(2);
    expect(findSectionEndLine(lines, index, index.headings[1])).toBe(2);
  });

  it("ignores trailing blank lines", () => {
    const lines = ["# A", "body", "", "", "# B"];
    const index = parseHeadings(lines.join("\n"), { maxDepth: 12 });
    expect(findSectionEndLine(lines, index, index.headings[0])).toBe(1);
  });

  it("returns the heading line itself for an empty section", () => {
    const lines = ["# A", "# B"];
    const index = parseHeadings(lines.join("\n"), { maxDepth: 12 });
    expect(findSectionEndLine(lines, index, index.headings[0])).toBe(0);
  });
});

describe("maxHeadingLevel", () => {
  it("returns the maximum across sources", () => {
    expect(maxHeadingLevel(["# a", "#### d"], 12)).toBe(4);
    expect(maxHeadingLevel(["# a", "######## h"], 12)).toBe(8);
    expect(maxHeadingLevel([], 12)).toBe(0);
    expect(maxHeadingLevel(["no headings"], 12)).toBe(0);
  });

  it("respects maxDepth", () => {
    expect(maxHeadingLevel(["######## h"], 6)).toBe(0);
  });
});

describe("parseHeadingLine", () => {
  it("returns the parsed parts", () => {
    expect(parseHeadingLine("  ## Title  ", 12)).toEqual({
      level: 2,
      text: "Title",
      hashLength: 2,
      leadingSpaces: 2
    });
  });

  it("rejects non-headings and over-deep levels", () => {
    expect(parseHeadingLine("text", 12)).toBeNull();
    expect(parseHeadingLine("#nope", 12)).toBeNull();
    expect(parseHeadingLine("####### deep", 6)).toBeNull();
  });
});
