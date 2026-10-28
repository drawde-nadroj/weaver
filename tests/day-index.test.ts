import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";

import { DayIndex } from "../src/entries/day-index";
import { DEFAULT_SETTINGS } from "../src/settings";
import { createApp, createFile } from "../test-support/harness";

const DRAFT = ["{ 1.1.1 } - 10:00:00", "a draft", "- 00:01:00"].join("\n");
const SETTLED = ["{ 1.1.1 } - 10:00:00", "done", "+ 00:01:00"].join("\n");

function index(after: (app: ReturnType<typeof createApp>) => void = () => {}): {
  dayIndex: DayIndex;
  reads: () => number;
} {
  const app = createApp([
    createFile("Chronomancer/2026-10-26.md", DRAFT),
    createFile("Chronomancer/2026-10-27.md", SETTLED),
    createFile("Elsewhere/2026-10-26.md", DRAFT),
    createFile("Chronomancer/Meeting notes.md", DRAFT)
  ]);

  let reads = 0;
  const original = app.vault.cachedRead.bind(app.vault);
  app.vault.cachedRead = async (file: TFile) => {
    reads += 1;
    return original(file);
  };

  after(app);
  return { dayIndex: new DayIndex(app, () => DEFAULT_SETTINGS), reads: () => reads };
}

describe("the day index", () => {
  it("reads the day-note folder only, and only what is still a draft", async () => {
    const { dayIndex } = index();

    const days = await dayIndex.drafts();

    expect(days.map((day) => day.dayKey)).toEqual(["2026-10-26"]);
    expect(days[0]?.path).toBe("Chronomancer/2026-10-26.md");
    expect(days[0]?.entries.map((entry) => entry.title)).toEqual(["a draft"]);
  });

  it("keeps its results until it is asked to look again", async () => {
    const { dayIndex, reads } = index();

    await dayIndex.drafts();
    // Two day notes in the folder: one draft, one settled.
    expect(reads()).toBe(2);

    await dayIndex.drafts();
    expect(reads()).toBe(2);

    await dayIndex.drafts(true);
    expect(reads()).toBe(4);
  });

  it("re-reads a file whose mtime changed", async () => {
    const files = [createFile("Chronomancer/2026-10-26.md", DRAFT)];
    const app = createApp(files);

    let reads = 0;
    const original = app.vault.cachedRead.bind(app.vault);
    app.vault.cachedRead = async (file: TFile) => {
      reads += 1;
      return original(file);
    };

    const dayIndex = new DayIndex(app, () => DEFAULT_SETTINGS);
    await dayIndex.drafts();
    expect(reads).toBe(1);

    const file = files[0];
    if (file === undefined) throw new Error("expected the draft file");
    file.stat.mtime = 2;

    await dayIndex.drafts();
    expect(reads).toBe(2);
  });

  it("forgets everything when it stops", async () => {
    const { dayIndex, reads } = index();

    dayIndex.start();
    await dayIndex.drafts();
    expect(reads()).toBe(2);

    dayIndex.stop();
    await dayIndex.drafts();
    // The cache is gone, so the next scan reads every file again.
    expect(reads()).toBe(4);
  });
});
