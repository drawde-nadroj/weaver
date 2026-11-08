import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import WeaverPlugin from "../src/main";
import { parseEntries } from "../src/core/entries";
import { captureInstantAt, type CaptureRequest } from "../src/core/capture";
import { readAlignments } from "../src/core/alignments";
import { bodyQuery, createApp, fileContent, instantiatePlugin } from "../test-support/harness";
import { shimDocument } from "../test-support/dom";
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

function timingValue(kind: "beginning" | "duration"): string | null {
  const digits = bodyQuery(`.weaver-composer-state [data-kind="${kind}"] .weaver-composer-timing-digits`);
  return digits?.hasAttribute("hidden") ? "—" : digits?.textContent ?? null;
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

    instance.openLoom();
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

  it("ignores another submission while saving and retains the confirmed reading", async () => {
    const instance = await plugin();

    instance.openLoom();
    instance.controller.setText("one thought");
    const saving = instance.controller.settle();
    // A pending save cannot queue a hide, branch or second write.
    await instance.controller.settle();
    await saving;

    const created = noteOf(instance, mainPath("2026-11-05"));
    expect(parseEntries(created).entries).toHaveLength(1);
    expect(instance.controller.state.phase).toBe("resting");

    instance.onunload();
  });

  it("refocuses an existing draft and saved reading without starting another Thread", async () => {
    const instance = await plugin();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    Object.defineProperty(outside, "isConnected", { value: true });
    outside.focus = () => { shimDocument.activeElement = outside as unknown as typeof shimDocument.activeElement; };
    outside.focus();
    instance.openLoom();
    instance.controller.setText("one retained thought", { from: 4, to: 12 });
    const input = bodyQuery(".weaver-composer-prose .cm-content");

    outside.focus();
    instance.openLoom();
    expect(shimDocument.activeElement === input).toBe(true);
    expect(instance.controller.state.selection).toEqual({ from: 4, to: 12 });
    expect(instance.controller.state.text).toBe("one retained thought");

    bodyQuery(".weaver-composer-prose .cm-content")?.dispatch("keydown", { key: "Escape" });
    expect(instance.controller.state.collapsed).toBe(true);
    instance.openLoom();
    expect(instance.controller.state.collapsed).toBe(false);
    expect(instance.controller.state.selection).toEqual({ from: 4, to: 12 });

    // The destination popover is a front layer, never a panel: retrieving the
    // draft closes it and hands the caret back.
    bodyQuery(".weaver-composer-dest")?.click();
    expect(bodyQuery(".weaver-composer-dest-popover")?.hasAttribute("hidden")).toBe(false);
    instance.openLoom();
    expect(bodyQuery(".weaver-composer-dest-popover")?.hasAttribute("hidden")).toBe(true);
    expect(shimDocument.activeElement === input).toBe(true);

    await instance.controller.settle();
    const recorded = noteOf(instance, mainPath("2026-11-05"));
    const saved = instance.controller.state.selected;
    outside.focus();
    instance.openLoom();
    instance.openLoom();

    expect(instance.controller.state.phase).toBe("resting");
    expect(instance.controller.state.selected).toEqual(saved);
    expect(shimDocument.activeElement === input).toBe(true);
    expect(noteOf(instance, mainPath("2026-11-05"))).toBe(recorded);

    bodyQuery(".weaver-composer-prose .cm-content")?.dispatch("keydown", { key: "Escape" });
    expect(shimDocument.activeElement === outside as unknown).toBe(true);
    instance.onunload();
  });
});

