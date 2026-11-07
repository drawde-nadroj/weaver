/**
 * Destination travel: going to a workspace, and coming back to it as you left it.
 *
 * The composer is the reason this exists. Writing somewhere no longer means going
 * there, so "viewing" has to be its own deliberate act — and if a visit is going
 * to replace the screen, returning has to be exact: the panes, their files, their
 * scroll positions and carets, all of it. A destination keeps its *last used*
 * layout, which is what makes a workspace feel like a place rather than a tab
 * that reloads.
 *
 * Four rules keep that honest:
 *
 *  - The layout is a host object. It is cloned on the way out and never mutated
 *    on the way in, so no guess about its internal field names is ever made.
 *  - A failed restore rolls back to the layout that was on screen and *says so*.
 *    A draft is never lost because a file was missing; if the rollback itself
 *    fails, the actual screen is labelled "Current workspace" rather than claimed
 *    to be a destination.
 *  - The composer's DOM is not a leaf, so a layout change cannot destroy the
 *    draft's input. Travel freezes the draft's timing and stores it before the
 *    layout moves.
 *  - Overlapping travel is refused while one transition is in flight: two
 *    restores racing would leave the screen in neither place.
 *
 * What is remembered is this device's: a layout name is namespaced by platform,
 * so a phone never rearranges a desk.
 */

import { MarkdownView, type App } from "obsidian";

import { contextDayPath, type WeavingContext } from "../core/contexts";
import { dayKey } from "../core/day";
import type { LocalStateRecord, PanePosition, WorkspaceSnapshot } from "./local-state";
import { isPhone, isTablet } from "../ui/platform";

/** The host's layout surface, injected so a test can stand in for a workspace. */
export interface LayoutApi {
  /** The workspace's own layout object. */
  getLayout(): unknown;
  /** Applies a layout. Rejects when the host could not build one. */
  applyLayout(layout: unknown): Promise<void>;
}

/** What travel needs from the plugin. */
export interface WorkspaceHost {
  app: App;
  /** The workspace's layout API, or null when this host has none. */
  layout(): LayoutApi | null;
  /** Every destination, `main` first. */
  contexts(): readonly WeavingContext[];
  /** The stored record, read fresh when a decision is made. */
  state(): LocalStateRecord;
  /**
   * Applies one synchronous update to the latest stored record.
   *
   * Travel spans awaited layout work, so a whole-envelope save made from the
   * record read before the await would carry a stale workspace field back and
   * clobber a change another owner made meanwhile. The updater sees the current
   * record and returns the next one; this module only ever edits `workspaces`.
   */
  save(update: (current: LocalStateRecord) => LocalStateRecord): LocalStateRecord;
  /** Freezes the draft's clock and stores it, before the screen moves. */
  freezeDraft(): void;
  /** Opens (creating when needed) a destination's note for a day. */
  openNote(path: string): Promise<boolean>;
  /** Says what actually happened. */
  notify(message: string): void;
}

/** The name a layout is remembered under: one screen, one destination. */
export function layoutKey(contextId: string, phone = isPhone(), tablet = isTablet()): string {
  const platform = phone ? "phone" : tablet ? "tablet" : "desktop";
  return `${platform}:${contextId}`;
}

/**
 * The clipboard-free half of travel: snapshots, positions, and the one visit.
 *
 * Nothing here writes a note. It reads the workspace, stores a clone of it, and
 * asks the host to open a destination — which may create that destination's note,
 * because a visit is explicit.
 */
export class ContextWorkspaces {
  /** The destination the screen is showing, or null when it is unrecognised. */
  private active: string | null = null;
  /** True while one transition is running, so a second cannot interleave. */
  private travelling = false;
  /** True once ownership was decided against the real layout. */
  private adopted = false;
  /** Pane positions a restore could not apply yet, with the restore that owns them. */
  private pending: PendingPane[] = [];
  /** Bumped by every restore, so a superseded restore's pending panes are dropped. */
  private generation = 0;

  constructor(private readonly host: WorkspaceHost) {
    // Ownership is unknown until `adopt` has compared the real screen with what
    // was remembered: a label is a claim about the workspace, not about a file.
    this.active = null;
  }

  /** The destination the workspace is showing, for a label. */
  viewing(): string {
    return this.active ?? "";
  }

