import type { HeadingIndex } from "./headings";

/** Deep headings (H7 and beyond) have no Obsidian default size or style. */
export const DEEP_MIN_LEVEL = 7;

export interface LineClassSpec {
  from: number;
  classes: string[];
}

export interface ReplaceSpec {
  from: number;
  to: number;
}

export interface OffsetRange {
  from: number;
  to: number;
}

/** One line-class decoration per heading, marking its level for coloring. */
export function lineClassSpecs(index: HeadingIndex, deepMinLevel = DEEP_MIN_LEVEL): LineClassSpec[] {
  return index.headings.map((heading) => {
    const deep = heading.level >= deepMinLevel;
    return {
      from: heading.from,
      classes: deep
        ? ["weaver-dimension-line", `weaver-h${heading.level}`, "weaver-deep"]
        : ["weaver-dimension-line", `weaver-h${heading.level}`]
    };
  });
}

export interface DeepHashOptions {
  index: HeadingIndex;
  /** Current selection in document offsets. */
  selection: OffsetRange;
  /** Ranges currently rendered by the editor viewport. */
  visible: readonly OffsetRange[];
  /** False in Source mode, where hashes must stay visible. */
  livePreview: boolean;
  /** The `deepHeadingLivePreview` setting. */
  enabled: boolean;
  deepMinLevel?: number;
}

/**
 * Ranges of hash runs to hide. Hashes stay visible while the cursor is on the
 * heading's own line, so the level can always be edited.
 */
export function deepHashHideSpecs(options: DeepHashOptions): ReplaceSpec[] {
  const { index, selection, visible, livePreview, enabled } = options;
  const deepMinLevel = options.deepMinLevel ?? DEEP_MIN_LEVEL;

  if (!livePreview || !enabled) return [];

  const specs: ReplaceSpec[] = [];

  for (const heading of index.headings) {
    if (heading.level < deepMinLevel) continue;
    if (!visible.some((range) => heading.from >= range.from && heading.from < range.to)) continue;
    // Keep the hashes whenever the selection touches the heading's own line,
    // including a caret sitting exactly at its first or last offset.
    if (selection.from <= heading.to && selection.to >= heading.from) continue;
    specs.push({ from: heading.hashFrom, to: heading.hashTo });
  }

  return specs;
}