describe("composer clock handoff", () => {
  it("records the visibly painted duration and beginning, not time spent saving", async () => {
    const instance = await plugin();
    instance.openLoom();
    instance.controller.setText("a timed thought");
    await vi.advanceTimersByTimeAsync(7400);
    const painted = timingValue("duration");
    expect(painted).toBe("00:00:07");
    expect(timingValue("beginning")).toBe("00:00:06");

    // No clock callback painted the time spent stalled before Enter.
    vi.setSystemTime(new Date(AT_2359.getTime() + 19_900));
    bodyQuery(".weaver-composer-save")?.click();
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();

    const source = noteOf(instance, mainPath("2026-11-05"));
    const entry = parseEntries(source).entries[0];
    expect(entry?.duration?.ms).toBe(7000);
    expect(entry?.day).toBe("2026-11-05");
    expect(entry?.time).toBe("23:59:59");
    expect(timingValue("duration")).toBe(painted);
    expect(timingValue("beginning")).toBe(entry?.time);
    instance.onunload();
  });

  it("refreshes the saved composer's clock when the note's clock row changes", async () => {
    const instance = await plugin();
    instance.openLoom();
    instance.controller.setText("a clock shared with its note");
    bodyQuery(".weaver-composer-save")?.click();
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
    expect(timingValue("duration")).toBe("00:00:00");
    expect(timingValue("beginning")).toBe("23:59:59");

    const file = instance.app.vault.getAbstractFileByPath(mainPath("2026-11-05"));
    if (file === null || !("extension" in file)) throw new Error("expected the saved note");
    await instance.app.vault.process(file as TFile, (source) =>
      source.replace("+ 00:00:00", "+ 00:02:14")
    );
    instance.app.vault.trigger("modify", file);
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();

    expect(timingValue("duration")).toBe("00:02:14");
    expect(timingValue("beginning")).toBe("23:59:59");

    // A changed moment no longer identifies the saved thought: do not keep
    // presenting the old stamp as if it still came from this note.
    await instance.app.vault.process(file as TFile, (source) =>
      source.replace("23:59:59", "23:58:43")
    );
    instance.app.vault.trigger("modify", file);
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
    expect(timingValue("duration")).toBe("—");
    expect(timingValue("beginning")).toBe("—");
    instance.onunload();
  });
});

describe("a branch written the next day", () => {
  it("stays in its parent's note and records its own new day", async () => {
    vi.setSystemTime(new Date(2026, 10, 5, 9, 0, 0));
    const instance = await plugin();

    // Yesterday's thought, written yesterday.
    instance.openLoom();
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

    instance.openLoom({ contextId: offered.occurrence.contextId });
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

    instance.openLoom({ contextId: offered.occurrence.contextId });
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
    instance.openLoom();
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

    instance.openLoom({ contextId: "ctx-spanish" });
    instance.controller.setText("una idea");
    await instance.controller.settle();

    expect(noteOf(instance, "Spanish/Daily/2026.11.05.md")).toContain("una idea");
    expect(noteOf(instance, mainPath("2026-11-05"))).toBe("");

    instance.onunload();
  });
});

describe("the write protocol", () => {
  const request = (text: string): CaptureRequest => ({
    contextId: "main",
    parent: null,
    text,
    beginning: captureInstantAt(AT_2359.getTime()),
    durationMs: 1000,
    portal: null
  });

  it("confirms a normal write and reports its receipt", async () => {
    const instance = await plugin();
    const out = await instance.entries.writeCapture(request("a protocol thought"), null, () => {});

    expect(out.kind).toBe("confirmed");
    if (out.kind === "confirmed") {
      expect(out.receipt.path).toBe(mainPath("2026-11-05"));
      expect(out.receipt.expected).toContain("a protocol thought");
    }
    expect(noteOf(instance, mainPath("2026-11-05"))).toContain("a protocol thought");

    instance.onunload();
  });

  it("refuses a retry whose target bytes changed, without writing", async () => {
    const instance = await plugin();
    const out = await instance.entries.writeCapture(
      request("should not land"),
      {
        operationId: "old-operation",
        path: mainPath("2026-11-05"),
        before: "bytes that are not in the note"
      },
      () => {}
    );

    expect(out.kind).toBe("refused");
    if (out.kind === "refused") expect(out.reason).toBe("retry-source-changed");
    expect(noteOf(instance, mainPath("2026-11-05"))).not.toContain("should not land");

    instance.onunload();
  });
});
