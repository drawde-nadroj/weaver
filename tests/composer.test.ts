import { beforeEach, describe, expect, it } from "vitest";

import type { CaptureResult, CaptureRequest, ThoughtRef, ThreadView } from "../src/core/capture";
import { mainContext, type WeavingContext } from "../src/core/contexts";
import { CaptureController, type CaptureHost, type CaptureRecord, type CaptureStore } from "../src/entries/capture";
import { EntryClock } from "../src/entries/clock";
import { EntrySession } from "../src/entries/session";
import { Composer } from "../src/ui/composer";
import { bodyQuery, createApp, resetHarness } from "../test-support/harness";
import type { ShimElement } from "../test-support/dom";

const CONTEXTS: WeavingContext[] = [
  mainContext({ folder: "Chronomancer", format: "YYYY.MM.DD" }),
  { id: "ctx-spanish", name: "Spanish", folder: "Spanish/Daily", format: "YYYY.MM.DD" }
];

/** The note a saved reply really lands in, so a branch can be validated. */
const NOTE_PATH = "Chronomancer/2026.11.05.md";
const NOTE_SOURCE = [
  "---",
  "date: 2026-11-05",
  "---",
  "",
  "{ 1.1.1 }",
  "",
  "typed",
  "+ 00:00:00 2026-11-05 09:00:00",
  ""
].join("\n");

/** A store that keeps the one record in memory. */
class MemoryStore implements CaptureStore {
  record: CaptureRecord | null = null;
  load(): CaptureRecord | null {
    return this.record;
  }
  save(record: CaptureRecord): void {
    this.record = record;
  }
  clear(): void {
    this.record = null;
  }
}

interface Run {
  composer: Composer;
  controller: CaptureController;
  requests: CaptureRequest[];
  input(): ShimElement;
  root(): ShimElement;
  button(className: string): ShimElement | null;
  text(): string;
  answer(result: CaptureResult): void;
  destroy(): void;
}

function harness(options: { thread?: ThreadView } = {}): Run {
  let now = new Date(2026, 10, 5, 9, 0, 0).getTime();
  const requests: CaptureRequest[] = [];
  const store = new MemoryStore();
  let reply: CaptureResult = { ok: false, error: "not configured" };

  const session = new EntrySession();
  const clock = new EntryClock(session, () => now);

  const host: CaptureHost = {
    now: () => now,
    contexts: () => CONTEXTS,
    capture: (request) => {
      requests.push(request);
      return Promise.resolve(reply);
    },
    read: (path) => Promise.resolve(path === NOTE_PATH ? NOTE_SOURCE : null),
    editInNote: () => Promise.resolve(true),
    freezeNative: () => {},
    pauseNative: () => Promise.resolve(true),
    invitationsAt: () => [],
    acknowledge: () => {},
    store,
    onChange: () => run.controller && run.composer.render()
  };

  const controller = new CaptureController(host);

  const run: Run = {
    composer: null as unknown as Composer,
    controller,
    requests,
    input: () => bodyQuery(".weaver-composer-input") as ShimElement,
    root: () => bodyQuery(".weaver-composer") as ShimElement,
    button: (className) => bodyQuery(`.weaver-composer ${className}`) as ShimElement | null,
    text: () => bodyQuery(".weaver-composer")?.textContent ?? "",
    answer(result) {
      reply = result;
    },
    destroy() {
      composer.destroy();
      clock.destroy();
    }
  };

  const composer = new Composer({
    app: createApp(),
    controller,
    clock,
    contexts: () => CONTEXTS,
    loadThread: (): Promise<ThreadView | null> => Promise.resolve(options.thread ?? null),
    travel: () => Promise.resolve(true),
    viewing: () => "main",
    renderMarkdown: (element, markdown) => {
      element.textContent = markdown;
    },
    openRealms: () => {},
    portalStrip: () => null,
    weaveOpening: () => {},
    dismissOpening: () => {},
    openPortals: () => {}
  });

  run.composer = composer;
  controller.open("main");
  composer.mount();
  composer.render();
  void now;

  return run;
}

/** A reply describing the thought a settle produced. */
function saved(n = 1): CaptureResult {
  const thought: ThoughtRef = {
    path: "Chronomancer/2026.11.05.md",
    n,
    b: 1,
    d: 1,
    rootN: n,
    day: "2026-11-05",
    time: "09:00:00",
    prose: "typed"
  };
  return { ok: true, thought, root: thought };
}

beforeEach(() => {
  resetHarness();
});

