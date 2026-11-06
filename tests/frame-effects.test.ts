import { describe, expect, it } from "vitest";

import { FRAME_EFFECTS, frameEffect } from "../src/editor/frame-effects";

const idle = {
  live: false,
  reading: false,
  portal: false,
  aligned: false
};

describe("the frame's effect registry", () => {
  it("shows nothing when nothing is happening", () => {
    expect(frameEffect(idle)).toBeNull();
    expect(frameEffect({ ...idle, portal: true })).toBeNull();
  });

  it("shows the clock's travel while an ordinary entry is being written", () => {
    expect(frameEffect({ ...idle, live: true })?.className).toBe("is-live");
  });

  it("shows the reading ring while a request is pending", () => {
    expect(frameEffect({ ...idle, reading: true })?.className).toBe("is-whispering");
  });

  it("prefers the transient fact when a whisper and a running clock coincide", () => {
    // A draft is liveness; the model speculating over it is a request in flight.
    // One box, one motion: the request wins.
    expect(frameEffect({ ...idle, live: true, reading: true })?.className).toBe(
      "is-whispering"
    );
  });

  it("gives a captured portal entry its own pulse instead of the ordinary travel", () => {
    expect(frameEffect({ ...idle, live: true, portal: true })?.className).toBe(
      "is-portal-live"
    );
  });

  it("leaves a paused captured portal static", () => {
    expect(frameEffect({ ...idle, portal: true })).toBeNull();
  });

  it("acknowledges an alignment above every other state", () => {
    expect(
      frameEffect({ live: true, reading: true, portal: true, aligned: true })?.className
    ).toBe("is-aligned");
  });

  it("shows the acknowledgment even before a live clock exists", () => {
    expect(frameEffect({ ...idle, aligned: true })?.className).toBe("is-aligned");
  });

  it("orders the registry by descending precedence", () => {
    const order = FRAME_EFFECTS.map((effect) => effect.precedence);
    expect(order).toEqual([30, 20, 15, 10]);
    expect(order).toEqual([...order].sort((left, right) => right - left));
    // Every effect is a distinct class, so one can never shadow another.
    expect(new Set(FRAME_EFFECTS.map((effect) => effect.className)).size).toBe(
      FRAME_EFFECTS.length
    );
  });

  it("registers exactly one winner for any activity", () => {
    const states = [false, true];
    for (const live of states) {
      for (const reading of states) {
        for (const portal of states) {
          for (const aligned of states) {
            const activity = { live, reading, portal, aligned };
            const winners = FRAME_EFFECTS.filter((effect) => effect.active(activity));
            const chosen = frameEffect(activity);
            if (winners.length === 0) expect(chosen).toBeNull();
            else {
              expect(chosen).not.toBeNull();
              expect(winners).toContain(chosen);
              const top = Math.max(...winners.map((effect) => effect.precedence));
              expect(chosen?.precedence).toBe(top);
            }
          }
        }
      }
    }
  });
});
