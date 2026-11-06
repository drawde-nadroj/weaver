/**
 * Pending portals in Live Preview: one block tray at the end of today's note.
 *
 * The tray is a block widget supplied by a `StateField`, because a plugin cannot
 * provide block decorations of its own. It sits after every recorded entry, so
 * ordinary writing naturally pushes it down, and on a genuinely empty note it is
 * still drawn — a portal is not an entry and does not need one to exist. Source
 * mode stays raw text: the field yields nothing when Live Preview is off.
 *
 * The tray's *existence* is state; its *contents* are not. The widget compares
 * equal to itself for as long as it exists, so a document change, a second write,
 * a countdown, or another portal's expiry never rebuilds the element under the
 * writer's hands. Which portals are shown inside it is reconciled directly from
 * the controller, and each face is a `PortalSurface`: the same DOM builder the
 * Reading view mounts.
 *
 * Seconds never travel through CodeMirror. The tray subscribes once to the
 * plugin's shared `EntryClock`, paints each face's labels in place, and dispatches
 * only when the controller reports a lifecycle change — a portal appearing,
 * opening, being prepared, or going away. The controller is the only source of
 * truth for candidates and the hold; this layer never schedules, never writes, and
 * never reads a file.
 *
 * Focus is deliberate. A control gesture or `focusPortal` prepares the hold and
 * moves focus into the one prepared receptacle; nothing here focuses by itself.
 * Escape releases the hold and returns focus to where it was, or to the editor
 * when that target is gone.
 */

import { editorInfoField, editorLivePreviewField } from "obsidian";
import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate
} from "@codemirror/view";

import { portalPhase, type PortalInstant } from "../core/portals";
import type { EntryClock } from "../entries/clock";
import type { PortalController } from "../entries/portals";
import type { WeaverSettings } from "../settings";
import { remeasureFrames } from "./entry-frame";
import {
  mountPortalSurface,
  PORTAL_REFUSAL,
  portalTrayElement,
  type PortalSurface
} from "../ui/portal";

/** Everything the tray may ask the plugin: the schedule, the clock, and the writer. */
export interface PortalWidgetHost {
  /** Which openings are showing and which one is prepared. */
  controller: PortalController;
  /** The one clock every drawn second comes from. */
  clock: EntryClock;
  /** Live settings: the toggle and whether frames may animate. */
  settings(): WeaverSettings;
  /** Hands the first text to the engine; `false` keeps it in the receptacle. */
  capture(view: EditorView, id: string, text: string, at: number): boolean;
  /** The engine's reason for a refused capture, when it has one. */
  lastFailure?(id: string): string | null;
}

/** Asks the state field to re-derive the tray (its candidate set) from the controller. */
const refreshPortals = StateEffect.define<void>();

/** The tray owns the writing faces of one editor view. */
const trays = new WeakMap<EditorView, PortalTray>();
/** The tray that built a given element, so `destroy(dom)` can clean it up. */
const trayOwners = new WeakMap<HTMLElement, PortalTray>();

/** The note this state belongs to, or null when no file is attached yet. */
function pathOf(state: EditorState): string | null {
  const info = state.field(editorInfoField, false);
  return info?.file?.path ?? null;
}

/** A block widget in the document flow whose DOM is never rebuilt while it exists. */
class PortalTrayWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const tray = portalTrayElement();
    trays.get(view)?.attach(tray);
    return tray;
  }

  destroy(dom: HTMLElement): void {
    trayOwners.get(dom)?.detach(dom);
  }
}

/**
 * The per-view writing tray.
 *
 * Exported because the extension is a thin composition of it: tests and the
 * field share one object, so there is no second implementation of the surface
 * lifecycle to drift.
 */
