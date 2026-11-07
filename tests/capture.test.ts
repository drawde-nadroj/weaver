import { describe, expect, it } from "vitest";

import {
  branchLabel,
  captureInstantAt,
  resolveThought,
  type CaptureInvitation,
  thoughtRefOf,
  type CaptureReceipt,
  type CaptureRequest,
  type CaptureResult,
  type ThoughtRef
} from "../src/core/capture";
import { parseEntries, type EntryIndex } from "../src/core/entries";
import { readCaptureRecord } from "../src/entries/local-state";
import { mainContext, type WeavingContext } from "../src/core/contexts";
import {
  CaptureController,
  type CaptureRecord,
  type CaptureStore,
  type CaptureHost
} from "../src/entries/capture";

const CONTEXTS: WeavingContext[] = [mainContext({ folder: "Chronomancer", format: "YYYY.MM.DD" })];

const NOTE = "Chronomancer/2026.11.05.md";

/** A day note holding one root with a child, so a saved thread can be selected. */
const SOURCE = [
  "---",
  "date: 2026-11-05",
  "---",
  "",
  "{ 1.1.1 }",
  "",
  "the first thought",
  "+ 00:04:00 2026-11-05 09:00:00",
  "",
  "{ 1.2.2 }",
  "",
  "a branch",
  "+ 00:01:00 2026-11-05 09:10:00",
  ""
].join("\n");

/** The `N`s of that fixture, in document order. */
function fixture(): EntryIndex {
  return parseEntries(SOURCE);
}

/** A reference to the root or the child of the fixture. */
function fixtureRef(which: 0 | 1): ThoughtRef {
  const index = fixture();
  const entry = index.entries[which];
  if (entry === undefined) throw new Error("the fixture is missing that entry");
  return thoughtRefOf(index, entry, NOTE);
}

/** A memory store that can be told to fail, to prove the refusal boundary. */
class MemoryStore implements CaptureStore {
  record: CaptureRecord | null = null;
  failWrites = false;
  clears = 0;

  load(): CaptureRecord | null {
    return this.record;
  }

  save(record: CaptureRecord): void {
    if (this.failWrites) throw new Error("storage is read-only");
    this.record = record;
  }

  clear(): void {
    this.clears += 1;
    this.record = null;
  }
}

/**
 * A store that validates on the way out, exactly as `LocalState` does.
 *
 * A reload reads stored JSON, never the object a previous session held in
 * memory, so provenance that could not pass validation must not reach the
 * controller at all.
 */
class ValidatingStore extends MemoryStore {
  override load(): CaptureRecord | null {
    return this.record === null ? null : readCaptureRecord(this.record);
  }
}

/** One configured reply from the writer, which may be withheld or refused. */
type Answer = { kind: "result"; result: CaptureResult } | { kind: "pending" | "fails" };

/**
 * A promise whose resolvers are kept.
 *
 * `Promise.withResolvers` is ES2024; this project's library target is ES2022, so
 * the executor is the only way to hold the two functions.
 */
function deferred(): {
  promise: Promise<CaptureResult>;
  resolve(result: CaptureResult): void;
  reject(error: Error): void;
} {
  const resolvers: {
    promise: Promise<CaptureResult>;
    resolve(result: CaptureResult): void;
    reject(error: Error): void;
  } = {
    promise: Promise.resolve({ ok: false, error: "unresolved" }),
    resolve: () => {},
    reject: () => {}
  };
  resolvers.promise = new Promise<CaptureResult>((resolve, reject) => {
    resolvers.resolve = resolve;
    resolvers.reject = reject;
  });
  return resolvers;
}

interface Harness {
  controller: CaptureController;
  store: MemoryStore;
  requests: CaptureRequest[];
  /** Every submission's frozen openings, in order. */
  sentInvitations: CaptureInvitation[][];
  acknowledged: CaptureInvitation[];
  edits: ThoughtRef[];
  pauses: number;
  frozen: number;
  at(ms: number): void;
  advance(ms: number): void;
  answer(result: CaptureResult): void;
  hold(): { release(result: CaptureResult): void; fail(error: Error): void };
  setNote(path: string, text: string): void;
  /** Holds text in the live editor, which the file does not have yet. */
  setLive(path: string, text: string): void;
  /** Paths whose owning editor was asked to save during Check note. */
  confirmations: string[];
}

