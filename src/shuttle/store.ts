/**
 * The shuttle: sources you grabbed, kept until you weave them in.
 *
 * It is session state, not evidence. It never enters the vault, it is
 * device-local, and it is never counted as attention. A row that has been woven
 * in stays loaded with a use count, because a source worth grabbing once is
 * usually worth grabbing again — only an explicit unload removes it.
 */

import type { ReferenceKind } from "../core/reference";

export interface ShuttleItem {
  id: string;
  kind: ReferenceKind;
  path: string;
  headingText?: string;
  blockId?: string;
  label: string;
  /** ISO timestamp of the load, so the palette can name the day. */
  addedAt: string;
  usedCount: number;
}

export const SHUTTLE_CAPACITY = 50;

const MATCH_FIELDS = ["kind", "path", "headingText", "blockId"] as const;

/** Two rows are the same source when they point at the same thing. */
function sameTarget(left: ShuttleItem, right: Omit<ShuttleItem, "id" | "addedAt" | "usedCount">): boolean {
  return MATCH_FIELDS.every((field) => left[field] === right[field]);
}

function newId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject !== undefined && typeof cryptoObject.randomUUID === "function") {
    return cryptoObject.randomUUID();
  }
  return `shuttle-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Newest first, capped, deduped on target. Ordering is stable and insertion is a move-to-front. */
export class ShuttleStore {
  private readonly items_: ShuttleItem[];
  private readonly write: (items: ShuttleItem[]) => void;

  constructor(initial: readonly ShuttleItem[], write: (items: ShuttleItem[]) => void) {
    this.items_ = [...initial].slice(0, SHUTTLE_CAPACITY);
    this.write = write;
  }

  items(): readonly ShuttleItem[] {
    return this.items_;
  }

  /** Loads a source, moving an identical row to the front and keeping its use count. */
  load(item: Omit<ShuttleItem, "id" | "addedAt" | "usedCount">): ShuttleItem {
    const existing = this.items_.find((candidate) => sameTarget(candidate, item));
    const next: ShuttleItem = {
      ...item,
      id: existing?.id ?? newId(),
      // Re-grabbing a source reorders it; the day it was loaded does not move.
      addedAt: existing?.addedAt ?? new Date().toISOString(),
      usedCount: existing?.usedCount ?? 0
    };

    const rest = this.items_.filter((candidate) => candidate !== existing);
    this.items_.splice(0, this.items_.length, next, ...rest.slice(0, SHUTTLE_CAPACITY - 1));
    this.persist();
    return next;
  }

  markUsed(id: string): void {
    const item = this.items_.find((candidate) => candidate.id === id);
    if (item === undefined) return;
    item.usedCount += 1;
    this.persist();
  }

  remove(id: string): void {
    const index = this.items_.findIndex((candidate) => candidate.id === id);
    if (index < 0) return;
    this.items_.splice(index, 1);
    this.persist();
  }

  clear(): void {
    if (this.items_.length === 0) return;
    this.items_.splice(0, this.items_.length);
    this.persist();
  }

  private persist(): void {
    this.write(this.items_);
  }
}
