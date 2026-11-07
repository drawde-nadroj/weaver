/**
 * The reading index: recognised notes parsed once and queried by scope, order and
 * filter, with every read bounded and cancellable.
 *
 * This replaces the one-day-at-a-time reader. A day is not a note, an address is
 * not unique across destinations, and a thought's recorded day may differ from
 * its note's filename — so the reference needs every recognised note, parsed
 * lazily and invalidated per path, rather than a fresh whole-vault parse on every
 * keystroke.
 *
 * The index is never write authority. It reads, caches and orders; a write is
 * revalidated against the note itself by the writer. The one rule it must not
 * break is honesty about gaps: a file it could not read is reported, never
 * counted as an empty scope, and a query that a newer generation superseded is
 * discarded rather than installed.
 *
 * Pure of every Obsidian API: paths, text and a generation are injected.
 */

import {
  resolveThought,
  rootEntryOf,
  thoughtRefOf,
  type ThoughtRef
} from "../core/capture";
import type { WeavingContext } from "../core/contexts";
import { parseEntries, type Entry, type EntryIndex } from "../core/entries";
import {
  orderRecords,
  recordInScope,
  recordMatches,
  recognisePath,
  thoughtRecordOf,
  type ReferenceQuery,
  type ReferenceReadError,
  type ReferenceSequence,
  type ThoughtRecord,
  type ThoughtSnapshot,
  type ThoughtSnapshotResult
} from "../core/reference";

/** How many notes are read at once. */
const READ_CONCURRENCY = 4;

/** How many parsed notes are kept before the cache is dropped wholesale. */
const CACHE_LIMIT = 512;

/** How the index reads the vault. */
export interface ThoughtIndexPorts {
  /** Every markdown path, in any order. */
  paths(): readonly string[];
  /** One note's text, preferring a live editor's own document. */
  read(path: string): Promise<string | null>;
  /** A generation number: a smaller one is stale and must not be installed. */
  generation(): number;
  /** Every configured destination, for recognising a path. */
  contexts(): readonly WeavingContext[];
}

/** One parsed note, or the reason it cannot be listed. */
type Parsed = { ok: true; index: EntryIndex } | { ok: false; message: string };

/**
 * The lazy, invalidatable reading index.
 *
 * A query reads only the notes it needs, deduplicating concurrent reads of the
 * same path and keeping at most four in flight; a modify/create/delete/rename
 * invalidates exactly the affected path so the next query re-reads it.
 */
export class ThoughtIndex {
  /** `path` → parsed note, dropped on invalidation and past the cache limit. */
  private readonly cache = new Map<string, Parsed>();
  /** `path` → the read already in flight, so two queries share one parse. */
  private readonly loading = new Map<string, Promise<Parsed>>();

  constructor(private readonly ports: ThoughtIndexPorts) {}

