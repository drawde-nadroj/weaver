import { describe, expect, it } from "vitest";

import {
  back,
  canGoBack,
  canGoForward,
  forward,
  HISTORY_LIMIT,
  initialHistory,
  record,
  sameStop,
  type NavigationHistory,
  type NoteStop,
  type Stop,
  type WorkspaceStop
} from "../src/core/navigation";

/** A note stop at one thought, with the caret at `caret`. */
function note(path: string, n: number, caret = 0): NoteStop {
  return {
    kind: "note",
    path,
    contextId: "main",
    n,
    thought: null,
    leafId: null,
    caretInProse: caret,
    lineText: null,
    lineBefore: null,
    lineAfter: null,
    scrollTop: 0,
    mode: "source"
  };
}

/** A whole-screen stop at one destination. */
function workspace(contextId: string, activePath: string | null = null): WorkspaceStop {
  return {
    kind: "workspace",
    contextId,
    layout: { contextId },
    panes: [],
    activePath,
    activeLeafId: null
  };
}

/** A history holding these stops, with the cursor on the last one. */
function visited(stops: readonly Stop[]): NavigationHistory {
  return stops.reduce((history, stop) => record(history, stop), initialHistory());
}

describe("recording a visit", () => {
  it("starts empty and moves the cursor onto the first visit", () => {
    const history = record(initialHistory(), note("a.md", 1));
    expect(history.visits).toHaveLength(1);
    expect(history.cursor).toBe(0);
    expect(canGoBack(history)).toBe(false);
    expect(canGoForward(history)).toBe(false);
  });

  it("does not duplicate the place the cursor already is", () => {
    const once = record(initialHistory(), note("a.md", 1));
    const twice = record(once, note("a.md", 1));
    expect(twice.visits).toHaveLength(1);
    expect(twice).toBe(once);
  });

  it("treats the same note with a different caret as a new place", () => {
    const history = visited([note("a.md", 1, 0), note("a.md", 1, 12)]);
    expect(history.visits).toHaveLength(2);
  });

  it("distinguishes two destinations, and two files in one", () => {
    expect(sameStop(workspace("main"), workspace("main", "a.md"))).toBe(false);
    expect(sameStop(note("a.md", 1), note("b.md", 1))).toBe(false);
    expect(sameStop(note("a.md", 1), workspace("main"))).toBe(false);
  });

  it("keeps the most recent places once the limit is reached", () => {
    let history = initialHistory();
    for (let index = 0; index < HISTORY_LIMIT + 5; index += 1) {
      history = record(history, note("a.md", index + 1));
    }
    expect(history.visits).toHaveLength(HISTORY_LIMIT);
    expect(history.cursor).toBe(HISTORY_LIMIT - 1);
    expect((history.visits[0] as NoteStop).n).toBe(6);
  });

  it("keeps a shorter limit honest about the cursor", () => {
    let history = initialHistory();
    for (let index = 0; index < 4; index += 1) history = record(history, note("a.md", index + 1), 3);
    expect(history.visits).toHaveLength(3);
    expect(history.cursor).toBe(2);
  });
});

describe("walking the history", () => {
  it("goes back and forward without losing the path", () => {
    const a = note("a.md", 1);
    const b = note("b.md", 2);
    const c = note("c.md", 3);
    let history = visited([a, b, c]);

    const first = back(history);
    expect(first.stop).toEqual(b);
    history = first.history;

    const second = back(history);
    expect(second.stop).toEqual(a);
    history = second.history;

    const third = back(history);
    expect(third.stop).toBeNull();
    expect(third.history).toBe(history);

    const again = forward(history);
    expect(again.stop).toEqual(b);
    expect(canGoForward(again.history)).toBe(true);
    expect(forward(again.history).stop).toEqual(c);
  });

  it("truncates the forward branch only when a new visit is recorded", () => {
    const a = note("a.md", 1);
    const b = note("b.md", 2);
    const c = note("c.md", 3);
    const d = note("d.md", 4);

    let history = visited([a, b, c]);
    history = back(history).history;
    history = back(history).history;
    expect(canGoForward(history)).toBe(true);

    // A failed navigation records nothing, so forward survives it.
    expect(history.visits).toHaveLength(3);

    history = record(history, d);
    expect(history.visits).toEqual([a, d]);
    expect(canGoForward(history)).toBe(false);
  });

  it("refuses forward from the end and back from the start", () => {
    const only = visited([note("a.md", 1)]);
    expect(back(only).stop).toBeNull();
    expect(forward(only).stop).toBeNull();
    expect(back(initialHistory()).stop).toBeNull();
    expect(forward(initialHistory()).stop).toBeNull();
  });

  it("remembers destinations as well as thoughts", () => {
    const history = visited([note("a.md", 1), workspace("spanish", "a.md")]);
    // Back from the destination lands on the thought it was entered from.
    expect(back(history).stop).toEqual(note("a.md", 1));
  });
});
