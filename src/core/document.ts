/**
 * The line-level facts every parser in Weaver shares: where each line starts,
 * where the frontmatter block ends, and which lines are fenced code.
 *
 * Both the entry parser and the close parser ask exactly these three questions,
 * so they are answered once, here, and cannot disagree.
 */

export interface CodeFence {
  /** Line index of the opening fence. */
  start: number;
  /** Line index of the closing fence, or the last line when unclosed. */
  end: number;
  closed: boolean;
}

/** Every line carrying a fence delimiter, plus the fields it sits inside. */
export interface FenceScan {
  /** Line indices inside a fence, fence lines included. */
  inside: Set<number>;
  fences: CodeFence[];
  unclosed: boolean;
}

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^( {0,3})(`{3,}|~{3,})[ \t]*$/;
const FRONTMATTER_DELIMITER = /^(---|\.\.\.)[ \t]*$/;

/** Absolute start offset of every line in `source`. */
export function lineStartsOf(source: string): number[] {
  const lines = source.split("\n");
  const starts: number[] = new Array(lines.length);
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    starts[index] = offset;
    offset += (lines[index]?.length ?? 0) + 1;
  }
  return starts;
}

/** Where the frontmatter is: none, closed at `end`, or unclosed. */
export interface FrontmatterScan {
  kind: "none" | "closed" | "unclosed";
  end: number;
}

/** Locates the leading frontmatter block, if the document opens with one. */
export function scanFrontmatter(lines: readonly string[]): FrontmatterScan {
  if (lines.length === 0) return { kind: "none", end: -1 };
  const first = lines[0] ?? "";
  if (!FRONTMATTER_DELIMITER.test(first) || !first.startsWith("---")) {
    return { kind: "none", end: -1 };
  }
  for (let index = 1; index < lines.length; index += 1) {
    if (FRONTMATTER_DELIMITER.test(lines[index] ?? "")) return { kind: "closed", end: index };
  }
  return { kind: "unclosed", end: -1 };
}

/** Every fenced code block, and the lines they occupy. */
export function scanFences(lines: readonly string[]): FenceScan {
  const inside = new Set<number>();
  const fences: CodeFence[] = [];
  let open: { character: string; length: number; start: number } | null = null;

  for (let line = 0; line < lines.length; line += 1) {
    const raw = lines[line] ?? "";

    if (open !== null) {
      inside.add(line);
      const run = FENCE_CLOSE.exec(raw)?.[2];
      if (run !== undefined && run[0] === open.character && run.length >= open.length) {
        fences.push({ start: open.start, end: line, closed: true });
        open = null;
      }
      continue;
    }

    const run = FENCE_OPEN.exec(raw)?.[2];
    if (run === undefined) continue;

    open = { character: run[0] ?? "`", length: run.length, start: line };
    inside.add(line);
  }

  if (open !== null) {
    fences.push({ start: open.start, end: Math.max(open.start, lines.length - 1), closed: false });
  }

  return { inside, fences, unclosed: open !== null };
}
