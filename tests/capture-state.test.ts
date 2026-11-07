import { describe, expect, it } from "vitest";

import { captureInstantAt, type CaptureInvitation, type ThoughtRef } from "../src/core/capture";
import {
  captureHasWork,
  draftProjection,
  initialCaptureModel,
  reduceCapture,
  type CaptureModel,
  type CaptureState,
  type WriteReceipt
} from "../src/core/capture-state";
import type { ThoughtSnapshot } from "../src/core/reference";

const AT = new Date(2026, 0, 1, 9, 0, 0).getTime();

const ref = (n = 1, path = "Chrono/2026.01.01.md"): ThoughtRef => ({
  path,
  n,
  b: 1,
  d: 1,
  rootN: n,
  day: "2026-01-01",
  time: "09:00:00",
  prose: "hi"
});

const snapshot = (text = "hi"): ThoughtSnapshot => ({
  thought: ref(),
  root: ref(),
  ancestry: [ref()],
  day: "2026-01-01",
  time: "09:00:00",
  durationMs: 0,
  originalBlock: "1.1.1 hi\n- 00:00:00",
  text,
  whispers: []
});

const invitation = (generation = 2, occurrenceId = "s@o"): CaptureInvitation => ({
  occurrenceId,
  scheduleId: "s",
  name: "Schedule",
  generation,
  portal: { id: "o", opensAt: AT, day: "2026-01-01", hour: 9, minute: 0, offsetMinutes: 0 },
  contextId: "main"
});

/** A draft with text, built through the real transitions so timestamps are fresh. */
function draftWith(text: string): CaptureModel {
  let model = initialCaptureModel();
  model = reduceCapture(model, {
    kind: "ensure-draft",
    id: "d1",
    target: { kind: "root", contextId: "main" }
  }).model;
  model = reduceCapture(model, {
    kind: "input",
    text,
    selection: { from: text.length, to: text.length },
    at: AT
  }).model;
  return model;
}

const captureReceipt: WriteReceipt = {
  kind: "capture",
  id: "op1",
  path: "Chrono/2026.01.01.md",
  before: "before",
  expected: "expected",
  saved: { thought: ref(), root: ref() }
};

function draftState(model: CaptureModel): Extract<CaptureState, { kind: "draft" }> {
  if (model.state.kind !== "draft") throw new Error(`expected draft, got ${model.state.kind}`);
  return model.state;
}

describe("submitting a draft", () => {
  it("freezes one capture intent with the sampled publication instant", () => {
    const model = draftWith("typed");
    const out = reduceCapture(model, { kind: "submit", id: "op1", published: captureInstantAt(AT) });

    expect(out.model.state.kind).toBe("preparing");
    expect(out.persistence).toBe("required");
    expect(out.effect?.kind).toBe("write");
    if (out.effect?.kind === "write" && out.effect.intent.kind === "capture") {
      expect(out.effect.intent.draft.text).toBe("typed");
      expect(out.effect.intent.id).toBe("op1");
    }
  });

  it("ignores a repeated submit while the first write is still preparing", () => {
    const preparing = reduceCapture(draftWith("typed"), {
      kind: "submit",
      id: "op1",
      published: captureInstantAt(AT)
    }).model;
    const again = reduceCapture(preparing, { kind: "submit", id: "op2", published: captureInstantAt(AT) });

    expect(again.model).toBe(preparing);
    expect(again.effect).toBeNull();
  });

  it("refuses an empty draft without freezing an intent", () => {
    const model = draftWith("   ");
    const out = reduceCapture(model, { kind: "submit", id: "op1", published: captureInstantAt(AT) });
    expect(out.model.state.kind).toBe("draft");
    expect(out.effect).toBeNull();
    expect(out.model.notice?.code).toBe("empty");
  });
});

