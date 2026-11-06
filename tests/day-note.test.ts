import { describe, expect, it } from "vitest";

import { dayFrontmatter, dayKey, dayKeyFromName, dayNotePath, dayNotePathFor } from "../src/core/day";
import { ensureDayNote, resolveContextDay } from "../src/entries/day-note";
import { DEFAULT_SETTINGS, type WeaverSettings } from "../src/settings";
import { createApp, createFile, fileContent } from "../test-support/harness";

const AT_1637 = new Date(2024, 0, 2, 16, 37, 4);

const SPANISH = {
  id: "ctx-spanish",
  name: "Spanish",
  folder: "Spanish/Daily",
  format: "YYYY.MM.DD"
};

function settingsWith(contexts: unknown): WeaverSettings {
  return { ...DEFAULT_SETTINGS, contexts };
}

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

  it("expands an explicit day, so a save after midnight keeps its own", () => {
    expect(dayNotePathFor("2026-11-05", { folder: "Chronomancer", format: "YYYY.MM.DD" })).toBe(
      "Chronomancer/2026.11.05.md"
    );
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

describe("dayFrontmatter", () => {
  it("carries the day and its three stats, and nothing else", () => {
    expect(dayFrontmatter("2026-10-26")).toBe(
      ["---", "date: 2026-10-26", "travels: 0", "depth: 0", "duration: 00:00:00", "---", ""].join("\n")
    );
  });
});

describe("resolveContextDay", () => {
  it("falls back to the settings for main when Daily Notes cannot be read", () => {
    const app = createApp([createFile("Chronomancer/2024.01.02.md", "")]);

    const resolved = resolveContextDay(app, DEFAULT_SETTINGS, "main", "2024-01-02");
    expect(resolved.ok && resolved.path).toBe("Chronomancer/2024.01.02.md");
    expect(resolved.ok && resolved.file?.path).toBe("Chronomancer/2024.01.02.md");
  });

  it("reports a missing day note as null rather than inventing a file", () => {
    const resolved = resolveContextDay(createApp(), DEFAULT_SETTINGS, "main", "2024-01-02");

    expect(resolved.ok && resolved.path).toBe("Chronomancer/2024.01.02.md");
    expect(resolved.ok && resolved.file).toBeNull();
  });

  it("prefers the Daily Notes configuration for main when it is readable", () => {
    const app = createApp([createFile("Journal/2024-01-02.md", "")]);
    // The harness App exposes the core-plugin slot for tests to fill in.
    const stub = app as unknown as { internalPlugins: unknown };
    stub.internalPlugins = {
      plugins: {
        "daily-notes": { instance: { options: { folder: "Journal", format: "YYYY-MM-DD" } } }
      }
    };

    const resolved = resolveContextDay(app, DEFAULT_SETTINGS, "main", "2024-01-02");
    expect(resolved.ok && resolved.path).toBe("Journal/2024-01-02.md");
  });

  it("resolves an additional destination in its own folder above Daily Notes", () => {
    const app = createApp([createFile("Spanish/Daily/2024.01.02.md", "")]);
    const stub = app as unknown as { internalPlugins: unknown };
    stub.internalPlugins = {
      plugins: { "daily-notes": { instance: { options: { folder: "Journal", format: "YYYY-MM-DD" } } } }
    };

    const resolved = resolveContextDay(app, settingsWith([SPANISH]), SPANISH.id, "2024-01-02");
    expect(resolved.ok && resolved.path).toBe("Spanish/Daily/2024.01.02.md");
    expect(resolved.ok && resolved.file?.path).toBe("Spanish/Daily/2024.01.02.md");
  });

  it("never falls back to main for a destination it cannot find", () => {
    const missing = resolveContextDay(createApp(), DEFAULT_SETTINGS, "ctx-gone", "2024-01-02");
    expect(missing.ok).toBe(false);

    const unreadable = resolveContextDay(createApp(), settingsWith([{ id: "" }]), "ctx-x", "2024-01-02");
    expect(unreadable.ok).toBe(false);
  });

  it("creates nothing while resolving", () => {
    const app = createApp();
    resolveContextDay(app, settingsWith([SPANISH]), SPANISH.id, "2024-01-02");

    const vault = app.vault as unknown as { files: unknown[]; folders: string[] };
    expect(vault.files).toHaveLength(0);
    expect(vault.folders).toEqual([]);
  });

  it("recognises an older configured note for a cross-day link", () => {
    // A note written before the destination existed is still that day's note.
    const app = createApp([createFile("Spanish/Daily/2024.01.02.md", "")]);
    const resolved = resolveContextDay(app, settingsWith([SPANISH]), SPANISH.id, "2024-01-02");
    expect(resolved.ok && resolved.file?.path).toBe("Spanish/Daily/2024.01.02.md");
  });
});

describe("ensureDayNote", () => {
  it("creates the file with the day's frontmatter", async () => {
    const app = createApp();
    const file = await ensureDayNote(app, "Chronomancer/2024.01.02.md", "2024-01-02");

    expect(file.path).toBe("Chronomancer/2024.01.02.md");
    expect(fileContent(file)).toContain("travels: 0");
  });

  it("stamps the day it was given, not the day it happens to run on", async () => {
    const app = createApp();
    const file = await ensureDayNote(app, "Chronomancer/2026.11.05.md", "2026-11-05");

    expect(fileContent(file)).toContain("date: 2026-11-05");
  });

  it("creates every missing folder in order", async () => {
    const app = createApp();
    await ensureDayNote(app, "Spanish/Daily/2024.01.02.md", "2024-01-02");

    const vault = app.vault as unknown as { folders: string[] };
    expect(vault.folders).toEqual(["Spanish", "Spanish/Daily"]);
  });

  it("never overwrites a note that already exists", async () => {
    const existing = createFile("Chronomancer/2024.01.02.md", "{ 1.1.1 } - 10:00:00");
    const app = createApp([existing]);

    const file = await ensureDayNote(app, "Chronomancer/2024.01.02.md", "2024-01-02");
    expect(fileContent(file)).toBe("{ 1.1.1 } - 10:00:00");
  });

  it("accepts a concurrent create that won the race", async () => {
    const app = createApp();
    const vault = app.vault as unknown as {
      create: (path: string, data?: string) => Promise<unknown>;
    };
    const original = vault.create.bind(vault);
    // Another device's sync lands the file between the read and the create.
    vault.create = async (path: string) => {
      vault.create = original;
      await original(path, "{ 9.9.9 }");
      throw new Error("File already exists");
    };

    const file = await ensureDayNote(app, "Chronomancer/2024.01.02.md", "2024-01-02");
    expect(file.path).toBe("Chronomancer/2024.01.02.md");
    expect(fileContent(file)).toBe("{ 9.9.9 }");
  });
});
