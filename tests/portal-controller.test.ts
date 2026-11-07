import { describe, expect, it } from "vitest";

import type { PortalSchedule } from "../src/core/portals";
import { PortalController, type PortalHost } from "../src/entries/portals";
import type { LocalStateRecord } from "../src/entries/local-state";

/** A local instant, so the assertions read in the machine's own zone. */
const local = (hour: number, minute: number, second = 0, day = 5) =>
  new Date(2026, 10, day, hour, minute, second).getTime();

function schedule(overrides: Partial<PortalSchedule> = {}): PortalSchedule {
  return {
    id: "morning",
    name: "Morning",
    contextId: "main",
    enabled: true,
    createdAt: 0,
    leadMinutes: 11,
    when: { kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], hour: 11, minute: 0 },
    ...overrides
  };
}

interface Harness {
  controller: PortalController;
  at(ms: number): void;
  advance(ms: number): void;
  persist: LocalStateRecord[];
  invites: string[];
  setSchedules(list: PortalSchedule[]): void;
  setEnabled(on: boolean): void;
  setRhythm(on: boolean): void;
  setVisible(on: boolean): void;
  state: LocalStateRecord;
  /** A fresh controller over the stored record, as a reload would build. */
  restart(): PortalController;
}

function harness(options: { schedules?: PortalSchedule[]; rhythm?: boolean } = {}): Harness {
  let now = local(0, 0);
  let schedules = options.schedules ?? [schedule()];
  let enabled = true;
  let rhythmic = options.rhythm !== false;
  let visible = true;

  const persist: LocalStateRecord[] = [];
  const invites: string[] = [];
  const state: LocalStateRecord = {
    workspaces: { activeContextId: null, snapshots: {}, selections: {} },
    schedules: {}
  };

  const host = (): PortalHost => ({
    now: () => now,
    enabled: () => enabled,
    rhythmic: () => rhythmic,
    rhythmContext: () => "main",
    schedules: () => schedules,
    state: () => state,
    persist: (update) => {
      const next = update(state);
      state.schedules = next.schedules;
      persist.push(next);
      return next;
    },
    visible: () => visible,
    invite: (occurrence) => {
      invites.push(occurrence.id);
    }
  });

  const controller = new PortalController(host());
  const test: Harness = {
    controller,
    state,
    persist,
    invites,
    at(ms) {
      now = ms;
    },
    advance(ms) {
      now += ms;
    },
    setSchedules(list) {
      schedules = list;
    },
    setEnabled(on) {
      enabled = on;
    },
    setRhythm(on) {
      rhythmic = on;
    },
    setVisible(on) {
      visible = on;
    },
    restart() {
      const next = new PortalController(host());
      next.start();
      return next;
    }
  };

  controller.start();
  return test;
}

describe("one opening per schedule", () => {
  it("is offered only inside its own minute, and withdrawn after it", () => {
    const test = harness({ rhythm: false });

    // Outside its lead window there is nothing to offer at all.
    test.at(local(10, 40));
    test.controller.reconcile();
    expect(test.controller.outstanding()).toEqual([]);

    test.at(local(11, 0));
    test.controller.reconcile();
    expect(test.controller.outstanding()).toHaveLength(1);
    expect(test.controller.outstanding()[0]?.phase).toBe("available");

    // A minute later the opening is gone: an unentered minute was never a promise,
    // and the next opening is a different one.
    test.at(local(11, 1));
    test.controller.reconcile();
    expect(test.controller.outstanding()).toEqual([]);
    test.at(local(23, 0));
    test.controller.reconcile();
    expect(test.controller.outstanding()).toEqual([]);
  });

  it("shows an approaching invitation only inside its lead window", () => {
    const test = harness({ rhythm: false });

    test.at(local(10, 40));
    test.controller.reconcile();
    expect(test.controller.outstanding()).toEqual([]);

    test.at(local(10, 50));
    test.controller.reconcile();
    const approaching = test.controller.outstanding();
    expect(approaching).toHaveLength(1);
    expect(approaching[0]?.phase).toBe("approaching");
  });

  it("renews its own invitation with the newest due opening", () => {
    const test = harness({
      rhythm: false,
      schedules: [schedule({ when: { kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], hour: 11, minute: 0 } })]
    });

    test.at(local(11, 0));
    test.controller.reconcile();
    const first = test.controller.outstanding()[0]?.occurrence.id;

    test.at(local(11, 0, 0, 6));
    test.controller.reconcile();
    const second = test.controller.outstanding()[0]?.occurrence.id;

    expect(first).not.toBe(second);
    // One schedule, one outstanding invitation — not a stack of yesterday's.
    expect(test.controller.outstanding()).toHaveLength(1);
  });

  it("keeps different schedules distinct even at the same minute and destination", () => {
    const test = harness({
      rhythm: false,
      schedules: [
        schedule({ id: "a", name: "A" }),
        schedule({ id: "b", name: "B" })
      ]
    });

    test.at(local(11, 0));
    test.controller.reconcile();
    expect(test.controller.outstanding().map((item) => item.occurrence.scheduleId)).toEqual(["a", "b"]);
  });

  it("keeps an hourly :11 apart from an hourly :00", () => {
    const test = harness({
      rhythm: false,
      schedules: [schedule({ id: "every-hour-11", when: { kind: "hourly", minute: 11 } })]
    });

    test.at(local(9, 11));
    test.controller.reconcile();
    const due = test.controller.outstanding()[0]?.occurrence.portal;
    expect(due?.minute).toBe(11);
    expect(due?.hour).toBe(9);
  });
});

