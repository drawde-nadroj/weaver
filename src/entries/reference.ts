/**
 * The upper half's one owner: the current query, the frozen sequence it produced,
 * the strictly selected thought, its loaded body, the search mode and the active
 * Review session.
 *
 * It owns *reading intent*, never a write: it queries the index, asks for one
 * thought's snapshot, and reports what it has. It does not call capture, travel a
 * workspace, open a note or create one. Every asynchronous answer carries the
 * request or selection id that asked for it, so a late result is discarded rather
 * than installed over a newer reader state.
 *
 * Pure of DOM and Obsidian: an index and a snapshot loader are injected.
 */

import type { ThoughtRef } from "../core/capture";
import type { ReviewCursor, ReviewDefinition, ReviewStamp } from "../core/reviews";
import {
  firstRecord,
  lastRecord,
  moveRecord,
  searchQueryOf,
  type ReferenceMove,
  type ReferenceQuery,
  type ReferenceReadError,
  type ReferenceSequence,
  type ReferenceStop,
  type ThoughtRecord,
  type ThoughtSnapshot
} from "../core/reference";
import type { ThoughtIndex } from "./thought-index";

/** What reading needs from the world. */
export interface ReferenceHost {
  /** The lazily-parsed reading index. */
  index: ThoughtIndex;
  /** One thought's lossless snapshot, live-editor-first. */
  load(target: ThoughtRef, signal?: AbortSignal): Promise<{ kind: "ready"; snapshot: ThoughtSnapshot } | { kind: "unavailable"; thought: ThoughtRef; reason: string }>;
  /** Something a surface draws has changed. */
  onChange(): void;
}

/** A Review session as it was opened, before any external change is observed. */
export interface ReviewSession {
  readonly id: string;
  readonly definition: ReviewDefinition;
  readonly definitionStamp: ReviewStamp;
  readonly cursor: ReviewCursor | null;
  readonly cursorStamp: ReviewStamp | null;
}

/** The active Review identity and how it has drifted since it was opened. */
export interface ActiveReview {
  readonly id: string;
  readonly definition: ReviewDefinition;
  readonly definitionStamp: ReviewStamp;
  readonly adoptedCursor: ReviewCursor | null;
  readonly cursorStamp: ReviewStamp | null;
  readonly externalStatus: "current" | "changed" | "deleted";
}

/** How far the query has got. */
export type ReferenceReadiness =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly requestId: number; readonly query: ReferenceQuery }
  | {
      readonly kind: "ready";
      readonly requestId: number;
      readonly query: ReferenceQuery;
      readonly sequence: ReferenceSequence;
      readonly changesAvailable: boolean;
    }
  | { readonly kind: "failed"; readonly requestId: number; readonly query: ReferenceQuery; readonly message: string };

/** Where the selected thought sits relative to the matching set. */
export type ReferencePlace =
  | { readonly kind: "none" }
  | { readonly kind: "member"; readonly stop: ReferenceStop }
  | { readonly kind: "context"; readonly stop: ReferenceStop; readonly returnTo: ReferenceStop }
  | { readonly kind: "outside-results"; readonly stop: ReferenceStop }
  | { readonly kind: "unavailable"; readonly thought: ThoughtRef; readonly reason: string };

/** The selected thought's body, and whether it is still loading. */
export type ReferenceBody =
  | { readonly kind: "none" }
  | { readonly kind: "loading"; readonly selectionId: number; readonly target: ThoughtRef }
  | {
      readonly kind: "ready";
      readonly selectionId: number;
      readonly target: ThoughtRef;
      readonly snapshot: ThoughtSnapshot;
    }
  | { readonly kind: "failed"; readonly selectionId: number; readonly target: ThoughtRef; readonly message: string };

/** The reading state kept to restore when a search is cancelled. */
export interface PreSearch {
  readonly query: ReferenceQuery;
  readonly selection: ThoughtRef | null;
  readonly textOffset: number;
}

