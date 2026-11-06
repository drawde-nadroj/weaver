import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import WeaverPlugin from "../src/main";
import { parseEntries } from "../src/core/entries";
import { readAlignments } from "../src/core/alignments";
import { createApp, fileContent, instantiatePlugin } from "../test-support/harness";
import type { TFile } from "obsidian";

/**
 * The whole write path, end to end: a composer draft, the one engine write, and
 * the bytes that end up in a day note.
 *
 * The clock is held still, so the interesting cases — a thought begun before
 * midnight and settled after it, a branch written the next day — are facts the
 * test can assert rather than races it hopes for.
 */

const AT_2359 = new Date(2026, 10, 5, 23, 59, 59);
const AT_0000 = new Date(2026, 10, 6, 0, 0, 30);

/** A day note for a given day, in `main`'s configured format. */
function mainPath(day: string): string {
  return `Chronomancer/${day.replace(/-/g, ".")}.md`;
}

async function plugin(app = createApp()): Promise<WeaverPlugin> {
  const instance = instantiatePlugin(WeaverPlugin, app);
  await instance.onload();
  return instance;
}

function noteOf(instance: WeaverPlugin, path: string): string {
  const file = instance.app.vault.getAbstractFileByPath(path);
  return fileContent(file as TFile | null);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AT_2359);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a thought begun before midnight", () => {
  it("is filed in its own day's note, with the moment it began", async () => {
    const instance = await plugin();

    instance.openComposer();
    instance.controller.setText("begun at the last second");

    // The save happens half a minute after midnight.
    vi.setSystemTime(AT_0000);
    instance.controller.commitDuration(7000);
    await instance.controller.settle();

    const created = noteOf(instance, mainPath("2026-11-05"));
    expect(created).toContain("begun at the last second");
    expect(created).toContain("date: 2026-11-05");
    // The note for the *next* day was never touched.
    expect(noteOf(instance, mainPath("2026-11-06"))).toBe("");

    const entry = parseEntries(created).entries[0];
    expect(entry?.day).toBe("2026-11-05");
    expect(entry?.time).toBe("23:59:59");
    expect(entry?.duration?.ms).toBe(7000);
    expect(entry?.state).toBe("settled");
    expect(instance.controller.state.phase).toBe("resting");

    instance.onunload();
  });

  it("writes exactly one entry, however many times Enter is pressed", async () => {
    const instance = await plugin();

    instance.openComposer();
    instance.controller.setText("one thought");
    const saving = instance.controller.settle();
    // A distinct second Enter during the save dismisses, and writes nothing more.
    await instance.controller.settle();
    await saving;

    const created = noteOf(instance, mainPath("2026-11-05"));
    expect(parseEntries(created).entries).toHaveLength(1);
    expect(instance.controller.state.phase).toBe("closed");

    instance.onunload();
  });
});

describe("a branch written the next day", () => {
  it("stays in its parent's note and records its own new day", async () => {
    vi.setSystemTime(new Date(2026, 10, 5, 9, 0, 0));
    const instance = await plugin();

    // Yesterday's thought, written yesterday.
    instance.openComposer();
    instance.controller.setText("the first thought");
    await instance.controller.settle();

    const yesterday = parseEntries(noteOf(instance, mainPath("2026-11-05")));
    const root = yesterday.entries[0];
    if (root === undefined) throw new Error("expected the first thought");
    const path = mainPath("2026-11-05");
    const parent = {
      path,
      n: root.n,
      b: root.b,
      d: root.d,
      rootN: root.n,
      day: root.day,
      time: root.time,
      prose: "the first thought"
    };

    // Today, a branch under it.
    vi.setSystemTime(new Date(2026, 10, 6, 8, 30, 0));
    await instance.controller.branch(parent);
    instance.controller.setText("a branch from yesterday");
    await instance.controller.settle();

    const written = parseEntries(noteOf(instance, path));
    expect(written.entries).toHaveLength(2);

    const child = written.entries[1];
    expect(child?.d).toBe(2);
    expect(child?.b).toBe(root.b);
    expect(child?.day).toBe("2026-11-06");
    expect(child?.time).toBe("08:30:00");
    // The file it lives in is still yesterday's.
    expect(noteOf(instance, mainPath("2026-11-06"))).toBe("");

    instance.onunload();
  });
});

