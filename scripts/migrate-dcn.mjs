#!/usr/bin/env node
/**
 * Migrates a day note from hashes to entry markers.
 *
 *   node scripts/migrate-dcn.mjs --dry-run <file…>
 *   node scripts/migrate-dcn.mjs --verify [--from <original>] <file…>
 *   node scripts/migrate-dcn.mjs <file…>
 *
 * The old grammar: the hash run is `D`, the text after it carries an optional
 * leading clock (sometimes after a `{ N }` that only repeats the hash count), and
 * the body is every line up to the next heading. The new grammar: one marker
 * line, the title on its own line, the body verbatim, and `+ 00:00:00`.
 *
 * `D` is the hash count, `C` the 1-based ordinal among siblings in document
 * order, `N` the rank by clock across the file (ties by document order). A file
 * whose lines already start with a marker is left untouched.
 *
 * Plain Node, no dependencies.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const HASH = /^(#{1,6})[ \t]+(.*)$/;
/** A line that lost its newline in front of a heading still holds its heading. */
const REPAIR = /^([^\w\s#]{0,8})(#{1,6}[ \t]+\d{1,2}:\d{2}(?::\d{2})?.*)$/;
const MARKER = /^\{[ \t]*(\d{1,3})\.(\d{1,3})\.(\d{1,6})[ \t]*\}[ \t]*-[ \t]*(\d{1,2}:\d{2}(?::\d{2})?)/;
const BRACE = /^\{\s*\d{1,3}\s*\}(?:[ \t]*-[ \t]*)?/;
const CLOCK = /^(\d{1,2}:\d{2}(?::\d{2})?)\b/;
const DELIMITER = /^(---|\.\.\.)[ \t]*$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})/;
const DURATION = /^[+\-=][ \t]+\d{2,}:[0-5]\d:[0-5]\d[ \t]*$/;
const KEY = /^([A-Za-z0-9_-]+)\s*:/;

const REMOVED_KEYS = new Set(["sparks", "dimensions", "sources"]);
const DURATION_LINE = "+ 00:00:00";

function pad(value) {
  return String(value).padStart(2, "0");
}

function normalizeClock(clock) {
  const [hours = "0", minutes = "00", seconds = "00"] = clock.split(":");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/** `2026.10.26` or `2026-10-26` becomes `2026-10-26`; anything else is null. */
function dayKeyFromName(name) {
  const match = /^(\d{4})[.-](\d{2})[.-](\d{2})$/.exec(name);
  return match === null ? null : `${match[1]}-${match[2]}-${match[3]}`;
}

function splitFrontmatter(lines) {
  if (lines.length === 0) return { block: null, body: lines };
  const first = lines[0] ?? "";
  if (!first.startsWith("---") || !DELIMITER.test(first)) return { block: null, body: lines };

  for (let index = 1; index < lines.length; index += 1) {
    if (DELIMITER.test(lines[index] ?? "")) {
      return { block: lines.slice(0, index + 1), body: lines.slice(index + 1) };
    }
  }
  return { block: null, body: lines };
}

/** Splits a heading's text into its clock and its title. */
function readClock(text) {
  const withoutBrace = text.replace(BRACE, "");
  const match = CLOCK.exec(withoutBrace);
  if (match === null) return { time: null, title: withoutBrace.trim() };

  let rest = withoutBrace.slice(match[0].length);
  if (rest.startsWith(" - ")) rest = rest.slice(3);
  else if (rest.trim() === "-") rest = "";

  return { time: normalizeClock(match[1] ?? "0:00"), title: rest.trim() };
}

/**
 * Repairs a heading whose newline was lost: the characters before it belong to
 * the prose above, the heading itself is parsed as one.
 */
function repair(body) {
  const lines = [];
  for (const line of body) {
    const match = REPAIR.exec(line);
    if (match === null) {
      lines.push(line);
      continue;
    }
    if ((match[1] ?? "") !== "") lines.push(match[1].trimEnd());
    lines.push(match[2]);
  }
  return lines;
}

function parseOld(body) {
  const preamble = [];
  const entries = [];
  let current = null;
  let fence = null;

  for (const line of body) {
    if (fence !== null) {
      if (current !== null) current.body.push(line);
      else preamble.push(line);

      const closing = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line);
      const run = closing?.[2];
      if (run !== undefined && run[0] === fence.character && run.length >= fence.length) fence = null;
      continue;
    }

    const open = FENCE.exec(line);
    if (open !== null) {
      const run = open[2] ?? "`";
      fence = { character: run[0], length: run.length };
      if (current !== null) current.body.push(line);
      else preamble.push(line);
      continue;
    }

    const heading = HASH.exec(line);
    if (heading !== null) {
      const hashRun = heading[1] ?? "#";
      const { time, title } = readClock(heading[2] ?? "");
      current = { d: hashRun.length, time, title, body: [] };
      entries.push(current);
      continue;
    }

    if (current !== null) current.body.push(line);
    else preamble.push(line);
  }

  return { preamble, entries };
}

