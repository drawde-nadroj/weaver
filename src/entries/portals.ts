/**
 * The invitation lifecycle: which schedule is offering what, right now.
 *
 * A portal stopped being a minute you could write in and became a call to
 * action. So this controller holds no note, no preparation and no permission:
 * it derives, from the actual instant, one outstanding invitation per schedule,
 * and every one of them opens the same composer the writer can open at any time.
 *
 * Three facts make the derivation honest:
 *
 *  - **Activation, not history.** A schedule is examined from the moment it was
 *    enabled, and answered occurrences are excluded, so turning a schedule on
 *    does not replay a month of openings and a dismissal is not forgotten at the
 *    next minute.
 *  - **One per schedule.** A later occurrence replaces its own schedule's
 *    outstanding invitation; different schedules stay distinct even when they
 *    point at the same minute. Each invitation carries the generation it belongs
 *    to, so a late answer can never clear a newer one.
 *  - **No note bytes.** Dismissing, announcing, or leaving an invitation forever
 *    writes nothing to the vault. Only a capture that actually settles produces
 *    evidence, and only through the one writer.
 *
 * The controller never counts timer callbacks: `reconcile` is called on a
 * boundary, on a settings change, on visibility, and once after load, and each
 * call answers as a fresh derivation would.
 */

import {
  DEFAULT_LEAD_MINUTES,
  dueOpening,
  nextOpening,
  OPENING_WINDOW_MS,
  portalContainsBeginning,
  portalPhase,
  RHYTHM_SCHEDULE_ID,
  sourceOccurrences,
  type PortalInstant,
  type PortalOccurrence,
  type PortalPhase,
  type PortalSchedule,
  type PortalSource
} from "../core/portals";
import type { LocalStateRecord, ScheduleRuntime } from "./local-state";

/** One minute: the granularity at which availability can change. */
const MINUTE_MS = 60_000;

/** A third of a minute past the boundary, so the new minute is already current. */
const WAKE_SLACK_MS = 20;

/** What the controller may know about the world, injected so a test can move time. */
export interface PortalHost {
  /** The current wall-clock instant, in epoch milliseconds. */
  now(): number;
  /** The master invitation switch in settings. */
  enabled(): boolean;
  /** Whether the built-in rhythm is offered. */
  rhythmic(): boolean;
  /** The destination the rhythm invites writing into. */
  rhythmContext(): string;
  /** Every configured schedule, validated. */
  schedules(): readonly PortalSchedule[];
  /** The stored record, read fresh when the controller starts. */
  state(): LocalStateRecord;
  /** Persists schedule runtime, so an answer survives a reload. */
  persist(record: LocalStateRecord): void;
  /** Whether the app is visible enough to speak about an invitation. */
  visible(): boolean;
  /** Announces one invitation that has just become available, once. */
  invite(occurrence: PortalOccurrence): void;
}

/** An invitation as a surface draws it: the occurrence, and how near it is. */
export interface OfferedInvitation {
  occurrence: PortalOccurrence;
  phase: "approaching" | "available";
  /** The schedule's lead, so a surface can say how long its notice is. */
  leadMinutes: number;
}

/**
 * The schedules' runtime state, and the invitations derived from it.
 *
 * Everything it decides is a function of the instant, the settings and what this
 * device has already answered; nothing is accumulated from callbacks.
 */
export class PortalController {
  /** `scheduleId` → the runtime the stored record carries. */
  private readonly runtime = new Map<string, ScheduleRuntime>();
  /** `scheduleId` → the schedule shape the runtime was started for. */
  private readonly signatures = new Map<string, string>();
  /** `occurrenceId` → the occurrence this session has already spoken about. */
  private readonly spoken = new Set<string>();
  /** `scheduleId` → the occurrence currently outstanding. */
  private readonly pending = new Map<string, PortalOccurrence>();
  private readonly listeners = new Set<() => void>();
  private timer: number | null = null;
  private lastShape = "";
  private destroyed = false;
  /** The stored record, updated in place so one write carries every change. */
  private record: LocalStateRecord | null = null;

  constructor(private readonly host: PortalHost) {}

  /** The controller's view of the current instant. */
  now(): number {
    return this.host.now();
  }

  /** Loads the stored runtimes, then derives what is outstanding right now. */
  start(): void {
    if (this.destroyed) return;
    const record = this.host.state();
    this.record = record;
    for (const [id, runtime] of Object.entries(record.schedules)) this.runtime.set(id, runtime);
    this.reconcile();
  }

