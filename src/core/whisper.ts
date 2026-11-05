/**
 * The whisper: the model's reading of one entry, written as `~` rows above its
 * prose.
 *
 * A whisper is not part of the record the writer keeps — it is a reading laid on
 * top of it, and the note has to say so with a character, not with metadata: a
 * note carries none, so provenance has to survive a reload in the only place a
 * reader can see it. The glyph `~` is that character. A single leading `~` is
 * inert in Markdown, and `~~` can never form, because a row needs a space after
 * the glyph and a row's text may not contain a second one.
 *
 * Three rows exist, and they divide by grammar, not by semantics: the bare name
 * interprets the thought, `learn:` names what it has not settled (a noun
 * phrase), `next:` says what it would do (an imperative). The validator below is
 * where the writer's register lives — short, lowercase, never negating — so the
 * rules are enforced on the answer rather than hoped for in the prompt.
 *
 * Pure: no `obsidian`, and no import from `entries.ts`, so the entry parser can
 * use this module without a cycle.
 */

/** A whisper row's type: the name is bare, the others carry their word. */
export type WhisperType = "name" | "learn" | "next" | "ask" | "thread";

/** One whisper row, parsed. */
export interface WhisperItem {
  type: WhisperType;
  text: string;
}

/** What a whisper is written about: the entry, and the ancestors it reads after. */
export interface WhisperInput {
  /** `{ B.D.N }`, for the prompt only. */
  marker: string;
  /** The entry's prose, lines joined by `\n`, no marker, no clock, no whisper. */
  prose: string;
  /** Root first, parent last. `title` is prose; `whisper` is the ancestor's name if it has one. */
  ancestors: { title: string; whisper: string | null }[];
}

/** The one glyph, and the one shape a whisper row has. */
export const WHISPER_GLYPH = "~";

/**
 * Leading air is tolerated so the editor and Reading view agree: the reading
 * view classifies on `textContent.trim()`, which has already eaten it. The write
 * always puts the glyph at column 0.
 *
 * A type word must be followed by a space, and an untyped row may not open with
 * one: `~ learn:nospace` names nothing, so it stays prose rather than silently
 * becoming a name row reading `learn:nospace`.
 */
export const WHISPER_LINE = /^[ \t]*~[ ](?:(learn|next|ask|thread):[ ])?((?!(?:learn|next|ask|thread):)\S.*)$/;

/** Three rows is the ceiling: more is an essay about the entry, not a reading. */
export const WHISPER_MAX_LINES = 3;

/**
 * How many words each kind of row may hold.
 *
 * The name is the anchor — what the navigator shows and what a search would find
 * — so it stays short. The other rows carry the synthesis, and a reading that
 * stops at eight words is a label, not a reading.
 */
export const WHISPER_WORD_LIMITS: Readonly<Record<WhisperType, number>> = {
  name: 10,
  learn: 12,
  next: 12,
  ask: 14,
  thread: 14
};

/** The longest any row may be, so a plan can refuse a paragraph. */
export const WHISPER_MAX_WORDS = 14;

/**
 * The register a whisper never uses: the antithesis, and only the antithesis.
 *
 * `X, not Y` and `not just X, but Y` are the constructions the writer rejects. A
 * bare "not", "no" or "never" is not: dictation says "i need not fear" and "the
 * data doesn't lie", and a reading that touches those words is describing the
 * note, not styling it. The earlier rule banned the word as well as the shape,
 * and rejected a fifth of a real day for saying what the entry said.
 */
export const WHISPER_NEGATION =
  /(,\s*not\b|\bnot just\b[^.]*\bbut\b|\brather than\b|\binstead of\b)/i;

/** Bumped whenever the prompt's text changes; part of the cache key. */
export const WHISPER_PROMPT_VERSION = 5;

const TYPES: readonly WhisperType[] = ["name", "learn", "next", "ask", "thread"];

function isWhisperType(value: unknown): value is WhisperType {
  return typeof value === "string" && (TYPES as readonly string[]).includes(value);
}