/** Off, being typed, or accepted (the reference has the keys again). */
export type ReferenceSearch =
  | { readonly kind: "off" }
  | { readonly kind: "editing"; readonly text: string; readonly preSearch: PreSearch }
  | { readonly kind: "accepted"; readonly text: string; readonly preSearch: PreSearch };

/** The whole reading model a surface draws. */
export interface ReferenceModel {
  readonly readiness: ReferenceReadiness;
  readonly place: ReferencePlace;
  readonly body: ReferenceBody;
  readonly search: ReferenceSearch;
  readonly selection: ThoughtRef | null;
  readonly textOffset: number;
  readonly activeReview: ActiveReview | null;
  readonly notice: string | null;
}

/** How a Review changed elsewhere, so a reader is told without being moved. */
export interface ReviewChange {
  readonly id: string;
  readonly status: "current" | "changed" | "deleted";
}

/** A command a surface may dispatch to the reference. */
export type ReferenceAction =
  | { readonly kind: "move"; readonly direction: ReferenceMove }
  | { readonly kind: "select"; readonly target: ThoughtRef }
  | { readonly kind: "begin-search" }
  | { readonly kind: "set-search-text"; readonly text: string }
  | { readonly kind: "accept-search" }
  | { readonly kind: "cancel-search" }
  | { readonly kind: "clear-search" }
  | { readonly kind: "set-order"; readonly order: ReferenceQuery["order"] }
  | { readonly kind: "refresh" };

/** True when two references name exactly the same thought, facts and all. */
function sameThought(left: ThoughtRef, right: ThoughtRef): boolean {
  return (
    left.path === right.path &&
    left.n === right.n &&
    left.b === right.b &&
    left.d === right.d &&
    left.day === right.day &&
    left.time === right.time &&
    left.prose === right.prose
  );
}

/** A selection as a start place: the strict stop, or the first thought. */
function startOf(selection: ThoughtRef | null, textOffset: number): "first" | ReferenceStop {
  return selection === null ? "first" : { thought: selection, textOffset };
}

/** The record whose thought is exactly `target`, or null. */
function findRecord(sequence: ReferenceSequence, target: ThoughtRef): ThoughtRecord | null {
  return sequence.members.find((record) => sameThought(record.thought, target)) ?? null;
}

/** The reference controller: one query, one selection, one body, one Review. */
export class ReferenceController {
  private readiness: ReferenceReadiness = { kind: "idle" };
  private place: ReferencePlace = { kind: "none" };
  private body: ReferenceBody = { kind: "none" };
  private search: ReferenceSearch = { kind: "off" };
  private selection: ThoughtRef | null = null;
  private textOffset = 0;
  private activeReview: ActiveReview | null = null;
  private notice: string | null = null;

  /** Bumped by every query request; a result names the one it answers. */
  private requestCount = 0;
  /** Bumped by every selection; a snapshot names the one it belongs to. */
  private selectionCount = 0;
  private query: ReferenceQuery = {
    scope: { kind: "history", tapestryId: null },
    order: "time",
    search: { kind: "none" }
  };
  private disposed = false;

  constructor(private readonly host: ReferenceHost) {}

  /** The state a surface draws. */
  get model(): ReferenceModel {
    return {
      readiness: this.readiness,
      place: this.place,
      body: this.body,
      search: this.search,
      selection: this.selection,
      textOffset: this.textOffset,
      activeReview: this.activeReview,
      notice: this.notice
    };
  }

  /** True when the selected body is loaded and no known invalidation blocks it. */
  get editable(): boolean {
    return this.body.kind === "ready" && this.place.kind !== "unavailable";
  }

  /**
   * Opens a query at a chosen place.
   *
   * A Review session freezes its identity and cursor for this reading: an
   * incoming change is reported, never adopted under the reader.
   */
  async open(
    query: ReferenceQuery,
    start: "first" | "last" | ReferenceStop,
    reviewSession: ReviewSession | null = null
  ): Promise<void> {
    if (this.disposed) return;
    this.activeReview =
      reviewSession === null
        ? null
        : {
            id: reviewSession.id,
            definition: reviewSession.definition,
            definitionStamp: reviewSession.definitionStamp,
            adoptedCursor: reviewSession.cursor,
            cursorStamp: reviewSession.cursorStamp,
            externalStatus: "current"
          };
    this.query = query;
    this.notice = null;
    await this.runQuery(query, start, reviewSession);
  }