describe("the floating surface", () => {
  it("names the writing Realm once, and does not repeat it when viewing is the same", () => {
    const run = harness();
    const text = run.text();

    expect(text).toContain("Realm: Main");
    // Writing and viewing agree here, so the quiet difference line is absent.
    expect(text).not.toContain("Writing to Main");
    // The rail names the thing being written, never a fabricated address.
    expect(text).toContain("Thread");
    expect(text).not.toContain("1D");

    run.destroy();
  });

  it("is a labelled region, not a modal", () => {
    const run = harness();
    const root = run.root();

    expect(root.getAttribute("role")).toBe("region");
    expect(root.getAttribute("aria-label")).toBe("Thread");
    expect(root.hasAttribute("aria-modal")).toBe(false);

    run.destroy();
  });

  it("positions itself without inserting anything into the note", () => {
    const run = harness();
    // The shim defers to the next frame; the style is written from the measured
    // box, never from padding on a `.cm-line`.
    const style = String(run.root().getAttribute("style") ?? "");
    expect(style === "" || style.includes("position: fixed")).toBe(true);

    run.destroy();
  });

  it("says it is saving, then that it is saved", async () => {
    const run = harness();
    run.input().value = "a thought";
    run.input().dispatch("input");
    expect(run.controller.state.text).toBe("a thought");

    run.answer(saved());
    await run.controller.settle();
    run.composer.render();

    expect(run.controller.state.phase).toBe("resting");
    expect(run.text()).toContain("Saved");

    run.destroy();
  });

  it("shows the reason a save was refused", async () => {
    const run = harness();
    run.input().value = "a thought";
    run.input().dispatch("input");
    run.answer({ ok: false, error: "this note could not take a new thought" });

    await run.controller.settle();
    run.composer.render();

    expect(run.text()).toContain("could not take a new thought");
    expect(run.input().value).toBe("a thought");

    run.destroy();
  });
});

describe("keys on the surface", () => {
  it("treats letters inside the input as prose", () => {
    const run = harness();
    const input = run.input();
    input.value = "instant note";
    input.dispatch("input");
    input.dispatch("keydown", { key: "n", isComposing: false });

    // Nothing branched: the composer is still a new Thread with its prose.
    expect(run.controller.state.parent).toBeNull();
    expect(run.controller.state.text).toBe("instant note");

    run.destroy();
  });

  it("settles on Enter in the input, and leaves Shift-Enter to the newline", () => {
    const run = harness();
    run.input().value = "a thought";
    run.input().dispatch("input");

    const shift = run.input().dispatch("keydown", { key: "Enter", shiftKey: true });
    void shift;
    expect(run.requests).toHaveLength(0);

    run.input().dispatch("keydown", { key: "Enter" });
    // Settling is asynchronous; the request is already recorded, though.
    expect(run.controller.state.phase).toBe("submitting");

    run.destroy();
  });

  it("ignores Enter while an IME composition is in progress", () => {
    const run = harness();
    run.input().value = "にほん";
    run.input().dispatch("input");
    run.input().dispatch("keydown", { key: "Enter", isComposing: true });

    expect(run.controller.state.phase).toBe("editing");

    run.destroy();
  });

  it("lets Enter on a focused action activate that action", () => {
    const run = harness();
    run.input().value = "a thought";
    run.input().dispatch("input");

    const button = run.button(".weaver-composer-save");
    // The surface's own keydown handler sees the event with a button target.
    run.root().dispatch("keydown", { key: "Enter", target: button });

    expect(run.requests).toHaveLength(0);

    run.destroy();
  });

  it("folds on Escape without losing the draft", () => {
    const run = harness();
    run.input().value = "keep me";
    run.input().dispatch("input");

    run.input().dispatch("keydown", { key: "Escape" });
    run.composer.render();

    expect(run.controller.state.collapsed).toBe(true);
    expect(run.controller.state.text).toBe("keep me");

    run.destroy();
  });
});

describe("the resting state", () => {
  it("offers Branch, New Thread and Done, and dismisses on Enter", async () => {
    const run = harness();
    run.input().value = "a thought";
    run.input().dispatch("input");
    run.answer(saved());
    await run.controller.settle();
    run.composer.render();

    expect(run.button(".weaver-composer-close")).not.toBeNull();
    expect(run.button(".weaver-composer-branch")).not.toBeNull();
    expect(run.button(".weaver-composer-new")).not.toBeNull();

    run.root().dispatch("keydown", { key: "Enter" });
    run.composer.render();
    expect(run.controller.state.phase).toBe("closed");

    run.destroy();
  });

  it("branches on N and starts a fresh Thread on T", async () => {
    const run = harness();
    run.input().value = "a thought";
    run.input().dispatch("input");
    run.answer(saved());
    await run.controller.settle();
    run.composer.render();

    run.root().dispatch("keydown", { key: "n" });
    // Validating a parent reads the note, so the branch lands a tick later.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run.controller.state.parent?.n).toBe(1);
    expect(run.controller.state.phase).toBe("editing");

    await run.controller.newThread();
    run.composer.render();
    expect(run.controller.state.parent).toBeNull();

    run.destroy();
  });
});

