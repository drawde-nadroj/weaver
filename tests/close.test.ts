import { describe, expect, it } from "vitest";

import { closeLine, parseClose, planCloseDay } from "../src/core/close";
import { applyPlanToSource } from "../src/core/insert";

const AT_1730 = new Date(2026, 9, 27, 17, 30, 4);

describe("parseClose", () => {
  const SOURCE = [
    "---",
    "✓ 09:00:00",
    "---",
    "```",
    "✓ 10:00:00",
    "```",
    "{ 1.1.1 } - 11:00:00",
    "prose",
    "✓ 17:30:00"
  ].join("\n");

  it("finds the mark and ignores frontmatter and fenced code", () => {
    const scan = parseClose(SOURCE);
    expect(scan.closedAt).toBe("17:30:00");
    expect(scan.line).toBe(8);
  });

  it("keeps the last mark when a note carries two", () => {
    expect(parseClose("✓ 09:00:00\n✓ 10:00:00").closedAt).toBe("10:00:00");
  });

  it("reports an open day as open", () => {
    expect(parseClose("{ 1.1.1 } - 10:00:00").closedAt).toBeNull();
  });

  it("writes the mark as one line", () => {
    expect(closeLine("17:30:04")).toBe("✓ 17:30:04");
  });
});

describe("planCloseDay", () => {
  it("appends the mark at the tip of the note", () => {
    const source = ["{ 1.1.1 }", "prose", "10:00:00 + 00:00:00"].join("\n");
    const plan = planCloseDay(source, AT_1730);
    if (plan === null) throw new Error("expected a plan");

    expect(applyPlanToSource(source, plan).source).toBe(`${source}\n\n✓ 17:30:04\n`);
  });

  it("refuses a second close", () => {
    const source = ["{ 1.1.1 }", "prose", "10:00:00 + 00:00:00", "✓ 09:00:00"].join("\n");
    expect(planCloseDay(source, AT_1730)).toBeNull();
  });

  it("refuses to write into an unclosed code block", () => {
    expect(planCloseDay("```\nunclosed", AT_1730)).toBeNull();
  });

  it("ends the file with a newline, like the rest of the note", () => {
    const plan = planCloseDay("", AT_1730);
    if (plan === null) throw new Error("expected a plan");
    expect(applyPlanToSource("", plan).source).toBe("✓ 17:30:04\n");
  });
});