describe("activation and acknowledgement", () => {
  it("never replays an opening from before the schedule was enabled", () => {
    // The schedule is created (enabled) at noon: the eleven o'clock opening is
    // already in its past and is never offered.
    const test = harness({ rhythm: false, schedules: [schedule({ createdAt: local(12, 0) })] });
    test.at(local(12, 0));
    test.controller.reconcile();
    expect(test.controller.outstanding()).toEqual([]);

    test.at(local(11, 0, 0, 6));
    test.controller.reconcile();
    expect(test.controller.outstanding()).toHaveLength(1);
  });

  it("does not show a dismissed occurrence again, and does show the next", () => {
    const test = harness({ rhythm: false });

    test.at(local(11, 0));
    test.controller.reconcile();
    const first = test.controller.outstanding()[0]?.occurrence.id;
    if (first === undefined) throw new Error("expected an invitation");

    test.controller.dismiss(first);
    test.controller.reconcile();
    expect(test.controller.outstanding()).toEqual([]);

    test.at(local(11, 0, 0, 6));
    test.controller.reconcile();
    expect(test.controller.outstanding()).toHaveLength(1);
    expect(test.controller.outstanding()[0]?.occurrence.id).not.toBe(first);
  });

  it("dismisses an approaching offer without suppressing the next one", () => {
    const test = harness({ rhythm: false });
    test.at(local(10, 50));
    test.controller.reconcile();
    const approaching = test.controller.outstanding()[0];
    if (approaching === undefined) throw new Error("expected an approaching offer");
    expect(approaching.phase).toBe("approaching");

    expect(test.controller.dismiss(approaching.occurrence.id)).toBe("acknowledged");
    test.controller.reconcile();
    expect(test.controller.outstanding()).toEqual([]);

    // The next day's notice is still offered later.
    test.at(local(10, 50, 0, 6));
    test.controller.reconcile();
    expect(test.controller.outstanding()).toHaveLength(1);
    expect(test.controller.dismiss("not-an-occurrence")).toBe("obsolete");
  });

  it("reconciles the latest due opening after a restart, without replaying every elapsed minute", () => {
    const test = harness({ rhythm: false });
    test.at(local(11, 0));
    test.controller.reconcile();

    const reloaded = test.restart();
    expect(reloaded.outstanding()).toHaveLength(1);
    expect(reloaded.outstanding()[0]?.occurrence.portal.opensAt).toBe(local(11, 0));
  });

  it("acknowledges only through its own opening, so a newer one survives", () => {
    const test = harness({ rhythm: false });

    test.at(local(11, 0, 10));
    test.controller.reconcile();
    const first = test.controller.captureAt("main", local(11, 0, 10))[0];
    if (first === undefined) throw new Error("expected a qualified opening");

    // A newer occurrence arrives while the draft is still open.
    test.at(local(11, 0, 20, 6));
    test.controller.reconcile();
    const newer = test.controller.outstanding()[0]?.occurrence.id;

    // Saving the older draft acknowledges only through its own opening.
    test.controller.acknowledge(first.occurrence, first.generation);
    test.controller.reconcile();

    expect(test.controller.outstanding()[0]?.occurrence.id).toBe(newer);
  });

  it("ignores an answer from an older generation", () => {
    const test = harness({ rhythm: false });

    test.at(local(11, 0, 10));
    test.controller.reconcile();
    const frozen = test.controller.captureAt("main", local(11, 0, 10))[0];
    if (frozen === undefined) throw new Error("expected a qualified opening");

    // The schedule's time changes, which starts a new generation.
    test.setSchedules([
      schedule({ when: { kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], hour: 12, minute: 0 } })
    ]);
    test.at(local(12, 0));
    test.controller.reconcile();

    expect(test.controller.acknowledge(frozen.occurrence, frozen.generation)).toBe("obsolete");
    test.controller.reconcile();

    // The new generation's invitation is untouched by the old answer.
    expect(test.controller.outstanding()).toHaveLength(1);
  });

  it("qualifies no beginning outside the opening's own minute", () => {
    const test = harness({ rhythm: false });

    test.at(local(10, 50));
    test.controller.reconcile();
    const approaching = test.controller.outstanding()[0];
    expect(approaching?.phase).toBe("approaching");

    // An approaching notice is not an opening yet, so a beginning now (and one
    // from before it) qualifies for nothing.
    expect(test.controller.captureAt("main", local(10, 50))).toEqual([]);
    expect(test.controller.captureAt("main", local(11, 0) - 1)).toEqual([]);

    // Inside the minute it does, and only there.
    expect(test.controller.captureAt("main", local(11, 0))).toHaveLength(1);
    expect(test.controller.captureAt("main", local(11, 1))).toEqual([]);
  });
});

