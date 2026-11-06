import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatLocalTimestamp, mergeAlignment } from "../src/core/alignments";
import { dayKey } from "../src/core/day";
import { portalInstants, type PortalInstant } from "../src/core/portals";
import { PortalController, type PortalHost } from "../src/entries/portals";

/** A local wall-clock instant on 2026-11-05, at whole seconds. */
const at = (hour: number, minute: number, second = 0): number =>
  new Date(2026, 10, 5, hour, minute, second).getTime();

/** The same clock one day later, for the rollover that moves today's note. */
const nextDay = (hour: number, minute: number): number => new Date(2026, 10, 6, hour, minute).getTime();

/** The one eligible opening that this local minute holds. */
function opening(hour: number, minute: number): PortalInstant {
  const [portal] = portalInstants(at(hour, minute), at(hour, minute));
  if (portal === undefined) throw new Error(`${hour}:${minute} is not a portal minute`);
  return portal;
}

/** Today's day note path, exactly as the host would resolve it. */
const todayPath = (instant: number): string => `Journal/${dayKey(new Date(instant))}.md`;
const TODAY = "Journal/2026-11-05.md";
const TOMORROW = "Journal/2026-11-06.md";

/** An empty day note: no frontmatter, no history, nothing entered. */
const EMPTY = "";

let now = at(12, 1);
let enabled = true;
let visible = true;
let active: string | null = null;
let invites: { id: string; remaining: number }[] = [];

const host: PortalHost = {
  now: () => now,
  enabled: () => enabled,
  todayPath,
  activePath: () => active,
  visible: () => visible,
  invite: (portal, remainingSeconds) => {
    invites.push({ id: portal.id, remaining: remainingSeconds });
  }
};

let controller = new PortalController(host);

beforeEach(() => {
  now = at(12, 1);
  enabled = true;
  visible = true;
  active = null;
  invites = [];
  vi.useFakeTimers();
  controller = new PortalController(host);
});

afterEach(() => {
  controller.destroy();
  vi.useRealTimers();
});

describe("PortalController candidates", () => {
  it("shows the eleven-minute lead and the open minute, and nothing else", () => {
    expect(controller.candidates(TODAY, EMPTY).map((portal) => portal.minute)).toEqual([11, 12]);

    now = at(12, 11);
    expect(controller.candidates(TODAY, EMPTY).map((portal) => portal.minute)).toEqual([11, 12, 22]);
    expect(controller.phase(opening(12, 11))).toBe("open");
    expect(controller.phase(opening(12, 12))).toBe("approaching");

    // Exactly at the end of the opening's own minute it is no longer offered.
    now = at(12, 12);
    expect(controller.candidates(TODAY, EMPTY).map((portal) => portal.minute)).toEqual([12, 22]);
    expect(controller.phase(opening(12, 11))).toBe("expired");
  });

  it("offers only today's note, never a historical one", () => {
    expect(controller.candidates("Journal/2026-11-04.md", EMPTY)).toEqual([]);
    // Nor a note nobody resolved as today, even at the same wall time.
    expect(controller.candidates("", EMPTY)).toEqual([]);
  });

  it("previews the midnight opening at the end of today's note", () => {
    now = at(23, 50);
    expect(controller.candidates(TODAY, EMPTY).map((portal) => [portal.day, portal.minute])).toEqual([
      ["2026-11-05", 55],
      ["2026-11-06", 0]
    ]);
  });

  it("still shows openings when the note's history cannot be read, so capture can refuse", () => {
    const malformed = "---\nweaver-alignments:\n  - not json\n---\n";
    expect(controller.candidates(TODAY, malformed).map((portal) => portal.minute)).toEqual([11, 12]);
    expect(controller.candidates(TODAY, "---\nweaver-alignments:\nweaver-alignments:\n---\n")).toHaveLength(2);
    expect(controller.candidates(TODAY, "---\nkind: day\n")).toHaveLength(2);

    // A prepared opening survives the same unreadable source: the refusal is
    // the capture's, and the frame the writer is typing into must not vanish.
    now = at(11, 55);
    const portal = opening(11, 55);
    controller.prepare(portal.id);
    now = at(11, 57);
    controller.reconcile();
    const shown = controller.candidates(TODAY, malformed).map((candidate) => candidate.minute);
    expect(shown).toEqual([55, 0]);
    expect(controller.phase(portal)).toBe("held");
  });
});

