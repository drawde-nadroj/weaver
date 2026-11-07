import { describe, expect, it } from "vitest";

import { mainContext, type WeavingContext } from "../src/core/contexts";
import { ContextWorkspaces, layoutKey, type LayoutApi, type WorkspaceHost } from "../src/entries/context-workspaces";
import { readWorkspaceRecord, type LocalStateRecord } from "../src/entries/local-state";
import { createApp, createFile } from "../test-support/harness";

const CONTEXTS: WeavingContext[] = [
  mainContext({ folder: "Chronomancer", format: "YYYY.MM.DD" }),
  { id: "ctx-spanish", name: "Spanish", folder: "Spanish/Daily", format: "YYYY.MM.DD" }
];

/** A layout API that records what it was given, and can refuse. */
class FakeLayout implements LayoutApi {
  applied: unknown[] = [];
  fail = false;
  /** Fail only the next `applyLayout` call, so a rollback can succeed after it. */
  failNext = 0;
  constructor(public current: unknown = { leaves: ["main"] }) {}

  getLayout(): unknown {
    return this.current;
  }

  async applyLayout(layout: unknown): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("this host cannot build that layout");
    }
    if (this.fail) throw new Error("this host cannot build that layout");
    this.applied.push(layout);
    this.current = layout;
  }
}

interface Harness {
  host: WorkspaceHost;
  workspaces: ContextWorkspaces;
  layout: FakeLayout;
  notes: string[];
  notices: string[];
  freezes: number;
  saved: LocalStateRecord[];
  state: LocalStateRecord;
}

function harness(options: { layout?: FakeLayout | null } = {}): Harness {
  const app = createApp();
  const layout = options.layout === undefined ? new FakeLayout() : options.layout;
  const notices: string[] = [];
  const notes: string[] = [];
  const saved: LocalStateRecord[] = [];
  const state: LocalStateRecord = {
    workspaces: { activeContextId: null, snapshots: {}, selections: {} },
    schedules: {}
  };

  const h: Harness = {
    host: null as unknown as WorkspaceHost,
    workspaces: null as unknown as ContextWorkspaces,
    layout: layout ?? new FakeLayout(),
    notes,
    notices,
    freezes: 0,
    saved,
    state
  };

  h.host = {
    app,
    layout: () => (options.layout === null ? null : layout),
    contexts: () => CONTEXTS,
    state: () => state,
    save: (update) => {
      const next = update(state);
      state.workspaces = next.workspaces;
      state.schedules = next.schedules;
      saved.push(next);
      return next;
    },
    freezeDraft: () => {
      h.freezes += 1;
    },
    openNote: async (path) => {
      notes.push(path);
      return true;
    },
    notify: (message) => notices.push(message)
  };

  h.workspaces = new ContextWorkspaces(h.host);
  return h;
}

describe("layout keys", () => {
  it("keeps each screen's memory to itself", () => {
    expect(layoutKey("main", true, false)).toBe("phone:main");
    expect(layoutKey("main", false, true)).toBe("tablet:main");
    expect(layoutKey("main", false, false)).toBe("desktop:main");
  });
});

