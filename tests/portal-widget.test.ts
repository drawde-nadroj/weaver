import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { editorInfoField, editorLivePreviewField, type MarkdownFileInfo } from "obsidian";

import { EntryClock } from "../src/entries/clock";
import { PortalController, type PortalHost } from "../src/entries/portals";
import { EntrySession } from "../src/entries/session";
import {
  focusPortal,
  PortalTray,
  trayDecorations,
  type PortalWidgetHost
} from "../src/editor/portal-widget";
import { DEFAULT_SETTINGS } from "../src/settings";
import { createFile, liveEditor, type LiveEditor } from "../test-support/harness";
import { resetDom, ShimElement } from "../test-support/dom";

const TODAY = "Chronomancer/2026-11-05.md";
/** 20:00:30 local: 20:00 is open and 20:11 is approaching, both in the window. */
const AT = new Date(2026, 10, 5, 20, 0, 30).getTime();

let now = AT;
let enabled = true;
let portalsEnabled = true;
let captureOk = false;
let lastFailure: string | null = "History is unreadable";

function controllerFor(): PortalController {
  const host: PortalHost = {
    now: () => now,
    enabled: () => enabled,
    todayPath: () => TODAY,
    activePath: () => TODAY,
    visible: () => true,
    invite: () => {}
  };
  return new PortalController(host);
}

interface Setup {
  tray: PortalTray;
  controller: PortalController;
  view: EditorView & LiveEditor;
  capture: Mock<(view: EditorView, id: string, text: string, at: number) => boolean>;
  container: ShimElement;
}

let liveTrays: PortalTray[] = [];

/**
 * A clock double that only records subscriptions; ticks are driven directly.
 * `PortalTray` uses only `subscribe`, so the seam is one method wide.
 */
class ClockStub {
  readonly listeners = new Set<(now: number, durationMs: number) => void>();

