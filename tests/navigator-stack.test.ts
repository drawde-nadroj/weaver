import { describe, expect, it } from "vitest";

import { popStop, pushStop, STACK_LIMIT, type Stop } from "../src/core/navigator-stack";

const stop = (n: number | null, caret: number, scroll = 0): Stop => ({ n, caret, scroll });

describe("pushStop", () => {
  it("appends the stop it is given", () => {
    const stops = pushStop([], stop(1, 10));

    expect(stops).toEqual([stop(1, 10)]);
  });

  it("is a no-op when the top is the same place", () => {
    const once = pushStop([], stop(1, 10, 0));
    const twice = pushStop(once, stop(1, 10, 400));

    // Same entry, same caret: walking back from here would go nowhere.
    expect(twice).toEqual([stop(1, 10, 0)]);
  });

  it("counts a different caret in the same entry as a step", () => {
    const stops = pushStop(pushStop([], stop(1, 10)), stop(1, 40));

    expect(stops.length).toBe(2);
  });

  it("drops the oldest stop past the limit", () => {
    let stops: Stop[] = [];
    for (let n = 1; n <= STACK_LIMIT + 2; n += 1) stops = pushStop(stops, stop(n, n));

    expect(stops.length).toBe(STACK_LIMIT);
    expect(stops[0]?.n).toBe(3);
    expect(stops[stops.length - 1]?.n).toBe(STACK_LIMIT + 2);
  });

  it("honours a smaller limit", () => {
    const stops = pushStop(pushStop([stop(1, 1)], stop(2, 2), 1), stop(3, 3), 1);

    expect(stops).toEqual([stop(3, 3)]);
  });
});

describe("popStop", () => {
  it("returns the top stop and the stack without it", () => {
    const { stops, stop: top } = popStop([stop(1, 10), stop(2, 20)]);

    expect(top).toEqual(stop(2, 20));
    expect(stops).toEqual([stop(1, 10)]);
  });

  it("answers null for an empty stack", () => {
    expect(popStop([])).toEqual({ stops: [], stop: null });
  });

  it("round-trips a single push", () => {
    const { stop: top } = popStop(pushStop([], stop(null, 0)));

    expect(top).toEqual(stop(null, 0));
  });
});
