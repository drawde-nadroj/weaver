import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";

import { applyPlanToSource } from "../src/core/insert";
import WeaverPlugin from "../src/main";
import {
  createApp,
  createFile,
  fileContent,
  instantiatePlugin,
  noticeMessages
} from "../test-support/harness";
import { planCloseDay } from "../src/core/close";
import { parseMarks } from "../src/core/marks";
import type { InsertOptions } from "../src/core/insert";

const AT_1637 = new Date(2024, 0, 2, 16, 37, 4);
const OPTIONS: InsertOptions = { maxDepth: 12, separator: " - ", format: "HH:mm:ss" };

describe("planCloseDay", () => {
  it("appends one closing mark after a blank line", () => {
    const source = "# 09:00:00 - x\nbody";
    const plan = planCloseDay(source, AT_1637, OPTIONS);
    expect(plan).not.toBeNull();

    const applied = applyPlanToSource(source, plan!);
    expect(applied.source).toBe("# 09:00:00 - x\nbody\n\n✓ 16:37:04\n");
    expect(parseMarks(applied.source).closedAt).toBe("16:37:04");
  });

  it("uses the note's own clock format, so the mark matches the dimensions", () => {
    const source = "# 09:00 - x";
    const plan = planCloseDay(source, AT_1637, { ...OPTIONS, format: "HH:mm" });
    expect(applyPlanToSource(source, plan!).source).toBe("# 09:00 - x\n\n✓ 16:37\n");
  });

  it("refuses a second close instead of appending another mark", () => {
    expect(planCloseDay("✓ 09:00", AT_1637, OPTIONS)).toBeNull();
    expect(planCloseDay("# 09:00:00 - x\n\n✓ 09:00\n\ntext", AT_1637, OPTIONS)).toBeNull();
  });

  it("refuses to write into an unclosed frontmatter block or fence", () => {
    expect(planCloseDay("---\ntitle: x", AT_1637, OPTIONS)).toBeNull();
    expect(planCloseDay("```\ncode", AT_1637, OPTIONS)).toBeNull();
  });

  it("writes a lone mark into an empty note", () => {
    const plan = planCloseDay("", AT_1637, OPTIONS);
    expect(applyPlanToSource("", plan!).source).toBe("✓ 16:37:04\n");
  });
});

describe("close-day through the plugin", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes once, then refuses with a notice and writes nothing more", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 27, 16, 37, 4));
    Platform.isPhone = false;

    const day = createFile("Chronomancer/2026.10.27.md", "# 09:00:00 - x\n");
    const app = createApp([day]);
    const plugin = instantiatePlugin(WeaverPlugin, app);
    await plugin.onload();

    await plugin.closeDay();

    expect(fileContent(day)).toContain("✓ 16:37:04");
    expect(parseMarks(fileContent(day)).closedAt).toBe("16:37:04");
    expect(noticeMessages()).toEqual(["Weaver: day closed at 16:37:04."]);

    const closed = fileContent(day);
    await plugin.closeDay();

    expect(fileContent(day)).toBe(closed);
    expect(noticeMessages()).toContain(
      "Weaver: this day is already closed. Nothing was written."
    );
    // Every refusal says what it is and that the vault is untouched.
    const refusal = noticeMessages().at(-1) ?? "";
    expect(refusal.startsWith("Weaver: ")).toBe(true);
    expect(refusal.endsWith("Nothing was written.")).toBe(true);
  });
});
