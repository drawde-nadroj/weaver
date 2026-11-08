import { beforeEach, describe, expect, it } from "vitest";

import type { CaptureResult, CaptureRequest, ThoughtRef } from "../src/core/capture";
import { mainContext, type WeavingContext } from "../src/core/contexts";
import { CaptureController, type CaptureHost, type CaptureRecord, type CaptureStore } from "../src/entries/capture";
import { EntryClock } from "../src/entries/clock";
import { EntrySession } from "../src/entries/session";
import { ThoughtIndex } from "../src/entries/thought-index";
import { ReferenceController } from "../src/entries/reference";
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
  reference: ReferenceController;
  requests: CaptureRequest[];
  writes: string[];
  travels: string[];
  input(): ShimElement;
  body(): ShimElement;
  root(): ShimElement;
  card(): ShimElement;
  resume(): ShimElement;
  menu(): ShimElement;
  status(): ShimElement;
  openings: string[];
  setInvitation(strip: LoomInvitation | null): void;
  button(selector: string): ShimElement | null;
  answer(result: CaptureResult): void;
  advance(ms: number): void;
  destroy(): void;
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}


function harness(source = NOTE_SOURCE, path = NOTE_PATH): Run {
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
    read: (requested) => Promise.resolve(requested === path ? source : null),
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
    reference: null as unknown as ReferenceController,
    requests,
    writes,
    travels,
    input: () => bodyQuery(".weaver-composer-prose .cm-content") as ShimElement,
    body: () => bodyQuery(".weaver-composer-body") as ShimElement,
    root: () => bodyQuery(".weaver-composer") as ShimElement,
    card: () => bodyQuery(".weaver-composer-card") as ShimElement,
    resume: () => bodyQuery(".weaver-composer-resume") as ShimElement,
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
    advance(ms) {
      now += ms;
      clock.refresh();
    },
    destroy() {
      composer.destroy();
      clock.destroy();
    }
  };

  const thoughtIndex = new ThoughtIndex({
    paths: () => [path],
    read: host.read,
    generation: () => 0,
    contexts: () => CONTEXTS
  });
  const reference = new ReferenceController({
    index: thoughtIndex,
    load: (target) => thoughtIndex.loadThought(target),
    onChange: () => run.composer?.render()
  });
  run.reference = reference;
  const composer = new Loom({
    app: createApp(),
    controller,
    reference,
    clock,
    contexts: () => CONTEXTS,
    loadThought: (target) => thoughtIndex.loadThought(target),
    travel: (contextId) => {
      travels.push(contextId);
      return Promise.resolve(true);
    },
    viewing: () => "main",
    writeHere: (contextId) => writes.push(contextId),
    invitations: () => strip === null ? [] : [strip],
    takeInvitation: (id) => openings.push(id),
    dismissInvitation: () => { strip = null; },
  });

  run.composer = composer;
  controller.open("main");
  composer.mount();
  composer.render();

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

function timing(kind: "beginning" | "duration", parent = ".weaver-composer-state"): string | null {
  const digits = bodyQuery(`${parent} [data-kind="${kind}"] .weaver-composer-timing-digits`);
  return digits?.hasAttribute("hidden") ? "—" : digits?.textContent ?? null;
}

async function browse(run: Run): Promise<void> {
  await run.reference.open({
    scope: { kind: "history", tapestryId: null }, order: "time", search: { kind: "none" }
  }, "last");
  run.composer.showPanel("reference");
}

beforeEach(() => {
  resetHarness();
});

