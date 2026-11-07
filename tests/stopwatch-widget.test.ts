import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DurationWidget, type DurationWidgetInput } from "../src/editor/stopwatch-widget";
import { EntryClock } from "../src/entries/clock";
import { EntrySession } from "../src/entries/session";

const PATH = "Chronomancer/2026-11-05.md";
/** 21:55:00 local, an exact whole second, so a boundary is one second away. */
const T0 = new Date(2026, 10, 5, 21, 55, 0).getTime();

let now = T0;

function clockFor(session = new EntrySession()): EntryClock {
  return new EntryClock(session, () => now);
}

/** A session already writing this entry, from the given baseline. */
function started(baselineMs = 0): EntrySession {
  const session = new EntrySession();
  session.start(PATH, 1, baselineMs, now);
  return session;
}

/** Moves the wall clock and the timers together, one second at a time. */
function advance(ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
    now += 1_000;
    vi.advanceTimersByTime(1_000);
  }
}

function widget(overrides: Partial<DurationWidgetInput> & { mode?: "fixed" | "awaiting" | "running" } = {}): DurationWidget {
  const { mode, ...rest } = overrides;
  const axes =
    mode === "running"
      ? { durationMode: "session" as const, momentMode: "fixed" as const }
      : mode === "awaiting"
        ? { durationMode: "fixed" as const, momentMode: "wall" as const }
        : { durationMode: "fixed" as const, momentMode: "fixed" as const };
  return new DurationWidget({
    n: 1,
    time: "09:14:22",
    sigil: "-",
    ms: 0,
    path: PATH,
    clock: clockFor(),
    color: "#f97316",
    d: 1,
    ...axes,
    ...rest
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
  now = T0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the duration widget", () => {
  it("is the same widget while only the elapsed time changes", () => {
    expect(widget({ ms: 0 }).eq(widget({ ms: 90_000 }))).toBe(true);
    expect(widget().eq(widget({ sigil: "=" }))).toBe(false);
    expect(widget().eq(widget({ time: "09:14:23" }))).toBe(false);
    // The mode is what the two corners show, so it is not the clock's business.
    expect(widget().eq(widget({ mode: "running" }))).toBe(false);
    expect(widget().eq(widget({ mode: "awaiting" }))).toBe(false);
    expect(widget().eq(widget({ path: "Chronomancer/2026-11-06.md" }))).toBe(false);
    expect(widget().eq(widget({ color: "#22d3ee" }))).toBe(false);
    expect(widget().eq(widget({ d: 3 }))).toBe(false);
    // A different entry is a different row: its stamp has to be repainted.
    expect(widget().eq(widget({ n: 2 }))).toBe(false);
    // One shared clock: two references to it are the same widget.
    expect(widget().eq(widget({ clock: clockFor() }))).toBe(true);
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
    expect(digits(root)).toBe("00:00:00");
  });

  it("draws only the half the row carries", () => {
    const momentOnly = widget({ sigil: null }).toDOM();
    expect(momentOnly.children.length).toBe(1);
    expect(momentOnly.children[0]?.classList.contains("weaver-duration-moment")).toBe(true);

    const durationOnly = widget({ time: null }).toDOM();
    expect(durationOnly.children.length).toBe(2);
    expect(durationOnly.children[0]?.classList.contains("weaver-duration-clock")).toBe(true);
    // The moment half is present but empty; `:empty` hides it, so the duration
    // still labels the left corner and the rail keeps its length.
    expect(durationOnly.children[1]?.classList.contains("weaver-duration-moment")).toBe(true);
    expect(durationOnly.children[1]?.textContent).toBe("");
  });

  it("paints the shared snapshot while running and never rewrites the moment", () => {
    const session = started();
    const clock = clockFor(session);
    const root = widget({ mode: "running", ms: session.displayed(), clock }).toDOM();

    expect(digits(root)).toBe("00:00:00");
    advance(3_000);

    expect(digits(root)).toBe("00:00:03");
    expect(momentDigits(root)).toBe("09:14:22");
    expect(session.displayed()).toBe(3_000);
  });

  it("paints a draft with its own wall clock and a zero duration", () => {
    const clock = clockFor();
    const root = widget({ mode: "awaiting", time: null, ms: 0, clock }).toDOM();

    // Nothing is recorded yet: the left corner is the zero the row holds, the
    // right corner is the moment the first input will write.
    expect(digits(root)).toBe("00:00:00");
    expect(momentDigits(root)).toBe("21:55:00");

    advance(1_000);
    expect(momentDigits(root)).toBe("21:55:01");
    expect(digits(root)).toBe("00:00:00");
  });

  it("keeps a paused draft's accumulated time beside its wall clock", () => {
    // A draft paused before its first input still awaits one, but the duration it
    // already holds is real: only the right corner is live.
    const clock = clockFor();
    const root = widget({ mode: "awaiting", time: null, sigil: "=", ms: 252_000, clock }).toDOM();

    expect(digits(root)).toBe("00:04:12");
    expect(momentDigits(root)).toBe("21:55:00");

    advance(2_000);
    expect(digits(root)).toBe("00:04:12");
    expect(momentDigits(root)).toBe("21:55:02");
  });

  it("gives a second mount the shared snapshot without advancing it", () => {
    const session = started();
    const clock = clockFor(session);
    const first = widget({ mode: "running", ms: session.displayed(), clock });
    const firstRoot = first.toDOM();

    advance(3_000);
    expect(digits(firstRoot)).toBe("00:00:03");

    // A second pane mounts with a deliberately stale duration: the shared
    // snapshot, not the stale input, is what it paints.
    const second = widget({ mode: "running", ms: 0, clock });
    const secondRoot = second.toDOM();

    expect(digits(secondRoot)).toBe("00:00:03");
    expect(digits(firstRoot)).toBe("00:00:03");

    advance(1_000);
    expect(digits(firstRoot)).toBe("00:00:04");
    expect(digits(secondRoot)).toBe("00:00:04");

    first.destroy();
    second.destroy();
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
    second.destroy();
  });

  it("turns an awaiting draft into a running row in place, then a fixed one", () => {
    const session = new EntrySession();
    const clock = clockFor(session);
    const root = widget({ mode: "awaiting", time: null, clock }).toDOM();
    const children = root.children.length;
    expect(momentDigits(root)).toBe("21:55:00");

    // The first input starts the session and records its moment: the same row,
    // same halves, now showing the shared duration on the left.
    session.start(PATH, 1, 0, now);
    const running = widget({ mode: "running", time: "21:55:03", ms: 0, clock });
    running.updateDOM(root);

    expect(root.children.length).toBe(children);
    expect(digits(root)).toBe("00:00:00");
    expect(momentDigits(root)).toBe("21:55:03");
    advance(2_000);
    expect(digits(root)).toBe("00:00:02");

    // Settled: the row stops ticking and keeps the duration the file holds.
    const fixed = widget({ mode: "fixed", time: "21:55:03", sigil: "+", ms: 2_000, clock });
    fixed.updateDOM(root);
    advance(4_000);

    expect(digits(root)).toBe("00:00:02");
    expect(momentDigits(root)).toBe("21:55:03");
    fixed.destroy();
    running.destroy();
  });

  it("hands a reused element to one writer only", () => {
    const session = started();
    const clock = clockFor(session);
    const first = widget({ mode: "running", clock });
    const root = first.toDOM();

    advance(1_000);
    expect(digits(root)).toBe("00:00:01");

    // A second instance adopts the element: the first stops painting before the
    // new one starts, so the digits advance once per second, from the shared
    // snapshot rather than from either widget's own count.
    const second = widget({ mode: "running", clock });
    second.updateDOM(root);
    advance(2_000);
    expect(digits(root)).toBe("00:00:03");

    // The superseded instance's destroy must not orphan the current writer.
    first.destroy();
    advance(1_000);
    expect(digits(root)).toBe("00:00:04");
    second.destroy();
  });

  it("floors a late tick to the second it sampled, not the one it missed", () => {
    const session = started();
    const clock = clockFor(session);
    const root = widget({ mode: "running", clock }).toDOM();

    advance(2_000);
    expect(digits(root)).toBe("00:00:02");

    // The callback arrives two and a half seconds late: it samples once, floors
    // to the whole second, and commits exactly what it painted.
    now += 2_400;
    vi.advanceTimersByTime(1_000);

    expect(digits(root)).toBe("00:00:04");
    expect(session.elapsed(now)).toBe(4_400);
    expect(session.displayed()).toBe(4_000);
  });

  it("keeps no timer of its own and freezes its digits on destroy", () => {
    const session = started();
    const clock = clockFor(session);
    const live = widget({ mode: "running", clock });
    const root = live.toDOM();

    // One timeout: the shared clock's. The widget itself schedules nothing.
    expect(vi.getTimerCount()).toBe(1);

    advance(1_000);
    expect(digits(root)).toBe("00:00:01");

    live.destroy();
    advance(3_000);
    expect(digits(root)).toBe("00:00:01");
    // The session is still live, so the shared snapshot keeps advancing.
    expect(session.displayed()).toBe(4_000);
  });

  it("replaces an adopted subscription instead of adding a second timer", () => {
    const clock = clockFor();
    const first = widget({ mode: "awaiting", time: null, clock });
    const root = first.toDOM();
    expect(vi.getTimerCount()).toBe(1);

    const second = widget({ mode: "awaiting", time: null, clock });
    second.updateDOM(root);
    expect(vi.getTimerCount()).toBe(1);

    second.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops ticking when it stops being live", () => {
    const live = widget({ mode: "running", clock: clockFor(started()) });
    const root = live.toDOM();

    widget({ mode: "fixed", ms: 10_000 }).updateDOM(root);
    advance(5_000);
    expect(digits(root)).toBe("00:00:10");
  });
});
