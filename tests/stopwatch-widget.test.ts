import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DurationWidget, type DurationWidgetInput } from "../src/editor/stopwatch-widget";

function widget(overrides: Partial<DurationWidgetInput> = {}): DurationWidget {
  return new DurationWidget({
    sigil: "-",
    ms: 0,
    active: false,
    color: "#f97316",
    d: 1,
    ...overrides
  });
}

function digits(root: HTMLElement): string {
  return Array.from(root.querySelectorAll(".weaver-duration-num"))
    .map((node) => node.textContent ?? "")
    .join(":");
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