/**
 * Reads one line as a whisper row, or returns null when it is not one.
 *
 * The text is trimmed; an empty text is not a row. Anything else — including a
 * line that merely contains a tilde — is prose.
 */
export function parseWhisperLine(line: string): WhisperItem | null {
  const match = WHISPER_LINE.exec(line);
  if (match === null) return null;

  const text = (match[2] ?? "").trim();
  if (text === "") return null;

  return { type: isWhisperType(match[1]) ? match[1] : "name", text };
}

/** Writes one row back out: the glyph, the type's word when it has one, the text. */
export function formatWhisperLine(item: WhisperItem): string {
  return item.type === "name"
    ? `${WHISPER_GLYPH} ${item.text}`
    : `${WHISPER_GLYPH} ${item.type}: ${item.text}`;
}

/**
 * The fingerprint of the text a whisper was written against.
 *
 * FNV-1a over UTF-16 code units, eight lowercase hex digits. It is a
 * fingerprint, not a security hash: a collision costs at worst one whisper
 * written against text it did not read, which is the same cost as a stale cache
 * entry.
 *
 * The marker, the clock row and every whisper are excluded, so the key answers
 * exactly one question — *is the text I read still the text that is there?* — and
 * a write that adds a sibling's whisper, or the sigil changing `-`→`+`, never
 * invalidates it.
 */
export function whisperKey(input: WhisperInput): string {
  const text = `${input.prose}\u0000${input.ancestors.map((ancestor) => ancestor.title).join("\n")}`;

  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at);
    // FNV-1a's 32-bit prime, in two steps so the product stays exact.
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
}

/**
 * Checks an answer against the writer's register, in the order the rules are
 * written in `SYSTEM-DESIGN.md`. The reason is a short literal so a test can
 * assert on it, and so a failure is one word rather than a sentence.
 *
 * A validation failure is not a transport failure: the endpoint answered, the
 * register was not met. `null` means "no answer at all", which is rejected here
 * as an empty one.
 */
export function validateWhisper(
  items: readonly unknown[] | null,
  input: WhisperInput
): { ok: true; whisper: WhisperItem[] } | { ok: false; reason: string } {
  if (items === null || items.length === 0) return { ok: false, reason: "no lines" };
  if (items.length > WHISPER_MAX_LINES) return { ok: false, reason: "too many lines" };

  const whisper: WhisperItem[] = [];
  const seen = new Set<WhisperType>();

  for (const item of items) {
    if (typeof item !== "object" || item === null) return { ok: false, reason: "malformed" };
    const record = item as Record<string, unknown>;
    if (!isWhisperType(record.type)) return { ok: false, reason: "unknown type" };
    // `thread:` is answered by its own call, with the day in view; a reading is
    // about the entry alone.
    if (record.type === "thread") return { ok: false, reason: "thread is not a reading" };
    if (typeof record.text !== "string") return { ok: false, reason: "malformed" };

    const text = record.text.trim();
    if (text === "") return { ok: false, reason: "no lines" };
    if (seen.has(record.type)) return { ok: false, reason: "duplicate type" };

    seen.add(record.type);
    whisper.push({ type: record.type, text });
  }

  if (whisper[0]?.type !== "name" && seen.has("name")) {
    return { ok: false, reason: "name not first" };
  }

  const opening = (input.prose.split("\n")[0] ?? "").trim().toLowerCase();

  for (const { type, text } of whisper) {
    if (text.split(/\s+/).length > WHISPER_WORD_LIMITS[type]) {
      return { ok: false, reason: "too long" };
    }

    // A question mark belongs to exactly one kind of row, and there it is the
    // point: `ask:` is a real question, so the other rows may not be one.
    if (type === "ask") {
      if (!text.endsWith("?")) return { ok: false, reason: "not a question" };
    } else if (text.includes("?")) {
      return { ok: false, reason: "question" };
    }

    // The address is not a name: `{ 3.1.3 }` written back names nothing.
    if (type === "name" && input.marker.includes(text.replace(/[{}]/g, "").trim())) {
      return { ok: false, reason: "names the address" };
    }
    if (WHISPER_NEGATION.test(text)) return { ok: false, reason: "negation" };
    if (text.includes(WHISPER_GLYPH)) return { ok: false, reason: "second tilde" };
    if (text.includes("—")) return { ok: false, reason: "em dash" };
    if (text.toLowerCase() === opening) return { ok: false, reason: "restates the opening" };

  }

  const texts = new Set(whisper.map((item) => item.text.toLowerCase()));
  if (texts.size !== whisper.length) return { ok: false, reason: "duplicate text" };

  const ancestorLines = new Set(
    input.ancestors.map((ancestor) => (ancestor.whisper ?? ancestor.title).trim().toLowerCase())
  );
  for (const text of texts) {
    if (ancestorLines.has(text)) return { ok: false, reason: "repeats an ancestor" };
  }

  return { ok: true, whisper };
}