describe("mobile writing", () => {
  it("leaves Return to the editor and threads only on explicit activation", async () => {
    document.body.classList.add("is-mobile");
    const run = harness();
    type(run, "first line");
    run.answer(saved());
    let prevented = false;
    run.input().dispatch("keydown", { key: "Enter", preventDefault: () => { prevented = true; } });
    await flush();
    expect(prevented).toBe(false);
    expect(run.requests).toEqual([]);
    expect(run.controller.state.phase).toBe("editing");
    type(run, "first line\nsecond line");
    run.button(".weaver-composer-save")?.click();
    await flush();
    expect(run.requests[0]?.text).toBe("first line\nsecond line");
    expect(run.controller.state.phase).toBe("resting");
    run.destroy();
  });

  it("preserves the draft and selection when hidden and retrieved", () => {
    document.body.classList.add("is-mobile");
    const run = harness();
    type(run, "keep these words");
    const selection = { ...run.controller.state.selection };
    run.button(".weaver-composer-hide")?.click();
    expect(run.requests).toEqual([]);
    expect(run.controller.state.text).toBe("keep these words");
    run.resume().children[0]?.click();
    expect(run.controller.state.selection).toEqual(selection);
    expect(run.input().value).toBe("keep these words");
    run.destroy();
  });
});


describe("composer timing", () => {
  it("counts the wall clock and the stopwatch together, then reads the recorded beginning", () => {
    const run = harness();
    expect(timing("beginning")).toBe("09:00:00");
    expect(timing("duration")).toBe("00:00:00");
    run.advance(1200);
    expect(timing("beginning")).toBe("09:00:01");
    type(run, "a beginning");
    run.advance(5400);
    // The beginning froze at 09:00:01, but the clock keeps counting the present.
    expect(timing("beginning")).toBe("09:00:06");
    expect(timing("duration")).toBe("00:00:05");
    run.controller.pause();
    expect(bodyQuery(".weaver-composer-state .weaver-composer-timing")?.getAttribute("data-mode")).toBe("paused");
    run.advance(10_000);
    expect(timing("beginning")).toBe("09:00:16");
    expect(timing("duration")).toBe("00:00:05");
    expect(run.requests).toEqual([]);
  });
  it("reads the saved duration from the note instead of the cleared draft clock", async () => {
    const run = harness(NOTE_SOURCE.replace("00:00:00", "00:02:14"));
    expect(timing("beginning")).toBe("09:00:00");
    expect(timing("duration")).toBe("00:00:00");
    type(run, "typed");
    expect(timing("duration")).toBe("00:00:00");
    run.answer(saved());
    run.input().dispatch("keydown", { key: "Enter" });
    await flush();
    expect(run.controller.state.phase).toBe("resting");
    expect(timing("duration")).toBe("00:02:14");
    expect(timing("beginning")).toBe("09:00:00");
  });

  it("retains the painted duration across a pause before saving", async () => {
    const run = harness();
    type(run, "typed");
    run.advance(2400);
    expect(timing("duration")).toBe("00:00:02");
    run.controller.pause();
    run.advance(5000);
    run.input().dispatch("keydown", { key: "Enter" });
    await flush();
    expect(run.requests[0]?.durationMs).toBe(2000);
  });

  it("shows unknown timing when the saved thought cannot be read", async () => {
    const run = harness();
    type(run, "typed");
    run.answer(saved(2));
    run.input().dispatch("keydown", { key: "Enter" });
    await flush();
    expect(timing("beginning")).toBe("—");
    expect(timing("duration")).toBe("—");
  });
});

describe("multiline writing", () => {
  it("does not submit an IME candidate before composition commits", async () => {
    const run = harness();
    run.answer(saved());
    run.input().dispatch("compositionstart");
    type(run, "漢");
    run.input().dispatch("keydown", { key: "Enter", isComposing: true });
    await flush();
    expect(run.requests).toEqual([]);
    expect(run.controller.state.phase).toBe("editing");
    run.input().dispatch("compositionend");
    run.input().dispatch("keydown", { key: "Enter" });
    await flush();
    expect(run.requests).toHaveLength(1);
    expect(run.controller.state.phase).toBe("resting");
  });

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

    // Obsidian's own scope sees `Mod-Enter` before the embedded editor does, which is
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

  it("leaves the retrieve chord to the app even when a draft already has focus", async () => {
    const run = harness();
    type(run, "still writing");
    run.answer(saved());
    fireWindowEvent("keydown", {
      key: "Enter", metaKey: true, shiftKey: true, target: run.input()
    });
    await flush();
    expect(run.controller.state.phase).toBe("editing");
    expect(run.controller.state.text).toBe("still writing");
    expect(run.requests).toEqual([]);
  });
});

