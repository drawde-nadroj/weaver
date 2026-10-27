import { describe, expect, it } from "vitest";

import {
  allocateDraftId,
  draftBlockText,
  draftContainsLine,
  draftElapsed,
  draftId,
  formatDraftOpened,
  parseDraftClose,
  parseDraftOpen,
  parseDrafts,
  weaveDraftText,
  type DraftBlock
} from "../src/core/drafts";
import { parseHeadings } from "../src/core/headings";
import type { InsertOptions } from "../src/core/insert";

const OPTIONS: InsertOptions = { maxDepth: 12, separator: " - ", format: "HH:mm:ss" };

const OPENED = "2026-10-26 16:37:04";

function draftSource(title: string, body = ""): string {
  return draftBlockText({ id: "2.1", openedAt: OPENED, title, body });
}

function only(source: string, maxDepth = 12): DraftBlock {
  const drafts = parseDrafts(source, maxDepth);
  expect(drafts).toHaveLength(1);
  return drafts[0]!;
}

describe("marker grammars", () => {
  it("parses an open marker and normalises a missing seconds field", () => {
    expect(parseDraftOpen(`⟪draft 3.2 ${OPENED}⟫`)).toEqual({
      level: 3,
      ordinal: 2,
      openedAt: OPENED
    });
    expect(parseDraftOpen("⟪draft 3.2 2026-10-26 16:37⟫")?.openedAt).toBe("2026-10-26 16:37:00");
    expect(parseDraftOpen("   ⟪draft 1.12 2026-10-26 16:37:04⟫   ")).toEqual({
      level: 1,
      ordinal: 12,
      openedAt: OPENED
    });
  });

  it("rejects near-miss markers", () => {
    expect(parseDraftOpen("⟪draft 3⟫")).toBeNull();
    expect(parseDraftOpen("⟪draft 3.2⟫")).toBeNull();
    expect(parseDraftOpen("⟪draft 3.2 26-10-26 16:37:04⟫")).toBeNull();
    expect(parseDraftOpen("⟪draft 123.2 2026-10-26 16:37:04⟫")).toBeNull();
    expect(parseDraftOpen("text ⟪draft 3.2 2026-10-26 16:37:04⟫")).toBeNull();
    expect(parseDraftClose("⟪draft 3.2⟫")).toBeNull();
  });

  it("parses a close marker", () => {
    expect(parseDraftClose("⟪/draft 3.2⟫")).toEqual({ level: 3, ordinal: 2 });
    expect(parseDraftClose("  ⟪/draft 3.2⟫  ")).toEqual({ level: 3, ordinal: 2 });
  });

  it("builds the exact block text and round-trips it", () => {
    const text = draftBlockText({
      id: "2.1",
      openedAt: OPENED,
      title: "Half-formed thought",
      body: "body of the thought"
    });
    expect(text).toBe(
      `⟪draft 2.1 ${OPENED}⟫\nHalf-formed thought\nbody of the thought\n⟪/draft 2.1⟫`
    );

    const draft = only(text);
    expect(draft.id).toBe("2.1");
    expect(draft.level).toBe(2);
    expect(draft.ordinal).toBe(1);
    expect(draft.openedAt).toBe(OPENED);
    expect(draft.title).toBe("Half-formed thought");
    expect(draft.body).toBe("body of the thought");
    expect(draft.openLine).toBe(0);
    expect(draft.closeLine).toBe(3);
    expect(draft.titleLine).toBe(1);
    expect(draft.bodyFrom).toBe(2);
    expect(draft.bodyTo).toBe(3);
    expect(text.slice(draft.from, draft.to)).toBe(text);
  });

  it("keeps a blank title line for an empty title", () => {
    const text = draftBlockText({ id: "2.1", openedAt: OPENED, title: "", body: "" });
    expect(text).toBe(`⟪draft 2.1 ${OPENED}⟫\n\n⟪/draft 2.1⟫`);

    const draft = only(text);
    expect(draft.title).toBe("");
    expect(draft.body).toBe("");
    expect(draft.titleLine).toBe(1);
    expect(draft.bodyFrom).toBe(draft.bodyTo);
  });

  it("right-trims only", () => {
    const draft = only(`⟪draft 2.1 ${OPENED}⟫\n  spaced title  \n  body  \n⟪/draft 2.1⟫`);
    expect(draft.title).toBe("  spaced title");
    expect(draft.body).toBe("  body");
  });

  it("reports absolute offsets that cover both marker lines", () => {
    const source = `# 09:00 Root\n${draftSource("Title", "body")}\n`;
    const draft = only(source);
    expect(source.slice(draft.from, draft.to)).toBe(draftSource("Title", "body"));
    expect(draft.titleFrom).toBe(source.indexOf("Title"));
    expect(draft.closeFrom).toBe(source.indexOf("⟪/draft 2.1⟫"));
  });
});

