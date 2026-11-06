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
    expect(session.displayed()).toBe(0);
  });

  it("never reports a negative elapsed time", () => {
    const session = new EntrySession();
    session.start("a.md", 1, 100, START);

    // A clock that jumped backwards must not make the stopwatch read below zero.
    expect(session.elapsed(START - 5000)).toBe(0);
  });

  it("starts its displayed snapshot on the whole second the row already holds", () => {
    const session = new EntrySession();
    session.start("a.md", 1, 7900, START);

    // The row's duration is already whole seconds; a fraction a resumed draft
    // never showed must not be claimed by the new session's first paint.
    expect(session.displayed()).toBe(7000);
    expect(session.elapsed(START)).toBe(7900);
  });

  it("commits only whole seconds the current session painted", () => {
    const session = new EntrySession();
    session.start("a.md", 1, 0, START);

    session.commitDisplay(9400);
    expect(session.displayed()).toBe(9000);

    // A backwards correction is a floor, not a negative clock.
    session.commitDisplay(-500);
    expect(session.displayed()).toBe(0);

    // An ended session accepts no late paint from a surface that outlived it.
    session.commitDisplay(7000);
    session.clear();
    session.commitDisplay(12_000);
    expect(session.displayed()).toBe(0);
  });

  it("stops from what was painted, not from what the wall clock reached", () => {
    const session = new EntrySession();
    session.start("a.md", 1, 0, START);
    session.commitDisplay(7000);

    // A delayed tick: 7.9 seconds have passed but the last paint was 7.
    expect(session.elapsed(START + 7900)).toBe(7900);
    expect(session.displayed()).toBe(7000);
  });

  it("holds the painted second while a stop is waiting on its write", () => {
    const session = new EntrySession();
    session.start("a.md", 1, 0, START);
    session.commitDisplay(7000);

    session.freezeDisplay();
    expect(session.frozen()).toBe(true);

    // A tick landing during the write must not move the stopped second, and a
    // retry a few seconds later must still write the second the writer saw.
    session.commitDisplay(10_000);
    expect(session.displayed()).toBe(7000);
    expect(session.elapsed(START + 12_900)).toBe(7000);
  });

  it("releases the hold when the session ends or a fresh one starts", () => {
    const session = new EntrySession();
    session.start("a.md", 1, 0, START);
    session.commitDisplay(7000);
    session.freezeDisplay();

    session.start("a.md", 1, 7000, START + 12_000);
    expect(session.frozen()).toBe(false);
    expect(session.elapsed(START + 13_000)).toBe(8000);
    session.commitDisplay(9000);
    expect(session.displayed()).toBe(9000);

    session.freezeDisplay();
    session.clear();
    expect(session.frozen()).toBe(false);

    // Nothing to hold when nothing is running.
    session.freezeDisplay();
    expect(session.frozen()).toBe(false);
  });
});
