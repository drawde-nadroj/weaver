import { beforeEach, describe, expect, it } from "vitest";

import type { CaptureResult, CaptureRequest, ThoughtRef, ThreadView } from "../src/core/capture";
import { mainContext, type WeavingContext } from "../src/core/contexts";
import { CaptureController, type CaptureHost, type CaptureRecord, type CaptureStore } from "../src/entries/capture";
import { EntryClock } from "../src/entries/clock";
import { EntrySession } from "../src/entries/session";
import { Loom, type LoomInvitation } from "../src/ui/loom";
import { bodyQuery, createApp, resetHarness } from "../test-support/harness";
import { fireWindowEvent, type ShimElement } from "../test-support/dom";

const CONTEXTS: WeavingContext[] = [
  mainContext({ folder: "Chronomancer", format: "YYYY.MM.DD" }),
  { id: "ctx-spanish", name: "Spanish", folder: "Spanish/Daily", format: "YYYY.MM.DD" }
];

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
  composer: Loom;
  controller: CaptureController;
  clock: EntryClock;
  requests: CaptureRequest[];
  writes: string[];
  travels: string[];
  input(): ShimElement;
  body(): ShimElement;
  root(): ShimElement;
  card(): ShimElement;
  resume(): ShimElement;
  chooser(): ShimElement;
  saved(): ShimElement;
  menu(): ShimElement;
  status(): ShimElement;
  openings: string[];
  setInvitation(strip: LoomInvitation | null): void;
  button(selector: string): ShimElement | null;
  answer(result: CaptureResult): void;
  destroy(): void;
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

