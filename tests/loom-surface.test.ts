import { describe, expect, it } from "vitest";

import type { ThoughtRef } from "../src/core/capture";
import {
  initialLoomModel,
  reduceLoom,
  type LoomAction,
  type LoomModel,
  type ReviewSetup
} from "../src/core/loom";

const ref: ThoughtRef = {
  path: "Chrono/2026.01.01.md",
  n: 3,
  b: 1,
  d: 2,
  rootN: 1,
  day: "2026-01-01",
  time: "09:00:00",
  prose: "hi"
};

function run(model: LoomModel, ...actions: LoomAction[]): LoomModel {
  return actions.reduce((current, action) => reduceLoom(current, action).model, model);
}

const setup = (id = "rev-1"): ReviewSetup => ({
  id,
  revision: 1,
  target: { kind: "new" },
  values: {},
  errors: {},
  returnPanel: "reviews",
  phaseTop: "editing",
  saveOperationId: null,
  submittedRevision: null
});

describe("opening and hiding", () => {
  it("starts hidden and opens over a collapsed upper half", () => {
    const model = run(initialLoomModel(), { kind: "open-writing" });
    expect(model.surface.kind).toBe("expanded");
    if (model.surface.kind !== "expanded") return;
    expect(model.surface.upper).toEqual({ kind: "collapsed", retainedPanel: "reference" });
    expect(model.surface.activeArea).toBe("lower");
  });

  it("hides without losing the content it will resume", () => {
    const shown = run(initialLoomModel(), { kind: "open-reference", panel: "tapestries" });
    const hidden = run(shown, { kind: "hide" });
    expect(hidden.surface.kind).toBe("hidden");
    if (hidden.surface.kind !== "hidden") return;
    expect(hidden.surface.resume.upper).toEqual({ kind: "shown", panel: "tapestries" });
  });

  it("a collapsed upper half cannot own focus", () => {
    const model = run(initialLoomModel(), { kind: "open-reference", panel: "reviews" }, { kind: "collapse-upper" });
    if (model.surface.kind !== "expanded") throw new Error("expected expanded");
    expect(model.surface.activeArea).toBe("lower");
    expect(model.surface.upper).toEqual({ kind: "collapsed", retainedPanel: "reviews" });
  });
});

describe("front layers", () => {
  it("a menu exists only in front of an expanded shell", () => {
    const hidden = run(initialLoomModel(), { kind: "open-menu", invokerId: "x" });
    expect(hidden.surface.kind).toBe("hidden");

    const expanded = run(initialLoomModel(), { kind: "open-writing" }, { kind: "open-menu", invokerId: "x" });
    if (expanded.surface.kind !== "expanded") throw new Error("expected expanded");
    expect(expanded.surface.front).toEqual({ kind: "menu", invokerId: "x" });

    const closed = run(expanded, { kind: "close-front" });
    if (closed.surface.kind !== "expanded") throw new Error("expected expanded");
    expect(closed.surface.front).toEqual({ kind: "none" });
  });

  it("arms and clears a delete confirmation", () => {
    const armed = run(
      initialLoomModel(),
      { kind: "open-reference", panel: "reference" },
      { kind: "request-delete", target: ref, subtree: "bytes", count: 2 }
    );
    if (armed.surface.kind !== "expanded") throw new Error("expected expanded");
    expect(armed.surface.front.kind).toBe("delete-confirmation");

    const cleared = run(armed, { kind: "confirm-delete" });
    if (cleared.surface.kind !== "expanded") throw new Error("expected expanded");
    expect(cleared.surface.front).toEqual({ kind: "none" });
  });
});

describe("Tapestry order", () => {
  it("moves a chosen Tapestry to the front and records its instant", () => {
    const model = run(
      initialLoomModel(),
      { kind: "select-tapestry", id: "main", at: 10 },
      { kind: "select-tapestry", id: "spanish", at: 20 },
      { kind: "select-tapestry", id: "main", at: 30 }
    );
    expect(model.selectedTapestry).toBe("main");
    expect(model.mru.map((entry) => entry.id)).toEqual(["main", "spanish"]);
    expect(model.mru[0]?.at).toBe(30);
  });

  it("cycles a frozen order, wrapping", () => {
    const start = run(initialLoomModel(), { kind: "select-tapestry", id: "a", at: 1 });
    const order = ["a", "b", "c"];
    const next = run(start, { kind: "cycle-tapestry", order, delta: 1, at: 2 });
    expect(next.selectedTapestry).toBe("b");
    const wrapped = run(next, { kind: "cycle-tapestry", order, delta: 1, at: 3 }, { kind: "cycle-tapestry", order, delta: 1, at: 4 });
    expect(wrapped.selectedTapestry).toBe("a");
  });
});

describe("Review setup", () => {
  it("shows a form, then clears it on cancel while returning to its panel", () => {
    const opened = run(initialLoomModel(), { kind: "begin-review", setup: setup() });
    expect(opened.reviewSetup?.id).toBe("rev-1");
    if (opened.surface.kind !== "expanded") throw new Error("expected expanded");
    expect(opened.surface.upper).toEqual({ kind: "shown", panel: "review-form" });

    const cancelled = run(opened, { kind: "cancel-review", revision: 1 });
    expect(cancelled.reviewSetup).toBeNull();
    if (cancelled.surface.kind !== "expanded") throw new Error("expected expanded");
    expect(cancelled.surface.upper).toEqual({ kind: "shown", panel: "reviews" });
  });

  it("ignores duplicate saves and late field edits for a superseded revision", () => {
    const opened = run(initialLoomModel(), { kind: "begin-review", setup: setup() });
    const saving = run(opened, { kind: "save-review", revision: 1, operationId: "op" });
    expect(saving.reviewSetup?.phaseTop).toBe("preparing");

    const duplicate = run(saving, { kind: "save-review", revision: 1, operationId: "op2" });
    expect(duplicate.reviewSetup?.saveOperationId).toBe("op");

    const stale = run(saving, { kind: "change-review-field", revision: 0, values: { name: "x" }, errors: {} });
    expect(stale.reviewSetup?.values).toEqual({});
  });
});

describe("back and visibility", () => {
  it("back collapses a shown upper half, then hides", () => {
    const shown = run(initialLoomModel(), { kind: "open-reference", panel: "invitations" });
    const collapsed = run(shown, { kind: "back" });
    if (collapsed.surface.kind !== "expanded") throw new Error("expected expanded");
    expect(collapsed.surface.upper).toEqual({ kind: "collapsed", retainedPanel: "invitations" });

    const hidden = run(collapsed, { kind: "back" });
    expect(hidden.surface.kind).toBe("hidden");
  });

  it("an app becoming invisible hides the shell", () => {
    const model = run(initialLoomModel(), { kind: "open-writing" }, { kind: "visibility-changed", visible: false });
    expect(model.surface.kind).toBe("hidden");
  });
});
