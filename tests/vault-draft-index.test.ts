import { beforeEach, describe, expect, it } from "vitest";

import { VaultDraftIndex } from "../src/drafts/vault-index";
import type { App, TFile } from "obsidian";
import { createApp, createFile, resetHarness } from "../test-support/harness";

function draftBlockText(id: string, openedAt: string, title: string): string {
  return `⟪draft ${id} ${openedAt}⟫\n${title}\n⟪/draft ${id}⟫`;
}

interface Counter {
  reads: string[];
}

function countingVault(app: App): Counter {
  const counter: Counter = { reads: [] };
  const vault = app.vault as unknown as {
    cachedRead(file: TFile): Promise<string>;
  };
  const original = vault.cachedRead.bind(vault);
  vault.cachedRead = (file: TFile) => {
    counter.reads.push(file.path);
    return original(file);
  };
  return counter;
}

function indexFor(app: App): VaultDraftIndex {
  return new VaultDraftIndex(app, () => 12);
}

beforeEach(() => {
  resetHarness();
});

describe("VaultDraftIndex.openDrafts", () => {
  it("returns drafts from every file, newest first", async () => {
    const early = createFile(
      "a.md",
      `# Root\n${draftBlockText("2.1", "2026-10-26 16:37:04", "early")}`
    );
    const late = createFile(
      "b.md",
      `# Root\n${draftBlockText("2.1", "2026-10-26 17:02:00", "late")}\n\n${draftBlockText(
        "2.2",
        "2026-10-26 16:50:00",
        "middle"
      )}`
    );
    const app = createApp([early, late]);

    const entries = await indexFor(app).openDrafts();

    expect(entries.map((entry) => [entry.draft.title, entry.file.path])).toEqual([
      ["late", "b.md"],
      ["middle", "b.md"],
      ["early", "a.md"]
    ]);
  });

  it("reuses the mtime cache on a second scan", async () => {
    const file = createFile("a.md", draftBlockText("2.1", "2026-10-26 16:37:04", "cached"));
    const app = createApp([file]);
    const counter = countingVault(app);
    const index = indexFor(app);

    await index.openDrafts();
    expect(counter.reads).toHaveLength(1);

    await index.openDrafts();
    expect(counter.reads).toHaveLength(1);

    await index.openDrafts(true);
    expect(counter.reads).toHaveLength(2);
  });

  it("re-reads a file whose mtime changed", async () => {
    const file = createFile("a.md", draftBlockText("2.1", "2026-10-26 16:37:04", "before"));
    const app = createApp([file]);
    const counter = countingVault(app);
    const index = indexFor(app);

    await index.openDrafts();
    expect(counter.reads).toHaveLength(1);

    (file as unknown as { content: string }).content = draftBlockText(
      "2.1",
      "2026-10-26 16:37:04",
      "after"
    );
    file.stat.mtime += 1;

    const entries = await index.openDrafts();
    expect(counter.reads).toHaveLength(2);
    expect(entries[0]?.draft.title).toBe("after");
  });

  it("drops the drafts of a deleted file", async () => {
    const keep = createFile("keep.md", draftBlockText("2.1", "2026-10-26 16:37:04", "keep"));
    const gone = createFile("gone.md", draftBlockText("2.2", "2026-10-26 16:40:00", "gone"));
    const app = createApp([keep, gone]);
    const index = indexFor(app);

    expect(await index.openDrafts()).toHaveLength(2);

    const vault = app.vault as unknown as { files: TFile[] };
    vault.files = vault.files.filter((file) => file.path !== "gone.md");

    const entries = await index.openDrafts();
    expect(entries.map((entry) => entry.draft.title)).toEqual(["keep"]);
  });

  it("skips a file over the size cap", async () => {
    const big = createFile("big.md", draftBlockText("2.1", "2026-10-26 16:37:04", "huge"));
    big.stat.size = 2_000_001;
    const small = createFile("small.md", draftBlockText("2.2", "2026-10-26 16:40:00", "tiny"));
    const app = createApp([big, small]);

    const entries = await indexFor(app).openDrafts();

    expect(entries.map((entry) => entry.draft.title)).toEqual(["tiny"]);
  });

  it("returns nothing for a vault with no drafts", async () => {
    const app = createApp([createFile("plain.md", "# Root\nbody")]);
    expect(await indexFor(app).openDrafts()).toEqual([]);
  });

  it("ignores markers that are not closed or are inside a fence", async () => {
    const app = createApp([
      createFile(
        "note.md",
        [
          "```",
          draftBlockText("2.1", "2026-10-26 16:37:04", "fenced"),
          "```",
          "",
          "⟪draft 2.2 2026-10-26 16:40:00⟫",
          "unclosed"
        ].join("\n")
      )
    ]);

    expect(await indexFor(app).openDrafts()).toEqual([]);
  });
});

describe("VaultDraftIndex lifecycle", () => {
  it("keeps the previous results when a scan throws", async () => {
    const file = createFile("a.md", draftBlockText("2.1", "2026-10-26 16:37:04", "kept"));
    const app = createApp([file]);
    const index = indexFor(app);

    const first = await index.openDrafts();
    expect(first).toHaveLength(1);

    const vault = app.vault as unknown as { cachedRead(): Promise<string> };
    vault.cachedRead = () => Promise.reject(new Error("disk on fire"));

    const second = await index.openDrafts(true);
    expect(second.map((entry) => entry.draft.title)).toEqual(["kept"]);
  });

  it("clears its cache on stop", async () => {
    const file = createFile("a.md", draftBlockText("2.1", "2026-10-26 16:37:04", "one"));
    const app = createApp([file]);
    const counter = countingVault(app);
    const index = indexFor(app);

    index.start();
    await index.openDrafts();
    const afterFirst = counter.reads.length;

    index.stop();
    await index.openDrafts();
    expect(counter.reads.length).toBe(afterFirst + 1);
  });
});
