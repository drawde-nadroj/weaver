import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { whisperKey, type WhisperInput, type WhisperItem } from "../src/core/whisper";
import {
  NoModel,
  type WhisperFailure,
  type WhisperModel,
  type WhisperReply,
  type WhisperRequest
} from "../src/model/whisper-model";
import {
  WHISPER_IDLE_MS,
  WHISPER_READING_DELAY_MS,
  WhisperRunner
} from "../src/model/whisper-runner";

const INPUT: WhisperInput = {
  address: "{ 1.1.1 }",
  prose: "made a version of pi with durable execution in go",
  ancestors: []
};

const ANSWER = JSON.stringify({ whisper: [{ type: "name", text: "durable pi in go" }] });

const OK: WhisperReply = { ok: true, text: ANSWER };
const UNREACHABLE_FAILURE: WhisperFailure = { kind: "unreachable" };
const DEAD: WhisperReply = { ok: false, failure: UNREACHABLE_FAILURE };

interface Harness {
  runner: WhisperRunner;
  /** Every time the runner said the set of waiting entries changed. */
  changes: number;
  /** Every request the model was asked to complete. */
  asked: WhisperRequest[];
  landed: Array<{ path: string; n: number; key: string; whisper: WhisperItem[] }>;
  logged: unknown[][];
}

/** The harness over a model the test supplies. */
function harnessWith(model: WhisperModel): Harness {
  const asked: WhisperRequest[] = [];
  const landed: Harness["landed"] = [];
  const logged: unknown[][] = [];

  const counting: WhisperModel = {
    id: model.id,
    complete: (request) => {
      asked.push(request);
      return model.complete(request);
    }
  };

  const counts = { changes: 0 };
  const runner = new WhisperRunner({
    model: () => counting,
    land: (path, n, key, whisper) => {
      landed.push({ path, n, key, whisper });
    },
    log: (...args: unknown[]) => {
      logged.push(args);
    },
    onChange: () => {
      counts.changes += 1;
    }
  });

  return {
    runner,
    asked,
    landed,
    logged,
    get changes(): number {
      return counts.changes;
    }
  };
}

/** A model that answers with `reply`, as soon as it is asked. */
function harness(reply: () => WhisperReply, id = "fake"): Harness {
  return harnessWith({ id, complete: () => Promise.resolve(reply()) });
}

/** A model that answers only when the test says so. */
function held(): { model: WhisperModel; answer: () => void } {
  const waiting: Array<() => void> = [];
  const model: WhisperModel = {
    id: "held",
    complete: () =>
      new Promise<WhisperReply>((resolve) => {
        waiting.push(() => resolve(OK));
      })
  };
  return { model, answer: () => waiting.shift()?.() };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the whisper runner with no model", () => {
  it("schedules nothing, asks nothing and counts no failure", async () => {
    const asked: WhisperRequest[] = [];
    const runner = new WhisperRunner({
      model: () => NoModel,
      land: () => {
        throw new Error("nothing may land with no model");
      },
      log: () => {},
      onChange: () => {}
    });

    runner.arm("day.md", 1, INPUT);
    runner.request("day.md", 1, INPUT);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(WHISPER_IDLE_MS * 2);
    expect(asked.length).toBe(0);
    expect(runner.live).toBe(true);
  });
});

