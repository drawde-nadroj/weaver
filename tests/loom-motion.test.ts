import { afterEach, describe, expect, it, vi } from "vitest";

import { LoomMotion } from "../src/ui/loom-motion";
import { ShimElement } from "../test-support/dom";

/**
 * The motion director's own contract, without the Loom around it.
 *
 * Three facts matter and none of them needs a rendered surface: a gesture is a
 * token the stylesheet can see, an unavailable animation path hides at once,
 * and a reader who asked for reduced motion gets no token at all. The test shim
 * defines no `Element.animate`, so the default here is the synchronous path —
 * the same one every other test in this suite renders through.
 */

/** One element, hidden until a test shows it. The shim's node is a DOM node. */
function surface(className: string): HTMLElement {
  const element = new ShimElement("div");
  element.className = className;
  return element as unknown as HTMLElement;
}

/** The one method that makes motion available; the shim defines none. */
interface AnimatablePrototype {
  animate?: unknown;
}
const shimPrototype = ShimElement.prototype as unknown as AnimatablePrototype;

afterEach(() => {
  delete shimPrototype.animate;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Adds a no-op `animate`, which is what makes motion available. */
function allowAnimation(): void {
  shimPrototype.animate = () => ({
    cancel(): void {},
    addEventListener(): void {}
  });
}

describe("the Loom's motion director", () => {
  it("names a gesture as one token on the root when a hidden surface arrives", () => {
    allowAnimation();
    const root = surface("weaver-composer");
    const card = surface("weaver-composer-card");
    const resume = surface("weaver-composer-resume");
    root.appendChild(card);
    root.appendChild(resume);
    root.setAttribute("hidden", "");
    card.setAttribute("hidden", "");
    resume.setAttribute("hidden", "");
    const motion = new LoomMotion(root, card, resume, null, () => globalThis as unknown as Window);

    motion.beforePaint();
    root.removeAttribute("hidden");
    card.removeAttribute("hidden");
    motion.afterPaint(null);

    expect(root.getAttribute("data-motion")).toBe("rise");
    motion.dispose();
    expect(root.hasAttribute("data-motion")).toBe(false);
  });

  it("hides the root at once when the document cannot animate", () => {
    const root = surface("weaver-composer");
    const card = surface("weaver-composer-card");
    const resume = surface("weaver-composer-resume");
    root.appendChild(card);
    root.appendChild(resume);
    const motion = new LoomMotion(root, card, resume, null, () => globalThis as unknown as Window);

    let hidden = false;
    motion.holdThenHide(() => {
      hidden = true;
    });

    expect(hidden).toBe(true);
    expect(root.hasAttribute("data-motion")).toBe(false);
    motion.dispose();
  });

  it("holds the exit for the sink, then hides", () => {
    allowAnimation();
    vi.useFakeTimers();
    const root = surface("weaver-composer");
    const card = surface("weaver-composer-card");
    const resume = surface("weaver-composer-resume");
    root.appendChild(card);
    root.appendChild(resume);
    const motion = new LoomMotion(root, card, resume, null, () => globalThis as unknown as Window);

    let hidden = false;
    motion.holdThenHide(() => {
      hidden = true;
    });
    expect(hidden).toBe(false);
    expect(root.getAttribute("data-motion")).toBe("sink");

    vi.advanceTimersByTime(200);
    expect(hidden).toBe(true);
    motion.dispose();
  });

  it("draws nothing for a reader who asked for reduced motion", () => {
    allowAnimation();
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener(): void {}, removeEventListener(): void {} }));
    const root = surface("weaver-composer");
    const card = surface("weaver-composer-card");
    const resume = surface("weaver-composer-resume");
    root.appendChild(card);
    root.appendChild(resume);
    root.setAttribute("hidden", "");
    card.setAttribute("hidden", "");
    resume.setAttribute("hidden", "");
    const motion = new LoomMotion(root, card, resume, null, () => globalThis as unknown as Window);

    motion.beforePaint();
    root.removeAttribute("hidden");
    card.removeAttribute("hidden");
    motion.afterPaint(null);
    expect(root.hasAttribute("data-motion")).toBe(false);

    let hidden = false;
    motion.holdThenHide(() => {
      hidden = true;
    });
    expect(hidden).toBe(true);
    expect(root.hasAttribute("data-motion")).toBe(false);
    motion.dispose();
  });
});
