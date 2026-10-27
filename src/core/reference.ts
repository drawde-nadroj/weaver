/**
 * The three reference forms, and the block ids the words form needs.
 *
 * Exactly three forms exist, and a dimension link beats a block id whenever the
 * target is a dimension: a heading link survives editing above it, while a
 * `^id` points at a position that a later edit can empty out. Block ids are for
 * prose that has no dimension to name, and they always go at the end of the
 * referenced line — never on a line of their own.
 */

import type { InsertPlan } from "./insert";

export type ReferenceKind = "note" | "dimension" | "words";

export interface Reference {
  kind: ReferenceKind;
  /** Vault-relative path of the referenced note. */
  path: string;
  basename: string;
  /** The dimension's heading text, exactly as written after the hash run. */
  headingText?: string;
  /** The dimension's clock, or null when its heading carries none. */
  headingTime?: string | null;
  headingTitle?: string;
  blockId?: string;
  /** The short alias shown instead of a long filename. */
  label: string;
}

const ID_LENGTH = 6;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const LABEL_MAX = 60;
const LABEL_WORDS = 5;

/** Collapses whitespace, keeps a few words, and stops at a readable width. */
export function shortLabel(text: string, words: number = LABEL_WORDS): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed === "") return "";

  const kept = collapsed.split(" ").slice(0, Math.max(1, Math.round(words))).join(" ");
  if (kept.length <= LABEL_MAX) return kept;
  return `${kept.slice(0, LABEL_MAX - 1).trimEnd()}…`;
}

/** A six-character `a-z0-9` id that `taken` does not already hold. */
export function newBlockId(taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    let id = "";
    for (let index = 0; index < ID_LENGTH; index += 1) {
      id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
    }
    if (!taken.has(id)) return id;
  }

  // A saturated random space still resolves deterministically, so an id is
  // always produced rather than a silent no-op.
  for (let counter = 0; counter < 36 ** ID_LENGTH; counter += 1) {
    const id = counter.toString(36).padStart(ID_LENGTH, "0");
    if (!taken.has(id)) return id;
  }
  return "0".repeat(ID_LENGTH);
}

const BLOCK_ID = /\^([a-z0-9]{6})\b/g;
const TRAILING_ID = /\s\^([a-z0-9]{6})\s*$/;

/** Every block id already in `source`, without the caret. */
export function collectBlockIds(source: string): Set<string> {
  const ids = new Set<string>();
  for (const match of source.matchAll(BLOCK_ID)) {
    const id = match[1];
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

/** The id already ending `line`, so a second one is never appended. */
export function trailingBlockId(line: string): string | null {
  return TRAILING_ID.exec(line)?.[1] ?? null;
}

/** The exact `[[…]]` text for a reference, in the form its kind dictates. */
export function referenceText(ref: Reference): string {
  if (ref.kind === "words" && ref.blockId !== undefined) {
    return `[[${ref.basename}#^${ref.blockId}|${ref.label}]]`;
  }

  if (ref.kind === "dimension" && ref.headingText !== undefined) {
    const time = ref.headingTime ?? null;
    const alias =
      time !== null
        ? `${time}${ref.headingTitle !== undefined && ref.headingTitle !== "" ? ` ${ref.headingTitle}` : ""}`
        : ref.label;
    return `[[${ref.basename}#${ref.headingText}|${alias}]]`;
  }

  // A words reference without an id addresses nothing, so it degrades to the
  // plain note form: a passage-shaped alias on a whole-note link would invite a
  // reader to look for a passage the link does not name.
  if (ref.kind === "words") return `[[${ref.basename}]]`;

  // A note form carries an alias only when the label says something the
  // basename does not.
  return ref.label !== "" && ref.label !== ref.basename
    ? `[[${ref.basename}|${ref.label}]]`
    : `[[${ref.basename}]]`;
}

/**
 * Inserts a reference at a caret, replacing `[from, to)`.
 *
 * A space is added when the caret follows a non-space character, so a link
 * never fuses with the word before it. Block ids are assigned once, by
 * `planSourceId`, which is why this planner takes a finished `Reference`.
 */
export function planReference(
  source: string,
  ref: Reference,
  from: number,
  to: number
): InsertPlan {
  const start = Math.max(0, Math.min(from, source.length));
  const end = Math.max(start, Math.min(to, source.length));
  const before = start > 0 ? (source[start - 1] ?? "") : "";
  const needsSpace = before !== "" && !/\s/.test(before);
  const link = `${needsSpace ? " " : ""}${referenceText(ref)}`;

  return {
    changes: [{ from: start, to: end, text: link }],
    selection: { from: start + link.length, to: start + link.length }
  };
}

/** `Chronomancer/2026.10.27.md` becomes `2026.10.27`. */
export function basenameOfPath(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return file.replace(/\.md$/, "");
}

/**
 * What a `✦` line should link to for a given source. The basename comes from the
 * path, so a caller cannot keep the two out of step.
 */
export function linkTargetOf(ref: {
  kind: ReferenceKind;
  path: string;
  headingText?: string;
  blockId?: string;
}): string {
  const basename = basenameOfPath(ref.path);
  if (ref.kind === "words" && ref.blockId !== undefined) return `${basename}#^${ref.blockId}`;
  if (ref.kind === "dimension" && ref.headingText !== undefined) {
    return `${basename}#${ref.headingText}`;
  }
  return basename;
}
