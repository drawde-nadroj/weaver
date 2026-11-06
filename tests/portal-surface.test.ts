import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { PortalInstant } from "../src/core/portals";
import {
  mountPortalSurface,
  mountPortalTray,
  PORTAL_REFUSAL,
  PortalSurface,
  portalCountdownLabel,
  portalTimeLabel,
  type PortalSurfaceOptions
} from "../src/ui/portal";
import { resetDom, ShimElement } from "../test-support/dom";

/** 22:55 local: the surface labels are read off the portal's own frozen fields. */
const OPENS = new Date(2026, 10, 5, 22, 55, 0).getTime();
const PORTAL: PortalInstant = {
  id: new Date(OPENS).toISOString(),
  opensAt: OPENS,
  day: "2026-11-05",
  hour: 22,
  minute: 55,
  offsetMinutes: -new Date(OPENS).getTimezoneOffset()
};

let now = OPENS - 30_000;

interface Fired {
  prevented: boolean;
  stopped: boolean;
}

/** Dispatches one shim event, reporting whether the surface consumed it. */
function fire(element: ShimElement, type: string, extra: Record<string, unknown> = {}): Fired {
  const flags: Fired = { prevented: false, stopped: false };
  element.dispatch(type, {
    preventDefault: () => {
      flags.prevented = true;
    },
    stopPropagation: () => {
      flags.stopped = true;
    },
    ...extra
  });
  return flags;
}

interface Built {
  surface: PortalSurface;
  root: ShimElement;
  input: ShimElement;
  capture: Mock<(text: string, at: number) => boolean>;
  prepare: Mock<() => void>;
  release: Mock<() => void>;
}

function build(overrides: Partial<PortalSurfaceOptions> = {}): Built {
  const capture = vi.fn<(text: string, at: number) => boolean>(() => true);
  const prepare = vi.fn<() => void>();
  const release = vi.fn<() => void>();
  const surface = mountPortalSurface(document.body, {
    portal: PORTAL,
    mode: "write",
    prepare,
    release,
    capture,
    now: () => now,
    ...overrides
  });
  const root = surface.root as unknown as ShimElement;
  const input = root.querySelector(".weaver-portal-input") as ShimElement;
  return { surface, root, input, capture, prepare, release };
}

function text(root: ShimElement, selector: string): string {
  return root.querySelector(selector)?.textContent ?? "";
}

function clockDigits(root: ShimElement): string {
  const spans = root.querySelectorAll(".weaver-portal-clock .weaver-duration-num");
  return spans.map((span) => span.textContent ?? "").join(":");
}

function type(element: ShimElement, data: string): Fired {
  return fire(element, "beforeinput", { inputType: "insertText", data });
}

beforeEach(() => {
  resetDom();
  now = OPENS - 30_000;
});

