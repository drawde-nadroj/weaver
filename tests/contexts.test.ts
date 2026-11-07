import { describe, expect, it } from "vitest";

import {
  contextDayForPath,
  contextDayPath,
  contextDraftError,
  effectiveContexts,
  entryDayLabel,
  mainContext,
  parseDayTemplate,
  readContexts,
  sourceDayOf,
  type WeavingContext
} from "../src/core/contexts";
import { createApp } from "../test-support/harness";
import { DEFAULT_SETTINGS } from "../src/settings";
import { contextList as listFromVault } from "../src/entries/day-note";

const MAIN_OPTIONS = { folder: "Chronomancer", format: "YYYY.MM.DD" };

const SPANISH: WeavingContext = {
  id: "ctx-spanish",
  name: "Spanish",
  folder: "Spanish/Daily",
  format: "YYYY.MM.DD"
};

const RESEARCH: WeavingContext = {
  id: "ctx-research",
  name: "Research",
  folder: "Research/Daily",
  format: "YYYY-MM-DD"
};

const CONTEXTS = [mainContext(MAIN_OPTIONS), SPANISH, RESEARCH];

describe("parseDayTemplate", () => {
  it("reads the folder, the tokens and the whole template", () => {
    const parsed = parseDayTemplate("Journal/Days", "YYYY-MM-DD");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.template.folder).toBe("Journal/Days");
    expect(parsed.template.tokens).toEqual(["YYYY", "MM", "DD"]);
    expect(parsed.template.source).toBe("Journal/Days/YYYY-MM-DD.md");
  });

  it("normalises a folder's stray slashes", () => {
    const parsed = parseDayTemplate("  Journal/Days/  ", "YYYY.MM.DD");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.template.folder).toBe("Journal/Days");
  });

  it("refuses a folder that would leave the vault or nest wrongly", () => {
    for (const folder of ["../Escape", "/Absolute", "a//b", "a/./b", "a\\b"]) {
      expect(parseDayTemplate(folder, "YYYY.MM.DD").ok).toBe(false);
    }
  });

  it("refuses a format token it cannot expand or read back", () => {
    const unsupported = parseDayTemplate("Journal", "YYYY-MM-DD-dddd");
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.error).toContain("dddd");

    expect(parseDayTemplate("Journal", "YYYY.YY.MM.DD").ok).toBe(false);
    expect(parseDayTemplate("Journal", "").ok).toBe(false);
    expect(parseDayTemplate("Journal", "YYYY/MM/DD").ok).toBe(false);
  });

  it("names the reason a draft cannot be added", () => {
    expect(contextDraftError("Spanish/Daily", "YYYY.MM.DD")).toBeNull();
    expect(contextDraftError("Spanish/Daily", "YYYY.MM")).toContain("year, month and day");
  });
});

describe("readContexts", () => {
  it("returns usable definitions in stored order", () => {
    const read = readContexts([SPANISH, RESEARCH], MAIN_OPTIONS);
    expect(read.errors).toEqual([]);
    expect(read.valid.map((context) => context.id)).toEqual([SPANISH.id, RESEARCH.id]);
  });

  it("treats a missing list as no additional destinations", () => {
    expect(readContexts(undefined).valid).toEqual([]);
    expect(readContexts(null).valid).toEqual([]);
  });

  it("reports a stored value that is not a list instead of emptying it", () => {
    const read = readContexts({ Spanish: SPANISH }, MAIN_OPTIONS);
    expect(read.valid).toEqual([]);
    expect(read.errors[0]?.index).toBeNull();
  });

  it("refuses the row it cannot use and keeps the rest", () => {
    const read = readContexts([{ id: "", name: "Empty" }, RESEARCH], MAIN_OPTIONS);
    expect(read.valid.map((context) => context.id)).toEqual([RESEARCH.id]);
    expect(read.errors[0]?.index).toBe(0);
  });

  it("refuses a reserved id, a repeated name and a shadowed template", () => {
    expect(readContexts([{ id: "main", name: "Mine", folder: "X", format: "YYYY.MM.DD" }]).errors[0]?.message).toContain("reserved");
    expect(readContexts([SPANISH, { ...RESEARCH, name: "spanish" }]).errors).toHaveLength(1);
    // The same folder and format as `main` would write the same notes.
    const shadow = readContexts(
      [{ id: "ctx-a", name: "Shadow", folder: "Chronomancer", format: "YYYY.MM.DD" }],
      MAIN_OPTIONS
    );
    expect(shadow.valid).toEqual([]);
    expect(shadow.errors[0]?.message).toContain("already writes to");
  });

  it("refuses a format that does not name a day", () => {
    const read = readContexts([{ id: "ctx-a", name: "Undated", folder: "Notes", format: "YYYY.MM" }]);
    expect(read.valid).toEqual([]);
    expect(read.errors[0]?.message).toContain("year, month and day");
  });
});

