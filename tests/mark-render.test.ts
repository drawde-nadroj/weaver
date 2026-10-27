import { describe, expect, it } from "vitest";

import { createMarkProcessor } from "../src/reading/mark-post-processor";
import { ShimElement, node } from "../test-support/harness";

function render(build: (root: ShimElement) => void): ShimElement {
  const root = new ShimElement("div");
  build(root);
  createMarkProcessor()(root as unknown as HTMLElement, {} as never);
  return root;
}

describe("mark rendering", () => {
  it("turns a source line into a chip and names the source for a screen reader", () => {
    const root = render((element) => element.createEl("p", { text: "✦ [[Note#^abc123|first]]" }));
    const mark = node(root, "p");

    expect(mark?.hasClass("weaver-mark")).toBe(true);
    expect(mark?.getAttr("aria-label")).toBe("Sparked by first");
    // The link itself is Obsidian's and must survive.
    expect(mark?.textContent).toBe("✦ [[Note#^abc123|first]]");
  });

  it("styles a bare spark without claiming a source", () => {
    const root = render((element) => element.createEl("p", { text: "✦" }));
    const mark = node(root, "p");

    expect(mark?.hasClass("weaver-mark")).toBe(true);
    expect(mark?.getAttr("aria-label")).toBeNull();
  });

  it("styles a closing mark as muted text", () => {
    const root = render((element) => element.createEl("p", { text: "✓ 23:41" }));
    const mark = node(root, "p");

    expect(mark?.hasClass("weaver-close-mark")).toBe(true);
    expect(mark?.getAttr("aria-label")).toBe("Day closed at 23:41");
  });

  it("leaves prose, drafts and nested containers alone", () => {
    const root = render((element) => {
      element.createEl("p", { text: "we spark things" });
      element.createEl("p", { text: "⟪draft 2.1 2026-10-26 16:37:04⟫" });
      const quote = element.createEl("blockquote");
      quote.createEl("p", { text: "✦ [[Quoted]]" });
    });

    expect(node(root, "p")?.hasClass("weaver-mark")).toBe(false);
    expect(root.querySelectorAll(".weaver-mark")).toHaveLength(0);
  });

  it("does not touch an element twice", () => {
    const root = render((element) => element.createEl("p", { text: "✦ [[Note]]" }));
    createMarkProcessor()(root as unknown as HTMLElement, {} as never);
    expect(root.querySelectorAll(".weaver-mark")).toHaveLength(1);
  });
});
