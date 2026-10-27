import { describe, expect, it } from "vitest";

import { parseHeadings } from "../src/core/headings";
import { applyPlanToSource, type InsertOptions, type InsertPlan } from "../src/core/insert";
import {
  createDraftRow,
  makeId,
  planComposerInsert,
  renderComposerBlock,
  resolveRowTimes,
  rowIsEmpty,
  type DraftRow
} from "../src/core/composer";

const AT_1637 = new Date(2024, 0, 2, 16, 37, 4);
const OPTIONS: InsertOptions = { maxDepth: 12, separator: " - ", format: "HH:mm:ss" };

function asPlan(plan: InsertPlan | null): InsertPlan {
  if (plan === null) throw new Error("expected an insert plan");
  return plan;
}

function row(overrides: Partial<DraftRow>): DraftRow {
  return { ...createDraftRow(2), ...overrides };
}

describe("createDraftRow", () => {
  it("starts empty, unpinned, at the requested level", () => {
    const draft = createDraftRow(3);
    expect(draft).toMatchObject({ level: 3, title: "", body: "", time: null, pinned: false });
    expect(draft.id.length).toBeGreaterThan(0);
  });

  it("gives every row a distinct id", () => {
    const ids = new Set(Array.from({ length: 50 }, () => makeId()));
    expect(ids.size).toBe(50);
  });
});

describe("rowIsEmpty", () => {
  it("ignores whitespace-only content", () => {
    expect(rowIsEmpty(row({}))).toBe(true);
    expect(rowIsEmpty(row({ title: "  ", body: "\n " }))).toBe(true);
    expect(rowIsEmpty(row({ title: "x" }))).toBe(false);
    expect(rowIsEmpty(row({ body: "x" }))).toBe(false);
  });
});

describe("resolveRowTimes", () => {
  it("stamps unpinned rows and preserves pinned ones", () => {
    const rows = [row({ title: "a" }), row({ title: "b", pinned: true, time: "09:00" })];
    const resolved = resolveRowTimes(rows, AT_1637, "HH:mm:ss");
    expect(resolved[0]?.time).toBe("16:37:04");
    expect(resolved[1]?.time).toBe("09:00");
    expect(rows[0]?.time).toBeNull();
  });

  it("honours the HH:mm format", () => {
    expect(resolveRowTimes([row({})], AT_1637, "HH:mm")[0]?.time).toBe("16:37");
  });
});

describe("renderComposerBlock", () => {
  it("separates rows with exactly one blank line", () => {
    const rows = [
      row({ level: 2, title: "First", time: "09:00" }),
      row({ level: 3, title: "Second", time: "09:01" })
    ];
    expect(renderComposerBlock(rows, OPTIONS)).toBe("## 09:00 - First\n\n### 09:01 - Second");
  });

  it("appends a body under its heading", () => {
    const rows = [row({ level: 3, title: "", time: "16:37:04", body: "body text  " })];
    expect(renderComposerBlock(rows, OPTIONS)).toBe("### 16:37:04 \nbody text");
  });

  it("skips empty rows without leaving gaps", () => {
    const rows = [
      row({ title: "First", time: "09:00" }),
      row({}),
      row({ title: "Third", time: "09:02" })
    ];
    expect(renderComposerBlock(rows, OPTIONS)).toBe("## 09:00 - First\n\n## 09:02 - Third");
  });

  it("returns an empty string when every row is empty", () => {
    expect(renderComposerBlock([row({}), row({})], OPTIONS)).toBe("");
  });

  it("clamps out-of-range levels", () => {
    expect(renderComposerBlock([row({ level: 0, title: "a", time: "1" })], OPTIONS)).toContain("# 1 - a");
    expect(renderComposerBlock([row({ level: 99, title: "a", time: "1" })], OPTIONS)).toContain(
      `${"#".repeat(12)} 1 - a`
    );
  });
});

describe("planComposerInsert", () => {
  const rows = [
    row({ level: 2, title: "First", time: "09:00", pinned: true }),
    row({ level: 3, title: "", body: "body text" }),
    row({ level: 3, title: "Third" })
  ];

  it("inserts every row in a single change", () => {
    const source = "intro\n\noutro";
    const index = parseHeadings(source, { maxDepth: 12 });
    const plan = planComposerInsert(source, index, 1, rows, AT_1637, OPTIONS);
    expect(plan?.changes).toHaveLength(1);

    const applied = applyPlanToSource(source, asPlan(plan));
    expect(applied.source).toBe(
      [
        "intro",
        "## 09:00 - First",
        "",
        "### 16:37:04 ",
        "body text",
        "",
        "### 16:37:04 - Third",
        "outro"
      ].join("\n")
    );
  });

  it("puts the cursor at the end of the last row", () => {
    const source = "intro\n\noutro";
    const index = parseHeadings(source, { maxDepth: 12 });
    const applied = applyPlanToSource(
      source,
      asPlan(planComposerInsert(source, index, 1, rows, AT_1637, OPTIONS))
    );
    expect(applied.selection.from).toBe(applied.source.indexOf("### 16:37:04 - Third") + "### 16:37:04 - Third".length);
  });

  it("keeps a pinned time while others follow the weave time", () => {
    const source = "# A\n\nbody";
    const index = parseHeadings(source, { maxDepth: 12 });
    const applied = applyPlanToSource(
      source,
      asPlan(planComposerInsert(source, index, 1, rows, AT_1637, OPTIONS))
    );
    expect(applied.source).toContain("## 09:00 - First");
    expect(applied.source.match(/16:37:04/g)).toHaveLength(2);
  });

  it("returns null when every row is empty", () => {
    const source = "# A\n\nbody";
    const index = parseHeadings(source, { maxDepth: 12 });
    expect(planComposerInsert(source, index, 1, [row({}), row({ body: "  " })], AT_1637, OPTIONS)).toBeNull();
  });

  it("returns null for an unclosed fence or frontmatter", () => {
    const fenced = "# A\n```\ncode";
    const fm = "---\ntitle: x";
    expect(
      planComposerInsert(fenced, parseHeadings(fenced, { maxDepth: 12 }), 2, rows, AT_1637, OPTIONS)
    ).toBeNull();
    expect(
      planComposerInsert(fm, parseHeadings(fm, { maxDepth: 12 }), 1, rows, AT_1637, OPTIONS)
    ).toBeNull();
  });
});