export class PortalTray {
  private tray: HTMLElement | null = null;
  private readonly surfaces = new Map<string, PortalSurface>();
  /**
   * Text a refused handoff kept, by portal id.
   *
   * A surface owns the visible receptacle, but the tray outlives any single
   * element: if the widget's DOM is replaced in the same tick as a failed
   * capture, the words must still be there, and the retry must be the whole
   * recovered text rather than the next keystroke.
   */
  private readonly recovered = new Map<string, { text: string; message: string }>();
  private readonly stopController: () => void;
  /**
   * The shared clock's unsubscribe, present only while a face is mounted.
   *
   * A source-mode, historical, or candidate-less view has nothing to paint, so
   * it must not keep the stopwatch clock ticking for its own sake.
   */
  private clockStop: (() => void) | null = null;
  /** Where Escape should return to; captured once per preparation. */
  private focusBefore: { target: HTMLElement | null } | null = null;
  private refreshQueued = false;
  private pendingFocus: string | null = null;
  private capturing = false;
  /**
   * True while the engine is writing the captured entry; focus belongs to the
   * prose it is about to place, so a removal during the handoff must not pull it
   * back to this tray.
   */
  private handingOff = false;
  private destroyed = false;

  constructor(
    private readonly view: EditorView,
    private readonly host: PortalWidgetHost
  ) {
    trays.set(view, this);
    this.stopController = host.controller.subscribe(() => this.requestReconcile());
  }

  /** Called by the widget once its element is in the document. */
  attach(tray: HTMLElement): void {
    if (this.destroyed) return;
    this.tray = tray;
    trayOwners.set(tray, this);
    this.reconcile();
    this.applyPendingFocus();
    // The frames may have measured before this widget existed: a block widget
    // mounts after the note's own layout. One re-measure puts the tray on the
    // root entry's frame; nothing per-second ever asks again, because a clock
    // tick is not geometry.
    remeasureFrames(this.view);
  }

  /** Called when the block widget is removed, e.g. on switching to source mode. */
  detach(tray: HTMLElement): void {
    if (this.tray !== tray) return;
    // Turning portals off removes the tray under the writer's cursor; that is
    // the one removal that must hand focus back. A mode switch or a departing
    // leaf is not a reason to move the caret.
    if (!this.host.settings().portalsEnabled) this.releaseFocusedSurface();
    trayOwners.delete(tray);
    this.clearSurfaces();
    this.syncClock();
    this.tray = null;
  }

  /** A document change can change eligibility (history) without a controller emission. */
  update(update: ViewUpdate): void {
    if (this.destroyed) return;
    const lifecycle = update.transactions.some((transaction) =>
      transaction.effects.some((effect) => effect.is(refreshPortals))
    );
    if (lifecycle || update.docChanged) this.reconcile();
  }

  /** Detaches from the controller and the clock; the view is going away. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopController();
    this.clearSurfaces();
    this.syncClock();
    if (this.tray !== null) trayOwners.delete(this.tray);
    this.tray = null;
    trays.delete(this.view);
  }

  /**
   * Prepares a portal and focuses its waiting receptacle.
   *
   * The call is deliberate — a control gesture or an explicit `focusPortal` —
   * never a consequence of time passing. A portal that is not currently in the
   * tray is remembered and focused once it appears (a switch to Live Preview
   * mounts the tray a moment later), and `false` still reports that nothing was
   * focused yet.
   */
  focus(id: string): boolean {
    if (this.destroyed) return false;
    const surface = this.surfaces.get(id);
    if (surface === undefined) {
      this.pendingFocus = id;
      return false;
    }

    if (this.host.controller.held()?.portal.id !== id) {
      this.rememberFocus();
      this.host.controller.prepare(id);
    }

    const prepared = this.host.controller.held()?.portal.id === id;
    this.paint(surface, prepared, this.host.controller.now());
    if (!prepared) return false;

    surface.setPrepared(true, true);
    this.pendingFocus = null;
    return true;
  }