describe("discarding", () => {
  it("asks in the status row, and the question survives a re-render", () => {
    const run = harness();
    type(run, "throw this away");

    run.button(".weaver-composer-more")!.click();
    const items = run.menu().querySelectorAll(".weaver-composer-menu-item");
    const discard = items.find((item) => item.textContent.startsWith("Discard"));
    expect(discard).toBeDefined();
    discard?.click();
    expect(run.controller.state.text).toBe("throw this away");
    expect(run.requests).toEqual([]);


    // A render from anywhere else must not erase the open question.
    run.composer.render();
    expect(run.controller.state.text).toBe("throw this away");
    run.button(".weaver-composer-save-alt")?.click();
    expect(run.controller.state.phase).toBe("closed");
    expect(run.controller.state.text).toBe("");
  });

  it("can keep writing instead", () => {
    const run = harness();
    type(run, "keep this");

    run.button(".weaver-composer-more")!.click();
    const items = run.menu().querySelectorAll(".weaver-composer-menu-item");
    items.find((item) => item.textContent.startsWith("Discard"))?.click();

    run.button(".weaver-composer-actions .weaver-composer-quiet-close")?.click();

    expect(run.requests).toEqual([]);
    expect(run.controller.state.text).toBe("keep this");
  });
});

describe("the destination popover", () => {
  it("stays an anchored layer over the draft and retargets it in place", () => {
    const run = harness();
    type(run, "kept through the popover");
    run.body().scrollTop = 120;
    run.body().dispatch("scroll");
    run.button(".weaver-composer-dest")!.click();

    const popover = run.button(".weaver-composer-dest-popover");
    expect(popover?.hasAttribute("hidden")).toBe(false);
    expect(run.controller.state.text).toBe("kept through the popover");
    expect(run.button(".weaver-composer-dest")?.getAttribute("aria-expanded")).toBe("true");

    const rows = popover?.querySelectorAll(".weaver-composer-dest-row") ?? [];
    expect(rows).toHaveLength(2);
    // The current Realm states where the draft is; it offers no second opinion.
    expect(rows[0]?.querySelector(".weaver-composer-dest-here")?.textContent).toBe("Writing here");
    rows[1]?.querySelector(".weaver-composer-dest-write")?.click();

    expect(run.writes).toEqual(["ctx-spanish"]);
    expect(popover?.hasAttribute("hidden")).toBe(true);
    expect(run.input().value).toBe("kept through the popover");
    expect(run.body().scrollTop).toBe(120);
  });

  it("keeps workspace travel a distinct secondary action", () => {
    const run = harness();
    run.button(".weaver-composer-dest")!.click();
    const rows = run.button(".weaver-composer-dest-popover")?.querySelectorAll(".weaver-composer-dest-row") ?? [];
    rows[0]?.querySelector(".weaver-composer-dest-travel")?.click();
    expect(run.travels).toEqual(["main"]);
    expect(run.writes).toEqual([]);
  });

  it("is one front layer at a time, and Escape hands the keys back to its chip", () => {
    const run = harness();
    run.button(".weaver-composer-dest")!.click();
    expect(run.button(".weaver-composer-dest-popover")?.hasAttribute("hidden")).toBe(false);
    run.button(".weaver-composer-more")!.click();
    expect(run.button(".weaver-composer-dest-popover")?.hasAttribute("hidden")).toBe(true);
    expect(run.menu().hasAttribute("hidden")).toBe(false);
    run.button(".weaver-composer-dest")!.click();
    expect(run.menu().hasAttribute("hidden")).toBe(true);
    expect(run.button(".weaver-composer-dest-popover")?.hasAttribute("hidden")).toBe(false);
    run.root().dispatch("keydown", { key: "Escape" });
    expect(run.button(".weaver-composer-dest-popover")?.hasAttribute("hidden")).toBe(true);
    expect(run.root().hasAttribute("hidden")).toBe(false);
  });
});