  /**
   * Every enabled source, the rhythm first, in a stable order.
   *
   * The rhythm is described as a source with no recurrence of its own: its
   * minutes are the built-in set, and `sourceOccurrences` is what knows that.
   */
  sources(): PortalSource[] {
    const rhythm: PortalSource | null = this.host.rhythmic()
      ? {
          id: RHYTHM_SCHEDULE_ID,
          name: "Rhythm",
          contextId: this.host.rhythmContext(),
          leadMinutes: DEFAULT_LEAD_MINUTES,
          createdAt: 0,
          schedule: null
        }
      : null;

    const configured = this.host
      .schedules()
      .filter((schedule) => this.host.enabled() && schedule.enabled)
      .map(
        (schedule): PortalSource => ({
          id: schedule.id,
          name: schedule.name,
          contextId: schedule.contextId,
          leadMinutes: schedule.leadMinutes,
          createdAt: schedule.createdAt,
          schedule
        })
      );

    return [...(rhythm === null ? [] : [rhythm]), ...configured];
  }

  /** Every invitation a surface may show: available first, then approaching. */
  outstanding(): OfferedInvitation[] {
    if (this.destroyed || !this.host.enabled()) return [];

    const now = this.host.now();
    const result: OfferedInvitation[] = [];

    for (const source of this.sources()) {
      const available = this.pending.get(source.id);
      // A minute that has closed is no longer an invitation: the writer can still
      // write, but not through an opening that went by.
      if (available !== undefined && portalPhase(available.portal, now) === "available") {
        result.push({ occurrence: available, phase: "available", leadMinutes: source.leadMinutes });
        continue;
      }

      const approaching = this.approaching(source, now);
      if (approaching !== null) {
        result.push({ occurrence: approaching, phase: "approaching", leadMinutes: source.leadMinutes });
      }
    }

    return result.sort((left, right) => {
      if (left.phase !== right.phase) return left.phase === "available" ? -1 : 1;
      const byOpening = left.occurrence.portal.opensAt - right.occurrence.portal.opensAt;
      if (byOpening !== 0) return byOpening;
      // Stable order, so the dock does not shuffle between renders.
      return left.occurrence.scheduleId < right.occurrence.scheduleId ? -1 : 1;
    });
  }

  /** The one invitation a compact dock shows, or null. */
  primary(): OfferedInvitation | null {
    return this.outstanding()[0] ?? null;
  }

  /** The next opening of one source, for a list that is not an invitation yet. */
  next(source: PortalSource): PortalInstant | null {
    return nextOpening(source, this.host.now());
  }

  /** The outstanding occurrence of one schedule, or null when it has none. */
  pendingFor(scheduleId: string): PortalOccurrence | null {
    const occurrence = this.pending.get(scheduleId);
    if (occurrence === undefined) return null;
    return portalPhase(occurrence.portal, this.host.now()) === "available" ? occurrence : null;
  }

  /** The phase of a live occurrence, so a countdown can be drawn. */
  phase(occurrence: PortalOccurrence): PortalPhase {
    return portalPhase(occurrence.portal, this.host.now());
  }

  /**
   * Every opening `contextId` at `at` would be written through.
   *
   * Asked with the instant of a draft's first committed input, so the answer is
   * the minute the writer actually began in — not the minute a surface happened
   * to look. An opening qualifies when it contains that instant, belongs to this
   * Realm's source, is enabled, and has not been answered through this
   * activation; two schedules may share the minute, and each is returned with its
   * own generation because each is answered separately.
   *
   * Dismissing an occurrence acknowledges it, so a dismissed opening never
   * qualifies: a writer who said no did not mean "unless I type".
   */
  captureAt(contextId: string, at: number): Array<{ occurrence: PortalOccurrence; generation: number }> {
    if (this.destroyed || !this.host.enabled()) return [];
    if (!Number.isFinite(at)) return [];

    const result: Array<{ occurrence: PortalOccurrence; generation: number }> = [];

    for (const source of this.sources()) {
      if (source.contextId !== contextId) continue;
      const runtime = this.runtime.get(source.id) ?? this.runtimeFor(source, this.host.now());
      const floor = Math.max(runtime.activatedAt, (runtime.acknowledgedThrough ?? 0) + 1);

      const candidates = sourceOccurrences(
        source,
        Math.max(floor, at - OPENING_WINDOW_MS + 1),
        at
      ).filter((portal) => portalContainsBeginning(portal, at));

      for (const portal of candidates) {
        if (portal.opensAt < floor) continue;
        result.push({ occurrence: this.occurrenceOf(source, portal), generation: runtime.generation });
      }
    }

    return result.sort((left, right) =>
      left.occurrence.scheduleId < right.occurrence.scheduleId ? -1 : 1
    );
  }