function harness(
  options: { notes?: Record<string, string>; store?: MemoryStore; open?: boolean } = {}
): Harness {
  let now = new Date(2026, 10, 5, 9, 0, 0).getTime();
  const store = options.store ?? new MemoryStore();
  const requests: CaptureRequest[] = [];
  const acknowledged: CaptureInvitation[] = [];
  const edits: ThoughtRef[] = [];
  const notes = new Map<string, string>(Object.entries(options.notes ?? { [NOTE]: SOURCE }));
  const live = new Map<string, string>();
  const confirmations: string[] = [];

  const sentInvitations: CaptureInvitation[][] = [];
  let answer: Answer = { kind: "result", result: { ok: false, error: "not configured" } };
  let settle: ReturnType<typeof deferred> | null = null;

  const state: Harness = {
    controller: null as unknown as CaptureController,
    store,
    requests,
    sentInvitations,
    acknowledged,
    edits,
    pauses: 0,
    frozen: 0,
    confirmations,
    at(ms) {
      now = ms;
    },
    advance(ms) {
      now += ms;
    },
    answer(result) {
      answer = { kind: "result", result };
      settle = null;
    },
    hold() {
      const held = deferred();
      settle = held;
      answer = { kind: "pending" };
      return {
        release: (result) => held.resolve(result),
        fail: (error) => held.reject(error)
      };
    },
    setNote(path, text) {
      notes.set(path, text);
    },
    setLive(path, text) {
      live.set(path, text);
    }
  };

  const host: CaptureHost = {
    now: () => now,
    contexts: () => CONTEXTS,
    capture: (request, invitations) => {
      requests.push(request);
      sentInvitations.push([...invitations]);
      if (answer.kind === "pending" && settle !== null) return (settle as ReturnType<typeof deferred>).promise;
      if (answer.kind === "fails") return Promise.reject(new Error("the vault stopped answering"));
      return Promise.resolve(answer.kind === "result" ? answer.result : { ok: false, error: "no answer" });
    },
    read: (path) => Promise.resolve(notes.get(path) ?? null),
    confirmPersisted: async (path, expected) => {
      confirmations.push(path);
      if (live.get(path) !== expected) return false;
      notes.set(path, expected);
      return true;
    },
    editInNote: (target) => {
      edits.push(target);
      return Promise.resolve(true);
    },
    freezeNative: () => {
      state.frozen += 1;
    },
    pauseNative: () => {
      state.pauses += 1;
      return Promise.resolve(true);
    },
    // The fake world offers one opening, contained by the instant it is asked
    // about — exactly what the controller is entitled to assume.
    invitationsAt: (contextId, at) => [
      {
        occurrenceId: `morning@2026-11-05T09:00:00.000Z`,
        scheduleId: "morning",
        name: "Morning",
        generation: 1,
        contextId,
        portal: {
          id: "2026-11-05T09:00:00.000Z",
          opensAt: at,
          day: "2026-11-05",
          hour: 9,
          minute: 0,
          offsetMinutes: 0
        }
      }
    ],
    acknowledge: (invitation) => {
      acknowledged.push(invitation);
    },
    store,
    onChange: () => {}
  };

  state.controller = new CaptureController(host);
  // A recovered controller is restored from its store, not opened over it.
  if (options.open !== false) state.controller.open("main");
  return state;
}

/** The thought a fresh save would be given, with the address a note would take. */
function savedResult(n = 3): CaptureResult {
  const thought = {
    path: NOTE,
    n,
    b: 1,
    d: 1,
    rootN: n,
    day: "2026-11-05",
    time: "09:00:07",
    prose: "typed"
  };
  return { ok: true, thought, root: thought };
}

/** A receipt for a submission of `typed` that was planned against the fixture. */
function fixtureReceipt(id: string): CaptureReceipt {
  const saved = savedResult();
  if (!saved.ok) throw new Error("the fixture result is a failure");
  return {
    id,
    request: {
      contextId: "main",
      parent: null,
      text: "typed",
      beginning: captureInstantAt(new Date(2026, 10, 5, 9, 0, 0).getTime()),
      durationMs: 0,
      portal: null
    },
    invitations: [],
    path: NOTE,
    thought: saved.thought,
    root: saved.root,
    before: SOURCE,
    expected: `${SOURCE}typed\n`
  };
}