describe("PortalController invitations", () => {
  it("announces the nearest eligible opening once and only once per id", () => {
    controller.reconcile();
    expect(invites).toEqual([{ id: opening(12, 11).id, remaining: 600 }]);

    // Re-deriving the same minute, and every second inside it, stays silent.
    controller.reconcile();
    now = at(12, 1, 30);
    controller.reconcile();
    expect(invites).toHaveLength(1);

    // The next boundary crossing introduces exactly one new opening.
    now = at(12, 11);
    controller.reconcile();
    expect(invites).toEqual([
      { id: opening(12, 11).id, remaining: 600 },
      { id: opening(12, 22).id, remaining: 660 }
    ]);

    now = at(12, 22);
    controller.reconcile();
    expect(invites.at(-1)).toEqual({ id: opening(12, 33).id, remaining: 660 });
  });

  it("speaks nothing while hidden and resumes with one truthful sentence", () => {
    visible = false;
    controller.reconcile();
    now = at(12, 30);
    controller.reconcile();
    expect(invites).toEqual([]);

    // Waking after many boundaries: one invitation, about actually remaining time.
    visible = true;
    controller.reconcile();
    expect(invites).toEqual([{ id: opening(12, 33).id, remaining: 180 }]);

    // A wake that lands inside an opening's minute announces that opening as
    // here now, truthfully, rather than as a time already past.
    visible = false;
    now = at(12, 44, 30);
    controller.reconcile();
    visible = true;
    controller.reconcile();
    expect(invites.at(-1)).toEqual({ id: opening(12, 44).id, remaining: 0 });
    expect(invites).toHaveLength(2);
  });

  it("never repeats a notice after the clock is corrected backwards", () => {
    controller.reconcile();
    now = at(12, 11);
    controller.reconcile();
    expect(invites.map((invite) => invite.id)).toEqual([
      opening(12, 11).id,
      opening(12, 22).id
    ]);

    // Both openings were already spoken for; an earlier instant inside their
    // lead window must stay silent.
    now = at(12, 5);
    controller.reconcile();
    expect(invites).toHaveLength(2);

    now = at(12, 11);
    controller.reconcile();
    expect(invites).toHaveLength(2);
  });

  it("announces nothing at all when portals are switched off", () => {
    enabled = false;
    controller.reconcile();
    now = at(12, 30);
    controller.reconcile();
    expect(invites).toEqual([]);
  });
});

describe("PortalController hold", () => {
  it("holds a prepared opening past its minute and removes it on release", () => {
    now = at(11, 55);
    const portal = opening(11, 55);
    controller.prepare(portal.id);
    expect(controller.held()).toEqual({ portal, path: TODAY });

    now = at(11, 57);
    controller.reconcile();
    expect(controller.phase(portal)).toBe("held");
    expect(controller.candidates(TODAY, EMPTY).map((candidate) => candidate.id)).toContain(portal.id);

    controller.release();
    expect(controller.held()).toBeNull();
    expect(controller.candidates(TODAY, EMPTY).map((candidate) => candidate.id)).not.toContain(portal.id);
    expect(controller.phase(portal)).toBe("expired");
  });

  it("releases the previous hold in the same emission when another is prepared", () => {
    let emissions = 0;
    controller.subscribe(() => {
      emissions += 1;
    });

    controller.prepare(opening(12, 11).id);
    expect(controller.held()?.portal.id).toBe(opening(12, 11).id);
    controller.prepare(opening(12, 12).id);
    expect(controller.held()?.portal.id).toBe(opening(12, 12).id);
    expect(emissions).toBe(2);
  });

  it("ignores an unknown, out-of-window, expired or already-entered id", () => {
    controller.prepare("1999-01-01T00:00:00.000Z");
    controller.prepare(opening(12, 33).id);
    expect(controller.held()).toBeNull();

    // The end of the opening's own minute is already too late to prepare it.
    now = at(12, 12);
    controller.prepare(opening(12, 11).id);
    expect(controller.held()).toBeNull();

    now = at(12, 1);
    controller.consume(opening(12, 11).id);
    controller.prepare(opening(12, 11).id);
    expect(controller.held()).toBeNull();
  });

  it("drops the hold when the app hides, when portals are disabled, or on unload", () => {
    controller.prepare(opening(12, 11).id);
    visible = false;
    controller.reconcile();
    expect(controller.held()).toBeNull();

    visible = true;
    controller.reconcile();
    controller.prepare(opening(12, 11).id);
    enabled = false;
    controller.reconcile();
    expect(controller.held()).toBeNull();
    expect(controller.candidates(TODAY, EMPTY)).toEqual([]);

    enabled = true;
    controller.prepare(opening(12, 11).id);
    controller.destroy();
    expect(controller.held()).toBeNull();
  });

  it("clears the hold when its portal is entered", () => {
    controller.prepare(opening(12, 11).id);
    controller.consume(opening(12, 11).id);
    expect(controller.held()).toBeNull();
  });

  it("keeps a hold pinned to its note across midnight while today moves on", () => {
    now = at(23, 50);
    const midnight = portalInstants(nextDay(0, 0), nextDay(0, 0))[0]!;
    controller.prepare(midnight.id);
    expect(controller.held()).toEqual({ portal: midnight, path: TODAY });

    now = nextDay(0, 1);
    controller.reconcile();

    // The held opening is still offered in the note it was prepared in, and
    // only there: today's new note offers today's own openings.
    expect(controller.candidates(TODAY, EMPTY).map((portal) => portal.id)).toEqual([midnight.id]);
    expect(controller.phase(midnight)).toBe("held");
    expect(controller.candidates(TOMORROW, EMPTY).map((portal) => portal.minute)).toEqual([11]);
  });

  it("pins to today's note even when an unrelated note is active", () => {
    active = "Notes/scratch.md";
    controller.prepare(opening(12, 11).id);
    expect(controller.held()?.path).toBe(TODAY);
    expect(controller.candidates(TODAY, EMPTY).map((portal) => portal.minute)).toContain(11);
  });
});

