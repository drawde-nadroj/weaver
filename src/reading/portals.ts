/**
 * Portals in Reading view: one tray at the end of each daily note that is open,
 * drawn from the same surface the editor uses.
 *
 * Reading is a read-only view of a note, so the tray never writes: it shows the
 * same pending portal frames the Live Preview shows, and its Prepare action
 * switches the *same* leaf to Live Preview and focuses the same portal id. That
 * is deliberate — one writing implementation, one set of keyboard and IME
 * behaviours — rather than a second editor living inside the reading surface.
 *
 * The tray is a lifecycle component of the view, not of a paragraph: it is
 * attached once per whole daily-note view and appended after everything the
 * Markdown renderer produced, so it appears whether the note has zero entries
 * or many, and never twice because a post processor ran twice. Source text is
 * read from the vault, never written, and an asynchronous read that loses its
 * view or is replaced by a newer one is discarded rather than applied.
 *
 * Seconds come from the plugin's one shared `EntryClock`: this component owns no
 * timer of its own. A preview re-render can discard an appended tray without any
 * workspace event, so each mounted tray watches its own view for detachment and
 * rebuilds itself — the view is the authority, not a clock tick.
 */

import { MarkdownView, TFile } from "obsidian";

import type { PortalInstant } from "../core/portals";
import type WeaverPlugin from "../main";
import { mountPortalSurface, mountPortalTray, type PortalSurface } from "../ui/portal";

/** A surface and the portal it draws, kept together for the shared clock's paint. */
interface MountedSurface {
  portal: PortalInstant;
  surface: PortalSurface;
}

/** One open preview view's tray, with the surfaces currently inside it. */
interface TrayRecord {
  view: MarkdownView;
  container: HTMLElement;
  tray: HTMLElement;
  mounted: MountedSurface[];
  /** Watches this view's root for a re-render that discarded the tray. */
  observer: MutationObserver | null;
}

/** Keeps the tray in the rendered text column, not the full preview pane. */
function trayContainer(view: MarkdownView): HTMLElement {
  const preview = view.previewMode as unknown as { containerEl?: HTMLElement };
  const root = preview.containerEl ?? view.contentEl;
  return root.querySelector<HTMLElement>(".markdown-preview-sizer") ?? root;
}

/**
 * Owns every Reading-view portal tray for the plugin's life.
 *
 * `start` wires the signals a tray depends on — the portal lifecycle, the note's
 * text, and the set of visible views; each mounted tray joins the plugin's one
 * clock, and `destroy` removes every tray, so a view replacement or an unload
 * leaves no orphaned subscription or DOM.
 */
export class PortalReadingTray {
  private readonly records = new Map<MarkdownView, TrayRecord>();
  private stopController: (() => void) | null = null;
  private stopClock: (() => void) | null = null;
  private token = 0;
  private started = false;
  /** One coalesced re-read per turn, however many mutations a re-render makes. */
  private resyncQueued = false;

  constructor(private readonly plugin: WeaverPlugin) {}