/** Waits one macrotask so the harness's animation-frame timer runs. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function harness(): Run {
  let now = new Date(2026, 10, 5, 9, 0, 0).getTime();
  const requests: CaptureRequest[] = [];
  const writes: string[] = [];
  const travels: string[] = [];
  const openings: string[] = [];
  let strip: LoomInvitation | null = null;
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
    confirmPersisted: () => Promise.resolve(false),
    editInNote: () => Promise.resolve(true),
    freezeNative: () => {},
    pauseNative: () => Promise.resolve(true),
    invitationsAt: () => [],
    acknowledge: () => "acknowledged",
    store,
    onChange: () => run.controller && run.composer.render()
  };

  const controller = new CaptureController(host);

  const run: Run = {
    composer: null as unknown as Loom,
    controller,
    clock,
    requests,
    writes,
    travels,
    input: () => bodyQuery(".weaver-composer-input") as ShimElement,
    body: () => bodyQuery(".weaver-composer-body") as ShimElement,
    root: () => bodyQuery(".weaver-composer") as ShimElement,
    card: () => bodyQuery(".weaver-composer-card") as ShimElement,
    resume: () => bodyQuery(".weaver-composer-resume") as ShimElement,
    chooser: () => bodyQuery(".weaver-composer-chooser") as ShimElement,
    saved: () => bodyQuery(".weaver-composer-saved") as ShimElement,
    menu: () => bodyQuery(".weaver-composer-menu") as ShimElement,
    status: () => bodyQuery(".weaver-composer-status") as ShimElement,
    openings,
    setInvitation(next) {
      strip = next;
    },
    button: (selector) => bodyQuery(`.weaver-composer ${selector}`) as ShimElement | null,
    answer(result) {
      reply = result;
    },
    destroy() {
      composer.destroy();
      clock.destroy();
    }
  };

  const composer = new Loom({
    app: createApp(),
    controller,
    clock,
    contexts: () => CONTEXTS,
    loadThread: (): Promise<ThreadView | null> => Promise.resolve(null),
    travel: (contextId) => {
      travels.push(contextId);
      return Promise.resolve(true);
    },
    viewing: () => "main",
    renderMarkdown: (element, markdown) => {
      element.textContent = markdown;
    },
    openRealms: () => {},
    writeHere: (contextId) => writes.push(contextId),
    invitations: () => strip === null ? [] : [strip],
    takeInvitation: (id) => openings.push(id),
    dismissInvitation: () => { strip = null; },
    openPortals: () => {}
  });

  run.composer = composer;
  controller.open("main");
  composer.mount();
  composer.render();
  void now;

  return run;
}

function saved(n = 1): CaptureResult {
  const thought: ThoughtRef = {
    path: NOTE_PATH,
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

function type(run: Run, text: string): void {
  const input = run.input();
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  input.dispatch("input");
}

beforeEach(() => {
  resetHarness();
});

describe("the compact surface", () => {

  it("shows prose as the dominant field and no nested frame", () => {
    const run = harness();
    const input = run.input();
    expect(input.tagName.toLowerCase()).toBe("textarea");
    expect(input.className).toContain("weaver-composer-input");
    // No separate rail/outline/selection rows remain around the prose.
    expect(run.button(".weaver-composer-rail")).toBeNull();
    expect(run.button(".weaver-composer-outline")).toBeNull();
  });

  it("keeps the footer to timing and one Save action", () => {
    const run = harness();
    const footer = run.button(".weaver-composer-footer");
    expect(footer).not.toBeNull();
    expect(footer?.querySelector(".weaver-composer-save")).not.toBeNull();
    expect(footer?.querySelector(".weaver-composer-duration")).not.toBeNull();
    expect(footer?.querySelector(".weaver-composer-moment")).not.toBeNull();
  });

  it("wears the dimension colour of the entry it will become", async () => {
    const run = harness();
    run.card().rect = { top: 0, left: 0, right: 0, bottom: 0, width: 720, height: 300 };
    run.composer.render();
    await tick();

    // A root is written at depth 1: the first anchor, red.
    expect(run.root().getAttribute("data-d")).toBe("1");
    expect(run.root().getAttribute("style")).toContain("--weaver-dcolor:#ef4444");
    expect(run.root().getAttribute("style")).toContain("--weaver-d:1");
  });

  it("steps the colour one dimension deeper when branching", async () => {
    const run = harness();
    run.card().rect = { top: 0, left: 0, right: 0, bottom: 0, width: 720, height: 300 };
    type(run, "typed");
    run.answer(saved());
    run.button(".weaver-composer-save")!.click();
    await flush();

    run.saved().querySelector(".weaver-composer-branch")?.click();
    await flush();
    await tick();

    // The parent is depth 1, so the branch is depth 2: the second anchor.
    expect(run.root().getAttribute("data-d")).toBe("2");
    expect(run.root().getAttribute("style")).toContain("--weaver-dcolor:#f97316");
  });
});

describe("multiline writing", () => {
  it("commits on a plain Return and keeps the newline on Shift+Return", async () => {
    const run = harness();
    type(run, "first line\nsecond line");
    run.answer(saved());

    // Shift is the newline: a shifted Return must neither save nor disturb prose.
    run.input().dispatch("keydown", { key: "Enter", shiftKey: true });
    await flush();
    expect(run.requests).toHaveLength(0);
    expect(run.controller.state.text).toBe("first line\nsecond line");

    run.input().dispatch("keydown", { key: "Enter", shiftKey: false });
    await flush();
    expect(run.requests).toHaveLength(1);
    expect(run.controller.state.phase).toBe("resting");
  });

  it("saves explicitly through the Save action", async () => {
    const run = harness();
    type(run, "one\n two");
    run.answer(saved());

    run.button(".weaver-composer-save")!.click();
    await flush();

    expect(run.requests).toHaveLength(1);
    expect(run.controller.state.phase).toBe("resting");
    expect(run.saved().hasAttribute("hidden")).toBe(false);
    expect(run.input().hasAttribute("hidden")).toBe(true);

    // After entering a thought the reading holds the keys, so Escape always
    // puts the Loom away instead of being swallowed by a blurred body.
    run.root().dispatch("keydown", { key: "Escape" });
    expect(run.controller.state.phase).toBe("closed");
  });

  it("saves on the explicit desktop shortcut, not on Return alone", async () => {
    const run = harness();
    type(run, "typed");
    run.answer(saved());

    run.input().dispatch("keydown", { key: "Enter", metaKey: true });
    await flush();

    expect(run.requests).toHaveLength(1);
    expect(run.controller.state.phase).toBe("resting");
  });

  it("claims the chord before an outer key scope can, while the Loom has focus", async () => {
    const run = harness();
    type(run, "typed");
    run.answer(saved());

    // Obsidian's own scope sees `Mod-Enter` before the textarea does, which is
    // why the chord is taken in the window's capture phase.
    fireWindowEvent("keydown", { key: "Enter", metaKey: true, target: run.input() });
    await flush();

    expect(run.requests).toHaveLength(1);
    expect(run.controller.state.phase).toBe("resting");
  });

  it("leaves the chord to the app when focus is outside the Loom", async () => {
    const run = harness();
    type(run, "typed");
    run.answer(saved());

    const outside = document.createElement("div");
    fireWindowEvent("keydown", { key: "Enter", metaKey: true, target: outside });
    await flush();

    expect(run.requests).toHaveLength(0);
  });
});

describe("discarding", () => {
  it("asks in the status row, and the question survives a re-render", () => {
    const run = harness();
    type(run, "throw this away");

    run.button(".weaver-composer-more")!.click();
    const items = run.menu().querySelectorAll(".weaver-composer-menu-item");
    const discard = items.find((item) => item.textContent === "Discard");
    expect(discard).toBeDefined();
    discard?.click();

    expect(run.status().hasAttribute("hidden")).toBe(false);
    expect(run.status().textContent).toContain("Discard this draft?");

    // A render from anywhere else must not erase the open question.
    run.composer.render();
    expect(run.status().textContent).toContain("Discard this draft?");

    run.status().querySelector(".weaver-composer-save")?.click();
    expect(run.controller.state.phase).toBe("closed");
    expect(run.controller.state.text).toBe("");
  });

  it("can keep writing instead", () => {
    const run = harness();
    type(run, "keep this");

    run.button(".weaver-composer-more")!.click();
    const items = run.menu().querySelectorAll(".weaver-composer-menu-item");
    items.find((item) => item.textContent === "Discard")?.click();

    const keep = run.status()
      .querySelectorAll("button")
      .find((button) => button.textContent === "Keep writing");
    keep?.click();

    expect(run.status().hasAttribute("hidden")).toBe(true);
    expect(run.controller.state.text).toBe("keep this");
  });
});

describe("the destination chooser", () => {
  it("replaces the content area, preserves the draft, and returns to it", () => {
    const run = harness();
    type(run, "kept through the chooser");
    run.body().scrollTop = 120;
    run.body().dispatch("scroll");

    run.button(".weaver-composer-dest")!.click();

    expect(run.chooser().hasAttribute("hidden")).toBe(false);
    expect(run.input().hasAttribute("hidden")).toBe(true);
    expect(run.controller.state.text).toBe("kept through the chooser");

    const rows = run.chooser().querySelectorAll(".weaver-composer-chooser-row");
    const spanish = rows[1];
    expect(spanish).toBeDefined();
    spanish?.querySelector(".weaver-composer-chooser-write")?.click();

    expect(run.writes).toEqual(["ctx-spanish"]);
    expect(run.chooser().hasAttribute("hidden")).toBe(true);
    expect(run.input().hasAttribute("hidden")).toBe(false);
    expect(run.input().value).toBe("kept through the chooser");
    expect(run.body().scrollTop).toBe(120);
  });

  it("keeps workspace travel a distinct secondary action", () => {
    const run = harness();
    run.button(".weaver-composer-dest")!.click();
    const rows = run.chooser().querySelectorAll(".weaver-composer-chooser-row");
    rows[0]?.querySelector(".weaver-composer-chooser-travel")?.click();
    expect(run.travels).toEqual(["main"]);
    expect(run.writes).toEqual([]);
  });
});

describe("hiding and resuming", () => {
  it("reduces to one resume strip and restores the draft and caret", () => {
    const run = harness();
    type(run, "a kept draft");
    run.input().setSelectionRange(4, 4);
    run.controller.setSelection({ from: 4, to: 4 });

    run.button(".weaver-composer-hide")!.click();

    expect(run.card().hasAttribute("hidden")).toBe(true);
    expect(run.resume().hasAttribute("hidden")).toBe(false);
    expect(run.resume().textContent).toContain("a kept draft");

    run.resume().querySelector(".weaver-composer-resume-open")?.click();

    expect(run.card().hasAttribute("hidden")).toBe(false);
    expect(run.input().value).toBe("a kept draft");
    expect(run.input().selectionStart).toBe(4);
  });
});

describe("invitations and writing", () => {
  const offered: LoomInvitation = {
    id: "occ-1", name: "Spanish", opening: "04:33", phase: "available"
  };

  it("keeps an arriving invitation out of an active draft, including its resume strip", () => {
    const run = harness();
    type(run, "a draft in progress");
    run.input().setSelectionRange(4, 7);
    run.controller.setSelection({ from: 4, to: 7 });
    run.setInvitation(offered);
    run.composer.render();
    expect(run.status().hasAttribute("hidden")).toBe(true);
    expect(run.controller.state.text).toBe("a draft in progress");
    expect(run.input().selectionStart).toBe(4);
    expect(run.input().selectionEnd).toBe(7);
    run.button(".weaver-composer-hide")!.click();
    expect(run.resume().textContent).toContain("a draft in progress");
    expect(run.resume().textContent).not.toContain("04:33");
    expect(run.openings).toEqual([]);
    expect(run.requests).toEqual([]);
  });

  it("dismisses an idle invitation without creating an entry", () => {
    const run = harness();
    run.controller.discardDraft();
    run.setInvitation(offered);
    run.composer.render();
    expect(run.resume().hasAttribute("hidden")).toBe(false);
    run.resume().querySelector(".weaver-composer-resume-dismiss")?.click();
    expect(run.root().hasAttribute("hidden")).toBe(true);
    expect(run.requests).toEqual([]);
  });
});

describe("the saved state", () => {

  it("branches from the saved thought and starts a fresh Thread", async () => {
    const run = harness();
    type(run, "typed");
    run.answer(saved());
    run.button(".weaver-composer-save")!.click();
    await flush();

    run.saved().querySelector(".weaver-composer-branch")?.click();
    await flush();
    expect(run.controller.state.parent?.n).toBe(1);

    run.answer({ ok: false, error: "n/a" });
    run.saved().querySelector(".weaver-composer-new")?.click();
    await flush();
    expect(run.controller.state.text).toBe("");
  });

  it("closes quietly without creating another entry", async () => {
    const run = harness();
    type(run, "typed");
    run.answer(saved());
    run.button(".weaver-composer-save")!.click();
    await flush();

    run.button(".weaver-composer-hide")?.click();
    expect(run.root().hasAttribute("hidden")).toBe(true);
    expect(run.requests).toHaveLength(1);
  });
});