describe("parseDrafts", () => {
  it("finds several drafts in document order", () => {
    const source = [
      `⟪draft 2.1 ${OPENED}⟫`,
      "first",
      "⟪/draft 2.1⟫",
      "",
      `⟪draft 2.2 2026-10-26 16:40:00⟫`,
      "second",
      "⟪/draft 2.2⟫"
    ].join("\n");

    expect(parseDrafts(source, 12).map((draft) => draft.id)).toEqual(["2.1", "2.2"]);
  });

  it("ignores a marker without a matching close line", () => {
    const source = `⟪draft 2.1 ${OPENED}⟫\ntitle\n\nbody text`;
    expect(parseDrafts(source, 12)).toEqual([]);

    const index = parseHeadings(source, { maxDepth: 12 });
    expect(index.drafts).toEqual([]);
    expect(index.headings).toEqual([]);
  });

  it("ignores a close line that belongs to another id", () => {
    const source = `⟪draft 2.1 ${OPENED}⟫\ntitle\n⟪/draft 2.2⟫\n⟪/draft 2.1⟫`;
    const draft = only(source);
    expect(draft.closeLine).toBe(3);
    expect(draft.body).toBe("⟪/draft 2.2⟫");
  });

  it("treats a nested open marker as body text", () => {
    const source = [
      `⟪draft 2.1 ${OPENED}⟫`,
      "outer",
      `⟪draft 2.2 ${OPENED}⟫`,
      "inner",
      "⟪/draft 2.2⟫",
      "⟪/draft 2.1⟫"
    ].join("\n");

    const drafts = parseDrafts(source, 12);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.id).toBe("2.1");
    expect(drafts[0]?.body).toBe([`⟪draft 2.2 ${OPENED}⟫`, "inner", "⟪/draft 2.2⟫"].join("\n"));
  });

  it("ignores markers inside a fenced code block", () => {
    const source = ["```", `⟪draft 2.1 ${OPENED}⟫`, "title", "⟪/draft 2.1⟫", "```"].join("\n");
    expect(parseDrafts(source, 12)).toEqual([]);

    const tildes = ["~~~", `⟪draft 2.1 ${OPENED}⟫`, "t", "⟪/draft 2.1⟫", "~~~"].join("\n");
    expect(parseDrafts(tildes, 12)).toEqual([]);
  });

  it("ignores markers inside frontmatter", () => {
    const source = ["---", `⟪draft 2.1 ${OPENED}⟫`, "title", "⟪/draft 2.1⟫", "---", "body"].join(
      "\n"
    );
    expect(parseDrafts(source, 12)).toEqual([]);

    const unclosed = ["---", `⟪draft 2.1 ${OPENED}⟫`, "title", "⟪/draft 2.1⟫"].join("\n");
    expect(parseDrafts(unclosed, 12)).toEqual([]);
  });

  it("accepts a draft after closed frontmatter", () => {
    const source = ["---", "title: x", "---", draftSource("T")].join("\n");
    expect(only(source).title).toBe("T");
  });

  it("rejects a level beyond maxDepth", () => {
    const source = draftBlockText({ id: "9.1", openedAt: OPENED, title: "T", body: "" });
    expect(parseDrafts(source, 6)).toEqual([]);
    expect(only(source, 12).level).toBe(9);
  });

  it("handles adjacent markers with no title line", () => {
    const draft = only(`⟪draft 2.1 ${OPENED}⟫\n⟪/draft 2.1⟫`);
    expect(draft.title).toBe("");
    expect(draft.body).toBe("");
    expect(draft.titleLine).toBe(1);
  });

  it("indexes drafts alongside headings without adding heading entries", () => {
    const index = parseHeadings(`# 09:00 Root\n${draftSource("T", "b")}`, { maxDepth: 12 });
    expect(index.headings).toHaveLength(1);
    expect(index.drafts).toHaveLength(1);
    expect(draftContainsLine(index.drafts[0]!, 1)).toBe(true);
    expect(draftContainsLine(index.drafts[0]!, 4)).toBe(true);
    expect(draftContainsLine(index.drafts[0]!, 5)).toBe(false);
    expect(draftContainsLine(index.drafts[0]!, 0)).toBe(false);
  });
});