  /**
   * Decides which Realm the screen already is, once the host has a layout.
   *
   * A stored active Realm is adopted only when the live screen still looks like
   * that Realm's remembered arrangement. Otherwise the screen is left as
   * **Current workspace** and every Realm keeps its own memory: a workspace that
   * was rearranged between sessions must not be relabelled as a place it no
   * longer resembles, because travelling away from it would then overwrite that
   * place with a stranger's panes.
   */
  adopt(): void {
    if (this.adopted) return;
    this.adopted = true;

    const record = this.host.state();
    const stored = record.workspaces.activeContextId;
    if (stored === null) {
      this.active = null;
      return;
    }

    const snapshot = record.workspaces.snapshots[layoutKey(stored)];
    const current = this.snapshot();
    if (snapshot === undefined || current === null || !sameScreen(snapshot, current)) {
      this.active = null;
      return;
    }
    this.active = stored;
  }

  /**
   * Applies one stored screen exactly.
   *
   * This is what history restores: a remembered place, not the latest state of
   * the Realm it was in. It does *not* remember the departure first, because the
   * departure is already a stop in the history that asked for this.
   */
  async restoreSnapshot(snapshot: WorkspaceSnapshot, contextId: string | null): Promise<boolean> {
    if (this.travelling) {
      this.host.notify("A workspace change is still finishing; nothing was moved.");
      return false;
    }

    const api = this.host.layout();
    if (api === null) {
      this.host.notify("This host does not expose workspace layouts, so nothing was moved.");
      return false;
    }

    this.travelling = true;
    try {
      this.host.freezeDraft();
      const before = this.snapshot();
      const restored = await this.restore(api, snapshot);
      if (!restored.ok) {
        if (before !== null && !(await this.restore(api, before)).ok) {
          // Nothing is claimable any more: say what the screen is, not what it
          // was hoped to be.
          this.active = null;
          this.host.notify(
            "That place could not be restored, and neither could the previous workspace. The screen is unchanged."
          );
          return false;
        }
        this.host.notify("That place could not be restored. Your draft is safe.");
        return false;
      }

      this.update((workspaces) => ({ ...workspaces, activeContextId: contextId }));
      this.active = contextId;
      this.adopted = true;
      return true;
    } finally {
      this.travelling = false;
    }
  }

  /**
   * Retries the pane positions a restore could not apply yet.
   *
   * A pane the host creates after the layout is applied has nowhere to scroll
   * until it exists, so its position waits here instead of being applied to a
   * pane that is still showing something else. A newer restore supersedes the
   * waiting positions, because the screen they belonged to is no longer what is
   * being built.
   */
  flushPending(): void {
    if (this.pending.length === 0) return;

    const live = this.pending.filter((pane) => pane.generation === this.generation);
    this.pending = [];
    const views = markdownViews(this.host.app);
    const used = new Set<MarkdownView>();

    for (const pane of live) {
      const match = matchPane(views, pane, used);
      if (match === null) {
        this.pending.push(pane);
        continue;
      }
      used.add(match);
      if (pane.state === null || typeof match.setEphemeralState !== "function") continue;
      try {
        match.setEphemeralState(clone(pane.state));
      } catch {
        // A host that refuses one position refuses only that one.
      }
    }
  }

  /**
   * Remembers where this destination was left, without travelling.
   *
   * Called on departure, on hiding and on unload: a reading position changes
   * without a layout change, so a layout event alone would lose it.
   */
  remember(): void {
    // An unlabelled screen is not a destination: storing its layout would
    // overwrite a real destination's memory with something unrecognised.
    if (this.active === null) return;

    const snapshot = this.snapshot();
    if (snapshot === null) return;

    const key = layoutKey(this.active);
    this.update((workspaces) => ({
      ...workspaces,
      snapshots: { ...workspaces.snapshots, [key]: snapshot }
    }));
  }

