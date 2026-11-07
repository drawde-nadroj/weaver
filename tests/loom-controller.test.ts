import { describe, expect, it } from "vitest";

import type { CaptureAction, CaptureModel, PendingWrite } from "../src/core/capture-state";
import { initialCaptureModel } from "../src/core/capture-state";
import { initialLoomModel, type LoomModel } from "../src/core/loom";
import { LoomController, type LoomCaptureOwner, type LoomPorts, type LoomReferenceOwner } from "../src/entries/loom";
import type { ReferenceAction, ReferenceModel } from "../src/entries/reference";

/** A lower owner that records commands and lets a test emit a change. */
class FakeCapture implements LoomCaptureOwner {
  model: CaptureModel = initialCaptureModel();
  readonly actions: CaptureAction[] = [];
  started = 0;
  disposed = 0;
  private listeners: Array<(model: CaptureModel) => void> = [];

  dispatch(action: CaptureAction): void {
    this.actions.push(action);
  }
  subscribe(listener: (model: CaptureModel) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((candidate) => candidate !== listener);
    };
  }
  start(): void {
    this.started += 1;
  }
  dispose(): void {
    this.disposed += 1;
  }
  emit(): void {
    for (const listener of [...this.listeners]) listener(this.model);
  }
}

class FakeReference implements LoomReferenceOwner {
  model: ReferenceModel = {
    readiness: { kind: "idle" },
    place: { kind: "none" },
    body: { kind: "none" },
    search: { kind: "off" },
    selection: null,
    textOffset: 0,
    activeReview: null,
    notice: null
  };
  readonly actions: ReferenceAction[] = [];
  disposed = 0;
  private listeners: Array<(model: ReferenceModel) => void> = [];

  dispatch(action: ReferenceAction): void {
    this.actions.push(action);
  }
  subscribe(listener: (model: ReferenceModel) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((candidate) => candidate !== listener);
    };
  }
  dispose(): void {
    this.disposed += 1;
  }
  emit(): void {
    for (const listener of [...this.listeners]) listener(this.model);
  }
}

class FakeUi {
  saved: LoomModel | null = null;
  saves = 0;
  load(): LoomModel | null {
    return this.saved;
  }
  save(model: LoomModel): void {
    this.saves += 1;
    this.saved = model;
  }
}

function harness() {
  const capture = new FakeCapture();
  const reference = new FakeReference();
  const ui = new FakeUi();
  let changes = 0;
  const ports: LoomPorts = {
    now: () => 1000,
    capture,
    reference,
    ui,
    tapestryOf: (path) => (path.startsWith("Spanish") ? "ctx-spanish" : null)
  };
  const loom = new LoomController(ports);
  loom.subscribe(() => {
    changes += 1;
  });
  return {
    loom,
    capture,
    reference,
    ui,
    get changes() {
      return changes;
    }
  };
}

const pending = (contextId: string): PendingWrite => ({
  kind: "capture",
  intent: {
    kind: "capture",
    id: "op",
    draft: {
      id: "op",
      target: { kind: "root", contextId },
      text: "typed",
      selection: { from: 5, to: 5 },
      beginning: null,
      durationMs: 0,
      invitations: []
    },
    published: {
      at: 1000,
      day: "2026-11-05",
      time: "09:00:00",
      localTimestamp: "2026-11-05T09:00:00+00:00"
    },
    portal: null
  },
  receipt: {
    kind: "capture",
    id: "op",
    path: "Chrono.md",
    before: "b",
    expected: "e",
    saved: {
      thought: { path: "Chrono.md", n: 1, b: 1, d: 1, rootN: 1, day: null, time: null, prose: "typed" },
      root: { path: "Chrono.md", n: 1, b: 1, d: 1, rootN: 1, day: null, time: null, prose: "typed" }
    }
  }
});

describe("composing the surface", () => {
  it("projects the shell, the draft and the reference together", () => {
    const test = harness();
    const state = test.loom.model;
    expect(state.loom).toEqual(initialLoomModel());
    expect(state.capture).toBe(test.capture.model);
    expect(state.reference).toBe(test.reference.model);
  });

  it("reduces and persists a shell command", () => {
    const test = harness();
    test.loom.dispatch({ kind: "open-writing" });

    expect(test.loom.model.loom.surface.kind).toBe("expanded");
    expect(test.ui.saves).toBe(1);
  });

  it("forwards capture and reference commands untouched", () => {
    const test = harness();
    test.loom.dispatch({ kind: "capture", action: { kind: "pause" } });
    test.loom.dispatch({ kind: "reference", action: { kind: "move", direction: "next" } });

    expect(test.capture.actions).toEqual([{ kind: "pause" }]);
    expect(test.reference.actions).toEqual([{ kind: "move", direction: "next" }]);
  });

  it("notifies subscribers when an owner changes", () => {
    const test = harness();
    test.loom.start();
    const before = test.changes;
    test.capture.emit();
    expect(test.changes).toBeGreaterThan(before);
  });
});

describe("lifecycle", () => {
  it("starts and disposes the owners", () => {
    const test = harness();
    test.loom.start();
    expect(test.capture.started).toBe(1);

    test.loom.dispose();
    expect(test.capture.disposed).toBe(1);
    expect(test.reference.disposed).toBe(1);
  });

  it("ignores commands after disposal", () => {
    const test = harness();
    test.loom.dispose();
    test.loom.dispatch({ kind: "capture", action: { kind: "pause" } });
    expect(test.capture.actions).toEqual([]);
  });
});

describe("staging a confirmed capture", () => {
  it("selects the writing Tapestry and moves it to the front of the MRU", () => {
    const test = harness();
    test.loom.stageCaptureCompletion(pending("ctx-spanish"));

    expect(test.loom.model.loom.selectedTapestry).toBe("ctx-spanish");
    expect(test.loom.model.loom.mru[0]).toEqual({ id: "ctx-spanish", at: 1000 });
    expect(test.ui.saved?.selectedTapestry).toBe("ctx-spanish");
  });

  it("resolves a branch parent's Tapestry and ignores an unknown one", () => {
    const test = harness();
    const spanish = { path: "Spanish/Daily/2026.11.05.md", n: 2, b: 1, d: 1, rootN: 2, day: null, time: null, prose: "p" };
    const branch = (path: string): PendingWrite => ({
      kind: "capture",
      intent: {
        kind: "capture",
        id: "op2",
        draft: {
          id: "op2",
          target: { kind: "branch", parent: { ...spanish, path } },
          text: "t",
          selection: { from: 1, to: 1 },
          beginning: null,
          durationMs: 0,
          invitations: []
        },
        published: { at: 1000, day: "2026-11-05", time: "09:00:00", localTimestamp: "2026-11-05T09:00:00+00:00" },
        portal: null
      },
      receipt: {
        kind: "capture",
        id: "op2",
        path,
        before: "b",
        expected: "e",
        saved: { thought: { ...spanish, path }, root: { ...spanish, path } }
      }
    });

    test.loom.stageCaptureCompletion(branch("Spanish/Daily/2026.11.05.md"));
    expect(test.loom.model.loom.selectedTapestry).toBe("ctx-spanish");

    const unknown = harness();
    unknown.loom.stageCaptureCompletion(branch("Chrono/2026.11.05.md"));
    expect(unknown.loom.model.loom.selectedTapestry).toBeNull();
  });
});