/** `D.C.N` per entry, in document order. */
function number(entries) {
  const timed = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.time !== null)
    .sort((left, right) => {
      const a = secondsOf(left.entry.time);
      const b = secondsOf(right.entry.time);
      return a === b ? left.index - right.index : a - b;
    });

  let next = timed.length + 1;
  timed.forEach(({ entry }, rank) => {
    entry.n = rank + 1;
  });

  for (const entry of entries) {
    if (entry.n === undefined) entry.n = next++;
  }

  const stack = [];
  const counts = new Map([[-1, 0]]);

  for (const entry of entries) {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (entries[top].d < entry.d) break;
      stack.pop();
    }
    const parent = stack.length > 0 ? stack[stack.length - 1] : -1;
    const ordinal = (counts.get(parent) ?? 0) + 1;
    counts.set(parent, ordinal);
    entry.c = ordinal;
    stack.push(entries.indexOf(entry));
  }

  return entries;
}

function secondsOf(time) {
  const [hours = "0", minutes = "0", seconds = "0"] = time.split(":");
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

function rewriteFrontmatter(block, day, travels, depth) {
  const desired = [];
  if (day !== null) desired.push(["date", day]);
  desired.push(["travels", String(travels)], ["depth", String(depth)], ["duration", "00:00:00"]);

  if (block === null) {
    return ["---", ...desired.map(([key, value]) => `${key}: ${value}`), "---", ""];
  }

  const wanted = new Map(desired);
  const seen = new Set();
  const kept = [];

  for (const line of block.slice(1, -1)) {
    const key = KEY.exec(line)?.[1];
    if (key !== undefined && REMOVED_KEYS.has(key)) continue;
    if (key !== undefined && wanted.has(key)) {
      seen.add(key);
      kept.push(`${key}: ${wanted.get(key)}`);
      continue;
    }
    kept.push(line);
  }

  for (const [key, value] of desired) {
    if (!seen.has(key)) kept.push(`${key}: ${value}`);
  }

  return ["---", ...kept, "---", ""];
}

/** The migrated text, plus what the migration saw. */
function migrate(source, path) {
  const lines = source.split("\n");
  const { block, body } = splitFrontmatter(lines);

  if (body.some((line) => MARKER.test(line))) {
    return { source, entries: [], skipped: true };
  }

  const { preamble, entries } = parseOld(repair(body));
  const numbered = number(entries);

  const out = [];
  if (preamble.length > 0) out.push(...preamble, "");

  for (const entry of numbered) {
    out.push(`{ ${entry.d}.${entry.c}.${entry.n} } - ${entry.time ?? "00:00:00"}`);
    if (entry.title !== "") out.push(entry.title);

    const prose = [...entry.body];
    while (prose.length > 0 && (prose[prose.length - 1] ?? "").trim() === "") prose.pop();
    out.push(...prose, DURATION_LINE, "");
  }

  while (out.length > 0 && (out[out.length - 1] ?? "") === "") out.pop();

  const day = dayKeyFromName(basename(path).replace(/\.md$/, ""));
  const depth = numbered.reduce((most, entry) => Math.max(most, entry.d), 0);
  const front = rewriteFrontmatter(block, day, numbered.length, depth);

  const text = [...front, ...out].join("\n");
  return { source: text.endsWith("\n") ? text : `${text}\n`, entries: numbered, skipped: false };
}

/** The non-heading lines the original held, in order, blanks removed. */
function survivingLines(source) {
  const { body } = splitFrontmatter(source.split("\n"));
  const { preamble, entries } = parseOld(repair(body));

  const lines = [...preamble.filter((line) => line.trim() !== "").map((line) => line.trimEnd())];
  for (const entry of entries) {
    if (entry.title !== "") lines.push(entry.title);
    for (const line of entry.body) {
      if (line.trim() !== "") lines.push(line.trimEnd());
    }
  }
  return lines;
}

function frontmatterValue(source, key) {
  const { block } = splitFrontmatter(source.split("\n"));
  if (block === null) return null;

  for (const line of block) {
    const match = new RegExp(`^${key}\\s*:\\s*(.*)$`).exec(line);
    if (match !== null) return (match[1] ?? "").trim();
  }
  return null;
}

function verify(source, original) {
  const problems = [];
  const lines = source.split("\n");
  const { body } = splitFrontmatter(lines);

  const markers = body.filter((line) => MARKER.test(line));
  const durations = body.filter((line) => DURATION.test(line));
  const hashes = body.filter((line) => line.startsWith("#"));

  if (hashes.length > 0) problems.push(`${hashes.length} heading line(s) left`);

  const travels = frontmatterValue(source, "travels");
  const depth = frontmatterValue(source, "depth");

  if (travels !== String(markers.length)) {
    problems.push(`travels is ${String(travels)}, marker count is ${markers.length}`);
  }
  if (durations.length !== markers.length) {
    problems.push(`${durations.length} duration line(s) for ${markers.length} markers`);
  }

  const deepest = markers.reduce((most, line) => {
    const match = MARKER.exec(line);
    return Math.max(most, Number(match?.[1] ?? 0));
  }, 0);
  if (depth !== String(deepest)) problems.push(`depth is ${String(depth)}, deepest D is ${deepest}`);

  for (const line of markers) {
    if (!/^\{ \d+\.\d+\.\d+ \} - \d{2}:\d{2}:\d{2}$/.test(line)) {
      problems.push(`malformed marker: ${line}`);
    }
  }

  if (original !== null) {
    const wanted = survivingLines(original);
    const present = body.map((line) => line.trimEnd());
    let cursor = 0;
    for (const line of wanted) {
      const found = present.indexOf(line, cursor);
      if (found < 0) {
        problems.push(`missing line: ${line.slice(0, 60)}`);
        break;
      }
      cursor = found + 1;
    }
  }

  return problems;
}

const args = process.argv.slice(2);
const mode = args.includes("--verify") ? "verify" : args.includes("--dry-run") ? "dry-run" : "write";
const fromIndex = args.indexOf("--from");
const originalPath = fromIndex >= 0 ? args[fromIndex + 1] : null;

const files = args.filter((arg, index) => {
  if (arg.startsWith("--")) return false;
  if (fromIndex >= 0 && index === fromIndex + 1) return false;
  return true;
});

if (files.length === 0) {
  console.error("usage: migrate-dcn.mjs [--dry-run|--verify [--from <original>]] <file…>");
  process.exit(2);
}

let failed = false;

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const result = migrate(source, file);

  if (mode === "dry-run") {
    process.stdout.write(result.source);
    continue;
  }

  if (mode === "verify") {
    const original = originalPath === null ? null : readFileSync(originalPath, "utf8");
    const problems = verify(source, original);
    if (problems.length > 0) {
      failed = true;
      console.error(`${file}: ${problems.join("; ")}`);
    } else {
      console.log(`${file}: ok`);
    }
    continue;
  }

  if (result.skipped) {
    console.log(`${file}: already migrated, left untouched`);
    continue;
  }

  writeFileSync(file, result.source);
  console.log(`${file}: ${result.entries.length} entries`);
}

process.exit(failed ? 1 : 0);
