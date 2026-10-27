import { describe, expect, it } from "vitest";

import { draftBlockText } from "../src/core/drafts";
import { parseHeadings, type HeadingIndex } from "../src/core/headings";
import {
  childTarget,
  firstDraftTarget,
  firstTarget,
  headingMatchesLevel,
  initialDraftTarget,
  initialTravelTarget,
  lastDraftTarget,
  lastTarget,
  levelTargets,
  moveDraftTarget,
  moveTravelTarget,
  orderedDrafts,
  parentTarget,
  travelLabel,
  travelLineSpecs
} from "../src/core/travel";

const SOURCE = ["# 00:00", "## 00:01", "## 00:02", "### 00:03", "## 00:04"].join("\n");

function index(source = SOURCE): HeadingIndex {
  return parseHeadings(source, { maxDepth: 12 });
}

function lines(headings: ReadonlyArray<{ line: number } | null>): Array<number | null> {
  return headings.map((heading) => heading?.line ?? null);
}

describe("levelTargets", () => {
  it("filters by level and includes all", () => {
    expect(lines(levelTargets(index(), 2))).toEqual([1, 2, 4]);
    expect(levelTargets(index(), "all")).toHaveLength(5);
    expect(levelTargets(index(), 4)).toEqual([]);
  });

  it("matches levels only", () => {
    const heading = index().headings[1];
    expect(headingMatchesLevel(heading, 2)).toBe(true);
    expect(headingMatchesLevel(heading, 3)).toBe(false);
    expect(headingMatchesLevel(heading, "all")).toBe(true);
  });
});

describe("initialTravelTarget", () => {
  it("uses the heading on the cursor line when it matches", () => {
    expect(initialTravelTarget(index(), 2, 2)?.line).toBe(2);
    expect(initialTravelTarget(index(), 3, 3)?.line).toBe(3);
  });

  it("falls forward to the next heading at the level", () => {
    expect(initialTravelTarget(index(), 1, 3)?.line).toBe(3);
    expect(initialTravelTarget(index(), 0, 2)?.line).toBe(1);
  });

  it("falls back to the nearest heading above", () => {
    expect(initialTravelTarget(index(), 9, 2)?.line).toBe(4);
    expect(initialTravelTarget(index(), 2, 3)?.line).toBe(3);
  });

  it("uses the cursor heading for the all filter", () => {
    expect(initialTravelTarget(index(), 2, "all")?.line).toBe(2);
    expect(initialTravelTarget(index(), 3, "all")?.line).toBe(3);
    expect(initialTravelTarget(index(), 0, "all")?.line).toBe(0);
  });

  it("returns null for an empty index", () => {
    expect(initialTravelTarget(index("body"), 0, "all")).toBeNull();
    expect(initialTravelTarget(index("body"), 0, 2)).toBeNull();
  });
});

describe("moveTravelTarget", () => {
  const all = index();

  it("moves between headings at the current level", () => {
    const current = all.headings[1] ?? null;
    expect(moveTravelTarget(all, current, 2, "next", false)?.line).toBe(2);
    expect(moveTravelTarget(all, all.headings[2] ?? null, 2, "next", false)?.line).toBe(4);
    expect(moveTravelTarget(all, all.headings[4] ?? null, 2, "prev", false)?.line).toBe(2);
  });

  it("does not wrap by default", () => {
    expect(moveTravelTarget(all, all.headings[4] ?? null, 2, "next", false)?.line).toBe(4);
    expect(moveTravelTarget(all, all.headings[1] ?? null, 2, "prev", false)?.line).toBe(1);
  });

  it("wraps when asked", () => {
    expect(moveTravelTarget(all, all.headings[4] ?? null, 2, "next", true)?.line).toBe(1);
    expect(moveTravelTarget(all, all.headings[1] ?? null, 2, "prev", true)?.line).toBe(4);
  });

  it("starts from the first or last heading when there is no current target", () => {
    expect(moveTravelTarget(all, null, 2, "next", false)?.line).toBe(1);
    expect(moveTravelTarget(all, null, 2, "prev", false)?.line).toBe(4);
    expect(moveTravelTarget(all, null, 2, "next", true)?.line).toBe(1);
  });

  it("recovers when the current heading left the filter", () => {
    const current = all.headings[2] ?? null;
    expect(moveTravelTarget(all, current, 3, "next", false)?.line).toBe(3);
    // No level-3 heading above line 2, so the current heading is kept.
    expect(moveTravelTarget(all, current, 3, "prev", false)?.line).toBe(2);
  });

  it("returns null when the filter has no headings", () => {
    expect(moveTravelTarget(all, all.headings[0] ?? null, 9, "next", false)).toBeNull();
  });
});

