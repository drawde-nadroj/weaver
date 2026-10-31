import { describe, expect, it } from "vitest";
import type { MarkdownPostProcessorContext } from "obsidian";

import { createCloseProcessor } from "../src/reading/close-processor";
import { createEntryProcessor } from "../src/reading/entry-processor";
import { ShimElement } from "../test-support/dom";

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
  const PATH = "Chronomancer/2026.10.26.md";

  it("turns a marker paragraph into the head, with the punctuation coloured", () => {
    const root = container();
    paragraph(root, "{ 1.2.3 }");

    createEntryProcessor()(root as never, context(PATH));

    const head = root.querySelector(".weaver-entry-head");
    expect(head).not.toBeNull();
    expect(head?.getAttr("style")).toBe("--weaver-dcolor:#ef4444;--weaver-d:1");
    expect(head?.querySelectorAll(".weaver-dcn-num").map((node) => node.textContent)).toEqual([
      "1",
      "2",
      "3"
    ]);
    expect(head?.querySelector(".weaver-dcn-ink")?.textContent).toBe("{ ");
    // The marker row is the top rail's label, in the file's own characters.
    expect(head?.hasClass("weaver-frame-label")).toBe(true);
    expect(head?.textContent).toBe("{ 1.2.3 }");
  });

  it("turns a clock paragraph into the rendered row", () => {
    const root = container();
    paragraph(root, "{ 1.2.3 }");
    paragraph(root, "13:27:43 + 00:04:12");

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
    paragraph(root, "{ 1.2.3 }");
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
    paragraph(root, "{ 1.2.3 }");
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
    paragraph(root, "{ 1.2.3 }");
    paragraph(root, "the thought this one opened");
    paragraph(root, "13:27:43 + 00:04:12");

    createEntryProcessor()(root as never, context(PATH));

    const frame = root.querySelector(".weaver-frame");
    expect(frame?.hasClass("is-static")).toBe(true);
    expect(frame?.getAttr("style")).toBe("--weaver-dcolor:#ef4444;--weaver-d:1");
    // The first child is the marker row, the last the clock row: each is the
    // label of the rail it sits on, so each cuts that rail behind itself.
    expect(frame?.firstChild?.hasClass("weaver-entry-head")).toBe(true);
    expect(frame?.firstChild?.hasClass("weaver-frame-label")).toBe(true);
    expect(frame?.firstChild?.textContent).toBe("{ 1.2.3 }");

    const row = frame?.lastChild;
    expect(row?.hasClass("weaver-duration")).toBe(true);
    // Two labels, one row: the moment at the left corner and the duration at the
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
    paragraph(root, "{ 1.2.3 } a title");

    createEntryProcessor()(root as never, context(PATH));

    // The label is the canonical marker, never the title: a rail cannot ellipsize
    // away a line of the entry.
    expect(root.querySelector(".weaver-entry-head")?.textContent).toBe("{ 1.2.3 }");
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
    paragraph(root, "{ 1.2.3 }");
    const prose = paragraph(root, "");
    prose.createEl("strong").setText("bold");
    paragraph(root, "13:27:43 + 00:04:12");

    createEntryProcessor()(root as never, context(PATH));

    expect(root.querySelector(".weaver-entry-prose")?.querySelector("strong")?.textContent).toBe("bold");
    // The clock row is an entry element, not prose.
    expect(root.querySelectorAll(".weaver-entry-prose").length).toBe(1);
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
