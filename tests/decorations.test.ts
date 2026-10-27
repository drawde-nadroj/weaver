import { describe, expect, it } from "vitest";

import { DEEP_MIN_LEVEL, deepHashHideSpecs, lineClassSpecs } from "../src/core/decorations";
import { parseHeadings, type HeadingIndex } from "../src/core/headings";

const SOURCE = "# 09:00 - a\nbody\n####### 09:01 - deep\n## 09:02 - b";

function index(source = SOURCE): HeadingIndex {
  return parseHeadings(source, { maxDepth: 12 });
}

const ALL = [{ from: 0, to: 10_000 }];

describe("lineClassSpecs", () => {
  it("marks every heading with its level classes", () => {
    const specs = lineClassSpecs(index());
    expect(specs).toHaveLength(3);
    expect(specs[0]).toEqual({ from: 0, classes: ["weaver-dimension-line", "weaver-h1"] });
    expect(specs.find((spec) => spec.classes.includes("weaver-h2"))?.classes).toEqual([
      "weaver-dimension-line",
      "weaver-h2"
    ]);
  });

  it("marks deep headings as deep", () => {
    const deep = lineClassSpecs(index()).find((spec) => spec.classes.includes("weaver-h7"));
    expect(deep?.classes).toEqual(["weaver-dimension-line", "weaver-h7", "weaver-deep"]);
  });

  it("respects a custom deep threshold", () => {
    const specs = lineClassSpecs(index("# a\n## b\n### c"), 3);
    expect(specs[2]?.classes).toContain("weaver-deep");
    expect(specs[1]?.classes).not.toContain("weaver-deep");
    expect(DEEP_MIN_LEVEL).toBe(7);
  });

  it("returns nothing for a note without headings", () => {
    expect(lineClassSpecs(index("just text"))).toEqual([]);
  });
});

describe("deepHashHideSpecs", () => {
  const base = {
    index: index(),
    selection: { from: 0, to: 0 },
    visible: ALL,
    livePreview: true,
    enabled: true
  };

  it("hides only deep hash runs", () => {
    const specs = deepHashHideSpecs(base);
    expect(specs).toHaveLength(1);
    const deep = index().headings.find((heading) => heading.level === 7);
    expect(deep).toBeDefined();
    expect(specs[0]).toEqual({ from: deep?.hashFrom, to: deep?.hashTo });
  });

  it("keeps hashes while the cursor is on the heading line", () => {
    const heading = index().headings.find((candidate) => candidate.level === 7);
    const onLine = deepHashHideSpecs({
      ...base,
      selection: { from: heading?.from ?? 0, to: heading?.from ?? 0 }
    });
    expect(onLine).toEqual([]);

    const inTitle = deepHashHideSpecs({
      ...base,
      selection: { from: (heading?.from ?? 0) + 4, to: (heading?.from ?? 0) + 4 }
    });
    expect(inTitle).toEqual([]);
  });

  it("hides hashes when the cursor is on a neighbouring line", () => {
    const heading = index().headings.find((candidate) => candidate.level === 7);
    const after = deepHashHideSpecs({
      ...base,
      selection: { from: (heading?.to ?? 0) + 2, to: (heading?.to ?? 0) + 2 }
    });
    expect(after).toHaveLength(1);
  });

  it("skips headings outside the viewport", () => {
    expect(deepHashHideSpecs({ ...base, visible: [{ from: 0, to: 5 }] })).toEqual([]);
  });

  it("does nothing in Source mode or when disabled", () => {
    expect(deepHashHideSpecs({ ...base, livePreview: false })).toEqual([]);
    expect(deepHashHideSpecs({ ...base, enabled: false })).toEqual([]);
  });

  it("never hides when the note has no deep headings", () => {
    expect(deepHashHideSpecs({ ...base, index: index("# a\n## b") })).toEqual([]);
  });

  it("handles a cursor selection spanning the heading", () => {
    const heading = index().headings.find((candidate) => candidate.level === 7);
    const spanning = deepHashHideSpecs({
      ...base,
      selection: { from: (heading?.from ?? 0) - 2, to: (heading?.to ?? 0) + 2 }
    });
    expect(spanning).toEqual([]);
  });
});