describe("the write protocol", () => {
  function writing(): CaptureModel {
    const preparing = reduceCapture(draftWith("typed"), {
      kind: "submit",
      id: "op1",
      published: captureInstantAt(AT)
    }).model;
    return reduceCapture(preparing, { kind: "receipt-prepared", intentId: "op1", receipt: captureReceipt }).model;
  }

  it("records the receipt before commit, then finalizes on confirmed bytes", () => {
    const model = writing();
    expect(model.state.kind).toBe("writing");

    const finalizing = reduceCapture(model, { kind: "write-confirmed", intentId: "op1" });
    expect(finalizing.model.state.kind).toBe("finalizing");
    expect(finalizing.effect?.kind).toBe("finalize");

    const done = reduceCapture(finalizing.model, { kind: "completion-stored", intentId: "op1" });
    expect(done.model.state.kind).toBe("resting");
  });

  it("returns an initial refusal to editable work, keeping the text", () => {
    const model = writing();
    const refused = reduceCapture(model, {
      kind: "write-refused",
      intentId: "op1",
      reason: "invalid",
      message: "no"
    });
    expect(refused.model.state.kind).toBe("draft");
    expect(draftState(refused.model).draft.text).toBe("typed");
    expect(refused.persistence).toBe("best-effort");
  });

  it("treats an unknown outcome as unconfirmed, never as failure", () => {
    const model = writing();
    const out = reduceCapture(model, { kind: "write-unconfirmed", intentId: "op1", message: "unknown" });
    expect(out.model.state.kind).toBe("unconfirmed");
  });

  it("keeps old evidence when a retry is refused", () => {
    const unconfirmed = reduceCapture(writing(), { kind: "write-unconfirmed", intentId: "op1", message: "x" }).model;
    const absent = reduceCapture(
      reduceCapture(unconfirmed, { kind: "check" }).model,
      { kind: "check-absent", intentId: "op1", message: "nothing landed" }
    ).model;
    expect(absent.state.kind).toBe("retryable");

    const retry = reduceCapture(absent, { kind: "retry", id: "op2", published: captureInstantAt(AT) });
    expect(retry.model.state.kind).toBe("preparing");
    if (retry.model.state.kind === "preparing") expect(retry.model.state.retryOf?.intent.id).toBe("op1");

    const refused = reduceCapture(retry.model, {
      kind: "write-refused",
      intentId: "op2",
      reason: "retry-source-changed",
      message: "changed"
    });
    expect(refused.model.state.kind).toBe("retryable");
    if (refused.model.state.kind === "retryable") expect(refused.model.state.pending.intent.id).toBe("op1");
  });

  it("ignores a late result that names a different intent", () => {
    const model = writing();
    const out = reduceCapture(model, { kind: "write-confirmed", intentId: "someone-else" });
    expect(out.model).toBe(model);
  });

  it("checks an unconfirmed write, and treats an unreadable note as still unknown", () => {
    const unconfirmed = reduceCapture(writing(), { kind: "write-unconfirmed", intentId: "op1", message: "x" }).model;
    const checking = reduceCapture(unconfirmed, { kind: "check" });
    expect(checking.model.state.kind).toBe("checking");
    expect(checking.effect?.kind).toBe("check");

    const failed = reduceCapture(checking.model, { kind: "check-failed", intentId: "op1", message: "unreadable" });
    expect(failed.model.state.kind).toBe("unconfirmed");
  });
});

describe("durability and storage failure", () => {
  it("blocks further writes when the store fails, but keeps the draft readable", () => {
    const model = reduceCapture(draftWith("typed"), { kind: "storage-failed", message: "disk" }).model;
    expect(model.durability).toBe("blocked");

    const submit = reduceCapture(model, { kind: "submit", id: "op1", published: captureInstantAt(AT) });
    expect(submit.model.state.kind).toBe("draft");
    expect(submit.effect).toBeNull();
    expect(submit.model.notice?.code).toBe("store-blocked");
    expect(captureHasWork(model)).toBe(true);
  });

  it("re-runs only the finalization handoff on retry-local-save", () => {
    const preparing = reduceCapture(draftWith("typed"), {
      kind: "submit",
      id: "op1",
      published: captureInstantAt(AT)
    }).model;
    const writing = reduceCapture(preparing, { kind: "receipt-prepared", intentId: "op1", receipt: captureReceipt }).model;
    const finalizing = reduceCapture(writing, { kind: "write-confirmed", intentId: "op1" }).model;
    const failed = reduceCapture(finalizing, { kind: "storage-failed", message: "disk" }).model;

    const retry = reduceCapture(failed, { kind: "retry-local-save" });
    expect(retry.model.state.kind).toBe("finalizing");
    expect(retry.effect?.kind).toBe("finalize");
  });
});

