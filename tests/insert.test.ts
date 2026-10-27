import { describe, expect, it } from "vitest";

import { parseHeadings } from "../src/core/headings";
import {
  applyPlanToSource,
  computeInsertLevel,
  offsetToLineCh,
  formatHeading,
  planSpark,
  planInsertHeading,
  resolveInsertSite,
  type InsertOptions,
  type InsertPlan
} from "../src/core/insert";

const AT_1637 = new Date(2024, 0, 2, 16, 37, 4);
const OPTIONS: InsertOptions = { maxDepth: 12, separator: " - ", format: "HH:mm:ss" };

function run(source: string, plan: InsertPlan | null): string {
  expect(plan).not.toBeNull();
  return applyPlanToSource(source, plan as InsertPlan).source;
}

function insert(
  source: string,
  cursorLine: number,
  options: InsertOptions = OPTIONS,
  title = "Title",
  levelOverride?: number
) {
  const index = parseHeadings(source, { maxDepth: options.maxDepth });
  return planInsertHeading(source, index, cursorLine, AT_1637, options, title, levelOverride);
}

describe("offsetToLineCh", () => {
  const source = "# A\nbody\n\nlast";

  it("converts offsets to line/ch positions", () => {
    expect(offsetToLineCh(source, 0)).toEqual({ line: 0, ch: 0 });
    expect(offsetToLineCh(source, 3)).toEqual({ line: 0, ch: 3 });
    expect(offsetToLineCh(source, 4)).toEqual({ line: 1, ch: 0 });
    expect(offsetToLineCh(source, 9)).toEqual({ line: 2, ch: 0 });
    expect(offsetToLineCh(source, source.length)).toEqual({ line: 3, ch: 4 });
  });

  it("clamps out-of-range offsets", () => {
    expect(offsetToLineCh(source, -5)).toEqual({ line: 0, ch: 0 });
    expect(offsetToLineCh(source, source.length + 50)).toEqual({ line: 3, ch: 4 });
  });

  it("agrees with the applied document", () => {
    const target = "# A\n\nbody";
    const applied = applyPlanToSource(target, insert(target, 1) as InsertPlan);
    const position = offsetToLineCh(applied.source, applied.selection.from);
    expect(position).toEqual({ line: 1, ch: "## 16:37:04 - Title".length });
    expect(applied.source.split("\n")[position.line]?.slice(0, position.ch)).toBe(
      "## 16:37:04 - Title"
    );
  });
});

describe("formatHeading", () => {
  it("joins hashes, time and title", () => {
    expect(formatHeading(3, "16:37:04", "Title", " - ")).toBe("### 16:37:04 - Title");
  });

  it("keeps one trailing space for an empty title", () => {
    expect(formatHeading(2, "16:37", "", " - ")).toBe("## 16:37 ");
  });

  it("honours a custom separator", () => {
    expect(formatHeading(1, "16:37", "Title", " • ")).toBe("# 16:37 • Title");
  });
});

describe("computeInsertLevel", () => {
  it("counts from the parent and caps at maxDepth", () => {
    const index = parseHeadings("# A\n###### F", { maxDepth: 12 });
    expect(computeInsertLevel(null, 12)).toBe(1);
    expect(computeInsertLevel(index.headings[0], 12)).toBe(2);
    expect(computeInsertLevel(index.headings[1], 6)).toBe(6);
  });
});