describe("contextDayForPath", () => {
  it("recognises each destination's own note and day", () => {
    expect(contextDayForPath("Spanish/Daily/2026.11.05.md", CONTEXTS)).toEqual({
      contextId: SPANISH.id,
      day: "2026-11-05",
      path: "Spanish/Daily/2026.11.05.md"
    });
    expect(contextDayForPath("Research/Daily/2026-11-05.md", CONTEXTS)?.contextId).toBe(RESEARCH.id);
    expect(contextDayForPath("Chronomancer/2026.11.05.md", CONTEXTS)?.contextId).toBe("main");
  });

  it("matches the whole path, never a folder or a basename alone", () => {
    expect(contextDayForPath("Spanish/2026.11.05.md", CONTEXTS)).toBeNull();
    expect(contextDayForPath("Spanish/Daily/Notes/2026.11.05.md", CONTEXTS)).toBeNull();
    expect(contextDayForPath("Spanish/Daily/2026.11.05.txt", CONTEXTS)).toBeNull();
    expect(contextDayForPath("Ordinary/2026.11.05.md", CONTEXTS)).toBeNull();
  });

  it("refuses a date the calendar does not have", () => {
    expect(contextDayForPath("Spanish/Daily/2026.02.30.md", CONTEXTS)).toBeNull();
    expect(contextDayForPath("Spanish/Daily/2026.13.01.md", CONTEXTS)).toBeNull();
  });

  it("skips a destination whose format cannot be read back", () => {
    const undated = { id: "ctx-x", name: "Journal", folder: "Journal", format: "Journal" };
    expect(contextDayForPath("Journal/Journal.md", [undated])).toBeNull();
  });

  it("expands a path for a day in a destination's own format", () => {
    expect(contextDayPath(SPANISH, "2026-11-05")).toBe("Spanish/Daily/2026.11.05.md");
    expect(contextDayPath(RESEARCH, "2026-11-05")).toBe("Research/Daily/2026-11-05.md");
  });
});

describe("entryDayLabel", () => {
  it("omits an undated entry and an entry on its containing day's date", () => {
    expect(entryDayLabel(null, "Spanish/Daily/2026.11.05.md", CONTEXTS, "2026-11-07")).toBeNull();
    expect(entryDayLabel("2026-11-05", "Spanish/Daily/2026.11.05.md", CONTEXTS, "2026-11-07")).toBeNull();
  });

  it("names a different recorded day with that destination's navigation target", () => {
    expect(entryDayLabel("2026-11-01", "Spanish/Daily/2026.11.05.md", CONTEXTS, "2026-11-07")).toEqual({
      day: "2026-11-01",
      target: "Spanish/Daily/2026.11.01"
    });
    expect(entryDayLabel("2026-11-09", "Research/Daily/2026-11-05.md", CONTEXTS, "2026-11-07")).toEqual({
      day: "2026-11-09",
      target: "Research/Daily/2026-11-09"
    });
  });

  it("uses the actual current day for an ordinary note and keeps an unlinked past date visible", () => {
    expect(entryDayLabel("2026-11-07", "Meeting notes.md", CONTEXTS, "2026-11-07")).toBeNull();
    expect(entryDayLabel("2026-11-05", "Meeting notes.md", CONTEXTS, "2026-11-07")).toEqual({
      day: "2026-11-05",
      target: null
    });
  });

  it("keeps the historical basename target when it can be inferred", () => {
    expect(entryDayLabel("2026-11-01", "Old/2026.11.05.md", [], "2026-11-07")).toEqual({
      day: "2026-11-01",
      target: "2026.11.01"
    });
    expect(entryDayLabel("2026-11-01", "Old/2026-11-05.md", [], "2026-11-07")).toEqual({
      day: "2026-11-01",
      target: "2026-11-01"
    });
  });
});

describe("sourceDayOf", () => {
  it("reads a configured note's day, and an older dotted one's", () => {
    expect(sourceDayOf("Spanish/Daily/2026.11.05.md", CONTEXTS)).toBe("2026-11-05");
    expect(sourceDayOf("Old/2026.11.05.md", CONTEXTS)).toBe("2026-11-05");
    expect(sourceDayOf("Meeting notes.md", CONTEXTS)).toBeNull();
  });
});

describe("the destination list a vault resolves", () => {
  it("puts main first and reads the rest from settings", () => {
    const app = createApp();
    const contexts = listFromVault(app, { ...DEFAULT_SETTINGS, contexts: [SPANISH] }).contexts;
    expect(contexts.map((context) => context.id)).toEqual(["main", SPANISH.id]);
    expect(effectiveContexts(MAIN_OPTIONS, [SPANISH])[0]?.folder).toBe("Chronomancer");
  });

  it("reports a rejected row without dropping main", () => {
    const app = createApp();
    const read = listFromVault(app, { ...DEFAULT_SETTINGS, contexts: [{ id: "" }] });
    expect(read.contexts.map((context) => context.id)).toEqual(["main"]);
    expect(read.errors).toHaveLength(1);
  });
});