describe("settings and visibility", () => {
  it("hides every invitation when the master switch is off, and writes nothing", () => {
    const test = harness({ rhythm: false });

    test.at(local(11, 0));
    test.controller.reconcile();
    expect(test.controller.outstanding()).toHaveLength(1);

    test.setEnabled(false);
    test.controller.reconcile();
    expect(test.controller.outstanding()).toEqual([]);
    // Only schedule runtime is stored; no note fact is ever produced here.
    for (const record of test.persist) {
      expect(Object.keys(record)).toEqual(["workspaces", "schedules"]);
    }
  });

  it("offers the rhythm through its own switch, into Main", () => {
    const test = harness({ schedules: [] });

    test.at(local(11, 0));
    test.controller.reconcile();
    const sources = test.controller.sources();
    expect(sources[0]?.id).toBe("rhythm");
    expect(sources[0]?.contextId).toBe("main");

    test.setRhythm(false);
    test.controller.reconcile();
    expect(test.controller.sources().find((source) => source.id === "rhythm")).toBeUndefined();
  });

  it("does not speak about an invitation while the app is hidden", () => {
    const test = harness({ rhythm: false });
    test.setVisible(false);

    test.at(local(11, 0));
    test.controller.reconcile();
    expect(test.invites).toEqual([]);
    expect(test.controller.outstanding()).toHaveLength(1);
  });

  it("speaks once per occurrence, and never once per second", () => {
    const test = harness({ rhythm: false });

    test.at(local(11, 0));
    test.controller.reconcile();
    test.controller.reconcile();
    test.at(local(11, 0, 1));
    test.controller.reconcile();

    expect(test.invites).toHaveLength(1);
  });

  it("clears a schedule's pending invitation when its time changes", () => {
    const test = harness({ rhythm: false });

    test.at(local(11, 0));
    test.controller.reconcile();
    expect(test.controller.outstanding()).toHaveLength(1);

    test.setSchedules([
      schedule({ when: { kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], hour: 13, minute: 0 } })
    ]);
    test.controller.reconcile();
    expect(test.controller.outstanding()).toEqual([]);

    test.at(local(13, 0));
    test.controller.reconcile();
    expect(test.controller.outstanding()).toHaveLength(1);
  });

  it("offers nothing for a schedule that no longer exists", () => {
    const test = harness({ rhythm: false });
    test.at(local(11, 0));
    test.controller.reconcile();

    test.setSchedules([]);
    test.controller.reconcile();
    expect(test.controller.outstanding()).toEqual([]);
  });
});

describe("the beginning a draft is written through", () => {
  it("returns every schedule that shares the minute, sorted by schedule", () => {
    const test = harness({
      rhythm: false,
      schedules: [
        schedule({ id: "beta", name: "Beta" }),
        schedule({ id: "alpha", name: "Alpha" })
      ]
    });

    test.at(local(11, 0, 30));
    test.controller.reconcile();

    const qualified = test.controller.captureAt("main", local(11, 0, 30));
    expect(qualified.map((entry) => entry.occurrence.scheduleId)).toEqual(["alpha", "beta"]);
    // Each carries its own activation's generation, so each is answered alone.
    for (const entry of qualified) expect(entry.generation).toBe(0);
  });

  it("qualifies only openings of the Realm the beginning was written in", () => {
    const test = harness({
      rhythm: false,
      schedules: [schedule({ id: "spanish", contextId: "ctx-spanish" })]
    });

    test.at(local(11, 0, 30));
    test.controller.reconcile();

    expect(test.controller.captureAt("main", local(11, 0, 30))).toEqual([]);
    expect(test.controller.captureAt("ctx-spanish", local(11, 0, 30))).toHaveLength(1);
  });

  it("stops qualifying an opening the writer put away", () => {
    const test = harness({ rhythm: false });

    test.at(local(11, 0, 10));
    test.controller.reconcile();
    const offered = test.controller.outstanding()[0];
    if (offered === undefined) throw new Error("expected an invitation");

    test.controller.dismiss(offered.occurrence.id);
    expect(test.controller.captureAt("main", local(11, 0, 20))).toEqual([]);
  });

  it("says which minute closed, and only while it is recent", () => {
    const test = harness({ rhythm: false });

    test.at(local(11, 0, 30));
    test.controller.reconcile();
    expect(test.controller.recentlyClosed(3000)).toEqual([]);

    test.at(local(11, 1, 1));
    expect(test.controller.recentlyClosed(3000).map((occurrence) => occurrence.portal.minute)).toEqual([0]);

    // Long after: a wake replays nothing.
    test.at(local(14, 30));
    expect(test.controller.recentlyClosed(3000)).toEqual([]);
  });
});
