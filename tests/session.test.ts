import { describe, expect, it } from "vitest";

import { EntrySession } from "../src/entries/session";

const START = 1_000_000;

describe("EntrySession", () => {
  it("counts from the baseline it was started with", () => {
    const session = new EntrySession();
    session.start("Chronomancer/2026.10.27.md", 3, 4000, START);

    expect(session.elapsed(START)).toBe(4000);
    expect(session.elapsed(START + 2500)).toBe(6500);
    expect(session.active()?.seq).toBe(3);
  });

  it("is scoped to one file and one sequence", () => {
    const session = new EntrySession();
    session.start("a.md", 3, 0, START);

    expect(session.activeFor("a.md", 3)).toBe(true);
    expect(session.activeFor("b.md", 3)).toBe(false);
    expect(session.activeFor("a.md", 4)).toBe(false);
  });

  it("stops when cleared", () => {
    const session = new EntrySession();
    session.start("a.md", 1, 0, START);
    session.clear();

    expect(session.active()).toBeNull();
    expect(session.elapsed(START + 5000)).toBe(0);
    expect(session.activeFor("a.md", 1)).toBe(false);
  });

  it("never reports a negative elapsed time", () => {
    const session = new EntrySession();
    session.start("a.md", 1, 100, START);

    // A clock that jumped backwards must not make the stopwatch read below zero.
    expect(session.elapsed(START - 5000)).toBe(0);
  });
});