describe("the pending portal surface", () => {
  it("draws its own vocabulary and keeps the node identity across paints", () => {
    const { surface, root, input } = build();

    expect(root.getAttribute("data-weaver-portal")).toBe(PORTAL.id);
    expect(root.getAttribute("data-mode")).toBe("write");
    expect(root.getAttribute("data-phase")).toBe("approaching");
    expect(text(root, ".weaver-portal-label")).toBe("Portal · 22:55");
    expect(text(root, ".weaver-portal-countdown")).toBe("Opens in 00:30");
    expect(clockDigits(root)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(text(root, ".weaver-portal-prepare")).toBe("Prepare");

    now = OPENS + 5_000;
    surface.refresh(now);
    expect(text(root, ".weaver-portal-countdown")).toBe("Open");
    expect(text(root, ".weaver-portal-prepare")).toBe("Enter");
    expect(root.getAttribute("data-phase")).toBe("open");
    expect((surface.root as unknown as ShimElement).querySelector(".weaver-portal-input")).toBe(input);
  });

  it("keeps both rail labels in one footer row, with the controls between", () => {
    const { root, input } = build();

    const footers = root.querySelectorAll(".weaver-portal-footer");
    expect(footers.length).toBe(1);

    const footer = footers[0];
    const countdown = root.querySelector(".weaver-portal-countdown") as ShimElement;
    const clock = root.querySelector(".weaver-portal-clock") as ShimElement;

    // The bottom rail is one row: reparenting, not a second pair of labels.
    expect(countdown.parentElement).toBe(footer);
    expect(clock.parentElement).toBe(footer);
    expect(root.querySelectorAll(".weaver-portal-countdown").length).toBe(1);
    expect(root.querySelectorAll(".weaver-portal-clock").length).toBe(1);
    expect(countdown.classList.contains("weaver-frame-label")).toBe(true);
    expect(clock.classList.contains("weaver-frame-label")).toBe(true);

    // The control and receptacle are the interior, never part of the rail row.
    expect(footer.contains(input)).toBe(false);
    expect(footer.contains(root.querySelector(".weaver-portal-prepare") as ShimElement)).toBe(false);
  });

  it("accepts nothing before the opening and says so once", () => {
    const { surface, root, input, capture } = build();
    surface.setPrepared(true);

    expect(input.hasAttribute("hidden")).toBe(false);
    expect(input.getAttribute("contenteditable")).toBe("true");
    expect(text(root, ".weaver-portal-prepare")).toBe("Release");

    const first = type(input, "a");
    expect(first.prevented).toBe(true);
    expect(first.stopped).toBe(true);
    expect(capture).not.toHaveBeenCalled();
    expect(input.textContent).toBe("");
    expect(text(root, ".weaver-portal-lock")).toBe("Locked until 22:55");

    type(input, "b");
    expect(capture).not.toHaveBeenCalled();
    expect(input.textContent).toBe("");
    expect(root.querySelectorAll(".weaver-portal-lock").length).toBe(1);
  });

  it("hands over the first committed text exactly once", () => {
    now = OPENS + 200;
    const { surface, input, capture } = build();
    surface.setPrepared(true);

    const started = type(input, "a");
    expect(started.prevented).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith("a", now);
    expect(input.textContent).toBe("");

    type(input, "b");
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("captures a paste once, as one line", () => {
    now = OPENS + 200;
    const { surface, input, capture } = build();
    surface.setPrepared(true);

    fire(input, "paste", {
      clipboardData: { getData: () => "one\n\ntwo " }
    });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith("one  two", now);
  });

  it("ignores a held key repeating across the boundary until a fresh press", () => {
    now = OPENS - 2_000;
    const { surface, input, capture } = build();
    surface.setPrepared(true);

    fire(input, "keydown", { key: "x", repeat: true });
    now = OPENS + 400;
    const repeated = type(input, "x");
    expect(repeated.prevented).toBe(true);
    expect(capture).not.toHaveBeenCalled();

    fire(input, "keyup", { key: "x" });
    fire(input, "keydown", { key: "x", repeat: false });
    type(input, "x");
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("captures one committed composition instead of preedit", () => {
    now = OPENS + 200;
    const { surface, input, capture } = build();
    surface.setPrepared(true);

    fire(input, "compositionstart");
    const preedit = fire(input, "beforeinput", {
      inputType: "insertCompositionText",
      data: "に",
      isComposing: true
    });
    expect(preedit.prevented).toBe(false);
    expect(capture).not.toHaveBeenCalled();

    input.textContent = "にほん";
    fire(input, "compositionend");

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith("にほん", now);
  });

  it("clears a composition committed before the opening", () => {
    const { surface, input, capture } = build();
    surface.setPrepared(true);

    fire(input, "compositionstart");
    const preedit = fire(input, "beforeinput", {
      inputType: "insertCompositionText",
      data: "に",
      isComposing: true
    });
    expect(preedit.prevented).toBe(true);
    input.textContent = "に";
    fire(input, "compositionend");

    expect(capture).not.toHaveBeenCalled();
    expect(input.textContent).toBe("");
  });

  it("keeps refused text and retries with the whole of it", () => {
    now = OPENS + 200;
    const capture = vi.fn<(text: string, at: number) => boolean>(() => false);
    const { surface, root, input } = build({ capture });
    surface.setPrepared(true);

    type(input, "a");
    expect(input.textContent).toBe("a");
    expect(text(root, ".weaver-portal-refusal")).toBe(PORTAL_REFUSAL);
    expect(root.classList.contains("is-refused")).toBe(true);
    expect(text(root, ".weaver-portal-prepare")).toBe("Retry");
    expect((root.querySelector(".weaver-portal-prepare") as ShimElement).hasAttribute("hidden")).toBe(false);

    capture.mockReturnValueOnce(true);
    const retried = fire(input, "keydown", { key: "Enter" });
    expect(retried.prevented).toBe(true);
    expect(capture).toHaveBeenLastCalledWith("a", now);
    expect(input.textContent).toBe("");
    expect(root.classList.contains("is-refused")).toBe(false);
  });

  it("prefixes a retry typed as more text with everything already kept", () => {
    now = OPENS + 200;
    const capture = vi.fn<(text: string, at: number) => boolean>(() => false);
    const { surface, input } = build({ capture });
    surface.setPrepared(true);

    type(input, "a");
    capture.mockReturnValueOnce(true);
    type(input, "b");

    expect(capture).toHaveBeenLastCalledWith("ab", now);
  });

  it("restores recovered text into a replacement element", () => {
    now = OPENS + 200;
    const { surface, root, input } = build({ capture: vi.fn(() => false) });
    surface.setPrepared(true);
    type(input, "a");

    surface.recover("a", "Source is unreadable");
    expect(input.textContent).toBe("a");
    expect(text(root, ".weaver-portal-refusal")).toBe("Source is unreadable");
  });

  it("keeps the control as a visible Release while prepared", () => {
    const { surface, root, release, capture } = build();
    surface.setPrepared(true);

    const button = root.querySelector(".weaver-portal-prepare") as ShimElement;
    expect(button.hasAttribute("hidden")).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Release");
    expect(button.getAttribute("aria-label")).toBe("Release portal 22:55");

    button.click();
    expect(release).toHaveBeenCalledTimes(1);
    expect(capture).not.toHaveBeenCalled();

    surface.setPrepared(false);
    expect(button.textContent).toBe("Prepare");
    expect(button.hasAttribute("hidden")).toBe(false);
  });

  it("releases on Escape and never treats Enter as text", () => {
    now = OPENS + 200;
    const { surface, input, capture, release } = build();
    surface.setPrepared(true);

    const escape = fire(input, "keydown", { key: "Escape" });
    expect(escape.prevented).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);

    fire(input, "keydown", { key: "Enter" });
    expect(capture).not.toHaveBeenCalled();
  });

  it("holds a prepared opening past its minute, then reports it as passed", () => {
    now = OPENS + 90_000;
    const { surface, root } = build();

    surface.setPrepared(true);
    expect(root.getAttribute("data-phase")).toBe("held");
    expect(text(root, ".weaver-portal-countdown")).toBe("Held");

    surface.setPrepared(false);
    expect(root.getAttribute("data-phase")).toBe("expired");
    expect(text(root, ".weaver-portal-countdown")).toBe("Passed");
    expect((root.querySelector(".weaver-portal-prepare") as ShimElement).hasAttribute("hidden")).toBe(true);
  });

  it("builds a Reading face that only offers the deliberate switch", () => {
    const prepare = vi.fn<() => void>();
    const tray = mountPortalTray(document.body);
    const surface = mountPortalSurface(tray, {
      portal: PORTAL,
      mode: "reading",
      prepare,
      release: vi.fn(),
      now: () => now
    });
    const root = surface.root as unknown as ShimElement;

    expect((tray as unknown as ShimElement).className).toBe("weaver-portal-tray");
    expect(root.querySelector(".weaver-portal-input")).toBeNull();
    expect(text(root, ".weaver-portal-countdown")).toBe("Opens in 00:30");
    expect(root.querySelectorAll(".weaver-portal-footer").length).toBe(1);
    expect(
      (root.querySelector(".weaver-portal-clock") as ShimElement).parentElement?.className
    ).toContain("weaver-portal-footer");
    (root.querySelector(".weaver-portal-prepare") as ShimElement).click();
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("ignores input after destroy", () => {
    const { surface, input, capture } = build();
    surface.setPrepared(true);
    now = OPENS + 200;
    surface.refresh(now);
    surface.destroy();

    fire(input, "beforeinput", { inputType: "insertText", data: "a" });
    expect(capture).not.toHaveBeenCalled();
  });

  it("removes its node on destroy", () => {
    const { surface, root } = build();
    expect((document.body as unknown as ShimElement).contains(root)).toBe(true);
    surface.destroy();
    expect((document.body as unknown as ShimElement).contains(root)).toBe(false);
  });
});

describe("portal labels", () => {
  it("never counts down past zero before the opening", () => {
    expect(portalCountdownLabel(PORTAL, OPENS - 1)).toBe("Opens in 00:01");
    expect(portalCountdownLabel(PORTAL, OPENS)).toBe("Open");
    expect(portalCountdownLabel(PORTAL, OPENS + 60_000)).toBe("Passed");
    expect(portalCountdownLabel(PORTAL, OPENS + 60_000, true)).toBe("Held");
    expect(portalTimeLabel(PORTAL)).toBe("Portal · 22:55");
  });
});
