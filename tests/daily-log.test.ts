import { describe, expect, it } from "vitest";

import { contextList } from "../src/entries/day-note";
import { readDailyLog, recognisePath, type DailyLogPorts } from "../src/entries/daily-log";
import { createApp } from "../test-support/harness";
import { DEFAULT_SETTINGS } from "../src/settings";
import type { WeavingContext } from "../src/core/contexts";

const SPANISH = {
  id: "ctx-spanish",
  name: "Spanish",
  folder: "Spanish/Daily",
  format: "YYYY.MM.DD"
};

function contexts(): readonly WeavingContext[] {
  return contextList(createApp(), { ...DEFAULT_SETTINGS, contexts: [SPANISH] }).contexts;
}

/** One note's text, with entries whose rows carry the days given. */
function note(date: string, rows: Array<{ n: number; prose: string; day: string | null; time: string | null }>): string {
  const body = rows.flatMap(({ n, prose, day, time }) => [
    `{ ${1}.1.${n} }`,
    "",
    prose,
    `+ 00:01:00 ${day ?? date} ${time ?? "09:00:00"}`,
    ""
  ]);
  return ["---", `date: ${date}`, "---", "", ...body].join("\n");
}

function ports(files: Record<string, string>): DailyLogPorts & { reads: string[] } {
  const reads: string[] = [];
  let generation = 0;
  return {
    reads,
    paths: () => Object.keys(files),
    read: async (path) => {
      reads.push(path);
      return files[path] ?? null;
    },
    generation: () => generation,
    // A settled generation for the test's own use.
    ...{ bump: () => (generation += 1) }
  } as DailyLogPorts & { reads: string[] };
}

describe("recognising a day note", () => {
  it("reads a configured destination's path back to its context and day", () => {
    expect(recognisePath("Spanish/Daily/2026.11.05.md", contexts())).toEqual({
      contextId: "ctx-spanish",
      day: "2026-11-05"
    });
  });

  it("reads an older dotted note, and refuses anything else", () => {
    expect(recognisePath("Old/2026.11.05.md", contexts())).toEqual({
      contextId: null,
      day: "2026-11-05"
    });
    expect(recognisePath("Meeting notes.md", contexts())).toBeNull();
  });
});

describe("the day across destinations", () => {
  it("includes a thought created on the day whatever file holds it", async () => {
    const files = {
      "Chronomancer/2026.11.05.md": note("2026-11-05", [
        { n: 1, prose: "this morning", day: "2026-11-05", time: "09:00:00" }
      ]),
      // Yesterday's file, holding a branch written after midnight.
      "Chronomancer/2026.11.04.md": note("2026-11-04", [
        { n: 2, prose: "written after midnight", day: "2026-11-05", time: "00:10:00" }
      ])
    };

    const log = await readDailyLog(ports(files), contexts(), "2026-11-05");

    expect(log.rows.map((row) => row.excerpt)).toEqual(["written after midnight", "this morning"]);
    expect(log.rows.map((row) => row.path)).toEqual([
      "Chronomancer/2026.11.04.md",
      "Chronomancer/2026.11.05.md"
    ]);
  });

  it("selects undated historical rows by their note's day", async () => {
    const files = {
      "Old/2026.11.05.md": note("2026-11-05", [
        { n: 1, prose: "an old entry", day: null, time: "07:00:00" }
      ])
    };

    const log = await readDailyLog(ports(files), contexts(), "2026-11-05");
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]?.contextId).toBeNull();
  });

  it("keeps untimed rows apart instead of inventing a midnight", async () => {
    const files = {
      "Chronomancer/2026.11.05.md": ["---", "date: 2026-11-05", "---", "", "{ 1.1.1 }", "", "no moment", ""].join("\n")
    };

    const log = await readDailyLog(ports(files), contexts(), "2026-11-05");
    expect(log.rows).toEqual([]);
    expect(log.untimed).toHaveLength(1);
    expect(log.untimed[0]?.time).toBeNull();
  });

  it("reports an unreadable note instead of quietly shortening the list", async () => {
    const files = {
      "Chronomancer/2026.11.05.md": note("2026-11-05", [
        { n: 1, prose: "fine", day: "2026-11-05", time: "09:00:00" }
      ]),
      "Chronomancer/2026.11.04.md": "---\ndate: 2026-11-04\n```\nunclosed"
    };

    const log = await readDailyLog(ports(files), contexts(), "2026-11-05");
    expect(log.rows).toHaveLength(1);
    expect(log.errors.map((error) => error.path)).toContain("Chronomancer/2026.11.04.md");
  });

  it("does not read notes dated after the day being listed", async () => {
    const files = {
      "Chronomancer/2026.11.09.md": note("2026-11-09", [
        { n: 1, prose: "later", day: "2026-11-05", time: "09:00:00" }
      ])
    };

    const reader = ports(files);
    const log = await readDailyLog(reader, contexts(), "2026-11-05");
    expect(log.rows).toEqual([]);
    expect(reader.reads).toEqual([]);
  });

  it("names a destination whose format cannot be read back", async () => {
    // A vault whose own Daily Notes format carries no day: its notes still
    // exist, and the list says why they are not attributed to it.
    const broken: WeavingContext[] = [
      { id: "main", name: "Journal", folder: "Journal", format: "Journal" },
      { id: "ctx-spanish", name: "Spanish", folder: "Spanish/Daily", format: "YYYY.MM.DD" }
    ];

    const log = await readDailyLog(ports({}), broken, "2026-11-05");
    expect(log.unsupported).toEqual(["Journal"]);
  });

  it("returns an empty list for a day nothing was written on", async () => {
    const log = await readDailyLog(ports({}), contexts(), "2026-11-05");
    expect(log).toEqual({ rows: [], untimed: [], errors: [], unsupported: [] });
  });
});
