import { describe, expect, it } from "vitest";

import { entryDayElement } from "../src/ui/day-link";

type Dispatchable = {
  className: string;
  textContent: string;
  click: () => void;
  dispatch: (type: string, event?: Record<string, unknown>) => void;
  getAttribute: (name: string) => string | null;
};

function element(
  target = "2026.11.02",
  sourcePath = "Chronomancer/2026.11.02.md",
  calls: [string, string][] = []
): Dispatchable {
  return entryDayElement({ day: target.replace(/\./g, "-"), target }, sourcePath, (opened, from) => {
    calls.push([opened, from]);
  }) as unknown as Dispatchable;
}

describe("the day link", () => {
  it("is a corner label and a wikilink to the daily note", () => {
    const link = element();

    expect(link.className).toBe("weaver-entry-daylink weaver-frame-label");
    expect(link.textContent).toBe("[[2026.11.02]]");
    expect(link.getAttribute("role")).toBe("link");
    expect(link.getAttribute("tabindex")).toBe("0");
  });

  it("renders an unlinked recorded day as a non-interactive corner label", () => {
    const label = entryDayElement(
      { day: "2026-11-02", target: null },
      "Projects/Idea.md",
      () => {}
    ) as unknown as Dispatchable;

    expect(label.className).toBe("weaver-entry-daylabel weaver-frame-label");
    expect(label.textContent).toBe("2026-11-02");
    expect(label.getAttribute("role")).toBeNull();
    expect(label.getAttribute("tabindex")).toBeNull();
  });

  it("opens the target from its source note on click", () => {
    const calls: [string, string][] = [];
    const link = element("2026.11.02", "Chronomancer/2026.11.02.md", calls);

    link.click();

    expect(calls).toEqual([["2026.11.02", "Chronomancer/2026.11.02.md"]]);
  });

  it("opens on Enter and Space, and stops the event from reaching the editor", () => {
    const calls: [string, string][] = [];
    const link = element("2026.11.02", "Chronomancer/2026.11.02.md", calls);

    let prevented = 0;
    let stopped = 0;
    const event = {
      key: "Enter",
      preventDefault: () => (prevented += 1),
      stopPropagation: () => (stopped += 1)
    };

    link.dispatch("keydown", event);
    link.dispatch("keydown", { ...event, key: " " });
    // A key the link does not claim is left alone.
    link.dispatch("keydown", { ...event, key: "Tab" });

    expect(calls).toHaveLength(2);
    expect(prevented).toBe(2);
    expect(stopped).toBe(2);
  });
});
