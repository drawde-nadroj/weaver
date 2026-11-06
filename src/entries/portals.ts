/**
 * Portal lifecycle: which openings are showing now, which one is prepared, and
 * which have already been entered in this plugin session.
 *
 * The controller is a pure derivation of an injected clock plus the note's own
 * history — it never writes, never touches the editor, and never reads a file.
 * Everything it knows about a note arrives with a `source` string, so a caller
 * can only be shown a portal that the note's readable history has no record of.
 * A note whose history cannot be read still shows its openings: the refusal
 * belongs to the capture, which can keep the writer's text.
 *
 * Status is always recomputed from the actual instant, never accumulated from
 * timer callbacks: a delayed timeout, a backwards clock correction, or a laptop
 * waking after noon must all produce the same answer as a fresh derivation. The
 * one timer it keeps is a minute-boundary wakeup, because that is the only
 * instant at which the eleven-minute window can gain or lose a candidate.
 */

import { readAlignments } from "../core/alignments";
import { portalInstants, portalPhase, type PortalInstant } from "../core/portals";

/** Leading notice time: a portal is visible and preparable eleven minutes early. */
const LEAD_MS = 660_000;
/** Openings are minute-aligned, so eligibility only changes on a minute boundary. */
const MINUTE_MS = 60_000;
/** Wake a hair past the boundary so the new minute is already the current one. */
const WAKE_SLACK_MS = 20;

/**
 * Everything the controller may know about the world outside itself.
 *
 * Injected rather than imported so a test can move time without changing the
 * system clock, and so the plugin's main module stays the only owner of vault
 * and workspace access. `todayPath` answers with the path the day note *would*
 * have, whether or not it exists yet: a passive schedule must never create it.
 */
export interface PortalHost {
  /** The current wall-clock instant, in epoch milliseconds. */
  now(): number;
  /** Whether portals are switched on in settings right now. */
  enabled(): boolean;
  /** The day note path a new portal belongs to at `at`, existing or not. */
  todayPath(at: number): string;
  /** The note currently being edited, or null when no editable note is active. */
  activePath(): string | null;
  /** Whether the app and its document are visible enough to speak. */
  visible(): boolean;
  /** Announce one opening, at most once per reconcile, with its true remaining time. */
  invite(portal: PortalInstant, remainingSeconds: number): void;
}

/** A portal's relationship to now; `held` survives the opening's own minute. */
export type PortalStatus = "approaching" | "open" | "held" | "expired";

/** The one prepared portal, pinned to the note that was showing it. */
export interface PortalHold {
  readonly portal: PortalInstant;
  /** The note the hold belongs to, so midnight does not move it. */
  readonly path: string;
}

/**
 * Owns the held portal, the session's entered set, and the announced set.
 *
 * Announcements are remembered for the lifetime of this instance, which is
 * exactly what keeps a backwards clock correction from speaking twice about the
 * same opening. A portal recorded in the note — or entered once already — never
 * becomes a candidate again, so a capture cannot be repeated.
 */
export class PortalController {
  private hold: PortalHold | null = null;
  private readonly heard = new Set<string>();
  private readonly used = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private timer: number | null = null;
  private lastShape = "";
  private destroyed = false;

  constructor(private readonly host: PortalHost) {}

  /** The controller's view of the current instant. */
  now(): number {
    return this.host.now();
  }

  /**
   * The portal openings this note should show, earliest first.
   *
   * A note is eligible for pending frames only when it is today's day note or
   * the note a portal is currently held in. History is consulted only when it
   * can be read: a note whose history is malformed is still shown the openings
   * it would otherwise have, because the refusal belongs to the capture, which
   * preserves recoverable text. Rendering an invitation never grants permission
   * to write over unreadable history.
   */
  candidates(path: string, source: string): PortalInstant[] {
    if (this.destroyed || !this.host.enabled()) return [];

    const now = this.host.now();
    const today = this.host.todayPath(now);
    const hold = this.hold;
    if (path !== today && (hold === null || hold.path !== path)) return [];

    const taken = new Set<string>(this.used);
    const history = readAlignments(source);
    if (history.ok) for (const record of history.records) taken.add(record.portal);

    const result = new Map<string, PortalInstant>();
    if (path === today) {
      for (const portal of this.eligible(now)) {
        if (!taken.has(portal.id)) result.set(portal.id, portal);
      }
    }
    // A held portal outlives its minute, so it is not in the boundary window.
    if (hold !== null && hold.path === path && !taken.has(hold.portal.id)) {
      result.set(hold.portal.id, hold.portal);
    }

    return [...result.values()].sort((left, right) => left.opensAt - right.opensAt);
  }

  /** The portal's phase, with the hold extending only an already-open minute. */
  phase(portal: PortalInstant): PortalStatus {
    return portalPhase(portal, this.host.now(), this.hold?.portal.id === portal.id);
  }

  /** The prepared portal and the note it was prepared in, if any. */
  held(): PortalHold | null {
    return this.hold;
  }

