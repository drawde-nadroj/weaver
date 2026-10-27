import type { LineClassSpec } from "./decorations";
import { draftId, draftTitleLine, type DraftBlock } from "./drafts";
import type { Heading, HeadingIndex } from "./headings";
import { dimensionLabel } from "./vocabulary";

export type LevelFilter = number | "all";

/** Travel walks one kind of target at a time; `Tab` switches kind. */
export type TravelKind = "headings" | "drafts";

export interface TravelSelection {
  active: boolean;
  kind: TravelKind;
  level: LevelFilter;
  /** Headings mode. */
  targetLine: number | null;
  /** Drafts mode. */
  draftId: string | null;
}

export type TravelDirection = "next" | "prev";

export function headingMatchesLevel(heading: Heading, level: LevelFilter): boolean {
  return level === "all" || heading.level === level;
}

export function levelTargets(index: HeadingIndex, level: LevelFilter): Heading[] {
  return index.headings.filter((heading) => headingMatchesLevel(heading, level));
}

function positionOf(index: HeadingIndex, heading: Heading): number {
  return index.headings.findIndex((candidate) => candidate.line === heading.line);
}

/**
 * Where travel starts: the heading under the cursor when it matches the filter,
 * else the first match at or below the cursor, else the closest one above.
 */
export function initialTravelTarget(
  index: HeadingIndex,
  cursorLine: number,
  level: LevelFilter
): Heading | null {
  const onLine = index.headings.find((heading) => heading.line === cursorLine);
  if (onLine !== undefined && headingMatchesLevel(onLine, level)) return onLine;

  if (level === "all") {
    let preceding: Heading | null = null;
    for (const heading of index.headings) {
      if (heading.line > cursorLine) break;
      preceding = heading;
    }
    return preceding ?? index.headings[0] ?? null;
  }

  const following = index.headings.find(
    (heading) => heading.level === level && heading.line >= cursorLine
  );
  if (following !== undefined) return following;

  for (let position = index.headings.length - 1; position >= 0; position -= 1) {
    const heading = index.headings[position];
    if (heading !== undefined && heading.level === level && heading.line < cursorLine) return heading;
  }
  return null;
}

/**
 * Moves one step within the current level filter. Without wrapping the current
 * heading is returned at the edges, so the caret never jumps.
 */
export function moveTravelTarget(
  index: HeadingIndex,
  current: Heading | null,
  level: LevelFilter,
  direction: TravelDirection,
  wrap: boolean
): Heading | null {
  const targets = levelTargets(index, level);
  if (targets.length === 0) return null;

  if (current === null) {
    return direction === "next" ? (targets[0] ?? null) : (targets[targets.length - 1] ?? null);
  }

  const position = targets.findIndex((heading) => heading.line === current.line);
  if (position === -1) {
    // The filter just changed and the current heading is outside it.
    if (direction === "next") {
      return targets.find((heading) => heading.line > current.line) ?? current;
    }
    for (let index2 = targets.length - 1; index2 >= 0; index2 -= 1) {
      const heading = targets[index2];
      if (heading !== undefined && heading.line < current.line) return heading;
    }
    return current;
  }

  const next = position + (direction === "next" ? 1 : -1);
  if (next < 0 || next >= targets.length) {
    if (!wrap) return current;
    return targets[(next + targets.length) % targets.length] ?? current;
  }
  return targets[next] ?? current;
}

/** The nearest heading above with a lower level. */
export function parentTarget(index: HeadingIndex, current: Heading): Heading | null {
  const position = positionOf(index, current);
  if (position === -1) return null;

  for (let candidate = position - 1; candidate >= 0; candidate -= 1) {
    const heading = index.headings[candidate];
    if (heading !== undefined && heading.level < current.level) return heading;
  }
  return null;
}

/** The first heading below with a higher level, before any sibling or uncle. */
export function childTarget(index: HeadingIndex, current: Heading): Heading | null {
  const position = positionOf(index, current);
  if (position === -1) return null;

  for (let candidate = position + 1; candidate < index.headings.length; candidate += 1) {
    const heading = index.headings[candidate];
    if (heading === undefined) continue;
    if (heading.level <= current.level) return null;
    return heading;
  }
  return null;
}

export function firstTarget(index: HeadingIndex, level: LevelFilter): Heading | null {
  return levelTargets(index, level)[0] ?? null;
}