describe("id allocation", () => {
  it("builds ids from level and ordinal", () => {
    expect(draftId(3, 2)).toBe("3.2");
  });

  it("bumps the ordinal on collision", () => {
    expect(allocateDraftId(2, 1, [])).toBe("2.1");
    expect(allocateDraftId(2, 1, ["2.1"])).toBe("2.2");
    expect(allocateDraftId(2, 1, ["2.1", "2.2", "2.4"])).toBe("2.3");
    expect(allocateDraftId(2, 3, ["3.3"])).toBe("2.3");
    expect(allocateDraftId(2, 1, ["2.1", "2.2", "2.3"])).toBe("2.4");
  });

  it("never returns an ordinal below one", () => {
    expect(allocateDraftId(1, 0, [])).toBe("1.1");
  });
});

describe("weaveDraftText", () => {
  const now = new Date(2026, 9, 26, 17, 2, 3);

  it("stamps a heading with time and title", () => {
    const draft = only(draftSource("Half-formed thought"));
    expect(weaveDraftText(draft, OPTIONS, now)).toBe("## 17:02:03 - Half-formed thought");
  });

  it("keeps a trailing space without a title", () => {
    const draft = only(draftSource(""));
    expect(weaveDraftText(draft, OPTIONS, now)).toBe("## 17:02:03 ");
  });

  it("appends the body on the next line", () => {
    const draft = only(draftSource("Title", "line one\nline two"));
    expect(weaveDraftText(draft, OPTIONS, now)).toBe("## 17:02:03 - Title\nline one\nline two");
  });

  it("uses the configured separator and clock format", () => {
    const draft = only(draftSource("Title"));
    const options: InsertOptions = { maxDepth: 12, separator: " · ", format: "HH:mm" };
    expect(weaveDraftText(draft, options, now)).toBe("## 17:02 · Title");
  });
});

describe("draftElapsed", () => {
  const draft = only(draftSource("T"));
  const opened = new Date(2026, 9, 26, 16, 37, 4);

  function at(offsetSeconds: number): string {
    return draftElapsed(draft, new Date(opened.getTime() + offsetSeconds * 1000));
  }

  it("formats the boundaries", () => {
    expect(at(0)).toBe("+00:00");
    expect(at(59)).toBe("+00:59");
    expect(at(60)).toBe("+01:00");
    expect(at(3600)).toBe("+1:00:00");
    expect(at(3661)).toBe("+1:01:01");
    expect(at(12 * 3600)).toBe("+12:00:00");
  });

  it("reports stale for a negative or very old difference", () => {
    expect(at(-1)).toBe("stale");
    expect(at(12 * 3600 + 1)).toBe("stale");
  });

  it("reports stale for an unparseable marker", () => {
    expect(draftElapsed({ ...draft, openedAt: "nonsense" }, new Date())).toBe("stale");
  });
});

describe("formatDraftOpened", () => {
  it("writes a fixed-width local datetime", () => {
    expect(formatDraftOpened(new Date(2026, 9, 26, 16, 37, 4))).toBe(OPENED);
    expect(formatDraftOpened(new Date(2026, 0, 2, 3, 4, 5))).toBe("2026-01-02 03:04:05");
  });
});