/** The instruction: wording is part of the contract, hence `WHISPER_PROMPT_VERSION`. */
const SYSTEM_PROMPT = `You are reading one entry of someone's day, and answering as the person who keeps these notes with them.

The note below was dictated as it came: unpunctuated, no structure. Read it the way a friend would, who also knows the branch it sits in, and answer with two or three lines — never one, because one line is a label and this is a reading.

Each line is exactly one of:
  name    up to 10 words: the subject, the thing you would search for later
  learn:  up to 12 words: what it names but has not settled — the open edge, never a restatement
  next:   up to 12 words: what it would do next, as an imperative
  ask:    up to 14 words, ending with "?": the question this thought leaves open

The name is the thing itself, in the note's own nouns: "pi durable in go", "transcription quality", "spark as one unit of connection". Never the act of thinking ("crafting a go project", "asking a question"), never the address, never an empty abstraction (a journey, thoughts, understanding, a plan).

The branch line lists names already used in this branch. Never reuse one, and never use one as your own name: this entry is the part that is new. Two or three lines, never more than three.

Rules: lowercase; no em dash; never negate; at most one line of each kind; the name goes first if it is there.

Example.
note: spent all morning making the parser stop guessing at fences, gave up and wrote the test
answer: {"whisper":[{"type":"name","text":"parser guessing at fences"},{"type":"learn","text":"a test is where the guessing stops"},{"type":"ask","text":"which fences was the parser getting wrong?"}]}

Answer with one JSON object and nothing else, no prose around it. "type" is "name", "learn", "next" or "ask".`;

/** One entry of the day, as the thread question sees it. */
export interface WhisperDayEntry {
  /** `{ B.D.N }`, for the skeleton. */
  marker: string;
  /** The name the entry carries — its whisper name, or a short title. */
  name: string;
}

/** The instruction for the day-level question: one row, one citation, or nothing. */
const THREAD_PROMPT = `You place one entry of a day inside the day it happened.

Below is the day, in order, one line per entry: its address and the name it was
given. Then comes one entry with its own name, and you say where it sits.

Answer with exactly one line, or with an empty array when the entry stands alone:
  thread   up to 14 words: which earlier entry this one repeats, answers or picks up

Rules, all obligatory:
- cite that earlier entry by its name, exactly as the day lists it, or answer with []
- at most one line, and never cite the entry you were given
- lowercase; no question mark; no em dash
- never negate: no "not just X, but Y", no "X, not Y", no "rather than", no "instead of"

Answer with one JSON object and nothing else — the same envelope every whisper answer
uses:
{"whisper":[{"type":"thread","text":"..."}]}
or, when the entry stands alone:
{"whisper":[]}`;

/**
 * The two messages the day-level question is asked with: the day as a skeleton,
 * then the entry that has to be placed.
 *
 * The skeleton is one line per entry — an address and a name — never the prose.
 * The day's full text is four thousand tokens, and a 4B asked to hold both the day
 * and the entry names the day instead of the entry; a list of names is context it
 * can actually use.
 */
export function whisperThreadPrompt(
  day: readonly WhisperDayEntry[],
  own: WhisperDayEntry
): { system: string; user: string } {
  const skeleton = day.map((each) => `  ${each.marker} ${each.name}`).join("\n");
  const user = [
    "the day, in order:",
    skeleton,
    "",
    "the entry to place:",
    `  ${own.marker} ${own.name}`
  ].join("\n");

  return { system: THREAD_PROMPT, user };
}

