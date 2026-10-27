/**
 * Threads: the rows the Tapestry shows under Day scope.
 *
 * A thread is one spark and everything under it, so a row counts the dimensions
 * it opened and names the first source recorded inside it. `index.headings`
 * already excludes draft blocks, so a count is never filtered twice.
 */

import type { Heading, HeadingIndex } from "./headings";
import type { DayMarks } from "./marks";

export interface ThreadRow {
  heading: Heading;
  /** Dimensions after this 1D, up to the next 1D or the end of the note. */
  children: number;
  hasSource: boolean;
  /** The first `✦` line's alias inside the thread, else its link target. */
  sourceLabel: string | null;
}

export function threadRows(index: HeadingIndex, marks: DayMarks): ThreadRow[] {
  const sparkIndexes = index.headings
    .map((heading, position) => ({ heading, position }))
    .filter((entry) => entry.heading.level === 1);

  return sparkIndexes.map((spark, position) => {
    const boundary = sparkIndexes[position + 1]?.heading.line ?? Number.POSITIVE_INFINITY;

    let children = 0;
    for (let next = spark.position + 1; next < index.headings.length; next += 1) {
      const candidate = index.headings[next];
      if (candidate === undefined || candidate.line >= boundary) break;
      children += 1;
    }

    const mark =
      marks.sources.find((source) => source.line > spark.heading.line && source.line < boundary) ??
      null;

    return {
      heading: spark.heading,
      children,
      hasSource: mark !== null,
      sourceLabel: mark === null ? null : (mark.label ?? mark.target)
    };
  });
}