/** A controller restored onto a stored receipt, in the state a crash leaves it. */
function recovered(notes: Record<string, string>): { test: Harness; store: MemoryStore } {
  const store = new MemoryStore();
  store.record = { draft: null, receipt: fixtureReceipt("receipt-recovered") };

  const test = harness({ notes, store, open: false });
  test.controller.recover();
  return { test, store };
}

describe("the draft's beginning and timing", () => {
  it("freezes one beginning from the first committed character", () => {
    const test = harness();
    const controller = test.controller;

    controller.setText("t");
    const begun = controller.state.beginning;
    expect(begun).not.toBeNull();
    expect(begun?.day).toBe("2026-11-05");
    expect(begun?.time).toBe("09:00:00");
    expect(begun?.localTimestamp).toMatch(/^2026-11-05T09:00:00[+-]\d{2}:\d{2}$/);

    // The beginning is one fact: a later keystroke does not move it.
    test.advance(3000);
    controller.setText("typed");
    expect(controller.state.beginning?.at).toBe(begun?.at);
  });

  it("treats leading whitespace as nothing and a real character as the beginning", () => {
    const test = harness();
    test.controller.setText("   ");
    expect(test.controller.state.beginning).toBeNull();

    test.advance(2000);
    test.controller.setText("   a");
    expect(test.controller.state.beginning?.time).toBe("09:00:02");
  });

  it("resets the beginning when every character is removed", () => {
    const test = harness();
    test.controller.setText("a thought");
    test.advance(5000);
    test.controller.setText("");

    expect(test.controller.state.beginning).toBeNull();
    expect(test.controller.state.durationMs).toBe(0);
  });

  it("writes the last second that was shown, not one sampled later", async () => {
    const test = harness();
    const controller = test.controller;

    controller.setText("seven seconds");
    controller.commitDuration(7000);
    test.advance(2000);
    test.answer(savedResult());
    await controller.settle();

    expect(test.requests[0]?.durationMs).toBe(7000);
  });

  it("counts only the spans spent writing", () => {
    const test = harness();
    const controller = test.controller;

    controller.setText("a");
    test.advance(4000);
    controller.commitDuration(4000);
    controller.pause();
    test.advance(60_000);
    // Nothing accrues while it is paused, and the resume starts from the stop.
    expect(controller.state.durationMs).toBe(4000);

    controller.setText("ab");
    test.advance(2000);
    controller.commitDuration(6000);
    expect(controller.state.durationMs).toBe(6000);
  });
});

describe("one submission", () => {
  it("writes once and rests on the saved thought", async () => {
    const test = harness();
    test.controller.setText("typed");
    test.answer(savedResult());

    await test.controller.settle();

    expect(test.requests).toHaveLength(1);
    expect(test.controller.state.phase).toBe("resting");
    expect(test.controller.state.selected?.n).toBe(3);
    expect(test.store.clears).toBeGreaterThan(0);
  });

  it("ignores a second settle while the first is still saving", async () => {
    const test = harness();
    const held = test.hold();

    test.controller.setText("typed");
    const first = test.controller.settle();
    await test.controller.settle();
    expect(test.controller.state.phase).toBe("submitting");
    expect(test.requests).toHaveLength(1);

    held.release(savedResult());
    await first;
    // Repeated submission never queues a hide or a continuation.
    expect(test.requests).toHaveLength(1);
    expect(test.controller.state.phase).toBe("resting");
  });

  it("keeps the text and its timing when the note refuses", async () => {
    const test = harness();
    test.controller.setText("typed");
    test.controller.commitDuration(3000);
    test.answer({ ok: false, error: "this note cannot take a new entry" });

    await test.controller.settle();

    expect(test.controller.state.phase).toBe("editing");
    expect(test.controller.state.text).toBe("typed");
    expect(test.controller.state.error).toContain("cannot take a new entry");
    expect(test.controller.state.durationMs).toBe(3000);
  });

  it("refuses to settle an empty draft", async () => {
    const test = harness();
    await test.controller.settle();

    expect(test.requests).toHaveLength(0);
    expect(test.controller.state.error).toContain("nothing to save");
  });

  it("does not write prose that is only whitespace", async () => {
    const test = harness();
    test.controller.setText("   \n  ");
    await test.controller.settle();
    expect(test.requests).toHaveLength(0);
  });
});