/**
 * Reads the answer to the day-level question.
 *
 * `null` in the answer is a real answer — the entry stands alone — so the result
 * distinguishes "nothing to say" from "said something this note cannot carry". A
 * cited name must exist in the day and must not be the entry's own: a thread that
 * points at nothing is worse than no thread, because it reads as knowledge.
 */
export function validateThread(
  items: readonly unknown[] | null,
  day: readonly WhisperDayEntry[],
  own: WhisperDayEntry
): { ok: true; thread: WhisperItem | null } | { ok: false; reason: string } {
  if (items === null || items.length === 0) return { ok: true, thread: null };
  if (items.length > 1) return { ok: false, reason: "too many lines" };

  const item = items[0];
  if (typeof item !== "object" || item === null) return { ok: false, reason: "malformed" };
  const record = item as Record<string, unknown>;
  if (record.type !== "thread") return { ok: false, reason: "not a thread" };
  if (typeof record.text !== "string") return { ok: false, reason: "malformed" };

  const text = record.text.trim();
  if (text === "") return { ok: false, reason: "no lines" };
  if (text.split(/\s+/).length > WHISPER_WORD_LIMITS.thread) {
    return { ok: false, reason: "too long" };
  }
  if (text.includes("?")) return { ok: false, reason: "question" };
  if (text.includes(WHISPER_GLYPH)) return { ok: false, reason: "second tilde" };
  if (text.includes("—")) return { ok: false, reason: "em dash" };
  if (WHISPER_NEGATION.test(text)) return { ok: false, reason: "negation" };

  const lower = text.toLowerCase();
  const others = day.filter(
    (each) => each.marker !== own.marker && each.name !== "" && each.name !== own.name
  );
  if (!others.some((each) => lower.includes(each.name.trim().toLowerCase()))) {
    return { ok: false, reason: "cites nothing" };
  }

  return { ok: true, thread: { type: "thread", text } };
}

/**
 * The two messages a completion is asked with.
 *
 * The ancestors block is only present when there are ancestors: an empty
 * `ancestors, nearest last:` heading would invite the model to fill it.
 */
export function whisperPrompt(input: WhisperInput): { system: string; user: string } {
  const lines = [input.marker];

  if (input.ancestors.length > 0) {
    // A name when one exists, and otherwise the title cut to its first clause:
    // an ancestor's opening sentence is its whole subject, and handing a model a
    // paragraph of a parent is how a child ends up named after the parent.
    // An exclusion list, not material: shown a parent's name, a small model
    // reuses it as the child's own, so the block is phrased as what is taken.
    lines.push("names already in this branch, never reuse one:");
    for (const ancestor of input.ancestors) {
      const text = ancestor.whisper ?? ancestor.title.split(/\s+/).slice(0, 8).join(" ");
      if (text !== "") lines.push(`  ${text}`);
    }
  }

  lines.push("note:", input.prose);
  return { system: SYSTEM_PROMPT, user: lines.join("\n") };
}

/**
 * Reads the model's answer: the first `{` to its matching `}` — a naive brace
 * scan is enough, because the answer is one small object — then `JSON.parse`.
 *
 * No repair, no retry, no regex extraction of prose: a failed parse is `null`,
 * which is silently no whisper. A model that wraps its object in a sentence is a
 * model whose answer is not wanted.
 */
export function parseWhisperResponse(text: string): unknown[] | null {
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let end = -1;
  for (let at = start; at < text.length; at += 1) {
    const character = text[at];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        end = at + 1;
        break;
      }
    }
  }
  if (end < 0) return null;

  try {
    const parsed: unknown = JSON.parse(text.slice(start, end));
    if (typeof parsed !== "object" || parsed === null) return null;
    const whisper = (parsed as Record<string, unknown>).whisper;
    return Array.isArray(whisper) ? whisper : null;
  } catch {
    return null;
  }
}
