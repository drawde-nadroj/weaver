import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DurationWidget, type DurationWidgetInput } from "../src/editor/stopwatch-widget";

function widget(overrides: Partial<DurationWidgetInput> = {}): DurationWidget {
  return new DurationWidget({
    n: 1,
    time: "09:14:22",
    sigil: "-",
    ms: 0,
    active: false,
    color: "#f97316",
    d: 1,
    ...overrides
  });
}

function texts(root: HTMLElement, selector: string): string[] {
  return Array.from(root.querySelectorAll(selector)).map((node) => node.textContent ?? "");
}

function runs(root: HTMLElement, selector: string): string {
  return texts(root, selector).join(":");
}

/** The clock half's digits only: the moment carries digits too. */
function digits(root: HTMLElement): string {
  return runs(root, ".weaver-duration-clock .weaver-duration-num");
}

function momentDigits(root: HTMLElement): string {
  return runs(root, ".weaver-duration-moment .weaver-duration-num");
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the duration widget", () => {
  it("is the same widget while only the elapsed time changes", () => {
    expect(widget({ ms: 0 }).eq(widget({ ms: 90_000 }))).toBe(true);
    expect(widget().eq(widget({ sigil: "=" }))).toBe(false);
    expect(widget().eq(widget({ active: true }))).toBe(false);
    expect(widget().eq(widget({ color: "#22d3ee" }))).toBe(false);
    expect(widget().eq(widget({ d: 3 }))).toBe(false);
    // A different entry is a different row: its stamp has to be repainted.
    expect(widget().eq(widget({ n: 2 }))).toBe(false);
  });

  it("draws the moment in the stopwatch's own grammar", () => {
    const root = widget().toDOM();
    const moment = root.querySelector<HTMLElement>(".weaver-duration-moment");
    if (moment === null) throw new Error("no moment half");

    // White digits around dimension-coloured colons, exactly like the clock.
    expect(texts(moment, ".weaver-duration-num")).toEqual(["09", "14", "22"]);
    expect(texts(moment, ".weaver-duration-ink")).toEqual([":", ":"]);
  });

  it("puts the stopwatch left, the moment right, and a space after the sigil", () => {
    const root = widget().toDOM();

    expect(root.children[0]?.classList.contains("weaver-duration-clock")).toBe(true);
    expect(root.children[1]?.classList.contains("weaver-duration-moment")).toBe(true);
    // The rendered row carries the same space the file writes after the sigil.
    expect(root.querySelector(".weaver-duration-clock")?.textContent).toBe("- 00:00:00");
  });

  it("draws only the half the row carries", () => {
    const momentOnly = widget({ sigil: null }).toDOM();
    expect(momentOnly.children.length).toBe(1);
    expect(momentOnly.children[0]?.classList.contains("weaver-duration-moment")).toBe(true);

    const durationOnly = widget({ time: null }).toDOM();
    expect(durationOnly.children.length).toBe(2);
    expect(durationOnly.children[0]?.classList.contains("weaver-duration-clock")).toBe(true);
    // The moment half is present but empty; `:empty` hides it, so the duration
    // still labels the left corner.
    expect(durationOnly.children[1]?.classList.contains("weaver-duration-moment")).toBe(true);
    expect(durationOnly.children[1]?.textContent).toBe("");
  });

  it("writes the tick into the clock half and never into the moment", () => {
    const root = widget({ active: true, ms: 0 }).toDOM();

    vi.advanceTimersByTime(3_000);

    expect(momentDigits(root)).toBe("09:14:22");
    expect(digits(root)).toBe("00:00:03");
  });

  it("stamps its element with the entry it belongs to", () => {
    // The frame layer finds this row by the stamp, not by a DOM position.
    expect(widget({ n: 4 }).toDOM().getAttribute("data-weaver-n")).toBe("4");

    // An adopted element is repainted, stamp included.
    const root = widget({ n: 4 }).toDOM();
    widget({ n: 7 }).updateDOM(root);
    expect(root.getAttribute("data-weaver-n")).toBe("7");
  });

  it("repaints a reused element in place instead of rebuilding it", () => {
    const first = widget({ sigil: "-", ms: 0 });
    const root = first.toDOM();
    const children = root.children.length;

    const second = widget({ sigil: "=", ms: 252_000, color: "#22d3ee", d: 3 });
    expect(second.updateDOM(root)).toBe(true);

    // Same element, same structure: the line cannot change height.
    expect(root.children.length).toBe(children);
    expect(root.querySelector(".weaver-duration-sigil")?.textContent).toBe("=");
    expect(digits(root)).toBe("00:04:12");
    expect(root.getAttribute("style")).toContain("--weaver-dcolor:#22d3ee");
  });

  it("ticks in seconds, and only one ticker writes into an element", () => {
    const first = widget({ active: true, ms: 0 });
    const root = first.toDOM();

    vi.advanceTimersByTime(3_000);
    expect(digits(root)).toBe("00:00:03");

    // A second live widget adopting the same element must take the ticker over,
    // not add another one: two writers would count twice per second.
    widget({ active: true, ms: 0 }).updateDOM(root);
    vi.advanceTimersByTime(2_000);
    expect(digits(root)).toBe("00:00:02");

    first.destroy(root);
    vi.advanceTimersByTime(5_000);
    expect(digits(root)).toBe("00:00:02");
  });

  it("stops ticking when it stops being live", () => {
    const live = widget({ active: true, ms: 10_000 });
    const root = live.toDOM();

    widget({ active: false, ms: 10_000 }).updateDOM(root);
    vi.advanceTimersByTime(5_000);
    expect(digits(root)).toBe("00:00:10");
  });
});