describe("an unconfirmed save", () => {
  it("is never retried as an append", async () => {
    const test = harness();
    const held = test.hold();

    test.controller.setText("typed");
    const pending = test.controller.settle();
    held.fail(new Error("the vault stopped answering"));
    await pending;

    expect(test.controller.state.phase).toBe("uncertain");
    expect(test.controller.state.error).toContain("could not be confirmed");
    await test.controller.settle();
    expect(test.requests).toHaveLength(1);
  });

  it("is saved when the note holds exactly what the write would have produced", async () => {
    const { test } = recovered({ [NOTE]: `${SOURCE}typed\n` });
    expect(test.controller.state.phase).toBe("uncertain");

    await test.controller.checkSave();

    expect(test.controller.state.phase).toBe("resting");
    expect(test.controller.state.selected?.n).toBe(3);
  });

  it("confirms a save the live editor already holds, without replaying it", async () => {
    const { test } = recovered({ [NOTE]: SOURCE });
    test.setLive(NOTE, `${SOURCE}typed\n`);

    await test.controller.checkSave();

    expect(test.controller.state.phase).toBe("resting");
    expect(test.confirmations).toEqual([NOTE]);
  });

  it("may be submitted again only when the note is byte-for-byte unchanged", async () => {
    const { test } = recovered({ [NOTE]: SOURCE });

    await test.controller.checkSave();

    expect(test.controller.state.phase).toBe("editing");
    expect(test.controller.state.error).toContain("did not reach the note");
  });

  it("stays unconfirmed when the note changed some other way", async () => {
    const { test } = recovered({ [NOTE]: `${SOURCE}someone else was here\n` });

    await test.controller.checkSave();

    expect(test.controller.state.phase).toBe("uncertain");
    expect(test.controller.state.error).toContain("cannot explain");
  });

  it("refuses a submission whose receipt cannot be stored", () => {
    const test = harness();
    test.store.failWrites = true;

    expect(() => test.controller.attachReceipt(fixtureReceipt("receipt-unwritable"))).toThrow();
  });
});

describe("one draft at a time", () => {
  it("resumes the draft that is already open instead of replacing it", () => {
    const test = harness();
    test.controller.setText("work in progress");

    test.controller.open("main");

    expect(test.controller.state.text).toBe("work in progress");
    expect(test.controller.state.phase).toBe("editing");
    expect(test.controller.state.collapsed).toBe(false);
    // The words are the writer's; no key of them was cleared by the gesture.
    expect(test.controller.state.beginning).not.toBeNull();
  });

  it("refuses to replace that draft with a saved thread", async () => {
    const test = harness();
    test.controller.setText("typed");

    expect(await test.controller.resumeThread(fixtureRef(0))).toBe(false);
    expect(test.controller.state.text).toBe("typed");
  });
});

describe("branching and new threads", () => {
  it("branches from the selected thought and names what it branches from", async () => {
    const test = harness();
    const root = fixtureRef(0);

    await test.controller.branch(root);
    expect(test.controller.state.parent?.n).toBe(1);
    expect(test.controller.state.phase).toBe("editing");
    expect(branchLabel(root)).toContain("the first thought");
    expect(branchLabel(root)).toContain("1.1.1");
  });

  it("starts a fresh root in the current destination", async () => {
    const test = harness();
    await test.controller.branch(fixtureRef(0));

    await test.controller.newThread();
    expect(test.controller.state.parent).toBeNull();
    expect(test.controller.state.text).toBe("");
    expect(test.controller.state.contextId).toBe("main");
  });

  it("proposes rather than clearing a new Thread over written words", async () => {
    const test = harness();
    await test.controller.branch(fixtureRef(0));
    test.controller.setText("a branch");

    await test.controller.newThread();
    // Nothing was cleared: the same draft is paused under a proposal.
    expect(test.controller.state.text).toBe("a branch");
    expect(test.controller.state.parent?.n).toBe(1);
    expect(test.controller.state.pendingTarget).toEqual({ kind: "root", contextId: "main" });

    await test.controller.confirmTarget();
    expect(test.controller.state.text).toBe("a branch");
    expect(test.controller.state.parent).toBeNull();
  });

  it("returns to the saved thread from an empty branch without writing", async () => {
    const test = harness();
    await test.controller.branch(fixtureRef(0));
    test.controller.backToSavedThought();

    expect(test.controller.state.parent).toBeNull();
    expect(test.controller.state.phase).toBe("resting");
    expect(test.requests).toHaveLength(0);
  });

  it("refuses to move a saved thread's destination", async () => {
    const test = harness();
    await test.controller.branch(fixtureRef(0));

    test.controller.setDestination("ctx-other");
    expect(test.controller.state.contextId).toBe("main");
    expect(test.controller.state.error).toContain("stays in its own note");
  });

  it("keeps the real beginning when an unsaved root changes destination", async () => {
    const test = harness();
    test.controller.setText("a thought");
    const begun = test.controller.state.beginning?.at;

    test.advance(4000);
    // With words in the draft, a destination change is a proposal: the words,
    // the beginning and the seconds on screen stay put until it is confirmed.
    // An unknown Realm resolves to `main`, which is where the draft already goes.
    await test.controller.setDestination("ctx-other");
    expect(test.controller.state.pendingTarget).toEqual({ kind: "root", contextId: "main" });
    expect(test.controller.state.beginning?.at).toBe(begun);

    await test.controller.confirmTarget();
    expect(test.controller.state.beginning?.at).toBe(begun);
    expect(test.controller.state.text).toBe("a thought");
  });
});