  /**
   * Openings that closed within `windowMs`, for one brief farewell.
   *
   * This is how a surface says "04:33 closed" without inventing history: the
   * opening is a fact about the calendar, and it is reported only while it is
   * recent. Nothing here records anything, so a missed minute leaves no trace in
   * any note, and waking after a long sleep replays nothing.
   */
  recentlyClosed(windowMs: number): PortalOccurrence[] {
    if (this.destroyed || !this.host.enabled()) return [];
    if (!Number.isFinite(windowMs) || windowMs <= 0) return [];

    const now = this.host.now();
    const result: PortalOccurrence[] = [];

    for (const source of this.sources()) {
      const runtime = this.runtime.get(source.id);
      const floor = Math.max(runtime?.activatedAt ?? 0, (runtime?.acknowledgedThrough ?? 0) + 1);

      // An opening's *close* is what falls in the window, so the search runs one
      // window earlier: the minute that ended recently began a minute before it.
      const closed = sourceOccurrences(
        source,
        now - windowMs - OPENING_WINDOW_MS,
        now - OPENING_WINDOW_MS
      ).filter((portal) => portal.opensAt + OPENING_WINDOW_MS > now - windowMs);
      const last = closed[closed.length - 1];
      if (last === undefined || last.opensAt < floor) continue;
      result.push(this.occurrenceOf(source, last));
    }

    return result.sort((left, right) => right.portal.opensAt - left.portal.opensAt);
  }

  /**
   * Records that one invitation was answered, and by what.
   *
   * Only the occurrence named is acknowledged, and only through its own opening:
   * a later occurrence that arrived meanwhile keeps its own invitation. An answer
   * from an older generation never clears a newer one.
   */
  acknowledge(occurrence: PortalOccurrence, generation: number): void {
    if (this.destroyed) return;
    const source = this.sources().find((candidate) => candidate.id === occurrence.scheduleId);
    if (source === undefined) return;

    const runtime = this.runtimeFor(source, this.host.now());
    if (runtime.generation !== generation) return;

    runtime.acknowledgedThrough = Math.max(
      runtime.acknowledgedThrough ?? 0,
      occurrence.portal.opensAt
    );

    const outstanding = this.pending.get(source.id);
    if (outstanding !== undefined && outstanding.portal.opensAt <= (runtime.acknowledgedThrough ?? 0)) {
      this.pending.delete(source.id);
    }

    this.commit();
    this.schedule();
  }