  subscribe(listener: (now: number, durationMs: number) => void): () => void {
    this.listeners.add(listener);
    listener(now, 0);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** The shim's active element is writable; the DOM type says otherwise. */
function setActive(element: ShimElement | null): void {
  const shim = document as unknown as { activeElement: ShimElement | null };
  shim.activeElement = element;
}

function setup(doc = "existing prose", clock?: EntryClock): Setup {
  const view = liveEditor(createFile(TODAY, ""), doc);
  const controller = controllerFor();
  const capture = vi.fn<(view: EditorView, id: string, text: string, at: number) => boolean>(
    () => captureOk
  );

  const host: PortalWidgetHost = {
    controller,
    clock: clock ?? new EntryClock(new EntrySession(), () => now),
    settings: () => ({ ...DEFAULT_SETTINGS, portalsEnabled, entryFrames: true }),
    capture,
    lastFailure: () => lastFailure
  };

  const tray = new PortalTray(view, host);
  liveTrays.push(tray);

  const container = document.createElement("div") as unknown as ShimElement;
  (document.body as unknown as ShimElement).appendChild(container);
  tray.attach(container as unknown as HTMLElement);

  return { tray, controller, view, capture, container };
}

function surfaces(container: ShimElement): ShimElement[] {
  return container.querySelectorAll(".weaver-portal");
}

function portalId(root: ShimElement): string {
  return root.getAttribute("data-weaver-portal") ?? "";
}

function inputOf(root: ShimElement): ShimElement {
  return root.querySelector(".weaver-portal-input") as ShimElement;
}

function label(root: ShimElement, selector: string): string {
  return root.querySelector(selector)?.textContent ?? "";
}

function fire(element: ShimElement, type: string, extra: Record<string, unknown> = {}): void {
  element.dispatch(type, {
    preventDefault: () => {},
    stopPropagation: () => {},
    ...extra
  });
}

/** The approaching portal of the initial window: 20:11. */
function approachingId(container: ShimElement): string {
  const all = surfaces(container);
  return portalId(all[all.length - 1] as ShimElement);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetDom();
  now = AT;
  enabled = true;
  portalsEnabled = true;
  captureOk = false;
  lastFailure = "History is unreadable";
  liveTrays = [];
});

afterEach(() => {
  for (const tray of liveTrays) tray.destroy();
  vi.useRealTimers();
});

describe("the portal tray in a note", () => {
  it("appends one face per candidate after the entries, on an empty note too", () => {
    const { container } = setup("");

    const all = surfaces(container);
    expect(all.length).toBe(2);
    expect(label(all[0] as ShimElement, ".weaver-portal-countdown")).toBe("Open");
    expect(label(all[1] as ShimElement, ".weaver-portal-countdown")).toBe("Opens in 10:30");
  });

  it("paints each second directly without dispatching a transaction", () => {
    const { view, container } = setup();
    const approaching = surfaces(container)[1] as ShimElement;
    expect(label(approaching, ".weaver-portal-countdown")).toBe("Opens in 10:30");
    const dispatches = view.dispatches;

    now += 1_000;
    vi.advanceTimersByTime(1_000);

    expect(label(approaching, ".weaver-portal-countdown")).toBe("Opens in 10:29");
    expect(view.dispatches).toBe(dispatches);
  });

  it("subscribes to the shared clock only while a face is mounted", () => {
    enabled = false;
    const stub = new ClockStub();
    // Only `subscribe` is used by the tray; the rest of EntryClock is not asked.
    const clock = stub as unknown as EntryClock;
    const { tray, container } = setup("prose", clock);

    expect(surfaces(container).length).toBe(0);
    expect(stub.listeners.size).toBe(0);

    enabled = true;
    tray.reconcile();
    expect(surfaces(container).length).toBe(2);
    expect(stub.listeners.size).toBe(1);

    // A revision does not join the clock twice.
    tray.reconcile();
    expect(stub.listeners.size).toBe(1);

    enabled = false;
    tray.reconcile();
    expect(surfaces(container).length).toBe(0);
    expect(stub.listeners.size).toBe(0);

    enabled = true;
    tray.reconcile();
    expect(stub.listeners.size).toBe(1);

    tray.destroy();
    expect(stub.listeners.size).toBe(0);
  });

  it("prepares and focuses only through a deliberate request", async () => {
    const { tray, controller, view, container } = setup();
    const id = approachingId(container);

    expect(tray.focus(id)).toBe(true);
    expect(controller.held()?.portal.id).toBe(id);
    expect(view.dispatches).toBe(0);
    const root = surfaces(container).find((candidate) => portalId(candidate) === id) as ShimElement;
    expect(inputOf(root).getAttribute("contenteditable")).toBe("true");
    expect(inputOf(root).hasAttribute("hidden")).toBe(false);

    await Promise.resolve();
    expect(view.dispatches).toBe(1);
  });

  it("dispatches once for coalesced lifecycle changes", async () => {
    const { controller, view, container } = setup();
    const id = approachingId(container);

    controller.prepare(id);
    controller.release();

    await Promise.resolve();
    expect(view.dispatches).toBe(1);
  });

  it("focusPortal prepares the already-rendered receptacle", () => {
    const { controller, view, container } = setup();
    const id = approachingId(container);

    expect(focusPortal(view, id)).toBe(true);
    expect(controller.held()?.portal.id).toBe(id);
    const root = surfaces(container).find((candidate) => portalId(candidate) === id) as ShimElement;
    expect(inputOf(root).getAttribute("contenteditable")).toBe("true");
  });

  it("captures nothing while the opening is still locked", () => {
    const { tray, capture, container } = setup();
    const id = approachingId(container);
    tray.focus(id);

    const root = surfaces(container).find((candidate) => portalId(candidate) === id) as ShimElement;
    fire(inputOf(root), "beforeinput", { inputType: "insertText", data: "a" });

    expect(capture).not.toHaveBeenCalled();
    expect(label(root, ".weaver-portal-lock")).toBe("Locked until 20:11");
  });

  it("keeps refused text and offers the whole of it for retry after a repair", async () => {
    const { tray, view, capture, container } = setup();
    const id = approachingId(container);
    tray.focus(id);

    now = new Date(2026, 10, 5, 20, 11, 0, 200).getTime();
    const root = surfaces(container).find((candidate) => portalId(candidate) === id) as ShimElement;
    fire(inputOf(root), "beforeinput", { inputType: "insertText", data: "a" });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(inputOf(root).textContent).toBe("a");
    expect(label(root, ".weaver-portal-refusal")).toBe("History is unreadable");
    expect(label(root, ".weaver-portal-prepare")).toBe("Retry");

    // A replacement tray element in the same session must not lose the words.
    const replacement = document.createElement("div") as unknown as ShimElement;
    (document.body as unknown as ShimElement).appendChild(replacement);
    tray.detach(container as unknown as HTMLElement);
    tray.attach(replacement as unknown as HTMLElement);

    const adopted = surfaces(replacement).find((candidate) => portalId(candidate) === id) as ShimElement;
    expect(inputOf(adopted).textContent).toBe("a");
    expect(label(adopted, ".weaver-portal-refusal")).toBe("History is unreadable");

    captureOk = true;
    lastFailure = null;
    fire(inputOf(adopted), "keydown", { key: "Enter" });

    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenLastCalledWith(view, id, "a", now);
    expect(inputOf(adopted).textContent).toBe("");

    await Promise.resolve();
    tray.reconcile();
    expect(surfaces(replacement).some((candidate) => portalId(candidate) === id)).toBe(false);
  });

  it("keeps a prepared face and its DOM through another portal's expiry", async () => {
    const { tray, controller, container } = setup();
    const id = approachingId(container);
    tray.focus(id);
    await Promise.resolve();

    const before = surfaces(container).find((candidate) => portalId(candidate) === id) as ShimElement;

    now = new Date(2026, 10, 5, 20, 12, 30).getTime();
    tray.reconcile();

    const after = surfaces(container).find((candidate) => portalId(candidate) === id) as ShimElement;
    expect(after).toBe(before);
    expect(after.getAttribute("data-phase")).toBe("held");
    expect(label(after, ".weaver-portal-countdown")).toBe("Held");
    expect(inputOf(after).getAttribute("contenteditable")).toBe("true");
    expect(controller.held()?.portal.id).toBe(id);
    expect(surfaces(container).length).toBe(3);
  });

  it("stops listening after the view goes away", async () => {
    const { tray, controller, view } = setup();
    tray.destroy();

    controller.reconcile();
    await Promise.resolve();
    expect(view.dispatches).toBe(0);
  });

  it("returns focus when settings remove a focused face, not on another expiry", () => {
    const { tray, view, container } = setup();
    const id = approachingId(container);

    const prior = document.createElement("div") as unknown as ShimElement;
    setActive(prior);
    tray.focus(id);

    const root = surfaces(container).find((candidate) => portalId(candidate) === id) as ShimElement;
    setActive(inputOf(root));
    const focusSpy = vi.spyOn(view, "focus");

    // A neighbouring portal expiring removes a face, not the focused one.
    now = new Date(2026, 10, 5, 20, 12, 30).getTime();
    tray.reconcile();
    expect(surfaces(container).length).toBe(3);
    expect(focusSpy).not.toHaveBeenCalled();

    // Turning portals off takes the tray under the caret: hand focus back.
    portalsEnabled = false;
    enabled = false;
    tray.detach(container as unknown as HTMLElement);
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it("never moves focus when the engine consumes the capture", async () => {
    captureOk = true;
    const { tray, view, container } = setup();
    const id = approachingId(container);

    const prior = document.createElement("div") as unknown as ShimElement;
    setActive(prior);
    tray.focus(id);

    const root = surfaces(container).find((candidate) => portalId(candidate) === id) as ShimElement;
    const input = inputOf(root);
    setActive(input);
    const focusSpy = vi.spyOn(view, "focus");

    now = new Date(2026, 10, 5, 20, 11, 0, 200).getTime();
    fire(input, "beforeinput", { inputType: "insertText", data: "a" });

    await Promise.resolve();
    tray.reconcile();
    expect(focusSpy).not.toHaveBeenCalled();
    expect(surfaces(container).some((candidate) => portalId(candidate) === id)).toBe(false);
  });

  it("releases a prepared face from its control without writing or moving the source", () => {
    const { tray, view, controller, container } = setup();
    const id = approachingId(container);

    const prior = document.createElement("div") as unknown as ShimElement;
    setActive(prior);
    tray.focus(id);

    const root = surfaces(container).find((candidate) => portalId(candidate) === id) as ShimElement;
    setActive(inputOf(root));
    const focusSpy = vi.spyOn(view, "focus");
    const before = view.state.doc.toString();

    (root.querySelector(".weaver-portal-prepare") as ShimElement).click();

    expect(controller.held()).toBeNull();
    expect(view.state.doc.toString()).toBe(before);
    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(label(root, ".weaver-portal-prepare")).toBe("Prepare");
    expect(surfaces(container).some((candidate) => portalId(candidate) === id)).toBe(true);
  });

  it("removes a held face released after its minute", async () => {
    const { tray, view, controller, container } = setup();
    const id = approachingId(container);

    const prior = document.createElement("div") as unknown as ShimElement;
    setActive(prior);
    tray.focus(id);
    await Promise.resolve();

    now = new Date(2026, 10, 5, 20, 12, 30).getTime();
    tray.reconcile();

    const root = surfaces(container).find((candidate) => portalId(candidate) === id) as ShimElement;
    expect(root.getAttribute("data-phase")).toBe("held");
    setActive(inputOf(root));
    const focusSpy = vi.spyOn(view, "focus");

    (root.querySelector(".weaver-portal-prepare") as ShimElement).click();

    expect(controller.held()).toBeNull();
    expect(label(root, ".weaver-portal-countdown")).toBe("Passed");
    expect(focusSpy).toHaveBeenCalledTimes(1);

    await Promise.resolve();
    tray.reconcile();
    expect(surfaces(container).some((candidate) => portalId(candidate) === id)).toBe(false);
  });

  it("clears the tray when portals are switched off", () => {
    const live = setup("prose");
    expect(surfaces(live.container).length).toBe(2);

    enabled = false;
    live.tray.reconcile();
    expect(surfaces(live.container).length).toBe(0);
  });
});

describe("the tray's block decoration", () => {
  function stateWith(doc: string, path = TODAY, live = true): EditorState {
    return EditorState.create({
      doc,
      extensions: [
        editorInfoField.init(() => ({ file: createFile(path, "") }) as unknown as MarkdownFileInfo),
        editorLivePreviewField.init(() => live)
      ]
    });
  }

  function decorations(doc: string, path = TODAY, live = true): number {
    const controller = controllerFor();
    const host: PortalWidgetHost = {
      controller,
      clock: new EntryClock(new EntrySession(), () => now),
      settings: () => ({ ...DEFAULT_SETTINGS, portalsEnabled, entryFrames: true }),
      capture: () => false
    };
    return trayDecorations(host, stateWith(doc, path, live)).size;
  }

  it("exists on an empty note and after ordinary text", () => {
    expect(decorations("")).toBe(1);
    expect(decorations("an ordinary entry")).toBe(1);
  });

  it("does not exist in source mode, off, or outside today's note", () => {
    expect(decorations("prose", TODAY, false)).toBe(0);
    portalsEnabled = false;
    expect(decorations("prose")).toBe(0);
    portalsEnabled = true;
    expect(decorations("prose", "Chronomancer/2026-11-04.md")).toBe(0);
  });
});