describe("collapsing and dismissing", () => {
  it("folds intact and freezes the clock", () => {
    const test = harness();
    test.controller.setText("keep me");
    test.advance(5000);
    test.controller.commitDuration(5000);

    test.controller.collapse();
    expect(test.controller.state.collapsed).toBe(true);
    expect(test.controller.state.text).toBe("keep me");

    test.advance(60_000);
    expect(test.controller.state.durationMs).toBe(5000);
  });

  it("does not lose unsaved prose to Escape", () => {
    const test = harness();
    test.controller.setText("keep me");

    test.controller.dismiss();
    expect(test.controller.state.phase).toBe("editing");
    expect(test.controller.state.collapsed).toBe(true);
  });

  it("closes an empty composer outright", () => {
    const test = harness();
    test.controller.discardDraft();
    expect(test.controller.state.phase).toBe("closed");
  });
});

describe("recovery", () => {
  it("restores a stored draft paused and folded, without writing", () => {
    const store = new MemoryStore();
    store.record = {
      draft: {
        contextId: "main",
        parent: null,
        root: null,
        text: "half a thought",
        selection: { from: 13, to: 13 },
        beginning: captureInstantAt(new Date(2026, 10, 5, 9, 0, 0).getTime()),
        durationMs: 12_000,
        collapsed: false,
        invitations: []
      },
      receipt: null
    };

    const test = harness({ store, open: false });
    test.controller.recover();

    expect(test.controller.state.phase).toBe("editing");
    expect(test.controller.state.collapsed).toBe(true);
    expect(test.controller.state.text).toBe("half a thought");
    expect(test.controller.state.durationMs).toBe(12_000);
    expect(test.controller.state.beginning?.time).toBe("09:00:00");
    expect(test.requests).toHaveLength(0);

    // Nothing accrues while it waits, and only real input resumes it.
    test.advance(5000);
    expect(test.controller.state.durationMs).toBe(12_000);
    test.controller.setText("half a thought, continued");
    expect(test.controller.state.durationMs).toBe(12_000);
  });

  it("opens an interrupted submission as unconfirmed", () => {
    const { test } = recovered({ [NOTE]: SOURCE });

    expect(test.controller.state.phase).toBe("uncertain");
    expect(test.controller.state.error).toContain("interrupted");
    expect(test.controller.pendingReceipt()?.id).toBe("receipt-recovered");
  });

  it("leaves an unreadable record alone and warns instead of overwriting it", () => {
    const store = new MemoryStore();
    store.load = () => {
      throw new Error("corrupt record");
    };

    const test = harness({ store, open: false });
    test.controller.recover();

    expect(test.controller.state.error).toContain("could not be read");
    expect(store.record).toBeNull();
  });
});

describe("saved references", () => {
  it("resolves a thought only while every recorded fact still matches", () => {
    const index = fixture();
    const ref = fixtureRef(1);
    expect(resolveThought(index, ref)?.n).toBe(2);

    // A deletion that reuses `N` does not revive the reference.
    const withoutChild = parseEntries(SOURCE.replace("a branch", "another thought"));
    expect(resolveThought(withoutChild, ref)).toBeNull();

    // Neither does editing the prose it pointed at.
    const edited = parseEntries(SOURCE.replace("a branch", "a branch, edited"));
    expect(resolveThought(edited, ref)).toBeNull();

    // Nor a different root for the same entry.
    expect(resolveThought(index, { ...ref, rootN: 99 })).toBeNull();
  });

  it("refuses to continue a thread whose thought is gone", async () => {
    const test = harness();
    const stale = { ...fixtureRef(1), prose: "gone" };

    expect(await test.controller.resumeThread(stale)).toBe(false);
    expect(test.controller.state.error).toContain("no longer in its note");
  });

  it("opens a saved thread on its own root", async () => {
    const test = harness();
    expect(await test.controller.resumeThread(fixtureRef(1))).toBe(true);

    expect(test.controller.state.phase).toBe("resting");
    expect(test.controller.state.root?.n).toBe(1);
    expect(test.controller.state.selected?.n).toBe(2);
  });
});