  /**
   * Deliberately prepares a portal, pinning it to the note that showed it.
   *
   * Nothing is prepared by itself: an announcement, an ordinary running
   * stopwatch, or an expiring neighbour never moves the hold. Preparing another
   * opening releases the previous one in the same emission.
   */
  prepare(id: string): void {
    if (this.destroyed || !this.host.enabled() || this.used.has(id)) return;
    if (this.hold?.portal.id === id) return;

    const portal = this.find(id);
    if (portal === null) return;

    const now = this.host.now();
    const today = this.host.todayPath(now);
    const active = this.host.activePath();
    // A portal is only ever offered in today's note or the note already holding
    // one, so the hold stays with that note; an unrelated active leaf must not
    // move it out from under the frame the writer just clicked.
    const path = active !== null && active === this.hold?.path ? active : today;
    this.hold = { portal, path };
    this.commit();
    this.schedule();
  }

  /** Gives up the prepared portal; it is removed at once if its minute is over. */
  release(): void {
    if (this.destroyed || this.hold === null) return;
    this.hold = null;
    this.commit();
    this.schedule();
  }

  /**
   * Records that this portal's entry exists, so it cannot be entered twice.
   *
   * The note's own history is the durable half of the same fact; this set only
   * covers the window before the write is re-read.
   */
  consume(id: string): void {
    if (this.destroyed) return;
    const fresh = !this.used.has(id);
    this.used.add(id);
    const clearing = this.hold?.portal.id === id;
    if (clearing) this.hold = null;
    if (fresh || clearing) {
      this.commit();
      this.schedule();
    }
  }

  /** Notifies on lifecycle changes only — never on elapsed seconds. */
  subscribe(listener: () => void): () => void {
    if (this.destroyed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Re-derives everything from the actual instant.
   *
   * This is the only entry point for wakeups, reloads, visibility restoration
   * and settings changes, so a missed or early timeout can never produce a
   * different answer than a fresh one. At most one invitation is spoken per
   * reconcile, and only for the nearest current opening: a long sleep resumes
   * with the truth about now, not with a queue of the boundaries it slept
   * through.
   */
  reconcile(): void {
    if (this.destroyed) return;

    const enabled = this.host.enabled();
    if (!enabled || !this.host.visible()) this.hold = null;
    if (enabled && this.host.visible()) this.invite();

    this.commit();
    this.schedule();
  }

  /** Stops the timer, drops the hold and forgets this session's listeners. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancel();
    this.hold = null;
    this.heard.clear();
    this.used.clear();
    this.listeners.clear();
    this.lastShape = "";
  }

  /** Every opening currently inside the eleven-minute lead and its open minute. */
  private eligible(now: number): PortalInstant[] {
    const result: PortalInstant[] = [];
    for (const portal of portalInstants(now - MINUTE_MS + 1, now + LEAD_MS)) {
      if (!this.used.has(portal.id)) result.push(portal);
    }
    return result;
  }

  /** Resolves an id inside the current window, or the held portal's own instant. */
  private find(id: string): PortalInstant | null {
    if (this.hold?.portal.id === id) return this.hold.portal;
    const now = this.host.now();
    for (const portal of portalInstants(now - MINUTE_MS + 1, now + LEAD_MS)) {
      if (portal.id === id) return portal;
    }
    return null;
  }

  /**
   * Speaks at most one invitation, then treats every presently eligible
   * opening as spoken.
   *
   * Marking the whole set is what turns a delayed wake into one truthful
   * sentence instead of a backlog, and it is also why a backwards correction
   * cannot repeat an invitation already given in this session. The chosen
   * opening is the one actually open now, else the nearest that is still
   * approaching.
   */
  private invite(): void {
    const now = this.host.now();
    const eligible = this.eligible(now);
    const fresh = eligible.filter((portal) => !this.heard.has(portal.id));
    for (const portal of eligible) this.heard.add(portal.id);
    if (fresh.length === 0) return;

    const open = fresh.filter((portal) => portal.opensAt <= now);
    const chosen = open.length > 0 ? open[open.length - 1] : fresh[0];
    if (chosen === undefined) return;

    const remainingSeconds = Math.max(0, Math.ceil((chosen.opensAt - now) / 1000));
    this.host.invite(chosen, remainingSeconds);
  }

  /** Emits once when the observable lifecycle state differs from the last time. */
  private commit(): void {
    if (this.destroyed) return;
    const shape = this.shape();
    if (shape === this.lastShape) return;
    this.lastShape = shape;
    for (const listener of [...this.listeners]) listener();
  }

  /** Phase and pinned identity change lifecycle; elapsed seconds do not. */
  private shape(): string {
    const now = this.host.now();
    const ids = this.host.enabled()
      ? this.eligible(now).map((portal) => `${portal.id}:${portalPhase(portal, now, false)}`)
      : [];
    const held = this.hold === null ? "" :
      `${this.hold.portal.id}@${this.hold.path}:${portalPhase(this.hold.portal, now, true)}`;
    return `${this.host.todayPath(now)}|${ids.join(",")}|${held}`;
  }

  /** One timeout, at the next wall-minute boundary, replaced on every change. */
  private schedule(): void {
    this.cancel();
    if (this.destroyed || !this.host.enabled()) return;
    const now = this.host.now();
    const next = Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.reconcile();
    }, Math.max(0, next - now) + WAKE_SLACK_MS);
  }

  private cancel(): void {
    if (this.timer === null) return;
    window.clearTimeout(this.timer);
    this.timer = null;
  }
}