describe("speculation on the idle pause", () => {
  it("asks once the writer has stopped, and remembers the answer", async () => {
    const { runner, asked } = harness(() => OK);

    runner.arm("day.md", 1, INPUT);
    expect(vi.getTimerCount()).toBe(1);
    expect(asked.length).toBe(0);

    await vi.advanceTimersByTimeAsync(WHISPER_IDLE_MS);

    expect(asked.length).toBe(1);
    expect(asked[0]?.user).toContain(INPUT.prose);
    expect(runner.peek(INPUT)).toEqual([{ type: "name", text: "durable pi in go" }]);
  });

  it("restarts the timer on every edit, so one long pause asks once", async () => {
    const { runner, asked } = harness(() => OK);

    runner.arm("day.md", 1, INPUT);
    await vi.advanceTimersByTimeAsync(WHISPER_IDLE_MS - 100);
    runner.arm("day.md", 1, INPUT);
    await vi.advanceTimersByTimeAsync(WHISPER_IDLE_MS - 100);

    expect(asked.length).toBe(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(asked.length).toBe(1);
  });

  it("does not cache an answer that breaks the register", async () => {
    const { runner, logged } = harness(() => ({
      ok: true,
      text: JSON.stringify({ whisper: [{ type: "name", text: "durable work, not portable" }] })
    }));

    runner.arm("day.md", 1, INPUT);
    await vi.advanceTimersByTimeAsync(WHISPER_IDLE_MS);

    expect(runner.peek(INPUT)).toBeNull();
    // A validation failure is not a transport failure: the endpoint answered.
    expect(runner.live).toBe(true);
    expect(logged.length).toBe(1);
  });
});

describe("a cold settle", () => {
  it("asks at once and lands the answer under the key of the text it read", () => {
    const { runner, asked, landed } = harness(() => OK);

    runner.request("day.md", 1, INPUT);

    expect(asked.length).toBe(1);
    // One timer is the "has this been waiting long enough to show?" clock.
    expect(vi.getTimerCount()).toBe(1);
    expect(runner.peek(INPUT)).toBeNull();
    expect(landed.length).toBe(0);
  });

  it("lands once the answer arrives, with the key it asked under", async () => {
    const { runner, landed } = harness(() => OK);

    runner.request("day.md", 4, INPUT);
    await vi.advanceTimersByTimeAsync(0);

    expect(landed).toEqual([
      {
        path: "day.md",
        n: 4,
        key: whisperKey(INPUT),
        whisper: [{ type: "name", text: "durable pi in go" }]
      }
    ]);
    expect(runner.peek(INPUT)).toEqual([{ type: "name", text: "durable pi in go" }]);
  });

  it("lands nothing when the endpoint answered with prose", async () => {
    const { runner, landed } = harness(() => ({
      ok: true,
      text: "I'm sorry, I can't help with that."
    }));

    runner.request("day.md", 1, INPUT);
    await vi.advanceTimersByTimeAsync(0);

    expect(landed.length).toBe(0);
    expect(runner.live).toBe(true);
  });
});

describe("an endpoint that refuses", () => {
  it("names the refusal in the one line it logs, then goes quiet", async () => {
    const refused: WhisperReply = {
      ok: false,
      failure: { kind: "refused", status: 401, detail: "API key required" }
    };
    const { runner, logged } = harness(() => refused);

    runner.arm("day.md", 1, INPUT);
    await vi.advanceTimersByTimeAsync(WHISPER_IDLE_MS);
    runner.arm("day.md", 1, INPUT);
    await vi.advanceTimersByTimeAsync(WHISPER_IDLE_MS);

    expect(runner.live).toBe(false);
    expect(String(logged.at(-1)?.[0])).toContain("HTTP 401");
    expect(String(logged.at(-1)?.[0])).toContain("API key required");
  });

  it("goes quiet after two failures, and says so once", async () => {
    const { runner, asked, logged } = harness(() => DEAD);

    runner.arm("day.md", 1, INPUT);
    await vi.advanceTimersByTimeAsync(WHISPER_IDLE_MS);
    expect(runner.live).toBe(true);

    runner.request("day.md", 1, INPUT);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.live).toBe(false);

    // Nothing is asked once this device has stopped asking.
    runner.arm("day.md", 2, INPUT);
    runner.request("day.md", 2, INPUT);
    await vi.advanceTimersByTimeAsync(WHISPER_IDLE_MS);
    expect(asked.length).toBe(2);
    expect(vi.getTimerCount()).toBe(0);

    const quiet = logged.filter((args) => String(args[0]).includes("quiet until reload"));
    expect(quiet.length).toBe(1);
    expect(String(quiet[0]?.[0])).toContain("did not answer");
  });

  it("starts asking again after a settings change", async () => {
    let reply: WhisperReply = DEAD;
    const { runner, asked } = harness(() => reply);

    runner.arm("day.md", 1, INPUT);
    await vi.advanceTimersByTimeAsync(WHISPER_IDLE_MS);
    runner.arm("day.md", 1, INPUT);
    await vi.advanceTimersByTimeAsync(WHISPER_IDLE_MS);
    expect(runner.live).toBe(false);

    reply = OK;
    runner.clear();
    expect(runner.live).toBe(true);
    expect(runner.peek(INPUT)).toBeNull();

    runner.arm("day.md", 1, INPUT);
    await vi.advanceTimersByTimeAsync(WHISPER_IDLE_MS);
    expect(asked.length).toBe(3);
    expect(runner.peek(INPUT)).not.toBeNull();
  });
});

describe("an entry that is being read", () => {
  it("shows nothing for a request that answers inside the blink window", async () => {
    const { runner, changes } = harness(() => OK);

    runner.request("day.md", 1, INPUT);
    expect(runner.pendingFor("day.md", 1)).toBe(false);

    await vi.advanceTimersByTimeAsync(0);

    expect(runner.pendingFor("day.md", 1)).toBe(false);
    expect(changes).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("says so once the wait is a wait, and stops when the answer lands", async () => {
    const { model, answer } = held();
    const run = harnessWith(model);

    run.runner.request("day.md", 3, INPUT);
    expect(run.runner.pendingFor("day.md", 3)).toBe(false);

    await vi.advanceTimersByTimeAsync(WHISPER_READING_DELAY_MS);
    expect(run.runner.pendingFor("day.md", 3)).toBe(true);
    expect(run.changes).toBe(1);

    answer();
    await vi.advanceTimersByTimeAsync(0);

    expect(run.runner.pendingFor("day.md", 3)).toBe(false);
    expect(run.changes).toBe(2);
  });

  it("counts a speculation and a settle's request as one indicator", async () => {
    const { model, answer } = held();
    const run = harnessWith(model);

    // Two requests for one entry: the idle speculation, then the cold settle.
    run.runner.request("day.md", 1, INPUT);
    run.runner.request("day.md", 1, INPUT);

    await vi.advanceTimersByTimeAsync(WHISPER_READING_DELAY_MS);
    expect(run.runner.pendingFor("day.md", 1)).toBe(true);
    expect(run.changes).toBe(1);

    // One of them answers: the entry is still being read.
    answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.runner.pendingFor("day.md", 1)).toBe(true);

    answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.runner.pendingFor("day.md", 1)).toBe(false);
    expect(run.changes).toBe(2);
  });

  it("forgets every pending entry when it is cleared", async () => {
    const { model } = held();
    const run = harnessWith(model);

    run.runner.request("day.md", 1, INPUT);
    await vi.advanceTimersByTimeAsync(WHISPER_READING_DELAY_MS);
    expect(run.runner.pendingFor("day.md", 1)).toBe(true);

    run.runner.clear();

    expect(run.runner.pendingFor("day.md", 1)).toBe(false);
    expect(run.changes).toBe(2);
    // The pending timers are gone with it.
    expect(vi.getTimerCount()).toBe(0);
  });
});