  /** Moves within the frozen sequence, or returns false at a boundary. */
  async move(direction: ReferenceMove): Promise<boolean> {
    if (this.readiness.kind !== "ready") return false;
    const next = moveRecord(this.readiness.sequence.members, this.selection, direction);
    if (next === null) return false;
    await this.activate(next.thought, this.readiness.sequence);
    return true;
  }

  /** Selects a specific thought, false when it is not in scope. */
  async select(target: ThoughtRef): Promise<boolean> {
    if (this.readiness.kind !== "ready") return false;
    const record = findRecord(this.readiness.sequence, target);
    if (record === null) {
      this.place = { kind: "unavailable", thought: target, reason: "that thought is not in this scope" };
      this.onChange();
      return false;
    }
    await this.activate(target, this.readiness.sequence);
    return this.body.kind === "ready";
  }

  /** Starts a search from the current reading place. */
  beginSearch(): void {
    if (this.readiness.kind !== "ready" || this.search.kind !== "off") return;
    this.search = {
      kind: "editing",
      text: "",
      preSearch: { query: this.query, selection: this.selection, textOffset: this.textOffset }
    };
    this.onChange();
  }

  /** Records typed query text and re-runs the scoped search. */
  async setSearchText(text: string): Promise<void> {
    if (this.search.kind !== "editing") return;
    this.search = { ...this.search, text };
    await this.runQuery({ ...this.query, search: searchQueryOf(text) }, "first", null, this.search);
  }

  /**
   * Accepts the current match, consuming Enter. False while loading or empty.
   *
   * Acceptance does not edit, travel or branch: it hands the keys back to the
   * reference and keeps the query and match sequence.
   */
  acceptSearch(): boolean {
    if (this.search.kind !== "editing") return false;
    if (this.readiness.kind !== "ready") return false;
    if (this.readiness.sequence.members.length === 0) return false;
    if (this.body.kind !== "ready") return false;
    this.search = { kind: "accepted", text: this.search.text, preSearch: this.search.preSearch };
    this.onChange();
    return true;
  }

  /** Cancels a search and restores the exact pre-search scope and place. */
  async cancelSearch(): Promise<void> {
    if (this.search.kind === "off") return;
    const preSearch = this.search.preSearch;
    this.search = { kind: "off" };
    await this.runQuery(preSearch.query, startOf(preSearch.selection, preSearch.textOffset), null, undefined, preSearch);
  }

  /** Clears an accepted search, keeping a selected thought only if it still belongs. */
  async clearSearch(): Promise<void> {
    if (this.search.kind === "off") return;
    const preSearch = this.search.preSearch;
    this.search = { kind: "off" };
    const keep = this.selection ?? preSearch.selection;
    await this.runQuery(preSearch.query, startOf(keep, preSearch.textOffset), null, undefined, preSearch);
  }

  /** Changes this session's reading order, keeping the selection if it survives. */
  async setOrder(order: ReferenceQuery["order"]): Promise<void> {
    await this.runQuery({ ...this.query, order }, startOf(this.selection, this.textOffset), null);
  }

  /** Re-runs the current query, keeping a strictly resolvable selection. */
  async refresh(): Promise<void> {
    await this.runQuery(this.query, startOf(this.selection, this.textOffset), null);
  }

  /** Records the intra-thought reading place, without touching the sequence. */
  setTextOffset(offset: number): void {
    this.textOffset = offset;
    if (this.place.kind === "member" || this.place.kind === "outside-results") {
      this.place = { kind: this.place.kind, stop: { ...this.place.stop, textOffset: offset } };
    }
  }

