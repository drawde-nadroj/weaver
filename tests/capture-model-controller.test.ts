import { describe, expect, it } from "vitest";

import { captureInstantAt, type CaptureReceipt, type CaptureRequest, type ThoughtRef } from "../src/core/capture";
import { mainContext, type WeavingContext } from "../src/core/contexts";
import type { CaptureEnvelopeV2 } from "../src/entries/capture-store";
import {
  CaptureModelController,
  type CaptureModelHost,
  type CaptureStorePort
} from "../src/entries/capture-model-controller";
import type { ThoughtSnapshot } from "../src/core/reference";

const NOW = new Date(2026, 10, 5, 9, 0, 0).getTime();
const PATH = "Chronomancer/2026.11.05.md";

const ref: ThoughtRef = {
  path: PATH,
  n: 1,
  b: 1,
  d: 1,
  rootN: 1,
  day: "2026-11-05",
  time: "09:00:00",
  prose: "typed"
};

const snapshot: ThoughtSnapshot = {
  thought: ref,
  root: ref,
  ancestry: [ref],
  day: "2026-11-05",
  time: "09:00:00",
  durationMs: 0,
  originalBlock: "",
  text: "original",
  whispers: []
};

/** A store that enforces compare-and-set and records every write. */
class MemoryStore implements CaptureStorePort {
  envelope: CaptureEnvelopeV2 | null = null;
  writes = 0;
  loadCapture(): CaptureEnvelopeV2 | null {
    return this.envelope;
  }
  saveCapture(next: CaptureEnvelopeV2, expected: number | null): CaptureEnvelopeV2 {
    const actual = this.envelope?.revision ?? null;
    if (actual !== expected) throw new Error(`revision ${actual} != ${expected}`);
    this.writes += 1;
    this.envelope = { ...next, revision: (expected ?? 0) + 1 };
    return this.envelope;
  }
}

class Host implements CaptureModelHost {
  readonly store = new MemoryStore();
  readonly stages: unknown[] = [];
  /** Every request handed to the writer, so its frozen clock can be read. */
  readonly requests: CaptureRequest[] = [];
  outcome: "confirmed" | "unconfirmed" | "refused" = "confirmed";
  persisted: string | null = "before";
  live: string | null = null;
  acknowledgements: string[] = [];
  /** The world time a surface samples; moving it never moves the draft's clock. */
  current: number = NOW;

  now(): number {
    return this.current;
  }
  contexts(): readonly WeavingContext[] {
    return [
      mainContext({ folder: "Chronomancer", format: "YYYY.MM.DD" }),
      { id: "ctx-spanish", name: "Spanish", folder: "Spanish/Daily", format: "YYYY.MM.DD" }
    ];
  }
  private receipt(request: CaptureRequest): CaptureReceipt {
    return {
      id: "op",
      request,
      invitations: [],
      path: PATH,
      thought: ref,
      root: ref,
      before: "before",
      expected: "expected"
    };
  }
  async writeCapture(request: CaptureRequest, _retry: unknown, beforeCommit: (r: CaptureReceipt) => void) {
    this.requests.push(request);
    const receipt = this.receipt(request);
    beforeCommit(receipt);
    if (this.outcome === "confirmed") return { kind: "confirmed" as const, receipt };
    if (this.outcome === "unconfirmed") return { kind: "unconfirmed" as const, receipt, message: "unknown" };
    return { kind: "refused" as const, reason: "invalid", message: "no" };
  }
  async read(): Promise<string | null> {
    return this.persisted;
  }
  async confirmPersisted(): Promise<boolean> {
    return false;
  }
  async editInNote(): Promise<boolean> {
    return true;
  }
  freezeNative(): void {}
  async pauseNative(): Promise<boolean> {
    return true;
  }
  invitationsAt() {
    return [];
  }
  acknowledge(): "acknowledged" | "obsolete" | "retry" {
    this.acknowledgements.push("ack");
    return "acknowledged";
  }
  stageCompletion(pending: unknown): void {
    this.stages.push(pending);
  }
  onChange(): void {}
}