describe("moving the one draft", () => {
  it("keeps the words, the beginning and the seconds until the move is confirmed", async () => {
    const test = harness();
    test.controller.setText("half a thought");
    test.advance(5000);
    test.controller.commitDuration(5000);

    const begun = test.controller.state.beginning?.at;
    await test.controller.requestTarget({ kind: "branch", parent: fixtureRef(1) });

    // Paused, not moved: nothing about the prose or its timing changed.
    expect(test.controller.state.pendingTarget).toEqual({ kind: "branch", parent: fixtureRef(1) });
    expect(test.controller.state.text).toBe("half a thought");
    expect(test.controller.state.beginning?.at).toBe(begun);

    test.advance(60_000);
    expect(test.controller.state.durationMs).toBe(5000);
  });

  it("changes only the parent when the move is confirmed", async () => {
    const test = harness();
    test.controller.setText("keep these words");
    const begun = test.controller.state.beginning?.at;

    await test.controller.requestTarget({ kind: "branch", parent: fixtureRef(1) });
    expect(await test.controller.confirmTarget()).toBe(true);

    expect(test.controller.state.parent?.n).toBe(2);
    // A deep parent resolves to the Thread's true root.
    expect(test.controller.state.root?.n).toBe(1);
    expect(test.controller.state.text).toBe("keep these words");
    expect(test.controller.state.beginning?.at).toBe(begun);
  });

  it("changes nothing at all when the move is cancelled", async () => {
    const test = harness();
    test.controller.setText("stay here");

    await test.controller.requestTarget({ kind: "branch", parent: fixtureRef(1) });
    test.controller.cancelTarget();

    expect(test.controller.state.pendingTarget).toBeNull();
    expect(test.controller.state.parent).toBeNull();
    expect(test.controller.state.text).toBe("stay here");
  });

  it("refuses a parent whose thought is gone, keeping the draft's own", async () => {
    const test = harness();
    test.controller.setText("my words");
    test.setNote(NOTE, SOURCE.replace("a branch", "something else"));

    await test.controller.requestTarget({ kind: "branch", parent: fixtureRef(1) });

    expect(test.controller.state.pendingTarget).toBeNull();
    expect(test.controller.state.error).toContain("no longer in its note");
    expect(test.controller.state.text).toBe("my words");
    expect(test.controller.state.parent).toBeNull();
  });

  it("starts a branch in a closed composer, which is where a navigator's Branch lands", async () => {
    const test = harness({ open: false });

    expect(test.controller.state.phase).toBe("closed");
    expect(await test.controller.branch(fixtureRef(0))).toBe(true);
    expect(test.controller.state.parent?.n).toBe(1);
    expect(test.controller.state.phase).toBe("editing");
    expect(test.controller.state.text).toBe("");
    expect(test.requests).toHaveLength(0);
  });
});