  /**
   * Dismisses exactly the occurrence named.
   *
   * Dismissing an approaching opening acknowledges that opening, so it does not
   * come back — and nothing else changes: the next occurrence is still offered.
   */
  dismiss(occurrenceId: string): void {
    if (this.destroyed) return;

    for (const source of this.sources()) {
      const occurrence = this.pending.get(source.id);
      if (occurrence === undefined || occurrence.id !== occurrenceId) continue;
      const runtime = this.runtimeFor(source, this.host.now());
      runtime.acknowledgedThrough = Math.max(
        runtime.acknowledgedThrough ?? 0,
        occurrence.portal.opensAt
      );
      this.pending.delete(source.id);
      this.commit();
      this.schedule();
      return;
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
   * Re-derives every schedule from the actual instant.
   *
   * The only entry point for wakeups, restarts, visibility and settings changes,
   * so a missed or early timeout can never produce a different answer than a
   * fresh one would.
   */
  reconcile(): void {
    if (this.destroyed) return;

    const now = this.host.now();
    const live = new Set<string>();

    for (const source of this.sources()) {
      live.add(source.id);
      const runtime = this.runtimeFor(source, now);
      const due = dueOpening(source, now, runtime.activatedAt, runtime.acknowledgedThrough);

      if (due === null) {
        // An approaching invitation is derived, never stored; a pending one that
        // is no longer due was answered elsewhere and goes with it.
        this.pending.delete(source.id);
        continue;
      }

      const occurrence = this.occurrenceOf(source, due);
      if (this.host.visible() && !this.spoken.has(occurrence.id)) {
        this.spoken.add(occurrence.id);
        this.host.invite(occurrence);
      }
      this.pending.set(source.id, occurrence);
    }

    // A schedule that no longer exists keeps its acknowledgement history but
    // offers nothing.
    for (const id of [...this.pending.keys()]) {
      if (!live.has(id)) this.pending.delete(id);
    }

    this.commit();
    this.schedule();
  }

  /** Stops the timer and forgets this session's listeners. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancel();
    this.pending.clear();
    this.spoken.clear();
    this.listeners.clear();
    this.lastShape = "";
  }

  /** The runtime for one source, started at the moment it is first seen. */
  private runtimeFor(source: PortalSource, now: number): ScheduleRuntime {
    const signature = `${source.contextId}|${source.leadMinutes}|${JSON.stringify(source.schedule?.when ?? null)}`;
    const previous = this.signatures.get(source.id);
    const existing = this.runtime.get(source.id);

    if (existing !== undefined && previous === signature) return existing;

    if (existing !== undefined) {
      // A time or destination edit — or a disable and re-enable — starts a new
      // activation: its pending invitation is cleared and nothing is backfilled.
      const next: ScheduleRuntime = {
        activatedAt: now,
        acknowledgedThrough: null,
        pending: null,
        generation: existing.generation + 1
      };
      this.runtime.set(source.id, next);
      this.signatures.set(source.id, signature);
      this.pending.delete(source.id);
      return next;
    }

    const created: ScheduleRuntime = {
      // A schedule is active from the moment it existed: its own creation
      // instant, or now for one written by hand without one. Nothing before it
      // is ever offered, which is what keeps an enable from replaying a day.
      activatedAt: source.createdAt === 0 ? now : source.createdAt,
      acknowledgedThrough: null,
      pending: null,
      generation: 0
    };
    this.runtime.set(source.id, created);
    this.signatures.set(source.id, signature);
    return created;
  }

  /** The occurrence value one due opening becomes. */
  private occurrenceOf(source: PortalSource, portal: PortalInstant): PortalOccurrence {
    return {
      id: `${source.id}@${portal.id}`,
      scheduleId: source.id,
      contextId: source.contextId,
      name: source.name,
      portal
    };
  }

  /**
   * An opening that is due to be announced but has not opened yet.
   *
   * Only inside the schedule's own lead window, and only while nothing is
   * already outstanding for that schedule: an available invitation is never
   * replaced by a notice about the next one.
   */
  private approaching(source: PortalSource, now: number): PortalOccurrence | null {
    const next = nextOpening(source, now);
    if (next === null) return null;

    const runtime = this.runtime.get(source.id);
    const floor = Math.max(runtime?.activatedAt ?? 0, (runtime?.acknowledgedThrough ?? 0) + 1);
    if (next.opensAt < floor) return null;
    if (portalPhase(next, now) !== "approaching") return null;
    if (now < next.opensAt - source.leadMinutes * MINUTE_MS) return null;

    return this.occurrenceOf(source, next);
  }

  /** Emits once when the observable lifecycle state differs from the last time. */
  private commit(): void {
    if (this.destroyed) return;
    if (this.record !== null) {
      const schedules: LocalStateRecord["schedules"] = { ...this.record.schedules };
      for (const [id, runtime] of this.runtime) schedules[id] = runtime;
      this.record = { ...this.record, schedules };
      try {
        this.host.persist(this.record);
      } catch {
        // Losing a runtime write costs an acknowledgement after a reload, never
        // the writer's words; the invitation is still derived from the instant.
      }
    }

    const shape = this.shape();
    if (shape === this.lastShape) return;
    this.lastShape = shape;
    for (const listener of [...this.listeners]) listener();
  }

  /** Availability and identity change lifecycle; elapsed seconds do not. */
  private shape(): string {
    const parts = this.sources().map((source) => {
      const pending = this.pending.get(source.id);
      const runtime = this.runtime.get(source.id);
      return `${source.id}:${pending?.id ?? "-"}:${runtime?.generation ?? 0}`;
    });
    return `${this.host.enabled()}|${parts.join(",")}`;
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