export function lastTarget(index: HeadingIndex, level: LevelFilter): Heading | null {
  const targets = levelTargets(index, level);
  return targets[targets.length - 1] ?? null;
}

/** Line classes for the travel highlight. */
export function travelLineSpecs(index: HeadingIndex, travel: TravelSelection): LineClassSpec[] {
  if (!travel.active) return [];

  if (travel.kind === "drafts") {
    const specs: LineClassSpec[] = [];
    for (const draft of orderedDrafts(index, travel.level)) {
      const classes = ["weaver-travel-level"];
      if (travel.draftId !== null && draft.id === travel.draftId) {
        classes.push("weaver-travel-target");
      }
      specs.push({ from: draft.titleFrom, classes });
    }
    return specs;
  }

  const specs: LineClassSpec[] = [];
  for (const heading of index.headings) {
    const classes: string[] = [];
    if (headingMatchesLevel(heading, travel.level)) classes.push("weaver-travel-level");
    if (travel.targetLine !== null && heading.line === travel.targetLine) {
      classes.push("weaver-travel-target");
    }
    if (classes.length > 0) specs.push({ from: heading.from, classes });
  }
  return specs;
}

/**
 * Open drafts in chronological order, then filtered by level.
 *
 * `openedAt` is a fixed-width `YYYY-MM-DD HH:mm:ss`, so comparing it as a string
 * is a chronological comparison; `from` breaks ties inside the same second.
 */
export function orderedDrafts(index: HeadingIndex, level: LevelFilter): DraftBlock[] {
  return index.drafts
    .filter((draft) => level === "all" || draft.level === level)
    .sort((left, right) => {
      if (left.openedAt !== right.openedAt) return left.openedAt < right.openedAt ? -1 : 1;
      return left.from - right.from;
    });
}

export function findDraft(index: HeadingIndex, id: string | null): DraftBlock | null {
  if (id === null) return null;
  return index.drafts.find((draft) => draft.id === id) ?? null;
}

/** The first draft at or below the cursor line, else the last one. */
export function initialDraftTarget(
  index: HeadingIndex,
  cursorLine: number,
  level: LevelFilter
): DraftBlock | null {
  const drafts = orderedDrafts(index, level);
  return (
    drafts.find((draft) => draftTitleLine(draft) >= cursorLine) ?? drafts[drafts.length - 1] ?? null
  );
}

/**
 * Moves one step chronologically. Without wrapping the current draft is
 * returned at the edges, so the caret never jumps.
 */
export function moveDraftTarget(
  index: HeadingIndex,
  current: DraftBlock | null,
  level: LevelFilter,
  direction: TravelDirection,
  wrap: boolean
): DraftBlock | null {
  const drafts = orderedDrafts(index, level);
  if (drafts.length === 0) return null;

  if (current === null) {
    return direction === "next" ? (drafts[0] ?? null) : (drafts[drafts.length - 1] ?? null);
  }

  const position = drafts.findIndex((draft) => draft.id === current.id);
  if (position === -1) {
    // The filter just changed and the current draft is outside it.
    if (direction === "next") {
      return drafts.find((draft) => draft.openedAt > current.openedAt) ?? current;
    }
    for (let index2 = drafts.length - 1; index2 >= 0; index2 -= 1) {
      const draft = drafts[index2];
      if (draft !== undefined && draft.openedAt < current.openedAt) return draft;
    }
    return current;
  }

  const next = position + (direction === "next" ? 1 : -1);
  if (next < 0 || next >= drafts.length) {
    if (!wrap) return current;
    return drafts[(next + drafts.length) % drafts.length] ?? current;
  }
  return drafts[next] ?? current;
}

export function firstDraftTarget(index: HeadingIndex, level: LevelFilter): DraftBlock | null {
  return orderedDrafts(index, level)[0] ?? null;
}

export function lastDraftTarget(index: HeadingIndex, level: LevelFilter): DraftBlock | null {
  const drafts = orderedDrafts(index, level);
  return drafts[drafts.length - 1] ?? null;
}

/** Label for a draft inside the travel HUD. */
export function draftTravelLabel(draft: DraftBlock): string {
  return `draft ${draftId(draft.level, draft.ordinal)}`;
}

/** Display text for a heading: the raw time and title, or its level. */
export function travelLabel(heading: Heading): string {
  const text = heading.text.trim();
  return text.length > 0 ? text : dimensionLabel(heading.level);
}