describe("the openings a draft counts for", () => {
  it("freezes an opening at the first committed input, once", () => {
    const test = harness();
    test.controller.setText("a");
    test.advance(1000);
    test.controller.setText("ab");

    expect(test.controller.state.invitations).toHaveLength(1);
    // A second keystroke is the same beginning, not a new minute.
    expect(test.controller.state.invitations[0]?.portal.opensAt).toBe(
      test.controller.state.beginning?.at
    );
  });

  it("forgets the association when every character is removed", () => {
    const test = harness();
    test.controller.setText("a");
    expect(test.controller.state.invitations).toHaveLength(1);

    test.controller.setText("");
    expect(test.controller.state.invitations).toEqual([]);
    expect(test.controller.state.beginning).toBeNull();
  });

  it("gives a branch no opening of its own", async () => {
    const test = harness();
    await test.controller.branch(fixtureRef(0));
    test.controller.setText("a branch");

    expect(test.controller.state.invitations).toEqual([]);
  });

  it("hands every frozen opening to the write, and acknowledges each once", async () => {
    const test = harness();
    test.controller.setText("a thought");
    test.answer(savedResult());

    await test.controller.settle();

    expect(test.sentInvitations[0]).toHaveLength(1);
    expect(test.acknowledged).toHaveLength(1);
    expect(test.controller.state.invitations).toEqual([]);
  });

  it("restores its openings from the stored draft, paused and folded", () => {
    const store = new ValidatingStore();
    store.record = {
      draft: {
        contextId: "main",
        parent: null,
        root: null,
        text: "half a thought",
        selection: { from: 13, to: 13 },
        beginning: captureInstantAt(new Date(2026, 10, 5, 9, 0, 0).getTime()),
        durationMs: 0,
        collapsed: false,
        invitations: [
          {
            occurrenceId: "morning@2026-11-05T09:00:00.000Z",
            scheduleId: "morning",
            name: "Morning",
            generation: 3,
            contextId: "main",
            portal: {
              id: "2026-11-05T09:00:00.000Z",
              opensAt: new Date(2026, 10, 5, 9, 0, 0).getTime(),
              day: "2026-11-05",
              hour: 9,
              minute: 0,
              offsetMinutes: 0
            }
          }
        ]
      },
      receipt: null
    };

    const test = harness({ store, open: false });
    test.controller.recover();

    expect(test.controller.state.invitations).toHaveLength(1);
    expect(test.controller.state.collapsed).toBe(true);
    // A late save still records the opening the beginning qualified for.
    expect(test.controller.state.error).toBeNull();
  });

  it("never records a later Realm's opening it did not begin in", () => {
    const store = new ValidatingStore();
    store.record = {
      draft: {
        contextId: "main",
        parent: null,
        root: null,
        text: "half a thought",
        selection: { from: 0, to: 0 },
        beginning: captureInstantAt(new Date(2026, 10, 5, 9, 0, 0).getTime()),
        durationMs: 0,
        collapsed: false,
        // The opening is an hour away from the beginning it was stored beside.
        invitations: [
          {
            occurrenceId: "morning@2026-11-05T10:00:00.000Z",
            scheduleId: "morning",
            name: "Morning",
            generation: 1,
            contextId: "main",
            portal: {
              id: "2026-11-05T10:00:00.000Z",
              opensAt: new Date(2026, 10, 5, 10, 0, 0).getTime(),
              day: "2026-11-05",
              hour: 10,
              minute: 0,
              offsetMinutes: 0
            }
          }
        ]
      },
      receipt: null
    };

    const test = harness({ store, open: false });
    test.controller.recover();

    // The prose is kept and the doubtful provenance is dropped, with a reason.
    expect(test.controller.state.text).toBe("half a thought");
    expect(test.controller.state.invitations).toEqual([]);
    expect(test.controller.state.error).toContain("could not be trusted");
  });

  it("drops invalid stored provenance without touching the words beside it", () => {
    const record = readCaptureRecord({
      draft: {
        contextId: "main",
        parent: null,
        root: null,
        text: "the words stay",
        selection: { from: 0, to: 0 },
        beginning: { at: 0, day: "2026-11-05", time: "09:00:00", localTimestamp: "2026-11-05T09:00:00+00:00" },
        durationMs: 0,
        collapsed: false,
        invitations: [{ occurrenceId: "nope", scheduleId: "morning" }]
      },
      receipt: null
    });

    expect(record?.draft?.text).toBe("the words stay");
    expect(record?.draft?.invitations).toEqual([]);
    expect(record?.warnings?.[0]).toContain("could not be trusted");
  });
});

describe("saving from a hidden draft", () => {
  it("finishes without expanding or stealing focus", async () => {
    const test = harness();
    test.controller.setText("written while hidden");
    test.controller.collapse();

    test.answer(savedResult());
    await test.controller.settle();

    // Saved without being summoned: the surface stayed exactly as it was.
    expect(test.controller.state.collapsed).toBe(true);
    expect(test.controller.state.phase).toBe("resting");
    expect(test.requests).toHaveLength(1);
  });

  it("is not expanded by the write it was waiting for", async () => {
    const test = harness();
    test.controller.setText("still writing");
    const held = test.hold();
    const saving = test.controller.settle();

    test.controller.collapse();
    held.release(savedResult());
    await saving;

    // The answer arrived while the surface was hidden; it stayed hidden.
    expect(test.requests).toHaveLength(1);
  });
});