  /**
   * Rebinds one corrected thought in the frozen sequence and its places.
   *
   * Only exact matches move; a different thought the reader selected meanwhile is
   * left alone. The body is rebuilt from the supplied snapshot, so the reader
   * sees the corrected prose without a refresh.
   */
  applyConfirmedRevision(before: ThoughtRef, after: ThoughtSnapshot): void {
    if (this.readiness.kind === "ready") {
      const members = this.readiness.sequence.members.map((record) =>
        sameThought(record.thought, before) ? { ...record, thought: after.thought } : record
      );
      this.readiness = { ...this.readiness, sequence: { ...this.readiness.sequence, members } };
    }
    if (this.selection !== null && sameThought(this.selection, before)) {
      this.selection = after.thought;
      this.body = { kind: "ready", selectionId: this.selectionCount, target: after.thought, snapshot: after };
    }
    this.place = rebindPlace(this.place, before, after.thought);
    if (this.activeReview?.adoptedCursor?.thought !== null && this.activeReview?.adoptedCursor?.thought !== undefined) {
      if (sameThought(this.activeReview.adoptedCursor.thought, before)) {
        this.activeReview = {
          ...this.activeReview,
          adoptedCursor: { ...this.activeReview.adoptedCursor, thought: after.thought }
        };
      }
    }
    this.onChange();
  }

  /**
   * Marks deleted thoughts unavailable, keeping the selection as an anchor.
   *
   * No automatic advance and no saved Review cursor change: the reader decides
   * when to move.
   */
  applyConfirmedDeletion(deleted: readonly ThoughtRef[]): void {
    if (deleted.length === 0) return;
    if (this.readiness.kind === "ready") {
      const members = this.readiness.sequence.members.filter(
        (record) => !deleted.some((target) => sameThought(record.thought, target))
      );
      this.readiness = { ...this.readiness, sequence: { ...this.readiness.sequence, members } };
    }
    const removed = this.selection !== null && deleted.some((target) => sameThought(this.selection as ThoughtRef, target));
    if (removed && this.selection !== null) {
      this.place = { kind: "unavailable", thought: this.selection, reason: "this thought was removed" };
      this.body = { kind: "none" };
    }
    this.onChange();
  }

  /** Reports a Review that changed elsewhere; never moves the reader. */
  observeReviewChange(change: ReviewChange): void {
    if (this.activeReview === null || this.activeReview.id !== change.id) return;
    this.activeReview = { ...this.activeReview, externalStatus: change.status };
    this.notice =
      change.status === "deleted"
        ? "Review deleted elsewhere · Save as new Review"
        : change.status === "changed"
          ? "Review changed elsewhere · Reload"
          : null;
    this.onChange();
  }

  /** Routes one command to the reading operation it names. */
  dispatch(action: ReferenceAction): void {
    switch (action.kind) {
      case "move":
        void this.move(action.direction);
        return;
      case "select":
        void this.select(action.target);
        return;
      case "begin-search":
        this.beginSearch();
        return;
      case "set-search-text":
        void this.setSearchText(action.text);
        return;
      case "accept-search":
        this.acceptSearch();
        return;
      case "cancel-search":
        void this.cancelSearch();
        return;
      case "clear-search":
        void this.clearSearch();
        return;
      case "set-order":
        void this.setOrder(action.order);
        return;
      case "refresh":
        void this.refresh();
        return;
    }
  }

  /** Stops all further work; late results are ignored. */
  dispose(): void {
    this.disposed = true;
    this.requestCount += 1;
    this.selectionCount += 1;
    this.readiness = { kind: "idle" };
    this.body = { kind: "none" };
    this.place = { kind: "none" };
    this.search = { kind: "off" };
    this.activeReview = null;
  }