describe("parentTarget and childTarget", () => {
  const all = index();

  it("finds the nearest lower level above", () => {
    expect(parentTarget(all, all.headings[3] ?? all.headings[0]!)?.line).toBe(2);
    expect(parentTarget(all, all.headings[2] ?? all.headings[0]!)?.line).toBe(0);
    expect(parentTarget(all, all.headings[0] ?? all.headings[1]!)).toBeNull();
  });

  it("finds the first child and stops at siblings", () => {
    expect(childTarget(all, all.headings[0] ?? all.headings[1]!)?.line).toBe(1);
    expect(childTarget(all, all.headings[1] ?? all.headings[0]!)).toBeNull();
    expect(childTarget(all, all.headings[2] ?? all.headings[0]!)?.line).toBe(3);
  });

  it("returns null for an empty index", () => {
    const empty = index("body");
    expect(parentTarget(empty, { line: 0 } as never)).toBeNull();
  });
});

describe("firstTarget and lastTarget", () => {
  it("returns the edges of the filter", () => {
    expect(firstTarget(index(), 2)?.line).toBe(1);
    expect(lastTarget(index(), 2)?.line).toBe(4);
    expect(firstTarget(index(), "all")?.line).toBe(0);
    expect(lastTarget(index(), "all")?.line).toBe(4);
    expect(firstTarget(index(), 9)).toBeNull();
  });
});

describe("travelLineSpecs", () => {
  it("marks levels and the active target", () => {
    const specs = travelLineSpecs(index(), {
      active: true,
      kind: "headings",
      level: 2,
      targetLine: 2,
      draftId: null
    });
    expect(specs).toEqual([
      { from: 8, classes: ["weaver-travel-level"] },
      { from: 17, classes: ["weaver-travel-level", "weaver-travel-target"] },
      { from: 36, classes: ["weaver-travel-level"] }
    ]);
  });

  it("returns nothing when travel is inactive", () => {
    expect(
      travelLineSpecs(index(), {
        active: false,
        kind: "headings",
        level: "all",
        targetLine: 1,
        draftId: null
      })
    ).toEqual([]);
  });
});

describe("travelLabel", () => {
  it("shows the heading text", () => {
    expect(travelLabel(index().headings[1] ?? index().headings[0]!)).toBe("00:01");
  });

  it("falls back to the level for an empty heading", () => {
    const heading = parseHeadings("##", { maxDepth: 12 }).headings[0];
    expect(travelLabel(heading ?? ({ level: 2, text: "" } as never))).toBe("2D");
  });
});

function draftText(id: string, openedAt: string, title: string): string {
  return draftBlockText({ id, openedAt, title, body: "" });
}

/**
 * Document order is 2.1 then 2.2, but 2.2 was opened first, so chronological
 * order is the reverse of the file order.
 */
const DRAFT_SOURCE = [
  "# 00:00 root",
  draftText("2.1", "2026-10-26 16:40:00", "later"),
  draftText("2.2", "2026-10-26 16:37:04", "earlier"),
  "## 00:05 sibling",
  draftText("2.3", "2026-10-26 16:50:00", "latest")
].join("\n");

function draftIndex() {
  return parseHeadings(DRAFT_SOURCE, { maxDepth: 12 });
}