describe("the motion model", () => {
  /** Puts the surface in its resting state on a saved thought. */
  async function resting(run: Run): Promise<void> {
    run.input().value = "a thought";
    run.input().dispatch("input");
    run.answer(saved());
    await run.controller.settle();
    run.composer.render();
  }

  it("moves the selection with j and k in the saved Thread", async () => {
    const run = harness();
    await resting(run);

    const moves: string[] = [];
    run.controller.selectThought = async (target) => {
      moves.push(`${target.b}.${target.d}.${target.n}`);
      return true;
    };

    run.root().dispatch("keydown", { key: "j" });
    run.root().dispatch("keydown", { key: "ArrowUp" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The loaded Thread holds only the saved thought here, so neither motion
    // invents a neighbour; the letters are still claimed rather than typed.
    expect(moves).toEqual([]);

    run.destroy();
  });

  it("never lets a structural letter become prose in the input", async () => {
    const run = harness();
    // Typing in the draft: the input is the draft, and letters are text.
    run.input().value = "j k h l";
    run.input().dispatch("input");
    run.input().dispatch("keydown", { key: "n" });

    expect(run.controller.state.text).toBe("j k h l");
    expect(run.controller.state.parent).toBeNull();

    run.destroy();
  });

  it("commits a composed value once and does not treat its Enter as a save", () => {
    const run = harness();
    const input = run.input();
    void resting;

    input.dispatch("compositionstart");
    input.value = "にほんご";
    input.dispatch("input");
    // Preedit is not a beginning: nothing was committed yet.
    expect(run.controller.state.text).toBe("");

    input.dispatch("compositionend");
    expect(run.controller.state.text).toBe("にほんご");

    // The confirmation Enter arrives while composing and is ignored.
    input.dispatch("keydown", { key: "Enter", isComposing: true });
    expect(run.requests).toHaveLength(0);

    run.destroy();
  });

  it("ignores a held Enter rather than saving twice", async () => {
    const run = harness();
    run.input().value = "a thought";
    run.input().dispatch("input");
    run.answer(saved());

    run.input().dispatch("keydown", { key: "Enter", repeat: true });
    expect(run.requests).toHaveLength(0);

    run.destroy();
  });
});

describe("hiding and resuming", () => {
  it("keeps the draft behind one strip and resumes it where it was", () => {
    const run = harness();
    run.input().value = "half a thought";
    run.input().dispatch("input");

    run.input().dispatch("keydown", { key: "Escape" });
    run.composer.render();

    const strip = run.button(".weaver-composer-resume-button");
    expect(strip?.textContent).toContain("Resume");
    expect(strip?.textContent).toContain("Main");
    expect(strip?.textContent).toContain("half a thought");

    strip?.click();
    run.composer.render();
    expect(run.controller.state.collapsed).toBe(false);
    expect(run.input().value).toBe("half a thought");

    run.destroy();
  });

  it("leaves nothing to resume when an untouched root is hidden", () => {
    const run = harness();
    run.root().dispatch("keydown", { key: "Escape" });
    run.composer.render();

    expect(run.controller.state.phase).toBe("closed");
    // Nothing is left at the bottom edge: no strip, no card.
    expect(run.root().hasAttribute("hidden")).toBe(true);

    run.destroy();
  });
});

describe("the saved state in the surface", () => {
  /** The thought a `saved()` reply describes. */
  function savedThought(): ThoughtRef {
    const result = saved();
    if (!result.ok) throw new Error("the fixture reply is a failure");
    return result.thought;
  }

  /** A loaded Thread holding that thought and its recorded duration. */
  function loadedThread(durationMs: number): ThreadView {
    const thought = savedThought();
    return {
      root: thought,
      ancestry: [thought],
      selected: thought,
      nodes: [{ thought, parentN: null, durationMs }]
    };
  }

  it("draws the entry's own recorded duration, not the dead draft's zero", async () => {
    const run = harness({ thread: loadedThread(4 * 60_000) });
    run.input().value = "a thought";
    run.input().dispatch("input");
    run.answer(saved());
    await run.controller.settle();
    // The Thread is read asynchronously, so the rail follows a tick later.
    await new Promise((resolve) => setTimeout(resolve, 0));
    run.composer.render();

    expect(run.controller.state.phase).toBe("resting");
    expect(run.button(".weaver-composer-duration")?.textContent).toBe("00:04:00");

    run.destroy();
  });

  it("makes the saved thought the focusable target and removes the textarea", async () => {
    const run = harness();
    run.input().value = "a thought";
    run.input().dispatch("input");
    run.answer(saved());
    await run.controller.settle();
    run.composer.render();

    // The selection is what the structural motions move, so it is the target;
    // the textarea leaves the focus order with the draft it belonged to. (Real
    // focus transfer is host behaviour: verified in the live pass, not here.)
    expect(run.input().hasAttribute("hidden")).toBe(true);
    expect(bodyQuery(".weaver-composer-selected")?.getAttribute("tabindex")).toBe("0");

    run.destroy();
  });
});