  /** Re-derives the faces from the controller's candidates, without rebuilding the tray. */
  reconcile(): void {
    const tray = this.tray;
    if (tray === null || this.destroyed) return;

    const path = pathOf(this.view.state);
    if (path === null) {
      this.clearSurfaces();
      this.syncClock();
      return;
    }

    const candidates = this.host.controller.candidates(path, this.view.state.doc.toString());
    const wanted = new Set(candidates.map((portal) => portal.id));

    for (const [id, surface] of [...this.surfaces]) {
      if (wanted.has(id)) continue;
      this.focusReturnIfInside(surface);
      surface.destroy();
      this.surfaces.delete(id);
      this.recovered.delete(id);
    }

    for (const portal of candidates) {
      if (this.surfaces.has(portal.id)) continue;
      const surface = mountPortalSurface(tray, this.surfaceOptions(portal));
      const kept = this.recovered.get(portal.id);
      if (kept !== undefined) surface.recover(kept.text, kept.message);
      this.surfaces.set(portal.id, surface);
    }

    const now = this.host.controller.now();
    const held = this.host.controller.held();
    for (const [id, surface] of this.surfaces) {
      this.paint(surface, held?.portal.id === id, now);
    }

    this.syncClock();
    this.applyPendingFocus();
  }

  /**
   * Joins or leaves the shared clock with the tray's contents.
   *
   * The tray subscribes only once a face exists and unsubscribes the moment the
   * last one is gone, so no editor keeps a second-by-second timer for a tray it
   * is not drawing.
   */
  private syncClock(): void {
    if (this.destroyed || this.surfaces.size === 0) {
      const stop = this.clockStop;
      this.clockStop = null;
      if (stop !== null) stop();
      return;
    }
    if (this.clockStop !== null) return;
    this.clockStop = this.host.clock.subscribe((now) => this.tick(now));
  }

  /** One clock sample: every face repaints its own labels; nothing else happens. */
  private tick(now: number): void {
    if (this.destroyed) return;
    const held = this.host.controller.held();
    for (const [id, surface] of this.surfaces) {
      this.paint(surface, held?.portal.id === id, now);
    }
  }

  /** Keeps the DOM and the hold in step without rebuilding the face. */
  private paint(surface: PortalSurface, prepared: boolean, now: number): void {
    if (surface.isPrepared !== prepared) surface.setPrepared(prepared);
    surface.refresh(now, prepared);
  }

  private surfaceOptions(portal: PortalInstant) {
    return {
      portal,
      mode: "write" as const,
      prepare: () => {
        this.focus(portal.id);
      },
      release: () => {
        this.release(portal.id);
      },
      capture: (text: string, at: number) => this.capture(portal, text, at),
      now: () => this.host.controller.now(),
      effectful: this.host.settings().entryFrames !== false,
      failure: () => this.host.lastFailure?.(portal.id) ?? undefined,
      focused: () => this.rememberFocus()
    };
  }

  /**
   * Hands focus back when the focused receptacle itself is being removed.
   *
   * Only a removal that takes the writer's focus is a reason to move it: an
   * unrelated portal expiring, a hidden app, or the engine consuming the text
   * (which already focused the prose) must leave focus alone.
   */
  private focusReturnIfInside(surface: PortalSurface): void {
    if (this.handingOff || this.focusBefore === null) return;
    const active = document.activeElement;
    if (active === null || !surface.root.contains(active)) return;
    this.restoreFocus();
  }

  /** Returns focus if any mounted face currently owns it. */
  private releaseFocusedSurface(): void {
    if (this.handingOff || this.focusBefore === null) return;
    const active = document.activeElement;
    if (active === null) return;
    for (const surface of this.surfaces.values()) {
      if (!surface.root.contains(active)) continue;
      this.restoreFocus();
      return;
    }
  }

  /** Escape (or an explicit release): drop the hold and return focus. */
  private release(id: string): void {
    this.host.controller.release();
    const surface = this.surfaces.get(id);
    if (surface !== undefined) surface.setPrepared(false);
    this.restoreFocus();
  }

  /** The synchronous handoff: text in, one engine capture out. */
  private capture(portal: PortalInstant, text: string, at: number): boolean {
    if (this.capturing) return false;

    const held = this.host.controller.held()?.portal.id === portal.id;
    const phase = portalPhase(portal, at, held);
    if (phase !== "open" && phase !== "held") return false;

    this.capturing = true;
    this.handingOff = true;
    try {
      let accepted = false;
      try {
        accepted = this.host.capture(this.view, portal.id, text, at);
      } catch {
        // A thrown write is a refusal with a cause, not a lost keystroke.
        accepted = false;
      }

      if (!accepted) {
        // The surface keeps the text; the tray keeps it too, across adoption.
        this.recovered.set(portal.id, {
          text,
          message: this.host.lastFailure?.(portal.id) ?? PORTAL_REFUSAL
        });
        return false;
      }

      this.recovered.delete(portal.id);
      this.host.controller.consume(portal.id);
      this.focusBefore = null;
      return true;
    } finally {
      this.capturing = false;
      this.handingOff = false;
    }
  }

