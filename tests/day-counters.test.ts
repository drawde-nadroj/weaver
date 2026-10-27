import { describe, expect, it } from "vitest";

import { parseHeadings } from "../src/core/headings";
import { countDay, applyDayCounts, writeDayCounts, recountDay } from "../src/core/day-counters";
import { parseMarks } from "../src/core/marks";
import { createApp, createFile, fileContent } from "../test-support/harness";

function counts(source: string) {
  const index = parseHeadings(source, { maxDepth: 12 });
  return countDay(index, parseMarks(source));
}

const DAY = [
  "---",
  "date: 2026-10-27",
  "---",
  "",
  "# 09:12:01 - first",
  "✦ [[Note#^abc123|first]]",
  "# 10:02:00 - second",
  "✦",
  "## 10:04:00 - deep",
  "### 10:06:00 - deeper",
  "# 16:37:04 - third",
  "✦ [[Other]]",
  "✓ 21:29"
].join("\n");

describe("countDay", () => {
  it("counts 1D sparks, every dimension, and linked sources", () => {
    expect(counts(DAY)).toEqual({
      sparks: 3,
      dimensions: 5,
      sources: 2,
      untitled: 0,
      lastMark: "21:29",
      closedAt: "21:29"
    });
  });

  it("reads an empty note as zeros rather than failing", () => {
    expect(counts("")).toEqual({
      sparks: 0,
      dimensions: 0,
      sources: 0,
      untitled: 0,
      lastMark: null,
      closedAt: null
    });
  });

  it("does not count a ✦ line inside a fence or a draft", () => {
    const source = [
      "# 09:00:00 - one",
      "```",
      "✦ [[Not counted]]",
      "```",
      "⟪draft 2.1 2026-10-26 16:37:04⟫",
      "✦ [[Also not counted]]",
      "⟪/draft 2.1⟫"
    ].join("\n");

    expect(counts(source).sources).toBe(0);
    expect(counts(source).sparks).toBe(1);
  });

  it("counts an untitled 1D without ever repairing it", () => {
    const source = "# 09:12:01 - \n✦\n# 10:02:00 - named\n## 11:00:00 - \n";
    const found = counts(source);
    expect(found.untitled).toBe(1);
    expect(found.sparks).toBe(2);
    // A bare separator is an empty title, not a title of `-`.
    expect(counts("# 09:12:01 - \n").untitled).toBe(1);
  });

  it("compares clocks as times, not as strings", () => {
    // A hand-written `9:05` must not outrank `16:37`.
    const source = "# 16:37:04 - late\n# 9:05 - early";
    expect(counts(source).lastMark).toBe("16:37:04");
  });

  it("reports the later of the newest spark and the close", () => {
    expect(counts("# 09:00:00 - x\n✓ 08:00").lastMark).toBe("09:00:00");
    expect(counts("# 09:00:00 - x\n✓ 23:41").lastMark).toBe("23:41");
  });
});

describe("applyDayCounts", () => {
  it("creates the frontmatter block when the note has none", () => {
    const result = applyDayCounts("# 09:00:00 - x\n", counts("# 09:00:00 - x\n"), "2026-10-27");
    expect(result.changed).toBe(true);
    expect(result.source).toBe(
      "---\ndate: 2026-10-27\nsparks: 1\ndimensions: 1\nsources: 0\n---\n# 09:00:00 - x\n"
    );
  });

  it("preserves unrelated keys and every other line", () => {
    const source = [
      "---",
      "title: A day",
      "tags:",
      "  - journal",
      "date: 2026-10-27",
      "sparks: 9",
      "---",
      "",
      "# 09:00:00 - x"
    ].join("\n");

    const result = applyDayCounts(source, counts(source), "2026-10-27");
    expect(result.source).toContain("title: A day");
    expect(result.source).toContain("tags:\n  - journal");
    expect(result.source).toContain("date: 2026-10-27");
    expect(result.source).toContain("sparks: 1");
    expect(result.source).toContain("dimensions: 1");
    expect(result.source).toContain("sources: 0");
    expect(result.source.endsWith("# 09:00:00 - x")).toBe(true);
  });

  it("does not fight a date the writer already set", () => {
    const source = "---\ndate: 2026-10-26\n---\n";
    const result = applyDayCounts(source, counts(source), "2026-10-27");
    expect(result.source).toContain("date: 2026-10-26");
  });

  it("reports no change when the counts already match, so no write loop starts", () => {
    const source = "---\ndate: 2026-10-27\nsparks: 0\ndimensions: 0\nsources: 0\n---\n";
    expect(applyDayCounts(source, recountDay(source, 12), "2026-10-27").changed).toBe(false);
  });

  it("never writes into an unclosed frontmatter block", () => {
    const source = "---\ntitle: broken\n";
    expect(applyDayCounts(source, recountDay(source, 12), "2026-10-27").changed).toBe(false);
  });
});

describe("writeDayCounts", () => {
  it("writes through the vault and reports whether anything changed", async () => {
    const file = createFile("Chronomancer/2026.10.27.md", "# 09:00:00 - x\n");
    const app = createApp([file]);

    expect(await writeDayCounts(app, file, recountDay(fileContent(file), 12))).toBe(true);
    expect(fileContent(file)).toContain("date: 2026-10-27");
    expect(fileContent(file)).toContain("sparks: 1");

    // A second pass over unchanged counts writes nothing at all.
    const before = file.stat.mtime;
    expect(await writeDayCounts(app, file, recountDay(fileContent(file), 12))).toBe(false);
    expect(file.stat.mtime).toBe(before);
  });
});
