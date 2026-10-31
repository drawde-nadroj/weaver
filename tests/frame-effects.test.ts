import { describe, expect, it } from "vitest";

import { FRAME_EFFECTS, frameEffect } from "../src/editor/frame-effects";

describe("the frame's effect registry", () => {
  it("shows nothing when nothing is happening", () => {
    expect(frameEffect({ live: false, reading: false })).toBeNull();
  });

  it("shows the clock's travel while an entry is being written", () => {
    expect(frameEffect({ live: true, reading: false })?.className).toBe("is-live");
  });

  it("shows the reading ring while a request is pending", () => {
    expect(frameEffect({ live: false, reading: true })?.className).toBe("is-whispering");
  });

  it("prefers the transient fact when both are true", () => {
    // A draft is liveness; the model speculating over it is a request in flight.
    // One box, one motion: the request wins.
    expect(frameEffect({ live: true, reading: true })?.className).toBe("is-whispering");
  });

  it("is ordered by precedence, not by list position", () => {
    const order = FRAME_EFFECTS.map((effect) => effect.precedence);
    expect(order).toEqual([...order].sort((left, right) => right - left));
    // Every effect is a distinct class, so one can never shadow another.
    expect(new Set(FRAME_EFFECTS.map((effect) => effect.className)).size).toBe(FRAME_EFFECTS.length);
  });
});