  /** Runs one query as a new request, then selects the start place. */
  private async runQuery(
    query: ReferenceQuery,
    start: "first" | "last" | ReferenceStop,
    reviewSession: ReviewSession | null,
    searchOverride?: ReferenceSearch,
    restore?: PreSearch
  ): Promise<void> {
    if (this.disposed) return;
    this.requestCount += 1;
    const requestId = this.requestCount;
    this.query = query;
    if (searchOverride !== undefined) this.search = searchOverride;
    this.readiness = { kind: "loading", requestId, query };
    this.onChange();

    let sequence: ReferenceSequence;
    try {
      sequence = await this.host.index.query(query);
    } catch (error) {
      if (requestId !== this.requestCount || this.disposed) return;
      this.readiness = {
        kind: "failed",
        requestId,
        query,
        message: error instanceof Error ? error.message : String(error)
      };
      this.onChange();
      return;
    }
    if (requestId !== this.requestCount || this.disposed) return;

    this.readiness = { kind: "ready", requestId, query, sequence, changesAvailable: false };
    const target = this.startTarget(sequence, start, reviewSession, restore);
    if (target.record === null) {
      this.selection = null;
      this.place = { kind: "none" };
      this.body = { kind: "none" };
      this.onChange();
      return;
    }
    if (target.textOffset !== null) this.textOffset = target.textOffset;
    await this.activate(target.record.thought, sequence);
  }

  /** The thought a start place resolves to, or null when the scope is empty. */
  private startTarget(
    sequence: ReferenceSequence,
    start: "first" | "last" | ReferenceStop,
    reviewSession: ReviewSession | null,
    restore?: PreSearch
  ): { record: ThoughtRecord | null; textOffset: number | null } {
    if (restore?.selection != null) {
      const kept = findRecord(sequence, restore.selection);
      return { record: kept, textOffset: restore.textOffset };
    }
    if (reviewSession?.cursor?.thought != null) {
      const kept = findRecord(sequence, reviewSession.cursor.thought);
      if (kept !== null) return { record: kept, textOffset: reviewSession.cursor.textOffset };
    }
    if (start === "last") return { record: lastRecord(sequence.members), textOffset: null };
    if (start === "first") return { record: firstRecord(sequence.members), textOffset: null };
    return { record: findRecord(sequence, start.thought), textOffset: start.textOffset };
  }

  /** Selects one thought and loads its body, guarded by the selection id. */
  private async activate(target: ThoughtRef, sequence: ReferenceSequence): Promise<void> {
    this.selectionCount += 1;
    const selectionId = this.selectionCount;
    this.selection = target;
    const member = findRecord(sequence, target);
    this.place = member === null
      ? { kind: "outside-results", stop: { thought: target, textOffset: 0 } }
      : { kind: "member", stop: { thought: target, textOffset: this.textOffset } };
    this.body = { kind: "loading", selectionId, target };
    this.onChange();

    const result = await this.host.load(target);
    if (selectionId !== this.selectionCount || this.disposed) return;
    if (result.kind === "ready") {
      this.body = { kind: "ready", selectionId, target, snapshot: result.snapshot };
    } else {
      this.body = { kind: "failed", selectionId, target, message: result.reason };
      this.place = { kind: "unavailable", thought: target, reason: result.reason };
    }
    this.onChange();
  }

  private onChange(): void {
    this.host.onChange();
  }
}

/** A place with its thought replaced where the reference exactly matches. */
function rebindPlace(place: ReferencePlace, before: ThoughtRef, after: ThoughtRef): ReferencePlace {
  if (place.kind === "member" || place.kind === "outside-results") {
    if (!sameThought(place.stop.thought, before)) return place;
    return { kind: place.kind, stop: { ...place.stop, thought: after } };
  }
  if (place.kind === "context") {
    const stop = sameThought(place.stop.thought, before) ? { ...place.stop, thought: after } : place.stop;
    const returnTo = sameThought(place.returnTo.thought, before)
      ? { ...place.returnTo, thought: after }
      : place.returnTo;
    return { kind: "context", stop, returnTo };
  }
  return place;
}

/** The errors a failed sequence carries, for a surface's expandable list. */
export function sequenceErrors(sequence: ReferenceSequence | null): readonly ReferenceReadError[] {
  return sequence?.errors ?? [];
}
