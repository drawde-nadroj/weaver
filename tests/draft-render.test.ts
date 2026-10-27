import { beforeEach, describe, expect, it } from "vitest";

import { createDraftProcessor } from "../src/reading/draft-post-processor";
import { resetHarness, ShimElement } from "../test-support/harness";

const OPENED = "2026-10-26 16:37:04";

interface Harness {
  run(): void;
  root: ShimElement;
  calls: string[];
}

function harness(options: { inPageDrafts?: boolean } = {}): Harness {
  const calls: string[] = [];
  const plugin = {
    settings: { inPageDrafts: options.inPageDrafts ?? true },
    drafts: {
      badgeHandlers: () => ({
        maxDepth: 12,
        onWeave: (id: string) => calls.push(`weave:${id}`),
        onDiscard: (id: string) => calls.push(`discard:${id}`),
        onLevel: (id: string, level: number) => calls.push(`level:${id}:${level}`)
      })
    }
  };

  const root = new ShimElement("div");
  const processor = createDraftProcessor(plugin as never);

  return {
    run: () => processor(root as unknown as HTMLElement, {} as never),
    root,
    calls
  };
}

function marker(root: ShimElement, id: string): ShimElement {
  return root.createEl("p", { text: `⟪draft ${id} ${OPENED}⟫` });
}

function close(root: ShimElement, id: string): ShimElement {
  return root.createEl("p", { text: `⟪/draft ${id}⟫` });
}

beforeEach(() => {
  resetHarness();
});

describe("createDraftProcessor", () => {
  it("wraps only the block, removes both markers, and keeps the badge first", () => {
    const context = harness();
    marker(context.root, "2.1");
    context.root.createEl("p", { text: "Half-formed thought" });
    const body = context.root.createEl("p", { text: "body text" });
    body.createEl("a", { text: "a link", href: "#" });
    close(context.root, "2.1");
    context.root.createEl("p", { text: "after" });

    context.run();

    const cards = context.root.querySelectorAll(".weaver-draft");
    expect(cards).toHaveLength(1);

    const card = cards[0]!;
    expect(card.getAttr("data-weaver-draft-id")).toBe("2.1");
    expect(card.getAttr("data-weaver-processed")).toBe("true");

    // The badge is the first child; then the title paragraph, then the body.
    expect(card.children[0]?.hasClass("weaver-draft-badge")).toBe(true);
    const blocks = card.querySelectorAll(".weaver-draft-title, .weaver-draft-body");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.textContent).toBe("Half-formed thought");
    expect(blocks[1]?.hasClass("weaver-draft-body")).toBe(true);

    // Inline structure survives the move.
    expect(card.querySelectorAll("a")).toHaveLength(1);

    // The markers are gone and the trailing paragraph is untouched.
    expect(context.root.children.map((child) => child.textContent)).toEqual([
      card.textContent,
      "after"
    ]);
    expect(context.root.children).toHaveLength(2);
  });

  it("leaves a block without a close marker as plain text", () => {
    const context = harness();
    marker(context.root, "2.1");
    context.root.createEl("p", { text: "never closed" });

    context.run();

    expect(context.root.querySelectorAll(".weaver-draft")).toHaveLength(0);
    expect(context.root.children).toHaveLength(2);
  });

  it("does nothing when in-page drafts are off", () => {
    const context = harness({ inPageDrafts: false });
    marker(context.root, "2.1");
    context.root.createEl("p", { text: "title" });
    close(context.root, "2.1");

    context.run();

    expect(context.root.querySelectorAll(".weaver-draft")).toHaveLength(0);
    expect(context.root.children).toHaveLength(3);
  });

  it("leaves a block containing a heading element alone", () => {
    const context = harness();
    marker(context.root, "2.1");
    context.root.createEl("h2", { text: "16:37 structural" });
    close(context.root, "2.1");

    context.run();

    expect(context.root.querySelectorAll(".weaver-draft")).toHaveLength(0);
  });

  it("leaves a block containing a table alone", () => {
    const context = harness();
    marker(context.root, "2.1");
    context.root.createEl("table");
    close(context.root, "2.1");

    context.run();

    expect(context.root.querySelectorAll(".weaver-draft")).toHaveLength(0);
  });

  it("keeps the close marker of another id inside the block", () => {
    const context = harness();
    marker(context.root, "2.1");
    context.root.createEl("p", { text: "title" });
    close(context.root, "2.2");
    close(context.root, "2.1");

    context.run();

    const cards = context.root.querySelectorAll(".weaver-draft");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.querySelectorAll("p")).toHaveLength(2);
  });

  it("is idempotent across repeated runs", () => {
    const context = harness();
    marker(context.root, "2.1");
    context.root.createEl("p", { text: "title" });
    close(context.root, "2.1");

    context.run();
    context.run();

    expect(context.root.querySelectorAll(".weaver-draft")).toHaveLength(1);
  });

  it("routes badge actions to the draft controller", () => {
    const context = harness();
    marker(context.root, "3.2");
    context.root.createEl("p", { text: "title" });
    close(context.root, "3.2");

    context.run();

    const card = context.root.querySelectorAll(".weaver-draft")[0]!;
    card.querySelectorAll(".weaver-draft-weave")[0]?.click();
    card.querySelectorAll(".weaver-draft-discard")[0]?.click();
    card.querySelectorAll(".weaver-stepper-button")[1]?.click();

    expect(context.calls).toEqual(["weave:3.2", "discard:3.2", "level:3.2:4"]);
  });

  it("disables the level stepper at the ends of the range", () => {
    const context = harness();
    marker(context.root, "1.1");
    context.root.createEl("p", { text: "lowest" });
    close(context.root, "1.1");
    marker(context.root, "12.1");
    context.root.createEl("p", { text: "deepest" });
    close(context.root, "12.1");

    context.run();

    const cards = context.root.querySelectorAll(".weaver-draft");
    const low = cards[0]!.querySelectorAll(".weaver-stepper-button");
    expect(low[0]?.disabled).toBe(true);
    expect(low[1]?.disabled).toBe(false);

    const high = cards[1]!.querySelectorAll(".weaver-stepper-button");
    expect(high[0]?.disabled).toBe(false);
    expect(high[1]?.disabled).toBe(true);
  });
});

describe("drafts never nest", () => {
  it("keeps inner markers inside the outer card's body", () => {
    const context = harness();
    marker(context.root, "2.1");
    context.root.createEl("p", { text: "outer" });
    marker(context.root, "2.2");
    context.root.createEl("p", { text: "inner" });
    close(context.root, "2.2");
    close(context.root, "2.1");

    context.run();

    const cards = context.root.querySelectorAll(".weaver-draft");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.getAttribute("data-weaver-draft-id")).toBe("2.1");
    expect(cards[0]?.querySelectorAll(".weaver-draft")).toHaveLength(0);
    // The inner marker pair is body text, so it survives as paragraphs.
    expect(cards[0]?.querySelectorAll("p").length).toBeGreaterThanOrEqual(3);
  });
});