  private rememberFocus(): void {
    if (this.focusBefore !== null) return;
    const active = document.activeElement;
    this.focusBefore = { target: active instanceof HTMLElement ? active : null };
  }

  /** Returns to the connected prior target, else to the editor's own caret. */
  private restoreFocus(): void {
    const memory = this.focusBefore;
    this.focusBefore = null;
    const dom = this.view.dom;
    if (dom && dom.isConnected === false) return;
    const target = memory === null ? null : memory.target;
    if (
      target !== null &&
      target !== document.body &&
      target !== this.view.contentDOM &&
      target.isConnected === true &&
      !this.view.dom.contains(target)
    ) {
      target.focus();
      return;
    }
    this.view.focus();
  }

  private applyPendingFocus(): void {
    const id = this.pendingFocus;
    if (id === null) return;
    if (!this.surfaces.has(id)) return;
    this.pendingFocus = null;
    this.focus(id);
  }

  private clearSurfaces(): void {
    for (const surface of this.surfaces.values()) surface.destroy();
    this.surfaces.clear();
  }

  /**
   * Asks the field to re-derive the tray from a lifecycle change.
   *
   * Deferred a microtask so a controller emission that happens inside the
   * engine's own dispatch can never dispatch a second transaction mid-update.
   * Repeated emissions in one turn coalesce into one refresh.
   */
  private requestReconcile(): void {
    if (this.destroyed || this.refreshQueued) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      if (this.destroyed) return;
      this.view.dispatch({ effects: refreshPortals.of() });
    });
  }
}

/** The block tray for Live Preview: the field, its decorations, and its tray. */
export function portalExtension(host: PortalWidgetHost): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => trayDecorations(host, state),
    update: (value, transaction) => {
      const live = transaction.state.field(editorLivePreviewField, false) !== false;
      const wasLive = transaction.startState.field(editorLivePreviewField, false) !== false;
      const lifecycle = transaction.effects.some((effect) => effect.is(refreshPortals));
      if (!transaction.docChanged && !lifecycle && live === wasLive) return value;
      return trayDecorations(host, transaction.state);
    }
  });

  const plugin = ViewPlugin.fromClass(
    class {
      private readonly tray: PortalTray;

      constructor(view: EditorView) {
        this.tray = new PortalTray(view, host);
      }

      update(update: ViewUpdate): void {
        this.tray.update(update);
      }

      destroy(): void {
        this.tray.destroy();
      }
    }
  );

  return [field, EditorView.decorations.from(field), plugin];
}

/**
 * Prepares an already-rendered portal and focuses its receptacle.
 *
 * This is the one entry point for other surfaces: Reading and the navigator
 * switch the leaf and then ask here, so the focus and the DOM are the Live
 * Preview tray's own. Never called by time passing.
 */
export function focusPortal(view: EditorView, id: string): boolean {
  return trays.get(view)?.focus(id) ?? false;
}

/**
 * The tray's block position: after every entry, including on an empty note.
 *
 * Exported as the field's pure half, so the Live Preview / source-mode rule and
 * the empty-note case are checked without mounting an editor.
 */
export function trayDecorations(host: PortalWidgetHost, state: EditorState): DecorationSet {
  if (state.field(editorLivePreviewField, false) === false) return Decoration.none;
  if (!host.settings().portalsEnabled) return Decoration.none;

  const path = pathOf(state);
  if (path === null) return Decoration.none;
  if (host.controller.candidates(path, state.doc.toString()).length === 0) return Decoration.none;

  const widget = new PortalTrayWidget();
  return Decoration.set([
    Decoration.widget({ widget, side: 1, block: true }).range(state.doc.length)
  ]);
}
