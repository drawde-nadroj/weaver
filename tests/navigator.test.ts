import { beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import type { Stop } from "../src/core/navigator-stack";
import { EntrySession } from "../src/entries/session";
import type WeaverPlugin from "../src/main";
import { Navigator } from "../src/ui/navigator";
import {
  bodyQuery,
  bodyQueryAll,
  resetHarness,
  ShimElement
} from "../test-support/harness";

const DOC = [
  "{ 1.1.1 } - 10:00:00",
  "first root",
  "+ 00:01:00",
  "",
  "{ 1.2.2 } - 10:05:00",
  "second root",
  "+ 00:02:00",
  "",
  "{ 1.3.3 } - 10:10:00",
  "third root",
  "+ 00:03:00",
  ""
].join("\n");

interface Run {
  navigator: Navigator;
  view: EditorView;
  jumps: Array<{ n: number | null; restore: Stop | undefined }>;
  descends: number[];
  starts: number;
  deletes: number[];
  pauses: number;
  dispatched: Array<Record<string, unknown>>;
  stack: { stops: Stop[] };
  session: EntrySession;
}

interface Options {
  caret?: number;
  stops?: Stop[];
}

function open(doc = DOC, options: Options = {}): Run {
  const caret = Math.min(Math.max(options.caret ?? doc.indexOf("second root"), 0), doc.length);
  const session = new EntrySession();
  const stack = { stops: [...(options.stops ?? [])] };

  const run: Partial<Run> & { paused: number } = { paused: 0 };
  const jumps: Run["jumps"] = [];
  const descends: number[] = [];
  const deletes: number[] = [];
  const dispatched: Array<Record<string, unknown>> = [];
  const plugin = {
    entries: {
      pause: () => {
        run.pauses = (run.pauses ?? 0) + 1;
      },
      startEntry: () => {
        run.starts = (run.starts ?? 0) + 1;
        session.clear();
        return Promise.resolve();
      },
      jumpTo: (n: number | null, restore?: Stop) => {
        jumps.push({ n, restore });
        session.clear();
        return Promise.resolve();
      },
      settleAndDescend: (_view: EditorView, entry: { n: number }) => {
        descends.push(entry.n);
        session.clear();
      },
      deleteEntry: (_view: EditorView, entry: { n: number }) => {
        deletes.push(entry.n);
      }
    },
    stack
  } as unknown as WeaverPlugin;

  const state = EditorState.create({ doc, selection: { anchor: caret } });
  const view = {
    state,
    dispatch: (spec: Record<string, unknown>) => {
      dispatched.push(spec);
    },
    focus: () => {},
    scrollDOM: { scrollTop: 0 }
  } as unknown as EditorView;

  const navigator = new Navigator(plugin);
  navigator.open(view);

  return Object.assign(run as Run, {
    navigator,
    view,
    jumps,
    descends,
    deletes,
    dispatched,
    stack,
    session
  });
}

function key(key: string, extra: Record<string, unknown> = {}): { prevented: boolean } {
  const seen = { prevented: false };
  const card = bodyQuery(".weaver-navigator-card");
  if (card === null) throw new Error("no card");

  card.dispatch("keydown", {
    key,
    preventDefault: () => {
      seen.prevented = true;
    },
    stopPropagation: () => {},
    ...extra
  });

  return seen;
}

function rows(selector: string): ShimElement[] {
  return bodyQueryAll(selector);
}

beforeEach(() => {
  resetHarness();
});

describe("opening", () => {
  it("pauses the clock and shows the caret's own entry as current", () => {
    const run = open();

    expect(run.pauses).toBe(1);

    const current = bodyQuery(".weaver-navigator-row.is-current");
    expect(current?.textContent).toContain("1.2.2");
    // The same row is the selection, so a tap on it descends.
    expect(current?.hasClass("is-selected")).toBe(true);
  });

  it("puts start an entry first", () => {
    open();

    const first = rows(".weaver-navigator-row")[0];
    expect(first?.hasClass("weaver-navigator-append")).toBe(true);
    expect(first?.textContent).toBe("＋ start an entry");
  });

  it("renders the return stack above today's entries", () => {
    open(DOC, { stops: [{ n: 1, caret: 4, scroll: 0 }] });

    const labels = rows(".weaver-navigator-label").map((label) => label.textContent);
    expect(labels).toEqual(["return", "today"]);

    const stops = rows(".weaver-navigator-stop");
    expect(stops.length).toBe(1);
    expect(stops[0]?.textContent).toBe("↩ 1.1.1");
  });

  it("says what to do on an empty note", () => {
    open("");

    const labels = rows(".weaver-navigator-label").map((label) => label.textContent);
    expect(labels).toEqual(["no entries yet — ＋ starts the first"]);
    expect(rows(".weaver-navigator-entry").length).toBe(0);
  });
});

describe("keys", () => {
  it("jumps with Enter", () => {
    const run = open();
    const seen = key("Enter");

    expect(seen.prevented).toBe(true);
    expect(run.jumps).toEqual([{ n: 2, restore: undefined }]);
    expect(bodyQuery(".weaver-navigator")).toBeNull();
  });

  it("descends with Shift-Enter, and starts no clock", () => {
    const run = open();
    const seen = key("Enter", { shiftKey: true });

    expect(seen.prevented).toBe(true);
    expect(run.descends).toEqual([2]);
    expect(run.session.active()).toBeNull();
    expect(bodyQuery(".weaver-navigator")).toBeNull();
  });

  it("starts an entry, and starts no clock", () => {
    const run = open();
    key("n");

    expect(run.starts).toBe(1);
    expect(run.session.active()).toBeNull();
    expect(bodyQuery(".weaver-navigator")).toBeNull();
  });

  it("deletes the selection and keeps the list open", () => {
    const run = open();
    key("x");

    expect(run.deletes).toEqual([2]);
    expect(bodyQuery(".weaver-navigator")).not.toBeNull();
    // The rows are the document as it now is.
    expect(rows(".weaver-navigator-entry").length).toBe(3);
  });

  it("walks the list with the arrows and clamps at the edges", () => {
    open();

    key("ArrowDown");
    expect(bodyQuery(".weaver-navigator-row.is-selected")?.textContent).toContain("1.3.3");

    // Past the last row: still the last row.
    key("ArrowDown");
    expect(bodyQuery(".weaver-navigator-row.is-selected")?.textContent).toContain("1.3.3");

    key("ArrowUp");
    expect(bodyQuery(".weaver-navigator-row.is-selected")?.textContent).toContain("1.2.2");
  });

  it("walks back with ⌘[ and rebuilds the list where it landed", async () => {
    const run = open(DOC, { stops: [{ n: 1, caret: 4, scroll: 0 }] });

    const seen = key("[", { metaKey: true });
    expect(seen.prevented).toBe(true);

    // The walk is an async hop through the engine: two microtasks, no clock.
    await Promise.resolve();
    await Promise.resolve();

    expect(run.jumps).toEqual([{ n: 1, restore: { n: 1, caret: 4, scroll: 0 } }]);
    expect(run.stack.stops).toEqual([]);
    // The panel stayed open, on the place the walk returned to.
    expect(bodyQuery(".weaver-navigator")).not.toBeNull();
  });

  it("closes on Esc and puts the caret back where it opened", () => {
    const run = open();
    const seen = key("Escape");

    expect(seen.prevented).toBe(true);
    expect(bodyQuery(".weaver-navigator")).toBeNull();
    expect(run.dispatched.length).toBe(1);
    expect(run.dispatched[0]?.selection).toEqual({ anchor: DOC.indexOf("second root") });
  });

  it("leaves every other chord to Obsidian", () => {
    open();

    expect(key("ArrowLeft").prevented).toBe(false);
    expect(key("a").prevented).toBe(false);
    expect(key("j", { metaKey: true }).prevented).toBe(false);
    expect(key("Enter", { ctrlKey: true }).prevented).toBe(false);
  });
});

describe("touch", () => {
  it("jumps when a row that is not the caret's is tapped", () => {
    const run = open();
    rows(".weaver-navigator-open")[2]?.click();

    expect(run.jumps).toEqual([{ n: 3, restore: undefined }]);
    expect(bodyQuery(".weaver-navigator")).toBeNull();
  });

  it("descends when the caret's own row is tapped", () => {
    const run = open();
    rows(".weaver-navigator-open")[1]?.click();

    expect(run.descends).toEqual([2]);
    expect(run.jumps).toEqual([]);
  });

  it("starts from the start-an-entry row", () => {
    const run = open();
    rows(".weaver-navigator-append")[0]?.click();

    expect(run.starts).toBe(1);
  });

  it("deletes only on the second tap of ✕", () => {
    const run = open();
    const deletes = rows(".weaver-navigator-delete");

    deletes[0]?.click();
    expect(run.deletes).toEqual([]);
    expect(deletes[0]?.textContent).toBe("✕ again");

    // The second tap is on the row's own armed button.
    rows(".weaver-navigator-delete")[0]?.click();
    expect(run.deletes).toEqual([1]);
    expect(bodyQuery(".weaver-navigator")).not.toBeNull();
  });

  it("disarms when the selection moves", () => {
    const run = open();

    rows(".weaver-navigator-delete")[0]?.click();
    key("ArrowDown");
    expect(rows(".weaver-navigator-delete")[0]?.textContent).toBe("✕");

    rows(".weaver-navigator-delete")[0]?.click();
    expect(run.deletes).toEqual([]);
  });
});

describe("closing", () => {
  it("is idempotent, and taking it away twice is harmless", () => {
    const run = open();
    run.navigator.close();
    run.navigator.close();

    expect(run.navigator.isOpen).toBe(false);
    expect(bodyQuery(".weaver-navigator")).toBeNull();
  });
});