describe("resolveInsertSite", () => {
  it("replaces a blank cursor line", () => {
    const source = "# A\n\nbody";
    const index = parseHeadings(source, { maxDepth: 12 });
    const site = resolveInsertSite(source, index, 1);
    expect(site).toMatchObject({ from: 4, to: 4, prefix: "", line: 1 });
  });

  it("appends after a body line", () => {
    const source = "# A\nbody";
    const index = parseHeadings(source, { maxDepth: 12 });
    const site = resolveInsertSite(source, index, 1);
    expect(site).toMatchObject({ from: 8, to: 8, prefix: "\n", line: 1 });
  });

  it("uses the section end for a heading line", () => {
    const source = "# A\nbody\n## B\nbeta\n\n# C";
    const index = parseHeadings(source, { maxDepth: 12 });
    expect(resolveInsertSite(source, index, 2)?.line).toBe(3);
    expect(resolveInsertSite(source, index, 0)?.line).toBe(3);
  });

  it("lands after a closed code fence", () => {
    const source = "# A\n```\ncode\n```\ntail";
    const index = parseHeadings(source, { maxDepth: 12 });
    expect(resolveInsertSite(source, index, 2)).toMatchObject({ line: 3, prefix: "\n" });
    expect(resolveInsertSite(source, index, 3)).toMatchObject({ line: 3, prefix: "\n" });
  });

  it("lands after a closed frontmatter block", () => {
    const source = "---\ntitle: x\n---\n# A";
    const index = parseHeadings(source, { maxDepth: 12 });
    expect(resolveInsertSite(source, index, 0)).toMatchObject({ line: 2, prefix: "\n" });
    expect(resolveInsertSite(source, index, 2)).toMatchObject({ line: 2, prefix: "\n" });
  });

  it("refuses an unclosed fence", () => {
    const source = "# A\n```\ncode";
    const index = parseHeadings(source, { maxDepth: 12 });
    expect(index.unclosedFence).toBe(true);
    expect(resolveInsertSite(source, index, 2)).toBeNull();
    expect(resolveInsertSite(source, index, 1)).toBeNull();
  });

  it("refuses unclosed frontmatter", () => {
    const source = "---\ntitle: x";
    const index = parseHeadings(source, { maxDepth: 12 });
    expect(resolveInsertSite(source, index, 1)).toBeNull();
  });
});

describe("planInsertHeading", () => {
  it("adds a child heading after a body line", () => {
    expect(run("# 16:10\nbody text", insert("# 16:10\nbody text", 1))).toBe(
      "# 16:10\nbody text\n## 16:37:04 - Title"
    );
  });

  it("replaces a blank line", () => {
    expect(run("# A\n\nbody text", insert("# A\n\nbody text", 1))).toBe(
      "# A\n## 16:37:04 - Title\nbody text"
    );
  });

  it("inserts at the end of the heading section", () => {
    const source = "# A\nbody\n## B\nbeta\n\n# C";
    expect(run(source, insert(source, 2))).toBe(
      "# A\nbody\n## B\nbeta\n### 16:37:04 - Title\n\n# C"
    );
  });

  it("starts at H1 when there is no parent", () => {
    expect(run("body only", insert("body only", 0))).toBe("body only\n# 16:37:04 - Title");
  });

  it("caps the level at maxDepth", () => {
    const options: InsertOptions = { ...OPTIONS, maxDepth: 6 };
    const source = "# a\n###### f\nbody";
    expect(run(source, insert(source, 2, options))).toBe(
      "# a\n###### f\nbody\n###### 16:37:04 - Title"
    );
  });

  it("uses an override but never goes shallower than the computed level", () => {
    const source = "# A\n## B\nbody";
    const deep = insert(source, 2, OPTIONS, "Title", 12);
    expect(run(source, deep)).toContain("\n############ 16:37:04 - Title");
    const shallow = insert(source, 2, OPTIONS, "Title", 1);
    expect(run(source, shallow)).toContain("\n### 16:37:04 - Title");
  });

  it("clamps an override above maxDepth", () => {
    const options: InsertOptions = { ...OPTIONS, maxDepth: 8 };
    const source = "# A\nbody";
    expect(run(source, insert(source, 1, options, "Title", 20))).toContain("\n######## 16:37:04");
  });

  it("inserts after a fenced code block", () => {
    const source = "# A\n```\ncode\n```\ntail";
    expect(run(source, insert(source, 2))).toBe(
      "# A\n```\ncode\n```\n## 16:37:04 - Title\ntail"
    );
  });

  it("inserts after the frontmatter block", () => {
    const source = "---\ntitle: x\n---\n# A";
    expect(run(source, insert(source, 1))).toBe("---\ntitle: x\n---\n# 16:37:04 - Title\n# A");
  });

  it("refuses to insert with an unclosed fence or frontmatter", () => {
    expect(insert("# A\n```\ncode", 2)).toBeNull();
    expect(insert("---\ntitle: x", 1)).toBeNull();
  });

  it("keeps a trailing space and puts the cursor after it for an empty title", () => {
    const source = "# A\n\nbody";
    const plan = insert(source, 1, OPTIONS, "   ");
    const applied = applyPlanToSource(source, plan as InsertPlan);
    expect(applied.source).toBe("# A\n## 16:37:04 \nbody");
    expect(applied.selection.from).toBe(applied.source.indexOf("## 16:37:04 ") + "## 16:37:04 ".length);
    expect(applied.source.slice(0, applied.selection.from).endsWith(" ")).toBe(true);
  });

  it("trims the title and places the cursor at its end", () => {
    const source = "# A\n\nbody";
    const plan = insert(source, 1, OPTIONS, "  Padded  ") as InsertPlan;
    const applied = applyPlanToSource(source, plan);
    expect(applied.source).toContain("## 16:37:04 - Padded");
    expect(applied.selection.from).toBe(applied.source.indexOf("Padded") + "Padded".length);
  });

  it("uses one change so a single undo reverts it", () => {
    expect(insert("# A\n\nbody", 1)?.changes).toHaveLength(1);
  });
});

