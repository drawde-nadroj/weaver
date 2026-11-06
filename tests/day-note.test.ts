import { describe, expect, it } from "vitest";

import {
  dayFrontmatter,
  dayKey,
  dayKeyFromName,
  dayNotePath,
  entryDayLinkTarget
} from "../src/core/day";
import { ensureDayNote, resolveDayNote } from "../src/entries/day-note";
import { DEFAULT_SETTINGS } from "../src/settings";
import { createApp, createFile, fileContent } from "../test-support/harness";

const AT_1637 = new Date(2024, 0, 2, 16, 37, 4);

describe("dayNotePath", () => {
  it("expands the three tokens and joins the folder", () => {
    expect(dayNotePath(AT_1637, { folder: "Chronomancer", format: "YYYY.MM.DD" })).toBe(
      "Chronomancer/2024.01.02.md"
    );
    expect(dayNotePath(AT_1637, { folder: "Journal/Days", format: "YYYY-MM-DD" })).toBe(
      "Journal/Days/2024-01-02.md"
    );
  });

  it("leaves no leading slash when there is no folder", () => {
    expect(dayNotePath(AT_1637, { folder: "", format: "YYYY.MM.DD" })).toBe("2024.01.02.md");
    expect(dayNotePath(AT_1637, { folder: "/", format: "YYYY.MM.DD" })).toBe("2024.01.02.md");
  });
});

describe("day keys", () => {
  it("formats the frontmatter key from a local date", () => {
    expect(dayKey(AT_1637)).toBe("2024-01-02");
  });

  it("reads a key back from either filename convention", () => {
    expect(dayKeyFromName("2026.10.27")).toBe("2026-10-27");
    expect(dayKeyFromName("2026-10-27")).toBe("2026-10-27");
    expect(dayKeyFromName("Meeting notes")).toBeNull();
  });

});

describe("entryDayLinkTarget", () => {
  it.each(["2026.11.02", "2026-11-02"])("omits same-day and historical dates in %s", (name) => {
    expect(entryDayLinkTarget("2026-11-02", name)).toBeNull();
    expect(entryDayLinkTarget(null, name)).toBeNull();
  });

  it.each([
    ["2026.11.02", "2026.11.05", "2026.11.01"],
    ["2026-11-02", "2026-11-05", "2026-11-01"]
  ])("labels earlier and later creation days in the style of %s", (name, later, earlier) => {
    expect(entryDayLinkTarget("2026-11-05", name)).toBe(later);
    expect(entryDayLinkTarget("2026-11-01", name)).toBe(earlier);
  });

  it("omits links without a day-note context", () => {
    expect(entryDayLinkTarget(null, "Meeting notes")).toBeNull();
    expect(entryDayLinkTarget("2026-11-05", "Meeting notes")).toBeNull();
  });
});

describe("dayFrontmatter", () => {
  it("carries the day and its three stats, and nothing else", () => {
    expect(dayFrontmatter("2026-10-26")).toBe(
      ["---", "date: 2026-10-26", "travels: 0", "depth: 0", "duration: 00:00:00", "---", ""].join("\n")
    );
  });
});

describe("resolveDayNote", () => {
  it("falls back to the settings when Daily Notes cannot be read", () => {
    const app = createApp([createFile("Chronomancer/2024.01.02.md", "")]);

    const resolved = resolveDayNote(app, DEFAULT_SETTINGS, AT_1637);
    expect(resolved.path).toBe("Chronomancer/2024.01.02.md");
    expect(resolved.file?.path).toBe("Chronomancer/2024.01.02.md");
  });

  it("reports a missing day note as null rather than inventing a file", () => {
    const resolved = resolveDayNote(createApp(), DEFAULT_SETTINGS, AT_1637);

    expect(resolved.path).toBe("Chronomancer/2024.01.02.md");
    expect(resolved.file).toBeNull();
  });

  it("prefers the Daily Notes configuration when it is readable", () => {
    const app = createApp([createFile("Journal/2024-01-02.md", "")]);
    // The harness App exposes the core-plugin slot for tests to fill in.
    const stub = app as unknown as { internalPlugins: unknown };
    stub.internalPlugins = {
      plugins: {
        "daily-notes": { instance: { options: { folder: "Journal", format: "YYYY-MM-DD" } } }
      }
    };

    expect(resolveDayNote(app, DEFAULT_SETTINGS, AT_1637).path).toBe("Journal/2024-01-02.md");
  });
});

describe("ensureDayNote", () => {
  it("creates the file with the day's frontmatter", async () => {
    const app = createApp();
    const file = await ensureDayNote(app, "Chronomancer/2024.01.02.md", AT_1637);

    expect(file.path).toBe("Chronomancer/2024.01.02.md");
    expect(fileContent(file)).toContain("travels: 0");
  });

  it("never overwrites a note that already exists", async () => {
    const existing = createFile("Chronomancer/2024.01.02.md", "{ 1.1.1 } - 10:00:00");
    const app = createApp([existing]);

    const file = await ensureDayNote(app, "Chronomancer/2024.01.02.md", AT_1637);
    expect(fileContent(file)).toBe("{ 1.1.1 } - 10:00:00");
  });
});