describe("correction", () => {
  it("borrows the composer for a revision and restores the protected draft on cancel", () => {
    const model = draftWith("protected draft text");
    const began = reduceCapture(model, { kind: "begin-revision", snapshot: snapshot("authored"), id: "r1" });
    expect(began.model.state.kind).toBe("revision");
    if (began.model.state.kind === "revision") {
      expect(began.model.state.revision.returnTo.kind).toBe("draft");
      expect(began.model.state.revision.text).toBe("authored");
    }

    const cancelled = reduceCapture(began.model, { kind: "cancel-revision" });
    expect(cancelled.model.state.kind).toBe("draft");
    expect(draftState(cancelled.model).draft.text).toBe("protected draft text");
  });

  it("refuses a second revision while one is open", () => {
    const model = draftWith("protected");
    const began = reduceCapture(model, { kind: "begin-revision", snapshot: snapshot(), id: "r1" }).model;
    const second = reduceCapture(began, { kind: "begin-revision", snapshot: snapshot(), id: "r2" });
    expect(second.model.state.kind).toBe("revision");
    expect(second.model.notice?.code).toBe("finish-first");
  });
});

describe("target and input transitions", () => {
  it("cancels a proposal on the next committed input and keeps the original target", () => {
    const model = draftWith("typed");
    const confirming = reduceCapture(model, {
      kind: "retarget",
      target: { kind: "root", contextId: "other" },
      confirm: true,
      proposalId: 7
    });
    expect(confirming.model.state.kind).toBe("target-confirmation");

    const typed = reduceCapture(confirming.model, {
      kind: "input",
      text: "typed more",
      selection: { from: 10, to: 10 },
      at: AT + 1
    });
    expect(typed.model.state.kind).toBe("draft");
    const draft = draftState(typed.model).draft;
    expect(draft.target).toEqual({ kind: "root", contextId: "main" });
    expect(draft.text).toBe("typed more");
  });

  it("refuses a new root over a nonempty draft", () => {
    const out = reduceCapture(draftWith("typed"), { kind: "new-root", contextId: "main" });
    expect(out.model.state.kind).toBe("draft");
    expect(out.model.notice?.code).toBe("draft-not-empty");
  });
});

describe("acknowledgement queue", () => {
  it("drops exactly the answered occurrence and generation", () => {
    const model: CaptureModel = {
      ...initialCaptureModel(),
      acknowledgements: [invitation(2, "s@o"), invitation(3, "t@p")]
    };
    const one = reduceCapture(model, { kind: "acknowledged", occurrenceId: "s@o", generation: 2 });
    expect(one.model.acknowledgements.map((a) => a.occurrenceId)).toEqual(["t@p"]);

    const wrongGeneration = reduceCapture(model, { kind: "acknowledged", occurrenceId: "s@o", generation: 9 });
    expect(wrongGeneration.model.acknowledgements).toHaveLength(2);
  });
});

describe("projection", () => {
  it("records the last painted second, not a fresh sample", () => {
    const model = draftWith("typed");
    const painted = reduceCapture(model, { kind: "painted", ms: 2500 }).model;
    const draft = draftState(painted).draft;
    expect(draftProjection({ ...draft, clock: { ...draft.clock, resumedAt: null } }).durationMs).toBe(2000);
  });
});