  /**
   * Visits a destination: snapshot here, restore there, roll back on failure.
   *
   * The draft is frozen and stored before anything moves, so a visit can never
   * cost the writer a word. `false` means the screen is not showing the
   * destination — either because it could not be opened and the previous layout
   * was restored, or because even that failed and the actual screen was left
   * alone and reported as "Current workspace".
   */
  async visit(contextId: string): Promise<boolean> {
    if (this.travelling) {
      this.host.notify("A workspace change is still finishing; nothing was moved.");
      return false;
    }

    const context = this.host.contexts().find((candidate) => candidate.id === contextId);
    if (context === undefined) {
      this.host.notify(`There is no destination called ${JSON.stringify(contextId)}; nothing was moved.`);
      return false;
    }

    const api = this.host.layout();
    if (api === null) {
      this.host.notify("This host does not expose workspace layouts, so nothing was moved.");
      return false;
    }

    this.travelling = true;
    try {
      // Freeze and store before leaving: the draft belongs to the composer, not
      // to the layout, and its timing must not keep running while it is unseen.
      this.host.freezeDraft();
      this.remember();

      const before = this.snapshot();
      const record = this.host.state();
      const key = layoutKey(contextId);
      const stored = record.workspaces.snapshots[key];

      if (stored === undefined) {
        // First visit: today's note in this destination, on the layout that is
        // already on screen. The previous layout stays as its own return point.
        const opened = await this.openToday(context);
        if (!opened) {
          if (before !== null) await this.restore(api, before);
          this.host.notify(`Could not open ${context.name}. Your draft is safe.`);
          return false;
        }
        // The destination now has a screen of its own to come back to, so its
        // next visit restores a real arrangement instead of opening again.
        const initial = this.snapshot() ?? before;
        this.update((workspaces) => ({
          ...workspaces,
          activeContextId: contextId,
          ...(initial === null ? {} : { snapshots: { ...workspaces.snapshots, [key]: initial } })
        }));
        this.active = contextId;
        return true;
      }

      const restored = await this.restore(api, stored);
      if (!restored.ok) {
        if (before !== null && (await this.restore(api, before)).ok) {
          this.host.notify(`Could not open ${context.name}. Your draft is safe.`);
          return false;
        }
        // Even the rollback failed: leave the real screen alone and stop
        // claiming it is a destination.
        this.active = null;
        this.update((workspaces) => ({ ...workspaces, activeContextId: null }));
        this.host.notify(
          `Could not open ${context.name}, and the previous workspace could not be restored. The screen is unchanged.`
        );
        return false;
      }

      this.update((workspaces) => ({ ...workspaces, activeContextId: contextId }));
      this.active = contextId;
      if (restored.approximate) {
        this.host.notify(
          `Opened ${context.name}. Some panes had changed, so their positions are the host's own.`
        );
      }
      return true;
    } finally {
      this.travelling = false;
    }
  }

  /** The destination a snapshot belongs to, when the label must be honest. */
  label(): string {
    return this.active ?? "Current workspace";
  }

  /** The layout object plus every markdown pane's own state, cloned. */
  snapshot(): WorkspaceSnapshot | null {
    const api = this.host.layout();
    if (api === null) return null;

    const layout = clone(api.getLayout());
    const panes: PanePosition[] = [];
    const activeView = this.host.app.workspace.getActiveViewOfType(MarkdownView);
    let activePath: string | null = null;
    let activeLeafId: string | null = null;

    for (const leaf of this.host.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      const path = view.file?.path;
      if (path === undefined) continue;
      if (view === activeView) {
        activePath = path;
        activeLeafId = leafIdOf(leaf);
      }
      const state =
        typeof view.getEphemeralState === "function" ? clone(view.getEphemeralState()) : null;
      panes.push({
        path,
        state,
        leafId: leafIdOf(leaf),
        mode: view.getMode() === "preview" ? "preview" : "source"
      });
    }

    return { layout, panes, activePath, activeLeafId };
  }

  /**
   * Applies a snapshot: the layout first, then every pane's position.
   *
   * Positions are applied *after* the host has built its views, because a view
   * that does not exist yet cannot be scrolled. Each saved position goes to one
   * pane — its own leaf when the identity still matches, else the only pane
   * showing that file, else the one pane in the same mode — so two panes showing
   * one note never both inherit the same scroll. A position with no unambiguous
   * pane is left pending rather than applied to a guess.
   */
  private async restore(
    api: LayoutApi,
    snapshot: WorkspaceSnapshot
  ): Promise<{ ok: boolean; approximate: boolean }> {
    try {
      await api.applyLayout(clone(snapshot.layout));
    } catch {
      return { ok: false, approximate: false };
    }

    const generation = ++this.generation;
    this.pending = [];

    let approximate = false;
    const views = markdownViews(this.host.app);
    const used = new Set<MarkdownView>();

    for (const pane of snapshot.panes) {
      const match = matchPane(views, pane, used);
      if (match === null) {
        this.pending.push({ ...pane, generation });
        approximate = true;
        continue;
      }
      used.add(match);
      if (typeof match.setEphemeralState !== "function" || pane.state === null) {
        approximate = true;
        continue;
      }
      try {
        match.setEphemeralState(clone(pane.state));
      } catch {
        approximate = true;
      }
    }

    this.focusActiveLeaf(snapshot, views);

    return { ok: true, approximate };
  }

