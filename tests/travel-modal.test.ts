import { beforeEach, describe, expect, it } from "vitest";
import { Platform, type MarkdownView } from "obsidian";

import type { TravelRow } from "../src/core/travel-model";
import type WeaverPlugin from "../src/main";
import { TravelModal } from "../src/ui/travel-modal";
import {
  bodyQuery,
  createApp,
  createFile,
  createView,
  resetHarness,
  setRect,
  setValue,
  ShimElement
} from "../test-support/harness";
import { FakeEditor } from "../test-support/editor";

function row(dayKey: string, n: number, d: number): TravelRow {
  return {
    path: `Chronomancer/${dayKey}.md`,
    dayKey,
    line: n,
    d,
    c: 1,
    n,
    time: "10:00:00",
    durationMs: 0,
    title: `entry ${n}`
  };
}

const ROWS = [row("2026-10-26", 1, 1), row("2026-10-26", 2, 3), row("2026-10-27", 3, 2)];

interface Run {
  modal: TravelModal;
  card: ShimElement;
  anchor: MarkdownView;
  travelled: TravelRow[];
  pauses: number;
}

function open(width = 1200, height = 800): Run {
  const app = createApp([createFile("Chronomancer/2026-10-26.md", "")]);
  const anchor = createView(
    app,
    createFile("Chronomancer/2026-10-26.md", ""),
    new FakeEditor("")
  ) as MarkdownView;
  setRect(anchor.contentEl, 0, height, 0, width);

  const run = { pauses: 0 } as { pauses: number };
  const travelled: TravelRow[] = [];
  const plugin = {
    entries: {
      pause: () => {
        run.pauses += 1;
      },
      travelTo: (target: TravelRow) => {
        travelled.push(target);
        return Promise.resolve();
      }
    },
    activeMarkdownView: () => anchor
  } as unknown as WeaverPlugin;

  const modal = new TravelModal(plugin, anchor);
  modal.open(ROWS);

  const card = bodyQuery(".weaver-travel-modal .weaver-travel-card") as ShimElement;
  return Object.assign(run, { modal, card, anchor, travelled }) as Run;
}

function press(card: ShimElement, key: string, extra: Record<string, unknown> = {}): void {
  card.dispatch("keydown", { key, ...extra });
}

function currentDay(run: Run): string {
  const chip = run.card.querySelector(".weaver-travel-day.is-current");
  return chip?.textContent ?? "";
}

beforeEach(() => {
  resetHarness();
  Platform.isPhone = false;
  Platform.isTablet = false;
  Platform.isMobile = false;
});

describe("the travel card", () => {
  it("pauses the stopwatch and mounts itself", () => {
    const run = open();

    expect(run.pauses).toBe(1);
    expect(run.modal.isOpen).toBe(true);
    expect(run.card.querySelector(".weaver-travel-hint")).not.toBeNull();
    expect(currentDay(run)).toBe("2026.10.26 · 2");

    run.modal.close();
  });

  it("walks days with the arrow keys and stays inside them", () => {
    const run = open();

    press(run.card, "ArrowRight");
    expect(currentDay(run)).toBe("2026.10.27 · 1");

    press(run.card, "ArrowRight");
    expect(currentDay(run)).toBe("2026.10.27 · 1");

    press(run.card, "ArrowLeft");
    press(run.card, "ArrowLeft");
    expect(currentDay(run)).toBe("2026.10.26 · 2");

    press(run.card, "ArrowDown");
    press(run.card, "ArrowDown");
    expect(run.card.querySelectorAll(".weaver-travel-row.is-current").length).toBe(1);
    expect(run.card.querySelector(".weaver-travel-row.is-current")?.textContent).toContain("2");

    run.modal.close();
  });

  it("travels on Enter when the query is empty", () => {
    const run = open();

    press(run.card, "Enter");
    expect(run.travelled.length).toBe(1);
    expect(run.travelled[0]?.n).toBe(1);
    expect(run.modal.isOpen).toBe(false);

    run.modal.close();
  });

  it("locks a query on Enter instead of travelling", () => {
    const run = open();
    setValue(run.card.querySelector(".weaver-travel-query"), "3");

    press(run.card, "Enter");

    expect(run.travelled).toEqual([]);
    expect(run.modal.isOpen).toBe(true);
    expect(run.card.querySelectorAll(".weaver-travel-row").length).toBe(1);
    expect(run.card.querySelector(".weaver-travel-row")?.textContent).toContain("3");

    run.modal.close();
  });

  it("never takes a chord away from Obsidian", () => {
    const run = open();
    let prevented = 0;

    press(run.card, ",", {
      metaKey: true,
      preventDefault: () => {
        prevented += 1;
      }
    });

    expect(prevented).toBe(0);
    expect(run.modal.isOpen).toBe(true);

    run.modal.close();
  });

  it("clears the query first and closes on the second Escape", () => {
    const run = open();
    setValue(run.card.querySelector(".weaver-travel-query"), "3");

    press(run.card, "Enter");
    press(run.card, "Escape");
    expect(run.modal.isOpen).toBe(true);
    // The filter is gone, so the current day shows all of its drafts again.
    expect(run.card.querySelectorAll(".weaver-travel-row").length).toBe(2);

    press(run.card, "Escape");
    expect(run.modal.isOpen).toBe(false);
  });

  it("centres itself in the note pane and follows it", () => {
    const run = open(1200, 800);
    const root = bodyQuery(".weaver-travel-modal") as ShimElement;

    expect(root.style.left).toBe("600px");
    expect(root.style.top).toBe("400px");

    setRect(run.anchor.contentEl, 0, 800, 0, 900);
    run.modal.recenter();

    expect(root.style.left).toBe("450px");
    expect(root.style.top).toBe("400px");

    run.modal.close();
  });

  it("centres on the visible viewport on a phone", () => {
    Platform.isPhone = true;
    const run = open(1200, 800);
    const root = bodyQuery(".weaver-travel-modal") as ShimElement;

    // The harness reports a 900-point viewport that starts at the origin.
    expect(root.style.top).toBe("450px");
    expect(root.style.left).toBe(`${1400 / 2}px`);

    run.modal.close();
  });
});