  /**
   * The thoughts a query matches, in reading order, with any read gaps named.
   *
   * A stale generation or an aborted signal yields an empty sequence the caller
   * must discard: it is not evidence that the scope is empty.
   */
  async query(query: ReferenceQuery, signal?: AbortSignal): Promise<ReferenceSequence> {
    const generation = this.ports.generation();
    const contexts = this.ports.contexts();

    const candidates: { path: string; tapestryId: string | null; noteDay: string }[] = [];
    for (const path of this.ports.paths()) {
      const recognised = recognisePath(path, contexts);
      if (recognised === null) continue;
      if (query.scope.tapestryId !== null && recognised.contextId !== query.scope.tapestryId) continue;
      candidates.push({ path, tapestryId: recognised.contextId, noteDay: recognised.day });
    }

    const scoped: ThoughtRecord[] = [];
    const errors: ReferenceReadError[] = [];

    let cursor = 0;
    let stale = false;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (stale || signal?.aborted || this.ports.generation() !== generation) return;
        const at = cursor;
        cursor += 1;
        const candidate = candidates[at];
        if (candidate === undefined) return;

        const parsed = await this.load(candidate.path);
        if (this.ports.generation() !== generation || signal?.aborted) {
          stale = true;
          return;
        }
        if (!parsed.ok) {
          errors.push({ path: candidate.path, message: parsed.message });
          continue;
        }

        for (const entry of parsed.index.entries) {
          const record = thoughtRecordOf(parsed.index, entry, candidate.path, candidate.tapestryId, candidate.noteDay);
          if (recordInScope(record, query.scope)) scoped.push(record);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(READ_CONCURRENCY, Math.max(1, candidates.length)) }, () => worker())
    );

    if (stale || signal?.aborted || this.ports.generation() !== generation) {
      return { members: [], errors: [] };
    }

    // Order over the whole scoped set so a parent outside the search filter still
    // places its descendants; then apply the search membership.
    const ordered = orderRecords(scoped, query.order);
    const members = ordered.filter((record) => recordMatches(record, query.search));
    return { members, errors };
  }

  /**
   * One thought's lossless snapshot, or why it cannot be read.
   *
   * The note is read live-editor-first; the addressed entry is resolved strictly,
   * so a deleted, renumbered or edited thought is reported rather than guessed.
   * `originalBlock` is this entry's own marker-to-clock bytes, and `text` is the
   * authored prose with indentation and hard-break spaces intact — never the
   * normalised `prose` used for identity and search.
   */
  async loadThought(target: ThoughtRef, signal?: AbortSignal): Promise<ThoughtSnapshotResult> {
    const source = await this.ports.read(target.path);
    if (signal?.aborted) return { kind: "unavailable", thought: target, reason: "the read was cancelled" };
    if (source === null) {
      return { kind: "unavailable", thought: target, reason: "this note could not be read" };
    }

    const index = this.indexOf(source);
    const entry = resolveThought(index, target);
    if (entry === null) {
      return { kind: "unavailable", thought: target, reason: "that thought is no longer in its note" };
    }

    return { kind: "ready", snapshot: snapshotOf(source, index, entry, target.path) };
  }

  /** Drops one path's parse so the next query re-reads it. */
  invalidate(path: string): void {
    this.cache.delete(path);
    this.loading.delete(path);
  }

  /** Drops every parse, for a rename that could move more than one path. */
  invalidateAll(): void {
    this.cache.clear();
    this.loading.clear();
  }

  /** Releases the cache; the index may be rebuilt for the same ports. */
  dispose(): void {
    this.invalidateAll();
  }

  /** One note's parse, from cache or a deduplicated read. */
  private async load(path: string): Promise<Parsed> {
    const cached = this.cache.get(path);
    if (cached !== undefined) return cached;

    const inFlight = this.loading.get(path);
    if (inFlight !== undefined) return inFlight;

    const promise = this.ports
      .read(path)
      .then((source): Parsed => {
        if (source === null) return { ok: false, message: "this note could not be read" };
        const index = this.indexOf(source);
        if (index.legacyFormat) {
          return { ok: false, message: "this note still uses the old entry format; its entries are not listed" };
        }
        if (index.unclosedFrontmatter) {
          return { ok: false, message: "this note's frontmatter is never closed" };
        }
        if (index.unclosedFence) {
          return { ok: false, message: "this note has an unclosed code block" };
        }
        return { ok: true, index };
      })
      .finally(() => this.loading.delete(path));

    this.loading.set(path, promise);
    const parsed = await promise;
    if (this.cache.size >= CACHE_LIMIT) this.cache.clear();
    this.cache.set(path, parsed);
    return parsed;
  }

  /** Parses, without touching the cache, for a one-off snapshot read. */
  private indexOf(source: string): EntryIndex {
    return parseEntries(source);
  }
}

/** The authored prose with indentation and hard-break spaces preserved. */
function authoredTextOf(source: string, index: EntryIndex, entry: Entry): string {
  return entry.proseLines
    .map((line, at) => {
      const raw = index.lines[line] ?? "";
      if (at === 0 && line === entry.line) {
        // Inline marker: the prose begins after the address on the marker line.
        const lineStart = index.lineStarts[line] ?? 0;
        return source.slice(entry.proseFrom, lineStart + raw.length);
      }
      return raw;
    })
    .join("\n");
}

/** This entry's own block bytes: its marker, prose and clock, without children. */
function ownBlockOf(source: string, entry: Entry): string {
  const end =
    entry.clockLine !== null
      ? entry.clockTo
      : entry.proseTo > entry.from
        ? entry.proseTo
        : entry.to;
  return source.slice(entry.from, end);
}

/** A strict thought's lossless snapshot, from a parsed note. */
function snapshotOf(source: string, index: EntryIndex, entry: Entry, path: string): ThoughtSnapshot {
  const root = rootEntryOf(index, entry);
  const ancestry: ThoughtRef[] = [];
  let current: Entry | null = entry;
  while (current !== null && current !== root) {
    ancestry.unshift(thoughtRefOf(index, current, path));
    current = current.parent === null ? null : (index.entries[current.parent] ?? null);
  }
  ancestry.unshift(thoughtRefOf(index, root, path));

  return {
    thought: thoughtRefOf(index, entry, path),
    root: thoughtRefOf(index, root, path),
    ancestry,
    day: entry.day,
    time: entry.time,
    durationMs: entry.duration?.ms ?? null,
    originalBlock: ownBlockOf(source, entry),
    text: authoredTextOf(source, index, entry),
    whispers: entry.whisper.map((item) => item.text)
  };
}