describe("PortalController consumption", () => {
  it("never offers an entered portal again in this session", () => {
    controller.consume(opening(12, 11).id);
    expect(controller.candidates(TODAY, EMPTY).map((portal) => portal.minute)).toEqual([12]);
    controller.consume(opening(12, 11).id);
    expect(controller.candidates(TODAY, EMPTY).map((portal) => portal.minute)).toEqual([12]);
  });

  it("consults the note's own history after a reload", () => {
    const portal = opening(12, 11);
    const merged = mergeAlignment("---\nkind: day\n---\n\nbody\n", {
      portal: portal.id,
      opened: formatLocalTimestamp(new Date(portal.opensAt)),
      began: formatLocalTimestamp(new Date(portal.opensAt + 55_500)),
      entry: 1
    });
    if (!merged.ok) throw new Error(merged.error);
    expect(merged.source).toContain("body");

    const reloaded = new PortalController(host);
    try {
      expect(reloaded.candidates(TODAY, merged.source).map((candidate) => candidate.minute)).toEqual([12]);
      // The history is per note: another day's note still offers its own times.
      reloaded.consume(opening(12, 12).id);
      expect(reloaded.candidates(TODAY, merged.source)).toEqual([]);
    } finally {
      reloaded.destroy();
    }
  });
});

describe("PortalController lifecycle emissions", () => {
  it("emits on lifecycle changes only, never on a query or an elapsed second", () => {
    let emissions = 0;
    controller.subscribe(() => {
      emissions += 1;
    });

    controller.reconcile();
    expect(emissions).toBe(1);
    controller.reconcile();
    now = at(12, 1, 30);
    controller.reconcile();
    expect(emissions).toBe(1);

    // Queries are free.
    controller.candidates(TODAY, EMPTY);
    controller.phase(opening(12, 11));
    controller.held();
    expect(emissions).toBe(1);

    // Sliding into the next second of the same minute changes nothing.
    now = at(12, 2);
    controller.reconcile();
    expect(emissions).toBe(1);

    // A new opening entering the lead does change the offered set, so surfaces
    // redraw once for the minute, not once per second.
    now = at(12, 11);
    controller.reconcile();
    expect(emissions).toBe(2);

    // Entering a portal changes the set once, not once per call.
    controller.consume(opening(12, 11).id);
    controller.consume(opening(12, 11).id);
    expect(emissions).toBe(3);
  });

  it("stops emitting and scheduling after destroy", () => {
    let emissions = 0;
    controller.subscribe(() => {
      emissions += 1;
    });
    controller.reconcile();
    const settled = emissions;

    controller.destroy();
    now = at(12, 11);
    vi.advanceTimersByTime(120_000);
    expect(emissions).toBe(settled);
    expect(controller.candidates(TODAY, EMPTY)).toEqual([]);
  });
});

describe("isolated mirror boundaries", () => {
  it("emits opening and held-expiry phases even when the candidate ids stay the same", () => {
    now = at(15, 14, 59);
    controller.reconcile();
    const ids = controller.candidates(TODAY, EMPTY).map(portal => portal.id);
    let emissions = 0;
    controller.subscribe(() => { emissions += 1; });
    now = at(15, 15);
    controller.reconcile();
    expect(controller.candidates(TODAY, EMPTY).map(portal => portal.id)).toEqual(ids);
    expect(emissions).toBe(1);
    controller.prepare(opening(15, 15).id);
    now = at(15, 16);
    controller.reconcile();
    expect(controller.phase(opening(15, 15))).toBe("held");
    expect(emissions).toBe(3);
  });

  it("does not invite an already announced opening after disabling and re-enabling", () => {
    controller.reconcile();
    const before = invites.slice();
    enabled = false;
    controller.reconcile();
    enabled = true;
    controller.reconcile();
    expect(invites).toEqual(before);
  });
});

describe("PortalController scheduling", () => {
  it("keeps one minute-boundary timer and derives status when it wakes", () => {
    controller.reconcile();
    expect(vi.getTimerCount()).toBe(1);
    controller.prepare(opening(12, 11).id);
    expect(vi.getTimerCount()).toBe(1);

    // A callback that wakes while the clock is still at 12:01 must reschedule
    // from the actual instant instead of advancing anything by counting ticks.
    vi.advanceTimersByTime(70_000);
    expect(invites).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);

    now = at(12, 2);
    vi.advanceTimersByTime(60_000);
    expect(controller.candidates(TODAY, EMPTY).map((portal) => portal.minute)).toEqual([11, 12]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("schedules nothing while portals are switched off", () => {
    enabled = false;
    controller.reconcile();
    expect(vi.getTimerCount()).toBe(0);
  });
});