describe("an invitation that was really answered", () => {
  it("records its evidence in the same write as the entry", async () => {
    const instance = await plugin();
    instance.settings.portalsEnabled = true;
    instance.settings.rhythmicPortalsEnabled = false;
    instance.settings.portalSchedules = [
      {
        id: "morning",
        name: "Morning",
        contextId: "main",
        enabled: true,
        createdAt: new Date(2026, 10, 5, 0, 0, 0).getTime(),
        leadMinutes: 11,
        when: { kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], hour: 23, minute: 59 }
      }
    ];

    // The opening is minute-aligned; type on its boundary second.
    vi.setSystemTime(new Date(2026, 10, 5, 23, 59, 0, 0));
    instance.portals.reconcile();
    const offered = instance.portals.outstanding()[0];
    if (offered === undefined) throw new Error("expected an invitation");

    instance.openComposer({ contextId: offered.occurrence.contextId });
    expect(instance.controller.state.contextId).toBe("main");
    instance.controller.setText("woven into the opening");
    await instance.controller.settle();

    const note = noteOf(instance, mainPath("2026-11-05"));
    const records = readAlignments(note);
    if (!records.ok) throw new Error(records.error);
    expect(records.records).toHaveLength(1);
    expect(records.records[0]?.portal).toBe(offered.occurrence.portal.id);
    expect(records.records[0]?.entry).toBe(1);

    instance.onunload();
  });

  it("leaves an invitation unspent when the draft is only collapsed", async () => {
    const instance = await plugin();
    instance.settings.rhythmicPortalsEnabled = false;
    instance.settings.portalSchedules = [
      {
        id: "morning",
        name: "Morning",
        contextId: "main",
        enabled: true,
        createdAt: new Date(2026, 10, 5, 0, 0, 0).getTime(),
        leadMinutes: 11,
        when: { kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], hour: 23, minute: 59 }
      }
    ];

    vi.setSystemTime(new Date(2026, 10, 5, 23, 59, 0, 0));
    instance.portals.reconcile();
    const offered = instance.portals.outstanding()[0];
    if (offered === undefined) throw new Error("expected an invitation");

    instance.openComposer({ contextId: offered.occurrence.contextId });
    instance.controller.setText("not finished");
    instance.controller.collapse();
    instance.portals.reconcile();

    // Still outstanding: an unanswered offer is not a spent one.
    expect(instance.portals.outstanding()).toHaveLength(1);
    expect(noteOf(instance, mainPath("2026-11-05"))).toBe("");

    instance.onunload();
  });
});

describe("the one draft", () => {
  it("survives a reload, folded and paused, and was never written", async () => {
    const instance = await plugin();
    instance.openComposer();
    instance.controller.setText("half a thought");
    instance.controller.commitDuration(12_000);
    instance.controller.collapse();

    // A second load over the same local storage is what a restart looks like.
    expect(noteOf(instance, mainPath("2026-11-05"))).toBe("");
    const recovered = await plugin(instance.app);
    recovered.controller.recover();

    expect(recovered.controller.state.text).toBe("half a thought");
    expect(recovered.controller.state.collapsed).toBe(true);
    expect(recovered.controller.state.durationMs).toBe(12_000);
    expect(noteOf(recovered, mainPath("2026-11-05"))).toBe("");

    recovered.onunload();
    instance.onunload();
  });
});

describe("two destinations", () => {
  it("files each thought where it was composed, not where the screen is", async () => {
    const instance = await plugin();
    instance.settings.contexts = [
      { id: "ctx-spanish", name: "Spanish", folder: "Spanish/Daily", format: "YYYY.MM.DD" }
    ];

    instance.openComposer({ contextId: "ctx-spanish" });
    instance.controller.setText("una idea");
    await instance.controller.settle();

    expect(noteOf(instance, "Spanish/Daily/2026.11.05.md")).toContain("una idea");
    expect(noteOf(instance, mainPath("2026-11-05"))).toBe("");

    instance.onunload();
  });
});
