import { describe, expect, it } from "vitest";
import type { MarkdownPostProcessorContext } from "obsidian";

import { createCloseProcessor } from "../src/reading/close-processor";
import { createEntryProcessor } from "../src/reading/entry-processor";
import { DEFAULT_SETTINGS } from "../src/settings";
import type WeaverPlugin from "../src/main";
import { ShimElement } from "../test-support/dom";

/** A plugin stand-in: the processors read settings and open links, nothing else. */
function host(overrides: Partial<typeof DEFAULT_SETTINGS> = {}): WeaverPlugin {
  const opened: string[] = [];
  const stub = {
    settings: { ...DEFAULT_SETTINGS, ...overrides },
    app: {
      workspace: {
        openLinkText: (target: string) => {
          opened.push(target);
          return Promise.resolve();
        }
      }
    },
    opened
  };
  return stub as unknown as WeaverPlugin;
}

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
    paragraph(root, "{ 1.2.3 } - 13:27:43");

    createEntryProcessor(host({ entryDayLink: false }))(root as never, context(PATH));

    const head = root.querySelector(".weaver-entry-head");
    expect(head).not.toBeNull();
    expect(head?.getAttr("style")).toBe("--weaver-dcolor:#ef4444;--weaver-d:1");
    expect(head?.querySelectorAll(".weaver-dcn-num").map((node) => node.textContent)).toEqual([
      "1",
      "2",
      "3",
      "13",
      "27",
      "43"
    ]);
    expect(head?.querySelector(".weaver-dcn-ink")?.textContent).toBe("{ ");
  });

  it("turns a duration paragraph into the rendered duration", () => {
    const root = container();
    paragraph(root, "{ 1.2.3 } - 13:27:43");
    paragraph(root, "+ 00:04:12");

    createEntryProcessor(host())(root as never, context(PATH));

    const duration = root.querySelector(".weaver-duration");
    expect(duration).not.toBeNull();
    expect(duration?.querySelector(".weaver-duration-sigil")?.textContent).toBe("+");
    // Digits white, colons in the dimension's colour: two spans either side of
    // them, in the order the file has.
    expect(duration?.querySelectorAll(".weaver-duration-num").map((node) => node.textContent)).toEqual(
      ["00", "04", "12"]
    );
    expect(duration?.querySelectorAll(".weaver-duration-ink").map((node) => node.textContent)).toEqual([
      ":",
      ":"
    ]);
    expect(root.querySelectorAll("p").length).toBe(0);
  });

  it("frames the entry around its prose, with the marker and duration on the rails", () => {
    const root = container();
    paragraph(root, "{ 1.2.3 } - 13:27:43");
    paragraph(root, "the thought this one opened");
    paragraph(root, "+ 00:04:12");

    createEntryProcessor(host({ entryDayLink: false }))(root as never, context(PATH));

    const frame = root.querySelector(".weaver-frame");
    expect(frame?.hasClass("is-static")).toBe(true);
    expect(frame?.getAttr("style")).toBe("--weaver-dcolor:#ef4444;--weaver-d:1");
    expect(frame?.querySelector(".weaver-frame-label-top")?.hasClass("weaver-entry-head")).toBe(true);
    expect(
      frame?.querySelector(".weaver-frame-label-bottom")?.hasClass("weaver-duration")
    ).toBe(true);
    // The prose is the interior; the marker and duration paragraphs are gone.
    expect(frame?.querySelectorAll(".weaver-entry-prose").length).toBe(1);
    expect(frame?.querySelectorAll("p").length).toBe(1);
    expect(root.querySelectorAll(".weaver-entry-prose").length).toBe(1);
  });

  it("keeps a title typed after the clock as the first prose line", () => {
    const root = container();
    paragraph(root, "{ 1.2.3 } - 13:27:43 a title");

    createEntryProcessor(host({ entryDayLink: false }))(root as never, context(PATH));

    // The label is the canonical marker, never the title: a rail cannot ellipsize
    // away a line of the entry.
    expect(root.querySelector(".weaver-entry-head")?.textContent).toBe("{ 1.2.3 } - 13:27:43");
    expect(root.querySelector(".weaver-entry-prose")?.textContent?.trim()).toBe("a title");
  });

  it("draws a duration with no entry above it as a plain block", () => {
    const root = container();
    paragraph(root, "+ 00:04:12");

    createEntryProcessor(host())(root as never, context(PATH));

    const duration = root.querySelector(".weaver-duration");
    expect(duration).not.toBeNull();
    expect(duration?.hasClass("weaver-frame-label")).toBe(false);
  });

  it("marks the prose and keeps its markup", () => {
    const root = container();
    paragraph(root, "{ 1.2.3 } - 13:27:43");
    const prose = paragraph(root, "");
    prose.createEl("strong").setText("bold");
    paragraph(root, "+ 00:04:12");

    createEntryProcessor(host())(root as never, context(PATH));

    expect(root.querySelector(".weaver-entry-prose")?.querySelector("strong")?.textContent).toBe("bold");
    // The duration line is an entry element, not prose.
    expect(root.querySelectorAll(".weaver-entry-prose").length).toBe(1);
  });

  it("links the day only when the file is not today's", () => {
    const past = container();
    paragraph(past, "{ 1.1.1 } - 13:27:43");
    createEntryProcessor(host({ entryDayLink: true }))(past as never, context(PATH));
    expect(past.querySelector(".weaver-entry-daylink")?.textContent).toBe(" - [[2026.10.26]]");

    const today = new Date();
    const name = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, "0"),
      String(today.getDate()).padStart(2, "0")
    ].join(".");
    const todays = container();
    paragraph(todays, "{ 1.1.1 } - 13:27:43");
    createEntryProcessor(host({ entryDayLink: true }))(
      todays as never,
      context(`Chronomancer/${name}.md`)
    );
    expect(todays.querySelector(".weaver-entry-daylink")).toBeNull();
  });

  it("leaves a paragraph that is not an entry alone", () => {
    const root = container();
    paragraph(root, "just a thought");

    createEntryProcessor(host())(root as never, context(PATH));

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