describe("hiding and resuming", () => {
  it("reduces to one resume strip and restores the draft and caret", () => {
    const run = harness();
    type(run, "a kept draft");
    run.input().setSelectionRange(4, 4);
    run.controller.setSelection({ from: 4, to: 4 });

    run.input().dispatch("keydown", { key: "Escape" });

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
    run.input().dispatch("keydown", { key: "Escape" });
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

    run.input().dispatch("keydown", { key: "Enter" });
    await flush();
    expect(run.controller.state.parent?.n).toBe(1);

    type(run, "a child");
    run.answer(saved(2));
    run.button(".weaver-composer-save")?.click();
    await flush();
    expect(run.requests[1]?.parent?.n).toBe(1);
    fireWindowEvent("keydown", { key: "Enter", metaKey: true, target: run.input() });
    await flush();
    expect(run.controller.state.text).toBe("");
    expect(run.controller.state.parent).toBeNull();
  });

  it("requires a fresh Enter after saving and never queues a branch", async () => {
    const run = harness();
    type(run, "typed");
    run.answer(saved());
    run.input().dispatch("keydown", { key: "Enter" });
    expect(run.controller.state.phase).toBe("submitting");
    run.input().dispatch("keydown", { key: "Enter" });
    await flush();
    expect(run.controller.state.phase).toBe("resting");
    run.input().dispatch("keydown", { key: "Enter", repeat: true });
    run.input().dispatch("keydown", { key: "Enter", shiftKey: true });
    await flush();
    expect(run.controller.state.phase).toBe("resting");
    expect(run.requests).toHaveLength(1);

    run.input().dispatch("keydown", { key: "Enter" });
    await flush();
    expect(run.controller.state.phase).toBe("editing");
    expect(run.controller.state.parent?.n).toBe(1);
    expect(run.requests).toHaveLength(1);
  });

  it("closes quietly without creating another entry", async () => {
    const run = harness();
    type(run, "typed");
    run.answer(saved());
    run.button(".weaver-composer-save")!.click();
    await flush();

    run.input().dispatch("keydown", { key: "Escape" });
    expect(run.root().hasAttribute("hidden")).toBe(true);
    expect(run.requests).toHaveLength(1);
  });
});