/** Lets the controller's async effects run, with no wall-clock wait. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

function harness() {
  const host = new Host();
  const controller = new CaptureModelController(host);
  return { controller, host };
}

/** A draft with text, submitted with a fresh intent. */
async function submitted(controller: CaptureModelController): Promise<void> {
  controller.dispatch({ kind: "ensure-draft", id: "d1", target: { kind: "root", contextId: "main" } });
  controller.dispatch({
    kind: "input",
    text: "typed",
    selection: { from: 5, to: 5 },
    at: NOW,
    invitations: []
  });
  controller.dispatch({ kind: "submit", id: "op1", published: captureInstantAt(NOW) });
  await flush();
}

describe("writing through the model", () => {
  it("confirms, stages completion, and rests with the receipt removed", async () => {
    const { controller, host } = harness();
    controller.start();
    await submitted(controller);

    expect(controller.model.state.kind).toBe("resting");
    expect(host.stages).toHaveLength(1);
    expect(host.store.envelope?.state.kind).toBe("resting");
    expect(host.store.writes).toBeGreaterThan(0);
  });

  it("keeps an unknown outcome as unconfirmed and reconciles it by Check", async () => {
    const { controller, host } = harness();
    host.outcome = "unconfirmed";
    controller.start();
    await submitted(controller);
    expect(controller.model.state.kind).toBe("unconfirmed");

    host.persisted = "before";
    await controller.checkSave();
    expect(controller.model.state.kind).toBe("retryable");
    expect(controller.state.phase).toBe("retryable");
    host.outcome = "confirmed";
    await controller.settle();
    expect(controller.model.state.kind).toBe("resting");
    expect(host.store.envelope?.state.kind).toBe("resting");
    expect(host.stages).toHaveLength(1);
  });

  it("confirms a Check when the note holds the expected bytes", async () => {
    const { controller, host } = harness();
    host.outcome = "unconfirmed";
    controller.start();
    await submitted(controller);

    host.persisted = "expected";
    controller.dispatch({ kind: "check" });
    await flush();
    expect(controller.model.state.kind).toBe("resting");
  });

  it("returns a definite refusal to editable work", async () => {
    const { controller, host } = harness();
    host.outcome = "refused";
    controller.start();
    await submitted(controller);
    expect(controller.model.state.kind).toBe("draft");
  });
});

describe("the clock a save records", () => {
  /** A started draft with one committed input, whose clock begins at `at`. */
  function typed(controller: CaptureModelController, at = NOW): void {
    controller.start();
    controller.dispatch({ kind: "ensure-draft", id: "d1", target: { kind: "root", contextId: "main" } });
    controller.dispatch({ kind: "input", text: "typed", selection: { from: 5, to: 5 }, at, invitations: [] });
  }

  it("files the last painted second even when the wall clock has moved on", async () => {
    const { controller, host } = harness();
    typed(controller);
    // The surface is the only thing that may advance the record: a fresh sample
    // taken at submit time must never replace the second that was on screen.
    controller.commitDuration(7000);
    host.current = NOW + 9000;

    await controller.settle();

    expect(host.requests).toHaveLength(1);
    expect(host.requests[0]?.durationMs).toBe(7000);
  });

  it("keeps the painted second through a pause and a late tick", async () => {
    const { controller, host } = harness();
    typed(controller);
    controller.commitDuration(4000);
    controller.pause();
    controller.commitDuration(9000);
    host.current = NOW + 12000;

    await controller.settle();

    expect(host.requests[0]?.durationMs).toBe(4000);
  });

  it("counts only the spans spent writing", async () => {
    const { controller, host } = harness();
    typed(controller);
    controller.commitDuration(4000);
    expect(controller.state.clockRunning).toBe(true);
    controller.pause();
    host.current = NOW + 60000;

    // Paused: the shown second is frozen, and a wall-clock sample never moves it.
    expect(controller.state.durationMs).toBe(4000);
    expect(controller.state.clockRunning).toBe(false);
    controller.commitDuration(9000);
    expect(controller.state.durationMs).toBe(4000);

    // Resuming starts from the stop, not from the minute that passed.
    controller.setText("typed more");
    expect(controller.state.clockRunning).toBe(true);
    host.current = NOW + 62000;
    controller.commitDuration(6000);
    expect(controller.state.durationMs).toBe(6000);

    host.current = NOW + 90000;
    await controller.settle();

    expect(host.requests[0]?.durationMs).toBe(6000);
  });

  it("dates the thought from its first input, not from the save", async () => {
    const { controller, host } = harness();
    const began = new Date(2026, 10, 5, 23, 59, 59).getTime();
    typed(controller, began);
    controller.commitDuration(1000);
    host.current = new Date(2026, 10, 6, 0, 0, 4).getTime();

    await controller.settle();

    expect(host.requests[0]?.beginning.at).toBe(began);
    expect(host.requests[0]?.beginning.day).toBe("2026-11-05");
    expect(host.requests[0]?.beginning.time).toBe("23:59:59");
  });
});