describe("visiting a destination", () => {
  it("opens today's note on the first visit and remembers the screen as it was", async () => {
    const test = harness();
    test.host.app.workspace.getLeavesOfType = () => [];

    const ok = await test.workspaces.visit("ctx-spanish");

    expect(ok).toBe(true);
    expect(test.notes).toHaveLength(1);
    expect(test.notes[0]).toMatch(/^Spanish\/Daily\/\d{4}\.\d{2}\.\d{2}\.md$/);
    expect(test.freezes).toBe(1);
    expect(test.workspaces.viewing()).toBe("ctx-spanish");
    // The layout that was on screen never had to be restored: nothing moved.
    expect(test.layout.applied).toEqual([]);
  });

  it("restores a destination's own last layout on a later visit", async () => {
    const test = harness();
    test.host.app.workspace.getLeavesOfType = () => [];

    await test.workspaces.visit("ctx-spanish");
    const stored = test.state.workspaces.snapshots[layoutKey("ctx-spanish")];
    expect(stored?.layout).toEqual({ leaves: ["main"] });

    // The writer visits another destination, rearranges it, and comes back.
    await test.workspaces.visit("main");
    test.layout.current = { leaves: ["main", "reference"] };
    await test.workspaces.visit("ctx-spanish");

    const applied = test.layout.applied.at(-1);
    expect(applied).toEqual(stored?.layout);
  });

  it("rolls back and says so when the destination cannot be restored", async () => {
    const test = harness();
    test.host.app.workspace.getLeavesOfType = () => [];

    await test.workspaces.visit("main");
    await test.workspaces.visit("ctx-spanish");
    const before = test.layout.current;
    // The destination cannot be built, but the rollback can.
    test.layout.failNext = 1;

    const ok = await test.workspaces.visit("main");

    expect(ok).toBe(false);
    expect(test.notices.join("\n")).toContain("Could not open Main");
    expect(test.notices.join("\n")).toContain("draft is safe");
    expect(test.workspaces.viewing()).toBe("ctx-spanish");
    expect(test.layout.current).toEqual(before);
  });

  it("leaves the real screen alone and stops claiming a destination when rollback fails too", async () => {
    const test = harness();
    test.host.app.workspace.getLeavesOfType = () => [];
    await test.workspaces.visit("main");
    await test.workspaces.visit("ctx-spanish");

    // Refuse both the destination and the rollback.
    let calls = 0;
    test.layout.applyLayout = async () => {
      calls += 1;
      throw new Error("no");
    };

    const ok = await test.workspaces.visit("main");

    expect(ok).toBe(false);
    expect(calls).toBeGreaterThan(1);
    expect(test.workspaces.viewing()).toBe("");
    expect(test.workspaces.label()).toBe("Current workspace");
    expect(test.notices.join("\n")).toContain("screen is unchanged");
  });

  it("refuses a destination it does not have, and moves nothing", async () => {
    const test = harness();
    const ok = await test.workspaces.visit("ctx-gone");

    expect(ok).toBe(false);
    expect(test.layout.applied).toEqual([]);
    expect(test.notices.join("\n")).toContain("no destination called");
  });

  it("refuses overlapping travel, so two restores cannot interleave", async () => {
    const test = harness();
    test.host.app.workspace.getLeavesOfType = () => [];

    const first = test.workspaces.visit("ctx-spanish");
    const second = test.workspaces.visit("main");

    expect(await second).toBe(false);
    expect(await first).toBe(true);
    expect(test.notices.join("\n")).toContain("still finishing");
  });

  it("says nothing was moved when the host has no layout API", async () => {
    const test = harness({ layout: null });
    const ok = await test.workspaces.visit("ctx-spanish");

    expect(ok).toBe(false);
    expect(test.notices.join("\n")).toContain("does not expose workspace layouts");
    expect(test.freezes).toBe(0);
  });
});

describe("remembering a screen", () => {
  it("stores nothing while the screen belongs to no destination", () => {
    const test = harness();
    test.workspaces.remember();
    expect(test.saved).toEqual([]);
  });

  it("stores the active destination's layout without travelling", async () => {
    const test = harness();
    test.host.app.workspace.getLeavesOfType = () => [];
    await test.workspaces.visit("ctx-spanish");

    test.workspaces.remember();
    expect(test.state.workspaces.snapshots[layoutKey("ctx-spanish")]?.layout).toEqual({ leaves: ["main"] });
  });
});

describe("stored records", () => {
  it("drops what it cannot read and keeps what it can", () => {
    const record = readWorkspaceRecord({
      workspaces: {
        activeContextId: "main",
        snapshots: { "desktop:main": { layout: { a: 1 }, panes: [{ path: "a.md", state: { line: 3 } }], activePath: "a.md" }, bad: 4 },
        selections: { "desktop:main": { path: "a.md", n: 1, b: 1, d: 1, rootN: 1, day: null, time: null, prose: "x" }, broken: { n: 0 } }
      },
      schedules: { s1: { activatedAt: 5, acknowledgedThrough: null, pending: null, generation: 2 }, s2: {} }
    });

    expect(Object.keys(record.workspaces.snapshots)).toEqual(["desktop:main"]);
    expect(Object.keys(record.workspaces.selections)).toEqual(["desktop:main"]);
    expect(Object.keys(record.schedules)).toEqual(["s1"]);
    expect(record.workspaces.activeContextId).toBe("main");
  });

  it("treats a value that is not a record as nothing remembered", () => {
    expect(readWorkspaceRecord("nonsense").workspaces.activeContextId).toBeNull();
    expect(readWorkspaceRecord(null).schedules).toEqual({});
  });

  it("keeps a note's position, not just its path", () => {
    const app = createApp([createFile("a.md", "a")]);
    const state = readWorkspaceRecord({
      workspaces: {
        activeContextId: null,
        snapshots: {
          "desktop:main": { layout: null, panes: [{ path: "a.md", state: { line: 7 } }], activePath: "a.md" }
        },
        selections: {}
      },
      schedules: {}
    });

    expect(state.workspaces.snapshots["desktop:main"]?.panes[0]?.state).toEqual({ line: 7 });
    expect(app.vault.getAbstractFileByPath("a.md")).not.toBeNull();
  });
});

