import { beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import {
  formatLocalTimestamp,
  type AlignmentRecord
} from "../src/core/alignments";
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

const TODAY = "2026-11-05";
/** 12:00:30 local: 11:55 has passed, 12:00 is open, 12:11 is approaching. */
const AT = new Date(2026, 10, 5, 12, 0, 30);
let now = AT.getTime();

interface Run {
  navigator: Navigator;
  view: EditorView;
  jumps: Array<{ n: number | null; restore: Stop | undefined }>;
  descends: number[];
  starts: number;
  deletes: number[];
  pauses: number;
  prepares: string[];
  dispatched: Array<Record<string, unknown>>;
  stack: { stops: Stop[] };
  session: EntrySession;
  portalListeners: Set<() => void>;
  emitPortals: () => void;
}

interface Options {
  caret?: number;
  stops?: Stop[];
  portalsEnabled?: boolean;
  held?: string | null;
}

/** One modern entry whose own clock row is the recorded beginning. */
function entryDoc(clock = "12:00:00"): string {
  return ["{ 1.1.1 }", "first root", `+ 00:01:00 ${TODAY} ${clock}`, ""].join("\n");
}

function record(
  entry: number,
  began: Date,
  opened = new Date(2026, 10, 5, 12, 0)
): AlignmentRecord {
  return {
    portal: opened.toISOString(),
    opened: formatLocalTimestamp(opened),
    began: formatLocalTimestamp(began),
    entry
  };
}

function withHistory(records: AlignmentRecord[], doc = entryDoc()): string {
  if (records.length === 0) return doc;
  return [
    "---",
    "weaver-alignments:",
    ...records.map((row) => `  - ${JSON.stringify(row)}`),
    "---",
    doc
  ].join("\n");
}

function open(doc = DOC, options: Options = {}): Run {
  const caret = Math.min(Math.max(options.caret ?? doc.indexOf("second root"), 0), doc.length);
  const session = new EntrySession();
  const stack = { stops: [...(options.stops ?? [])] };

  const run: Partial<Run> & { paused: number } = { paused: 0 };
  const jumps: Run["jumps"] = [];
  const descends: number[] = [];
  const deletes: number[] = [];
  const prepares: string[] = [];
  const dispatched: Array<Record<string, unknown>> = [];
  const portalListeners = new Set<() => void>();
  const held = options.held ?? null;

  const plugin = {
    settings: { portalsEnabled: options.portalsEnabled ?? true },
    portals: {
      now: () => now,
      subscribe: (listener: () => void) => {
        portalListeners.add(listener);
        return () => {
          portalListeners.delete(listener);
        };
      },
      held: () =>
        held === null ? null : { portal: { id: held }, path: "2026-11-05.md" }
    },
    preparePortal: (id: string) => {
      prepares.push(id);
      return Promise.resolve();
    },
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

  // A view double that really applies what it is dispatched — including the
  // card's document compartment — and replays CodeMirror's update listeners on
  // a document change, which is what the card subscribes to while it is open.
  const box = {
    state: EditorState.create({ doc, selection: { anchor: caret } })
  };
  const view = {
    get state() {
      return box.state;
    },
    dispatch(spec: Parameters<EditorState["update"]>[0]) {
      dispatched.push(spec as unknown as Record<string, unknown>);
      const transaction = box.state.update(spec);
      box.state = transaction.state;
      if (!transaction.docChanged) return;
      for (const listener of box.state.facet(EditorView.updateListener)) {
        listener({ docChanged: true } as never);
      }
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
    prepares,
    dispatched,
    stack,
    session,
    portalListeners,
    emitPortals: () => {
      for (const listener of [...portalListeners]) listener();
    }
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

function expand(): void {
  bodyQuery(".weaver-navigator-portals-toggle")?.click();
}

const scrolled: ShimElement[] = [];

beforeEach(() => {
  resetHarness();
  now = AT.getTime();
  scrolled.length = 0;
  ShimElement.prototype.scrollIntoView = function scrollIntoView(this: ShimElement) {
    scrolled.push(this);
  };
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

  it("labels a row with its whisper before its own first words", () => {
    open(
      [
        "{ 1.1.1 }",
        "~ a pricing decision, taken slowly",
        "the first root as it was written",
        "10:00:00 + 00:01:00",
        "",
        "{ 1.2.2 }",
        "the second root as it was written",
        "10:05:00 + 00:02:00"
      ].join("\n")
    );

    const titles = rows(".weaver-navigator-title").map((title) => title.textContent);
    expect(titles).toEqual([
      "a pricing decision, taken slowly",
      "the second root as it was written"
    ]);
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
    expect(labels).toEqual([
      "no entries yet — ＋ starts the first"
    ]);
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

    // Past the last entry the section header is next, and that is the edge.
    key("ArrowDown");
    expect(bodyQuery(".weaver-navigator-row.is-selected")?.hasClass("weaver-navigator-portals-toggle")).toBe(
      true
    );
    key("ArrowDown");
    expect(bodyQuery(".weaver-navigator-row.is-selected")?.hasClass("weaver-navigator-portals-toggle")).toBe(
      true
    );

    key("ArrowUp");
    expect(bodyQuery(".weaver-navigator-row.is-selected")?.textContent).toContain("1.3.3");
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

    // The card's own document listener leaves in the same restore transaction.
    const restore = run.dispatched.filter((spec) => spec.selection !== undefined);
    expect(restore.length).toBe(1);
    expect(restore[0]?.selection).toEqual({ anchor: DOC.indexOf("second root") });
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

describe("portal history", () => {
  it("keeps the section collapsed and after the entries", () => {
    open(withHistory([record(1, new Date(2026, 10, 5, 12, 0))]));

    const toggle = bodyQuery(".weaver-navigator-portals-toggle");
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle?.textContent).toContain("Portals");
    expect(rows(".weaver-navigator-portal").length).toBe(0);

    const list = bodyQuery(".weaver-navigator-list");
    const children = list?.children ?? [];
    const toggleAt = children.findIndex((child) => child.hasClass("weaver-navigator-portals-toggle"));
    const lastEntry = children.reduce(
      (last, child, at) => (child.hasClass("weaver-navigator-entry") ? at : last),
      -1
    );
    expect(toggleAt).toBeGreaterThan(lastEntry);
  });

  it("expands on Enter into passed, entered, and upcoming rows", () => {
    const began = new Date(2026, 10, 5, 12, 0);
    open(withHistory([record(1, began)], entryDoc("12:00:00")));

    // One entry, so the section header is one row down from the entry.
    key("ArrowDown");
    const seen = key("Enter");

    expect(seen.prevented).toBe(true);
    expect(bodyQuery(".weaver-navigator-portals-toggle")?.getAttribute("aria-expanded")).toBe(
      "true"
    );
    expect(bodyQuery(".weaver-navigator")).not.toBeNull();

    const labels = rows(".weaver-navigator-portal-label").map((label) => label.textContent);
    expect(labels).toContain("Passed");
    expect(labels).toContain("Aligned · Boundary + minute echo");
    expect(labels).toContain("Upcoming");

    // A recorded row keeps its actual moment and the offset it happened at.
    const recorded = bodyQuery(".weaver-navigator-portal.is-recorded");
    const stamp = formatLocalTimestamp(began);
    expect(recorded?.textContent).toContain(`${stamp.slice(11, 19)} ${stamp.slice(19)}`);

    // Schedule rows are this machine's clock, and say so once.
    const note = bodyQuery(".weaver-navigator-portals-note");
    expect(note?.textContent).toBe("Schedule in current timezone");
  });

  it("labels an entered opening by its actual moment without an alignment", () => {
    const began = new Date(2026, 10, 5, 12, 0, 5);
    open(withHistory([record(1, began)], entryDoc("12:00:05")));
    expand();

    const labels = rows(".weaver-navigator-portal-label").map((label) => label.textContent);
    expect(labels).toContain("Entered · 12:00:05");
  });

  it("brings the row nearest to now into view on the first expansion", () => {
    open(withHistory([record(1, new Date(2026, 10, 5, 12, 0))]));
    expand();

    const first = scrolled.find((element) => element.hasClass("weaver-navigator-portal"));
    expect(first).not.toBeUndefined();
    // The recorded 12:00 opening is nearest to 12:00:30.
    expect(first?.textContent).toContain("Aligned · Boundary");
  });

  it("shows every opening, in order, with no score", () => {
    open(withHistory([record(1, new Date(2026, 10, 5, 12, 0))]));
    expand();

    const before = rows(".weaver-navigator-portal").length;
    const showAll = bodyQuery(".weaver-navigator-portals-all");
    showAll?.click();

    expect(bodyQuery(".weaver-navigator-portals-all")?.getAttribute("aria-pressed")).toBe("true");
    expect(rows(".weaver-navigator-portal").length).toBeGreaterThan(before);

    const times = rows(".weaver-navigator-portal-time").map((time) => time.textContent ?? "");
    expect(times).toEqual([...times].sort());

    const text = bodyQuery(".weaver-navigator-list")?.textContent ?? "";
    expect(text).not.toContain("%");
    expect(text).not.toMatch(/missed/i);
  });

  it("surfaces unreadable history instead of showing an empty list", () => {
    open(["---", "weaver-alignments:", "  - {oops}", "---", entryDoc()].join("\n"));
    expand();

    expect(rows(".weaver-navigator-portal").length).toBe(0);
    const error = bodyQuery(".weaver-navigator-portals-error");
    expect(error?.textContent).toContain("portal history is unreadable");
    expect(error?.getAttribute("role")).toBe("status");
  });

  it("prepares an upcoming opening and closes the card", () => {
    const run = open(entryDoc());
    expand();

    const upcoming = bodyQuery(".weaver-navigator-portal.is-approaching .weaver-navigator-open");
    if (upcoming === null) throw new Error("No upcoming opening");
    upcoming.click();

    expect(run.prepares).toEqual([new Date(2026, 10, 5, 12, 11).toISOString()]);
    expect(bodyQuery(".weaver-navigator")).toBeNull();
  });

  it("leaves a passed opening informational", () => {
    const run = open(entryDoc());
    expand();

    bodyQuery(".weaver-navigator-portal.is-passed .weaver-navigator-open")?.click();

    expect(run.prepares).toEqual([]);
    expect(bodyQuery(".weaver-navigator")).not.toBeNull();
  });

  it("cannot prepare a portal while portals are disabled", () => {
    const run = open(entryDoc(), { portalsEnabled: false });
    expand();

    const upcoming = bodyQuery(".weaver-navigator-portal.is-approaching .weaver-navigator-open");
    if (upcoming === null) throw new Error("No upcoming opening");
    upcoming.click();

    expect(run.prepares).toEqual([]);
    expect(bodyQuery(".weaver-navigator")).not.toBeNull();
  });

  it("still follows a recorded entry while portals are disabled", () => {
    const run = open(withHistory([record(1, new Date(2026, 10, 5, 12, 0))]), {
      portalsEnabled: false
    });
    expand();

    bodyQuery(".weaver-navigator-portal.is-recorded .weaver-navigator-open")?.click();

    expect(run.jumps).toEqual([{ n: 1, restore: undefined }]);
    expect(bodyQuery(".weaver-navigator")).toBeNull();
  });

  it("marks an unavailable entry and never jumps to it", () => {
    const run = open(withHistory([record(2, new Date(2026, 10, 5, 12, 0))]));
    expand();

    const unavailable = bodyQuery(".weaver-navigator-portal.is-unavailable");
    expect(unavailable).not.toBeNull();
    expect(unavailable?.textContent).toContain("Entry unavailable");

    unavailable?.querySelector(".weaver-navigator-open")?.click();

    expect(run.jumps).toEqual([]);
    expect(bodyQuery(".weaver-navigator")).not.toBeNull();
  });

  it("revalidates the association against the live document", () => {
    const run = open(withHistory([record(1, new Date(2026, 10, 5, 12, 0))]));
    expand();
    expect(bodyQuery(".weaver-navigator-portal.is-recorded")?.hasClass("is-unavailable")).toBe(
      false
    );

    // The entry's own clock is edited: its N still exists, but it no longer names
    // the recorded beginning, so the fact has no entry to follow.
    const source = run.view.state.doc.toString();
    const at = source.lastIndexOf("12:00:00");
    run.view.dispatch({ changes: { from: at, to: at + 8, insert: "12:00:07" } });

    const recorded = bodyQuery(".weaver-navigator-portal.is-recorded");
    expect(recorded?.hasClass("is-unavailable")).toBe(true);
    expect(recorded?.textContent).toContain("Entry unavailable");

    recorded?.querySelector(".weaver-navigator-open")?.click();
    expect(run.jumps).toEqual([]);
    expect(bodyQuery(".weaver-navigator")).not.toBeNull();
  });

  it("keeps the selected row and scroll place across a lifecycle refresh", () => {
    const run = open(withHistory([record(1, new Date(2026, 10, 5, 12, 0))]));
    expand();
    key("ArrowDown");

    const selected = bodyQuery(".weaver-navigator-portal.is-selected");
    const id = selected?.getAttribute("data-portal-id");
    expect(id).not.toBeUndefined();

    const list = bodyQuery(".weaver-navigator-list") as unknown as ShimElement;
    list.scrollTop = 40;
    run.emitPortals();

    expect(bodyQuery(".weaver-navigator-portal.is-selected")?.getAttribute("data-portal-id")).toBe(
      id
    );
    expect(list.scrollTop).toBe(40);
  });

  it("does not descend or delete from a history row", () => {
    const run = open(withHistory([record(1, new Date(2026, 10, 5, 12, 0))]));
    expand();
    key("ArrowDown");

    expect(key("x").prevented).toBe(true);
    expect(key("Enter", { shiftKey: true }).prevented).toBe(true);

    expect(run.deletes).toEqual([]);
    expect(run.descends).toEqual([]);
    expect(bodyQuery(".weaver-navigator")).not.toBeNull();
  });
});