describe("opening while a draft exists", () => {
  function held(controller: CaptureModelController): void {
    controller.start();
    controller.dispatch({
      kind: "ensure-draft",
      id: "d1",
      target: { kind: "root", contextId: "spanish" }
    });
    controller.dispatch({ kind: "input", text: "held words", selection: { from: 10, to: 10 }, at: NOW });
  }

  it("proposes the named Realm instead of silently keeping the old one", () => {
    const { controller } = harness();
    held(controller);

    controller.open("main", { move: true });

    // The words are not moved on the caller's word alone: the old destination
    // still holds them until the writer answers the proposal.
    expect(controller.state.pendingTarget).toEqual({ kind: "root", contextId: "main" });
    expect(controller.state.text).toBe("held words");
    expect(controller.state.contextId).toBe("spanish");
  });

  it("resumes without retargeting when the caller names no Realm", () => {
    const { controller } = harness();
    held(controller);

    controller.open("main");

    expect(controller.state.pendingTarget).toBeNull();
    expect(controller.state.contextId).toBe("spanish");
  });

  it("keeps a second proposal a proposal while the draft holds words", async () => {
    const { controller } = harness();
    held(controller);

    await controller.requestTarget({ kind: "root", contextId: "main" });
    expect(controller.state.pendingTarget).toEqual({ kind: "root", contextId: "main" });

    // A replacement proposal still asks; it must not silently move held words.
    await controller.requestTarget({ kind: "root", contextId: "elsewhere" });
    expect(controller.state.pendingTarget).toEqual({ kind: "root", contextId: "elsewhere" });
    expect(controller.state.text).toBe("held words");
  });

  it("moves an empty draft straight to the named Realm", () => {
    const { controller } = harness();
    controller.start();
    controller.dispatch({
      kind: "ensure-draft",
      id: "d1",
      target: { kind: "root", contextId: "spanish" }
    });

    controller.open("main", { move: true });

    expect(controller.state.pendingTarget).toBeNull();
    expect(controller.state.contextId).toBe("main");
  });
});

describe("starting a thread", () => {
  it("starts a new root in the explicitly named destination", async () => {
    const { controller } = harness();
    controller.start();

    await controller.newThread("ctx-spanish");

    expect(controller.state.phase).toBe("editing");
    expect(controller.state.contextId).toBe("ctx-spanish");
  });
});

describe("correction state", () => {
  it("borrows the composer and restores the protected draft on cancel", () => {
    const { controller } = harness();
    controller.start();
    controller.dispatch({ kind: "ensure-draft", id: "d1", target: { kind: "root", contextId: "main" } });
    controller.dispatch({ kind: "input", text: "protected", selection: { from: 9, to: 9 }, at: NOW });

    controller.dispatch({ kind: "begin-revision", snapshot, id: "r1" });
    expect(controller.model.state.kind).toBe("revision");

    controller.dispatch({ kind: "cancel-revision" });
    expect(controller.model.state.kind).toBe("draft");
  });
});

describe("recovery", () => {
  it("restores paused work from the durable store", async () => {
    const { controller, host } = harness();
    host.store.envelope = {
      version: 2,
      revision: 1,
      state: {
        kind: "draft",
        draft: {
          id: "d1",
          target: { kind: "root", contextId: "main" },
          text: "resumed",
          selection: { from: 7, to: 7 },
          beginning: null,
          durationMs: 3000,
          invitations: []
        }
      },
      acknowledgements: []
    };
    controller.start();

    expect(controller.model.state.kind).toBe("draft");
    if (controller.model.state.kind === "draft") {
      expect(controller.model.state.draft.text).toBe("resumed");
      expect(controller.model.state.draft.clock.shownMs).toBe(3000);
    }
    expect(controller.state.clockRunning).toBe(false);
  });

  it("blocks durability when the store cannot be read", () => {
    const { controller, host } = harness();
    host.store.loadCapture = () => {
      throw new Error("unreadable");
    };
    controller.start();
    expect(controller.model.durability).toBe("blocked");
  });
});