  /** Attaches the subscriptions and draws the trays that exist right now. */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.stopController = this.plugin.portals.subscribe(() => this.sync());
    this.plugin.registerEvent(this.plugin.app.workspace.on("layout-change", () => this.sync()));
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("active-leaf-change", () => this.sync())
    );
    this.plugin.registerEvent(this.plugin.app.vault.on("modify", () => this.sync()));

    // The clock is subscribed only while a tray exists: a Reading view with no
    // pending portal must not keep the shared timer alive, and the same clock
    // the stopwatch rows paint from is the one that paints these countdowns.
    this.sync();
  }

  /** Removes every tray and every subscription this component owns. */
  destroy(): void {
    if (!this.started) return;
    this.started = false;
    this.token += 1;

    this.stopController?.();
    this.stopController = null;
    this.stopClock?.();
    this.stopClock = null;

    for (const view of [...this.records.keys()]) this.remove(view);
  }

  /** Rebuilds every tray's surfaces after a setting that changes their look. */
  settingsChanged(): void {
    for (const record of this.records.values()) {
      for (const { surface } of record.mounted) surface.destroy();
      record.mounted = [];
    }
    this.sync();
  }

  /** Re-reads every open preview view and re-renders its tray. */
  private sync(): void {
    if (!this.started) return;
    this.token += 1;
    const token = this.token;

    const live = new Set<MarkdownView>();
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      const file = view.file;
      // The controller resolves today's configured path and any pinned note.
      // A filename spelling is not evidence that this is (or is not) today's note.
      if (file === null || this.plugin.portals.candidates(file.path, "").length === 0) continue;
      if (view.getMode() !== "preview") continue;

      live.add(view);
      void this.render(view, file.path, token);
    }

    // A view that switched to source mode, closed, or was replaced keeps no
    // tray: its DOM is gone with it, and its subscriptions must go too.
    for (const view of [...this.records.keys()]) {
      if (!live.has(view)) this.remove(view);
    }
  }

  /** Coalesces a detachment signal into one re-read per turn. */
  private queueSync(): void {
    if (this.resyncQueued || !this.started) return;
    this.resyncQueued = true;
    queueMicrotask(() => {
      this.resyncQueued = false;
      this.sync();
    });
  }

  /** Reads one note's text read-only and draws the tray its candidates earn. */
  private async render(view: MarkdownView, path: string, token: number): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    let source: string;
    try {
      source = await this.plugin.app.vault.cachedRead(file);
    } catch {
      return;
    }
    // A newer sync, a closed view, or a replaced container wins: this read is
    // stale and must not overwrite what is on screen now.
    if (token !== this.token || !this.started) return;
    const container = trayContainer(view);
    if (view.getMode() !== "preview" || view.file?.path !== path) return;

    const candidates = this.plugin.portals.candidates(path, source);
    if (candidates.length === 0) {
      this.remove(view);
      return;
    }

    let record = this.records.get(view) ?? null;
    const detached =
      record !== null &&
      (record.container !== container || record.tray.parentElement !== container);
    if (detached) {
      // A new preview root, or a re-render that discarded the appended tray:
      // the old DOM is gone, so its surfaces go with it and a fresh tray is
      // appended after the renderer's new output.
      this.remove(view);
      record = null;
    }

    if (record === null) {
      record = {
        view,
        container,
        tray: mountPortalTray(container),
        mounted: [],
        observer: null
      };
      this.records.set(view, record);
      this.observe(record);
      this.ensureClock();
    }

    // The tray is the stable thing; only its contents are diffed. Surfaces that
    // still stand for a candidate are kept as they are, so a candidate set
    // change never re-creates the labels the reader is looking at.
    const tray = record;
    const previous = new Map(tray.mounted.map((each) => [each.portal.id, each]));
    const next: MountedSurface[] = [];
    for (const portal of candidates) {
      const found = previous.get(portal.id);
      if (found !== undefined) {
        previous.delete(portal.id);
        next.push(found);
      } else {
        next.push(this.mount(tray, portal));
      }
    }
    for (const { surface } of previous.values()) surface.destroy();
    tray.mounted = next;

    // Candidates are chronological; re-append in that order so a surface added
    // ahead of an existing one does not sit after it. Moving a node is not a
    // re-mount, and the detachment watcher ignores it.
    for (const { surface } of tray.mounted) tray.tray.appendChild(surface.root);

    this.refreshRecord(tray, this.plugin.portals.now());
  }

  /**
   * Watches the view's own root for a re-render that threw the tray away.
   *
   * Obsidian can replace a preview's contents without a workspace event, so the
   * component cannot rely on `layout-change` alone: a discarded tray is detected
   * from the DOM that discarded it, and the view is re-read once per turn.
   */
  private observe(record: TrayRecord): void {
    if (typeof MutationObserver !== "function") return;
    const view = record.view;
    const observer = new MutationObserver(() => {
      if (this.records.get(view) !== record) return;
      const container = trayContainer(view);
      if (record.container !== container || record.tray.parentElement !== container) {
        this.queueSync();
      }
    });
    observer.observe(view.contentEl, { childList: true, subtree: true });
    record.observer = observer;
  }

  /** One surface in reading mode: no receptacle, and a Prepare button only. */
  private mount(record: TrayRecord, portal: PortalInstant): MountedSurface {
    return {
      portal,
      surface: mountPortalSurface(record.tray, {
        portal,
        mode: "reading",
        prepare: () => void this.plugin.preparePortal(portal.id, record.view),
        release: () => this.plugin.portals.release(),
        now: () => this.plugin.portals.now(),
        effectful: this.plugin.settings.entryFrames
      })
    };
  }

  /**
   * Paints every mounted surface at the shared clock's sample.
   *
   * One sample per wall second, from the plugin's clock, never an interval of
   * this component's own.
   */
  private refreshAll(now: number): void {
    if (!this.started) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    for (const record of [...this.records.values()]) this.refreshRecord(record, now);
  }

  /** Joins the shared tick for as long as at least one tray is mounted. */
  private ensureClock(): void {
    if (this.stopClock !== null) return;
    this.stopClock = this.plugin.clock.subscribe((now) => this.refreshAll(now));
  }

  /** Leaves the shared tick when the last tray goes away. */
  private stopClockIfIdle(): void {
    if (this.records.size > 0) return;
    this.stopClock?.();
    this.stopClock = null;
  }

  private refreshRecord(record: TrayRecord, now: number): void {
    const held = this.plugin.portals.held()?.portal.id ?? null;
    for (const { portal, surface } of record.mounted) {
      surface.refresh(now, held === portal.id);
    }
  }

  private remove(view: MarkdownView): void {
    const record = this.records.get(view);
    if (record === undefined) return;
    record.observer?.disconnect();
    for (const { surface } of record.mounted) surface.destroy();
    record.tray.remove();
    this.records.delete(view);
    this.stopClockIfIdle();
  }
}