describe("orderedDrafts", () => {
  it("sorts chronologically, not by document order", () => {
    expect(orderedDrafts(draftIndex(), "all").map((draft) => draft.id)).toEqual([
      "2.2",
      "2.1",
      "2.3"
    ]);
  });

  it("filters by level", () => {
    expect(orderedDrafts(draftIndex(), 2).map((draft) => draft.id)).toEqual(["2.2", "2.1", "2.3"]);
    expect(orderedDrafts(draftIndex(), 3)).toEqual([]);
  });

  it("breaks ties inside the same second by document position", () => {
    const source = [
      draftText("2.1", "2026-10-26 16:37:04", "first"),
      draftText("2.2", "2026-10-26 16:37:04", "second")
    ].join("\n\n");
    expect(orderedDrafts(parseHeadings(source, { maxDepth: 12 }), "all").map((d) => d.id)).toEqual([
      "2.1",
      "2.2"
    ]);
  });
});

describe("initialDraftTarget", () => {
  it("uses the first draft at or below the cursor", () => {
    const drafts = draftIndex();
    const first = drafts.drafts[0]!;
    expect(initialDraftTarget(drafts, 0, "all")?.id).toBe("2.2");
    expect(initialDraftTarget(drafts, first.titleLine, "all")?.id).toBe("2.2");
  });

  it("falls back to the last draft", () => {
    expect(initialDraftTarget(draftIndex(), 999, "all")?.id).toBe("2.3");
  });

  it("returns null without drafts", () => {
    expect(initialDraftTarget(index(), 0, "all")).toBeNull();
  });
});

describe("moveDraftTarget", () => {
  it("walks chronologically and stops at the edges", () => {
    const drafts = orderedDrafts(draftIndex(), "all");
    const first = drafts[0]!;
    const middle = drafts[1]!;
    const last = drafts[2]!;

    expect(moveDraftTarget(draftIndex(), first, "all", "next", false)?.id).toBe(middle.id);
    expect(moveDraftTarget(draftIndex(), middle, "all", "next", false)?.id).toBe(last.id);
    expect(moveDraftTarget(draftIndex(), last, "all", "next", false)?.id).toBe(last.id);
    expect(moveDraftTarget(draftIndex(), first, "all", "prev", false)?.id).toBe(first.id);
  });

  it("wraps when asked", () => {
    const drafts = orderedDrafts(draftIndex(), "all");
    expect(moveDraftTarget(draftIndex(), drafts[2]!, "all", "next", true)?.id).toBe("2.2");
    expect(moveDraftTarget(draftIndex(), drafts[0]!, "all", "prev", true)?.id).toBe("2.3");
  });

  it("starts from an edge when there is no current draft", () => {
    expect(moveDraftTarget(draftIndex(), null, "all", "next", false)?.id).toBe("2.2");
    expect(moveDraftTarget(draftIndex(), null, "all", "prev", false)?.id).toBe("2.3");
  });

  it("returns null when the filter is empty", () => {
    expect(moveDraftTarget(draftIndex(), null, 9, "next", false)).toBeNull();
  });
});

describe("firstDraftTarget and lastDraftTarget", () => {
  it("returns the chronological edges", () => {
    expect(firstDraftTarget(draftIndex(), "all")?.id).toBe("2.2");
    expect(lastDraftTarget(draftIndex(), "all")?.id).toBe("2.3");
    expect(firstDraftTarget(draftIndex(), 9)).toBeNull();
  });
});

describe("travelLineSpecs in drafts mode", () => {
  it("marks every filtered draft and the target's title line", () => {
    const drafts = draftIndex();
    const target = drafts.drafts[0]!;
    const specs = travelLineSpecs(drafts, {
      active: true,
      kind: "drafts",
      level: "all",
      targetLine: null,
      draftId: target.id
    });

    expect(specs).toHaveLength(3);
    const targetSpec = specs.find((spec) => spec.from === target.titleFrom);
    expect(targetSpec?.classes).toEqual(["weaver-travel-level", "weaver-travel-target"]);

    const other = specs.find((spec) => spec.from === drafts.drafts[1]!.titleFrom);
    expect(other?.classes).toEqual(["weaver-travel-level"]);
  });

  it("marks nothing when the level filter excludes every draft", () => {
    expect(
      travelLineSpecs(draftIndex(), {
        active: true,
        kind: "drafts",
        level: 9,
        targetLine: null,
        draftId: null
      })
    ).toEqual([]);
  });
});
