import { describe, expect, it } from "vitest";
import type { MarkdownPostProcessorContext, MarkdownRenderChild } from "obsidian";

import { createCloseProcessor } from "../src/reading/close-processor";
import { createEntryProcessor } from "../src/reading/entry-processor";
import { ShimElement } from "../test-support/dom";
import { EntryClock } from "../src/entries/clock";
import { EntrySession } from "../src/entries/session";

function context(sourcePath: string): MarkdownPostProcessorContext {
  return { sourcePath, frontmatter: {}, docId: "1", addChild: () => {} } as unknown as MarkdownPostProcessorContext;
}

function paragraph(parent: ShimElement, text: string): ShimElement {
  const element = parent.createEl("p");
  element.appendChild(document.createTextNode(text) as unknown as ShimElement);
  return element;
}

function container(): ShimElement {
  const root = document.createElement("div") as unknown as ShimElement;
  return root;
}

describe("the entry processor", () => {
  it("keeps adjacent unprocessed entry paragraphs in sibling frames", () => {
    const root = container();
    paragraph(root, "{ 1.1.1 }\nfirst\n+ 00:00:07 2026-11-05 22:55:00");
    paragraph(root, "{ 2.1.2 }\nsecond\n= 00:00:03 2026-11-05 23:00:00");
    createEntryProcessor()(root as never, context("Chronomancer/2026.11.05.md"));
    const frames = root.querySelectorAll(".weaver-frame");
    expect(frames.length).toBe(2);
    expect(frames.every(frame => frame.parentElement === root)).toBe(true);
    expect(frames[0]?.querySelector(".weaver-entry-prose")?.textContent).toBe("first");
    expect(frames[1]?.querySelector(".weaver-entry-prose")?.textContent).toBe("second");
    expect(frames[0]?.querySelector(".weaver-duration-clock")?.textContent).toBe("+ 00:00:07");
    expect(frames[1]?.querySelector(".weaver-duration-clock")?.textContent).toBe("= 00:00:03");
  });

  it.each(["+", "-"])("keeps a %s clock in its frame across Obsidian sections", (sigil) => {
    const source = `{ 15.1.29 }\nprose\n${sigil} 00:00:29 08:30:06`;
    const root = container();
    paragraph(root, "{ 15.1.29 }\nprose");
    const clockSection = container();
    clockSection.createEl("ul").createEl("li").setText("00:00:29 08:30:06");
    const sectionContext = (start: number, end: number): MarkdownPostProcessorContext => ({
      ...context("Chronomancer/2026.11.02.md"),
      getSectionInfo: () => ({ text: source, lineStart: start, lineEnd: end })
    });
    const process = createEntryProcessor();
    // Sections can arrive in either order, including a list before its marker.
    process(clockSection as never, sectionContext(2, 2));
    process(root as never, sectionContext(0, 1));
    const frame = root.querySelector(".weaver-frame");
    expect(frame?.lastChild?.hasClass("weaver-duration")).toBe(true);
    expect(frame?.querySelector(".weaver-duration-clock")?.textContent).toBe(`${sigil} 00:00:29`);
    expect(frame?.querySelector(".weaver-duration-moment")?.textContent).toBe("08:30:06");
    expect(clockSection.getAttr("hidden")).toBe("");

    const unrelated = container();
    unrelated.createEl("ul").createEl("li").setText("00:00:29 08:30:06");
    process(unrelated as never, {
      ...context("Chronomancer/2026.11.02.md"),
      getSectionInfo: () => ({ text: "+ 00:00:29 08:30:06", lineStart: 0, lineEnd: 0 })
    });
    expect(unrelated.getAttr("hidden")).toBeNull();
  });
  const PATH = "Chronomancer/2026.10.26.md";

  it("removes the marker's soft break without losing prose markup or later breaks", () => {
    const root = container();
    const p = paragraph(root, "{ 2.1.3 }");
    p.createEl("br");
    p.appendChild(document.createTextNode("\n") as unknown as ShimElement);
    p.createEl("strong").setText("first prose");
    p.createEl("br");
    p.appendChild(document.createTextNode("\nsecond line") as unknown as ShimElement);
    createEntryProcessor()(root as never, context(PATH));
    const prose = root.querySelector(".weaver-entry-prose");
    expect(prose?.querySelector("strong")?.textContent).toBe("first prose");
    expect(prose?.querySelectorAll("br").length).toBe(1);
    expect(prose?.textContent).toBe("first prose\nsecond line");
  });

  it("removes only the marker newline when soft breaks are rendered as text", () => {
    const root = container();
    paragraph(root, "{ 2.1.3 }\n\nfirst prose");
    createEntryProcessor()(root as never, context(PATH));
    expect(root.querySelector(".weaver-entry-prose")?.textContent).toBe("\nfirst prose");
  });

  it("turns a marker paragraph into the head, with the punctuation coloured", () => {
    const root = container();
    paragraph(root, "{ 2.1.3 }");

    createEntryProcessor()(root as never, context(PATH));

    const head = root.querySelector(".weaver-entry-head");
    expect(head).not.toBeNull();
    expect(head?.getAttr("style")).toBe("--weaver-dcolor:#ef4444;--weaver-d:1");
    expect(head?.querySelectorAll(".weaver-dcn-num").map((node) => node.textContent)).toEqual([
      "2",
      "1",
      "3"
    ]);
    expect(head?.querySelector(".weaver-dcn-ink")?.textContent).toBe("{ ");
    // The marker row is the top rail's label, in the file's own characters.
    expect(head?.hasClass("weaver-frame-label")).toBe(true);
    expect(head?.textContent).toBe("{ 2.1.3 }");
  });

  it("turns a clock paragraph into the rendered row", () => {
    const root = container();
    paragraph(root, "{ 2.1.3 }");
    paragraph(root, "+ 00:04:12 13:27:43");

    createEntryProcessor()(root as never, context(PATH));

    const row = root.querySelector(".weaver-duration");
    expect(row).not.toBeNull();
    // Both halves are three white digit spans around two coloured colons.
    expect(
      row?.querySelectorAll(".weaver-duration-moment .weaver-duration-num").map((n) => n.textContent)
    ).toEqual(["13", "27", "43"]);
    expect(
      row?.querySelectorAll(".weaver-duration-moment .weaver-duration-ink").map((n) => n.textContent)
    ).toEqual([":", ":"]);
    expect(row?.querySelector(".weaver-duration-moment")?.textContent).toBe("13:27:43");
    expect(row?.querySelector(".weaver-duration-sigil")?.textContent).toBe("+");
    expect(row?.querySelector(".weaver-duration-clock")?.textContent).toBe("+ 00:04:12");
    expect(
      row?.querySelectorAll(".weaver-duration-clock .weaver-duration-num").map((n) => n.textContent)
    ).toEqual(["00", "04", "12"]);
    expect(
      row?.querySelectorAll(".weaver-duration-clock .weaver-duration-ink").map((n) => n.textContent)
    ).toEqual([":", ":"]);
    expect(root.querySelectorAll("p").length).toBe(0);
  });

  it("keeps a whisper row as text, in the note's own colour", () => {
    const root = container();
    paragraph(root, "{ 2.1.3 }");
    paragraph(root, "~ learn: durable execution");

    createEntryProcessor()(root as never, context(PATH));

    const whisper = root.querySelector(".weaver-entry-whisper");
    expect(whisper).not.toBeNull();
    // Inside the frame, still the file's own characters, and never a prose row:
    // `.weaver-entry-prose` is what would paint it in the dimension's colour.
    expect(whisper?.parentElement?.hasClass("weaver-frame")).toBe(true);
    expect(whisper?.hasClass("weaver-entry-prose")).toBe(false);
    expect(whisper?.textContent).toBe("~ learn: durable execution");
  });

  it("draws a moment-only row without inventing a duration", () => {
    const root = container();
    paragraph(root, "{ 2.1.3 }");
    paragraph(root, "13:27:43");

    createEntryProcessor()(root as never, context(PATH));

    const row = root.querySelector(".weaver-duration");
    expect(row?.querySelector(".weaver-duration-moment")?.textContent).toBe("13:27:43");
    // No duration half in the file, none in the frame: no corner is labelled
    // with a value the note does not hold.
    expect(row?.querySelector(".weaver-duration-clock")).toBeNull();
  });

  it("labels the bottom rail at both corners", () => {
    const root = container();
    paragraph(root, "{ 2.1.3 }");
    paragraph(root, "the thought this one opened");
    paragraph(root, "+ 00:04:12 13:27:43");

    createEntryProcessor()(root as never, context(PATH));

    const frame = root.querySelector(".weaver-frame");
    expect(frame?.hasClass("is-static")).toBe(true);
    expect(frame?.getAttr("style")).toBe("--weaver-dcolor:#ef4444;--weaver-d:1");
    // The first child is the marker row, the last the clock row: each is the
    // label of the rail it sits on, so each cuts that rail behind itself.
    expect(frame?.firstChild?.hasClass("weaver-entry-head")).toBe(true);
    expect(frame?.firstChild?.hasClass("weaver-frame-label")).toBe(true);
    expect(frame?.firstChild?.textContent).toBe("{ 2.1.3 }");

    const row = frame?.lastChild;
    expect(row?.hasClass("weaver-duration")).toBe(true);
    // Two labels, one row: the duration at the left corner and the moment at the
    // right, with the rail itself left visible between them.
    expect(row?.querySelector(".weaver-duration-moment")?.hasClass("weaver-frame-label")).toBe(true);
    expect(row?.querySelector(".weaver-duration-clock")?.hasClass("weaver-frame-label")).toBe(true);
    // The prose is the interior; the marker and clock paragraphs are gone.
    expect(frame?.querySelectorAll(".weaver-entry-prose").length).toBe(1);
    expect(frame?.querySelectorAll("p").length).toBe(1);
    expect(root.querySelectorAll(".weaver-entry-prose").length).toBe(1);
  });

  it("keeps a title typed after the marker as the first prose line", () => {
    const root = container();
    paragraph(root, "{ 2.1.3 } a title");

    createEntryProcessor()(root as never, context(PATH));

    // The label is the canonical marker, never the title: a rail cannot ellipsize
    // away a line of the entry.
    expect(root.querySelector(".weaver-entry-head")?.textContent).toBe("{ 2.1.3 }");
    expect(root.querySelector(".weaver-entry-prose")?.textContent?.trim()).toBe("a title");
  });

  it("draws a clock with no entry above it as a plain block", () => {
    const root = container();
    paragraph(root, "+ 00:04:12");

    createEntryProcessor()(root as never, context(PATH));

    const row = root.querySelector(".weaver-duration");
    expect(row).not.toBeNull();
    // No rail to cut, so no label: a stray clock must not paint a band over the
    // text beside it.
    expect(row?.querySelector(".weaver-duration-moment")?.hasClass("weaver-frame-label")).toBe(
      false
    );
    expect(row?.querySelector(".weaver-duration-clock")?.hasClass("weaver-frame-label")).toBe(false);
  });

  it("marks the prose and keeps its markup", () => {
    const root = container();
    paragraph(root, "{ 2.1.3 }");
    const prose = paragraph(root, "");
    prose.createEl("strong").setText("bold");
    paragraph(root, "+ 00:04:12 13:27:43");

    createEntryProcessor()(root as never, context(PATH));

    expect(root.querySelector(".weaver-entry-prose")?.querySelector("strong")?.textContent).toBe("bold");
    // The clock row is an entry element, not prose.
    expect(root.querySelectorAll(".weaver-entry-prose").length).toBe(1);
  });

  it("opens a different creation day from the frame's top-right corner", () => {
    const root = container();
    paragraph(root, "{ 2.1.3 }");
    paragraph(root, "+ 00:04:12 2026-11-05 13:27:43");
    const opened: [string, string][] = [];

    createEntryProcessor((target, source) => {
      opened.push([target, source]);
    })(root as never, context(PATH));

    const link = root.querySelector(".weaver-entry-daylink");
    expect(link?.hasClass("weaver-frame-label")).toBe(true);
    expect(link?.textContent).toBe("[[2026.11.05]]");
    // It is a child of the frame, not of the shrink-wrapped head.
    expect(link?.parentElement?.hasClass("weaver-frame")).toBe(true);

    link?.click();
    expect(opened).toEqual([["2026.11.05", PATH]]);
  });

  it.each(["2026.11.02", "2026-11-02"])("omits same-day and historical dates in %s", (name) => {
    for (const clock of ["+ 00:01:00 10:00:00", "+ 00:01:00 2026-11-02 10:00:00"]) {
      const root = container();
      paragraph(root, "{ 2.1.3 }");
      paragraph(root, clock);
      createEntryProcessor()(root as never, context(`Chronomancer/${name}.md`));
      expect(root.querySelector(".weaver-entry-daylink")).toBeNull();
    }
  });

  it.each([
    ["2026.11.02", "2026.11.05"],
    ["2026-11-02", "2026-11-05"]
  ])("prefers the clock row's day in a %s note", (name, expected) => {
    const root = container();
    paragraph(root, "{ 2.1.3 }");
    paragraph(root, "+ 00:04:12 2026-11-05 13:27:43");

    createEntryProcessor()(root as never, context(`Chronomancer/${name}.md`));

    expect(root.querySelector(".weaver-entry-daylink")?.textContent).toBe(`[[${expected}]]`);
  });

  it("keeps mixed historical and newly dated entries on their own days", () => {
    const root = container();
    paragraph(root, "{ 2.1.3 }");
    paragraph(root, "old prose");
    paragraph(root, "+ 00:01:00 10:00:00");
    paragraph(root, "{ 2.1.4 }");
    paragraph(root, "new prose");
    paragraph(root, "+ 00:02:00 2026-11-05 10:00:00");

    createEntryProcessor()(root as never, context("Chronomancer/2026.11.02.md"));

    expect(root.querySelectorAll(".weaver-entry-daylink").map((link) => link.textContent)).toEqual([
      "[[2026.11.05]]"
    ]);
  });

  it.each([
    "+ 00:04:12 2026-11-05 13:27:43",
    "= 00:04:12 2026-11-05 13:27:43",
    "2026-11-05 13:27:43"
  ])("moves a contained clock onto the rail without repeating its date: %s", (clock) => {
    const root = container();
    paragraph(root, `{ 2.1.3 }\nprose\n${clock}`);

    createEntryProcessor()(root as never, context("Chronomancer/2026.11.02.md"));

    expect(root.querySelector(".weaver-entry-daylink")?.textContent).toBe("[[2026.11.05]]");
    expect(root.querySelector(".weaver-entry-prose")?.textContent).toBe("prose");
    expect(root.querySelector(".weaver-duration-moment")?.textContent).toBe("13:27:43");
  });

  it("extracts a paused row after a soft break without damaging prose markup", () => {
    const root = container();
    const p = paragraph(root, "{ 2.1.3 }");
    p.createEl("br");
    p.appendChild(document.createTextNode("\n") as unknown as ShimElement);
    p.createEl("strong").setText("prose");
    p.createEl("br");
    p.appendChild(document.createTextNode("\n= 00:04:12 2026-11-05 13:27:43") as unknown as ShimElement);
    createEntryProcessor()(root as never, context(PATH));
    expect(root.querySelector(".weaver-entry-prose")?.textContent).toBe("prose");
    expect(root.querySelector(".weaver-entry-prose strong")?.textContent).toBe("prose");
    expect(root.querySelector(".weaver-entry-prose br")).toBeNull();
    expect(root.querySelector(".weaver-duration-clock")?.textContent).toBe("= 00:04:12");
    expect(root.querySelector(".weaver-duration-moment")?.textContent).toBe("13:27:43");
  });

  it("reads a section's recorded day without waiting for its clock paragraph", () => {
    const source = "{ 2.1.3 }\nprose\n+ 00:04:12 2026-11-05 13:27:43";
    const root = container();
    paragraph(root, source);
    createEntryProcessor()(root as never, {
      ...context("Chronomancer/2026.11.02.md"),
      getSectionInfo: () => ({ text: source, lineStart: 0, lineEnd: 2 })
    });

    expect(root.querySelector(".weaver-entry-daylink")?.textContent).toBe("[[2026.11.05]]");
  });

  it("keeps the date out of the clock row", () => {
    const root = container();
    paragraph(root, "{ 2.1.3 }");
    paragraph(root, "+ 00:04:12 2026-11-05 13:27:43");

    createEntryProcessor()(root as never, context(PATH));

    const row = root.querySelector(".weaver-duration");
    expect(row?.querySelector(".weaver-duration-moment")?.textContent).toBe("13:27:43");
    // The date labels the top-right corner only; the row stays time.
    expect(row?.textContent).not.toContain("2026-11-05");
  });

  it("shows an awaiting wall clock without inventing a recorded day", () => {
    let now = new Date(2026, 10, 5, 23, 59, 58).getTime();
    const clock = new EntryClock(new EntrySession(), () => now);
    const root = container();
    paragraph(root, "{ 1.1.1 }");
    paragraph(root, "- 00:00:00");
    const children: MarkdownRenderChild[] = [];
    createEntryProcessor(undefined, clock)(root as never, {
      ...context("Chronomancer/2026.11.05.md"),
      addChild: (child) => { children.push(child); return child; }
    });
    for (const child of children) child.onload();
    expect(root.querySelector(".weaver-entry-daylink")).toBeNull();
    expect(root.querySelector(".weaver-duration-moment")?.textContent).toBe("23:59:58");
    now = new Date(2026, 10, 6, 0, 0, 3).getTime();
    clock.refresh();
    expect(root.querySelector(".weaver-duration-moment")?.textContent).toBe("00:00:03");
    for (const child of children) child.onunload();
    now += 1000;
    clock.refresh();
    expect(root.querySelector(".weaver-duration-moment")?.textContent).toBe("00:00:03");
    clock.destroy();
  });

  it("draws no day link on a note that is not a day", () => {
    for (const path of ["Chronomancer/notes.md", ""]) {
      const root = container();
      paragraph(root, "{ 2.1.3 }");
      paragraph(root, "+ 00:04:12 2026-11-05 13:27:43");
      createEntryProcessor()(root as never, context(path));
      expect(root.querySelector(".weaver-entry-daylink")).toBeNull();
    }
  });

  it("leaves a paragraph that is not an entry alone", () => {
    const root = container();
    paragraph(root, "just a thought");

    createEntryProcessor()(root as never, context(PATH));

    expect(root.querySelectorAll("p").length).toBe(1);
    expect(root.querySelector(".weaver-entry-head")).toBeNull();
  });
});

describe("the close processor", () => {
  it("styles the closing mark and labels it", () => {
    const root = container();
    const mark = paragraph(root, "✓ 17:30:00");

    createCloseProcessor()(root as never, context("Chronomancer/2026.10.26.md"));

    expect(mark.hasClass("weaver-close-mark")).toBe(true);
    expect(mark.getAttr("aria-label")).toBe("Day closed at 17:30:00");
  });

  it("ignores a ✓ that is not a close mark", () => {
    const root = container();
    const prose = paragraph(root, "✓ ok");

    createCloseProcessor()(root as never, context("Chronomancer/2026.10.26.md"));

    expect(prose.hasClass("weaver-close-mark")).toBe(false);
  });
});
