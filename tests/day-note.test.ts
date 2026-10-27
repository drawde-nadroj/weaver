import { describe, expect, it } from "vitest";

import {
  dayFrontmatter,
  dayKey,
  dayKeyFromName,
  dayNotePath,
  ensureDayNote,
  resolveDayNote
} from "../src/core/day-note";
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

describe("resolveDayNote", () => {
  it("falls back to the settings when Daily Notes cannot be read", () => {
    const app = createApp([createFile("Chronomancer/2024.01.02.md", "# 09:00 - x")]);

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
    (app as unknown as { internalPlugins: unknown }).internalPlugins = {
      plugins: {
        "daily-notes": { instance: { options: { folder: "Journal", format: "YYYY-MM-DD" } } }
      }
    };

    const resolved = resolveDayNote(app, DEFAULT_SETTINGS, AT_1637);
    expect(resolved.path).toBe("Journal/2024-01-02.md");
    expect(resolved.file).not.toBeNull();
  });

  it("survives an internal plugin shape it does not recognise", () => {
    const app = createApp();
    (app as unknown as { internalPlugins: unknown }).internalPlugins = { plugins: "nonsense" };

    expect(resolveDayNote(app, DEFAULT_SETTINGS, AT_1637).path).toBe(
      "Chronomancer/2024.01.02.md"
    );
  });
});

describe("ensureDayNote", () => {
  it("creates the folder and a frontmatter-only note", async () => {
    const app = createApp();

    const file = await ensureDayNote(app, "Chronomancer/2024.01.02.md", AT_1637);

    expect(file.path).toBe("Chronomancer/2024.01.02.md");
    expect(fileContent(file)).toBe(dayFrontmatter("2024-01-02"));
    expect(fileContent(file)).toBe(
      "---\ndate: 2024-01-02\nsparks: 0\ndimensions: 0\nsources: 0\n---\n"
    );
    expect((app.vault as unknown as { folders: string[] }).folders).toEqual(["Chronomancer"]);
  });

  it("never overwrites an existing day note", async () => {
    const existing = createFile("Chronomancer/2024.01.02.md", "# 09:00 - written\n");
    const app = createApp([existing]);

    const file = await ensureDayNote(app, existing.path, AT_1637);

    expect(fileContent(file)).toBe("# 09:00 - written\n");
  });

  it("creates a note with no folder when the path has none", async () => {
    const app = createApp();
    const file = await ensureDayNote(app, "2024.01.02.md", AT_1637);
    expect(file.path).toBe("2024.01.02.md");
  });
});