  /**
   * Puts focus on the pane that was active, when it can still be found.
   *
   * The active pane is part of the place: returning to a Realm and landing in a
   * different pane of the same layout is not the same screen.
   */
  private focusActiveLeaf(snapshot: WorkspaceSnapshot, views: readonly MarkdownView[]): void {
    const workspace = this.host.app.workspace as unknown as {
      setActiveLeaf?: (leaf: unknown, options?: { focus?: boolean }) => void;
    };
    if (typeof workspace.setActiveLeaf !== "function") return;

    const leaves = this.host.app.workspace.getLeavesOfType("markdown");
    const target =
      (snapshot.activeLeafId === null
        ? undefined
        : leaves.find((leaf) => leafIdOf(leaf) === snapshot.activeLeafId)) ??
      (snapshot.activePath === null
        ? undefined
        : leaves.find((leaf) => {
            const view = leaf.view;
            return view instanceof MarkdownView && view.file?.path === snapshot.activePath;
          })) ??
      leaves.find((leaf) => views.includes(leaf.view as MarkdownView));

    if (target === undefined) return;
    try {
      workspace.setActiveLeaf(target, { focus: false });
    } catch {
      // A host that refuses the activation still shows every pane it built.
    }
  }

  /** Opens a destination's note for today, creating it: a visit is explicit. */
  private async openToday(context: WeavingContext): Promise<boolean> {
    const path = contextDayPath(context, dayKey(new Date()));
    return this.host.openNote(path);
  }

  /**
   * Applies a workspace-only change to the latest stored record.
   *
   * Only the `workspaces` slice is ever written here, and it is applied to the
   * record read at the moment of the write, so a schedule acknowledgement or a
   * Loom field written during an awaited travel survives this save.
   */
  private update(apply: (workspaces: LocalStateRecord["workspaces"]) => LocalStateRecord["workspaces"]): void {
    try {
      this.host.save((current) => ({ ...current, workspaces: apply(current.workspaces) }));
    } catch {
      // A layout that could not be stored costs the next visit its position,
      // never the writer's words.
    }
  }
}

/** Every live markdown view, in workspace order. */
function markdownViews(app: App): MarkdownView[] {
  const views: MarkdownView[] = [];
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    if (leaf.view instanceof MarkdownView) views.push(leaf.view);
  }
  return views;
}

/** One saved pane, and the restore that is still waiting to apply it. */
interface PendingPane extends PanePosition {
  generation: number;
}

/** A host leaf's own id, when the host gives it one. */
function leafIdOf(leaf: unknown): string | null {
  if (leaf === null || typeof leaf !== "object") return null;
  const id = Reflect.get(leaf, "id");
  return typeof id === "string" && id !== "" ? id : null;
}

/** The view a pane is in, narrowed to the two modes a saved position distinguishes. */
function modeOf(view: MarkdownView): "source" | "preview" {
  return view.getMode() === "preview" ? "preview" : "source";
}

/**
 * The one pane a saved position belongs to, or null when it cannot be told.
 *
 * Identity first, because two panes may show one file and only the leaf says
 * which is which. Then the path, when exactly one free pane shows it. Then the
 * mode, which distinguishes a reading pane from an editing one. Nothing else is
 * guessed: an ambiguous position is left pending.
 */
function matchPane(
  views: readonly MarkdownView[],
  pane: PanePosition,
  used: ReadonlySet<MarkdownView>
): MarkdownView | null {
  const free = views.filter((view) => !used.has(view));

  if (pane.leafId !== null) {
    const byLeaf = free.filter((view) => {
      if (view.file?.path !== pane.path) return false;
      const leaf = (view as unknown as { leaf?: unknown }).leaf;
      return leafIdOf(leaf) === pane.leafId;
    });
    if (byLeaf.length === 1) return byLeaf[0] ?? null;
  }

  const byPath = free.filter((view) => view.file?.path === pane.path);
  if (byPath.length === 1) return byPath[0] ?? null;
  if (byPath.length === 0) return null;

  const byMode = byPath.filter((view) => modeOf(view) === pane.mode);
  return byMode.length === 1 ? (byMode[0] ?? null) : null;
}

/**
 * Whether two snapshots describe the same screen, for deciding ownership.
 *
 * Caret, scroll and the opaque layout object are excluded on purpose: a session
 * that ended with the writer three lines lower is still the same place, and the
 * layout is a host object this module never inspects.
 */
function sameScreen(left: WorkspaceSnapshot, right: WorkspaceSnapshot): boolean {
  if (left.activePath !== right.activePath) return false;
  if (left.panes.length !== right.panes.length) return false;
  return left.panes.every((pane, at) => {
    const other = right.panes[at];
    return other !== undefined && other.path === pane.path && other.mode === pane.mode;
  });
}

/** A structural clone, so a host object is never kept by reference. */
function clone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}