describe("browsing and composing one Loom", () => {
  const twoThoughts = `${NOTE_SOURCE}\n{ 2.1.2 }\nsecond thought\n+ 00:01:14 2026-11-05 10:15:36\n`;

  it("lists the reading in time order and opens the selected thought on Enter", async () => {
    const run = harness(twoThoughts);
    run.controller.discardDraft();
    await browse(run);
    expect(timing("beginning")).toBe("10:15:36");
    expect(timing("duration")).toBe("00:01:14");

    const list = run.button(".weaver-composer-browse-list");
    const rows = list?.querySelectorAll(".weaver-composer-browse-row") ?? [];
    expect(rows).toHaveLength(2);
    expect(rows[1]?.querySelector(".weaver-composer-browse-address")?.textContent).toBe("{ 2.1.2 }");
    expect(rows[1]?.querySelector(".weaver-composer-browse-text")?.textContent).toBe("second thought");
    expect(rows[1]?.querySelector(".weaver-composer-browse-time")?.textContent).toBe("10:15");
    expect(rows[1]?.hasAttribute("data-selected")).toBe(true);

    run.root().dispatch("keydown", { key: "Enter", target: list });
    await flush();
    const open = run.button(".weaver-composer-browse-row[data-expanded]");

    const reading = open?.querySelector(".weaver-composer-reference-prose .cm-content");
    expect(reading?.value).toBe("second thought");
    expect(open?.querySelector(".weaver-composer-reference-prose .weaver-markdown")?.getAttribute("data-readonly")).toBe("true");
    expect(run.requests).toEqual([]);

    open?.querySelector(".weaver-composer-browse-branch")?.click();
    await flush();
    expect(run.controller.state.phase).toBe("editing");
    expect(run.controller.state.parent?.n).toBe(2);
    expect(run.controller.state.beginning).toBeNull();
    expect(run.requests).toEqual([]);
  });

  it("accepts a search result, then reads it without branching", async () => {
    const run = harness(twoThoughts);
    run.controller.discardDraft();
    await browse(run);
    run.root().dispatch("keydown", { key: "/", target: run.button(".weaver-composer-browse-list") });
    const field = run.button(".weaver-composer-browse-search");
    expect(field?.hasAttribute("hidden")).toBe(false);
    await run.reference.setSearchText("typed");
    field?.dispatch("keydown", { key: "Enter" });
    expect(run.reference.model.search.kind).toBe("accepted");
    expect(run.reference.model.selection?.n).toBe(1);
    run.root().dispatch("keydown", { key: "Enter", target: run.button(".weaver-composer-browse-list") });
    await flush();
    expect(run.reference.model.selection?.n).toBe(1);
    expect(run.controller.state.phase).toBe("closed");
    expect(run.requests).toEqual([]);
  });

  it("resumes a hidden draft from its own control without replacing its words", async () => {
    const run = harness(twoThoughts);
    type(run, "a draft to keep");
    run.controller.setSelection({ from: 2, to: 7 });
    run.input().dispatch("keydown", { key: "Escape" });
    await browse(run);
    run.root().dispatch("keydown", {
      key: "Escape", target: run.button(".weaver-composer-browse-list")
    });
    expect(run.card().hasAttribute("hidden")).toBe(true);
    expect(run.controller.state.text).toBe("a draft to keep");
    await browse(run);
    run.button(".weaver-composer-branch")?.click();
    await flush();
    expect(run.controller.state.text).toBe("a draft to keep");
    expect(run.controller.state.selection).toEqual({ from: 2, to: 7 });
    expect(run.controller.state.parent).toBeNull();
    expect(run.controller.state.collapsed).toBe(false);
    expect(run.input().selectionStart).toBe(2);
    expect(run.input().selectionEnd).toBe(7);
    expect(run.requests).toEqual([]);
  });

  it("walks the list with arrows and leaves prose selection alone", async () => {
    const run = harness(twoThoughts);
    type(run, "the active draft");
    await browse(run);
    run.advance(2400);
    expect(timing("duration")).toBe("00:00:02");
    // The draft's clock reads the shared present; the reading keeps its record.
    expect(timing("beginning")).toBe("09:00:02");
    expect(timing("duration", ".weaver-composer-reference")).toBe("00:01:14");
    expect(timing("beginning", ".weaver-composer-reference")).toBe("10:15:36");

    run.root().dispatch("keydown", { key: "Enter", target: run.button(".weaver-composer-browse-list") });
    const prose = run.button(".weaver-composer-browse-row[data-expanded] .cm-content");
    run.root().dispatch("keydown", { key: "ArrowUp", target: prose });
    expect(run.reference.model.selection?.n).toBe(2);
    run.root().dispatch("keydown", { key: "ArrowLeft", target: run.button(".weaver-composer-browse-list") });
    expect(run.reference.model.selection?.n).toBe(2);
    run.root().dispatch("keydown", { key: "ArrowUp", target: run.button(".weaver-composer-browse-list") });
    await flush();
    expect(run.reference.model.selection?.n).toBe(1);
    expect(run.controller.state.text).toBe("the active draft");
    expect(run.controller.state.parent).toBeNull();
  });

  it("starts a new Thread in the browsed thought's destination", async () => {
    const run = harness(NOTE_SOURCE, "Spanish/Daily/2026.11.05.md");
    run.controller.discardDraft();
    await browse(run);
    fireWindowEvent("keydown", {
      key: "Enter", metaKey: true, target: run.button(".weaver-composer-browse-list")
    });
    await flush();
    expect(run.controller.state.phase).toBe("editing");
    expect(run.controller.state.contextId).toBe("ctx-spanish");
    expect(run.controller.state.parent).toBeNull();
    expect(run.controller.state.text).toBe("");
    expect(run.requests).toEqual([]);
  });
});