describe("restoring a recorded screen", () => {
  /** A markdown view the shim can stand in for, with its own position. */
  function pane(path: string, mode: "source" | "preview", state: unknown) {
    let current = state;
    const view = {
      file: { path },
      getMode: () => mode,
      getEphemeralState: () => current,
      setEphemeralState: (next: unknown) => {
        current = next;
      },
      applied: () => current
    };
    return view;
  }

  function leaf(id: string, view: unknown): { id: string; view: unknown } {
    return { id, view };
  }

  it("restores a stored snapshot instead of the Realm's latest layout", async () => {
    const test = harness();
    const recorded = { leaves: ["one"] };

    test.host.app.workspace.getLeavesOfType = () => [];
    // The Realm's own memory says something else entirely.
    test.state.workspaces.snapshots[layoutKey("main")] = {
      layout: { leaves: ["latest"] },
      panes: [],
      activePath: null,
      activeLeafId: null
    };

    expect(
      await test.workspaces.restoreSnapshot(
        { layout: recorded, panes: [], activePath: null, activeLeafId: null },
        "main"
      )
    ).toBe(true);

    // The snapshot asked for, not the Realm's latest: history returns places.
    expect(test.layout.applied).toEqual([recorded]);
    expect(test.workspaces.viewing()).toBe("main");
  });

  it("matches two panes of one note by leaf and mode rather than by path", async () => {
    const MarkdownView = (await import("obsidian")).MarkdownView as unknown as new () => object;
    const left = Object.assign(Object.create(MarkdownView.prototype), pane("Note.md", "source", { from: 1 }));
    const right = Object.assign(Object.create(MarkdownView.prototype), pane("Note.md", "preview", { from: 2 }));

    const test = harness();
    const leaves = [leaf("leaf-left", left), leaf("leaf-right", right)];
    test.host.app.workspace.getLeavesOfType = () => leaves as never;

    const ok = await test.workspaces.restoreSnapshot({
      layout: { leaves: ["left", "right"] },
      panes: [
        { path: "Note.md", state: { from: 1 }, leafId: "leaf-left", mode: "source" },
        { path: "Note.md", state: { from: 2 }, leafId: "leaf-right", mode: "preview" }
      ],
      activePath: "Note.md",
      activeLeafId: "leaf-right"
    }, "main");

    expect(ok).toBe(true);
    // Each position went to its own pane: the reading pane did not inherit the
    // editing pane's scroll.
    expect((left as unknown as { applied(): unknown }).applied()).toEqual({ from: 1 });
    expect((right as unknown as { applied(): unknown }).applied()).toEqual({ from: 2 });
  });

  it("leaves the label unknown when the screen is not the Realm it remembered", async () => {
    const test = harness();
    test.state.workspaces.activeContextId = "ctx-spanish";
    test.state.workspaces.snapshots[layoutKey("ctx-spanish")] = {
      layout: { leaves: ["remembered"] },
      panes: [{ path: "Spanish/Daily/2026.11.05.md", state: null, leafId: null, mode: "source" }],
      activePath: "Spanish/Daily/2026.11.05.md",
      activeLeafId: null
    };

    const MarkdownView = (await import("obsidian")).MarkdownView as unknown as new () => object;
    const live = Object.assign(
      Object.create(MarkdownView.prototype),
      pane("Main/2026.11.05.md", "source", null)
    );
    test.host.app.workspace.getLeavesOfType = () => [leaf("leaf-1", live)] as never;

    test.workspaces.adopt();
    // The live screen does not look like the remembered one, so nothing claims it.
    expect(test.workspaces.viewing()).toBe("");
  });
});
