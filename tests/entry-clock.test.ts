import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EntryClock } from "../src/entries/clock";
import { EntrySession } from "../src/entries/session";

/** 12:00:00 local on an exact whole second, so a boundary is one second away. */
const T0 = new Date(2026, 10, 5, 12, 0, 0).getTime();

let now = T0;

/** Moves the wall clock and the timers together, one second at a time. */
function advance(ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
    now += 1_000;
    vi.advanceTimersByTime(1_000);
  }
}

beforeEach(() => {
  now = T0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EntryClock", () => {
  it("samples the real time once and floors the elapsed second", () => {
    const session = new EntrySession();
    session.start("a.md", 1, 0, now);
    const clock = new EntryClock(session, () => now);
    const seen: [number, number][] = [];
    const stop = clock.subscribe((at, ms) => seen.push([at, ms]));

    // The first paint is the current snapshot, not an extra tick.
    expect(seen).toEqual([[T0, 0]]);

    advance(2_000);
    expect(seen.at(-1)).toEqual([T0 + 2_000, 2_000]);

    // A delayed callback samples the moment it actually wakes, so the paint is
    // 4.4 seconds floored, not the 3 seconds the timer asked to be woken at.
    now += 2_400;
    vi.advanceTimersByTime(1_000);
    expect(seen.at(-1)).toEqual([T0 + 4_400, 4_000]);
    expect(session.displayed()).toBe(4_000);

    stop();
  });

  it("paints before it commits, so displayed is what a surface saw", () => {
    const session = new EntrySession();
    session.start("a.md", 1, 0, now);
    const clock = new EntryClock(session, () => now);
    const duringPaint: number[] = [];
    const stop = clock.subscribe(() => duringPaint.push(session.displayed()));

    advance(1_000);

    // On the first tick the surface is still painting the previous commit; the
    // new second lands only once every surface has drawn it.
    expect(duringPaint).toEqual([0, 0]);
    expect(session.displayed()).toBe(1_000);

    stop();
  });

  it("subscribes to the current session, not a snapshot another one left", () => {
    const session = new EntrySession();
    session.start("a.md", 1, 0, now);
    const clock = new EntryClock(session, () => now);

    const first: number[] = [];
    const stop = clock.subscribe((_, ms) => first.push(ms));
    advance(5_000);
    expect(first.at(-1)).toBe(5_000);

    // That pane closes and the entry stops; a later session starts with its own
    // baseline. A new view must paint that session, not the old snapshot.
    stop();
    session.clear();
    session.start("b.md", 2, 3_000, now);

    const second: number[] = [];
    clock.subscribe((_, ms) => second.push(ms));
    expect(second).toEqual([3_000]);
  });

  it("keeps one timeout for every subscriber, and none when idle", () => {
    const clock = new EntryClock(new EntrySession(), () => now);

    const stopA = clock.subscribe(() => {});
    const stopB = clock.subscribe(() => {});
    expect(vi.getTimerCount()).toBe(1);

    stopA();
    expect(vi.getTimerCount()).toBe(1);
    stopB();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("samples a session with no surface mounted", () => {
    const session = new EntrySession();
    session.start("a.md", 1, 0, now);
    const clock = new EntryClock(session, () => now);

    // What the engine does right after the first input: one sample, then the
    // timer keeps it current even though no clock row is mounted.
    clock.refresh();
    advance(3_000);
    expect(session.displayed()).toBe(3_000);

    const seen: number[] = [];
    clock.subscribe((_, ms) => seen.push(ms));
    expect(seen).toEqual([3_000]);
  });

  it("holds a stopped session's second for every mounted clock", () => {
    const session = new EntrySession();
    session.start("a.md", 1, 0, now);
    const clock = new EntryClock(session, () => now);
    const seen: number[] = [];
    clock.subscribe((_, ms) => seen.push(ms));

    advance(2_000);
    expect(seen.at(-1)).toBe(2_000);

    // A stop is waiting on its write: no tick may move the number the row shows.
    session.freezeDisplay();
    advance(3_000);

    expect(seen.at(-1)).toBe(2_000);
    expect(session.displayed()).toBe(2_000);
  });

  it("cannot restart sampling when widgets unsubscribe after plugin destruction", () => {
    const session = new EntrySession();
    session.start("a.md", 1, 0, now);
    const clock = new EntryClock(session, () => now);
    const unmount = clock.subscribe(() => {});
    advance(1_000);
    clock.destroy();
    unmount();
    advance(3_000);
    expect(session.displayed()).toBe(1_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops sampling when destroyed", () => {
    const session = new EntrySession();
    session.start("a.md", 1, 0, now);
    const clock = new EntryClock(session, () => now);
    const seen: number[] = [];
    clock.subscribe((_, ms) => seen.push(ms));

    advance(2_000);
    clock.destroy();
    expect(vi.getTimerCount()).toBe(0);

    advance(3_000);
    expect(seen.at(-1)).toBe(2_000);
    expect(session.displayed()).toBe(2_000);
  });
});