describe("planSpark", () => {
  function spark(
    source: string,
    selection: string | null,
    existingIds: ReadonlySet<string> = new Set()
  ) {
    const index = parseHeadings(source, { maxDepth: OPTIONS.maxDepth });
    const from = selection === null ? 0 : source.indexOf(selection);
    return planSpark({
      source,
      index,
      now: AT_1637,
      options: OPTIONS,
      selection:
        selection === null ? null : { from, to: from + selection.length, text: selection },
      noteBasename: "Day",
      existingIds
    });
  }

  it("writes a bare spark into an empty note", () => {
    const applied = applyPlanToSource("", spark("", null) as InsertPlan);
    expect(applied.source).toBe("# 16:37:04 - \n✦\n");
    expect(applied.selection.from).toBe("# 16:37:04 - ".length);
  });

  it("leaves exactly one blank line before the spark", () => {
    expect(run("# A", spark("# A", null))).toBe("# A\n\n# 16:37:04 - \n✦\n");
  });

  it("normalizes trailing blank runs on both sides of the block", () => {
    // Three blank lines above collapse to one, and the file's final newline stays.
    expect(run("# A\n\n\n", spark("# A\n\n\n", null))).toBe("# A\n\n# 16:37:04 - \n✦\n");
  });

  it("turns a selection into the title and a source line, and ids its last line", () => {
    const source = "a passage worth keeping\nnext line";
    const applied = applyPlanToSource(source, spark(source, "a passage worth keeping") as InsertPlan);

    const id = /\^([a-z0-9]{6})/.exec(applied.source)?.[1] ?? "";
    expect(id).toHaveLength(6);
    expect(applied.source).toBe(
      `a passage worth keeping ^${id}\nnext line\n\n# 16:37:04 - a passage worth keeping\n✦ [[Day#^${id}|a passage worth keeping]]\n`
    );
  });

  it("reuses a block id the line already carries", () => {
    const source = "a passage ^abc123\nnext";
    const applied = applyPlanToSource(source, spark(source, "a passage") as InsertPlan);

    expect(applied.source).toBe(
      "a passage ^abc123\nnext\n\n# 16:37:04 - a passage\n✦ [[Day#^abc123|a passage]]\n"
    );
  });

  it("collapses a multi-line selection into one title line", () => {
    const source = "first\nsecond";
    const applied = applyPlanToSource(source, spark(source, "first\nsecond") as InsertPlan);
    expect(applied.source).toContain("# 16:37:04 - first second\n");
  });

  it("refuses an unclosed fence or frontmatter", () => {
    expect(spark("# A\n```\ncode", null)).toBeNull();
    expect(spark("---\ntitle: x", null)).toBeNull();
  });
});
