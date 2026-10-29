#!/usr/bin/env node
/**
 * Migrates a day note from hashes to entry markers, and threads the markers of a
 * note that already has them.
 *
 *   node scripts/migrate-dcn.mjs --dry-run <file…>
 *   node scripts/migrate-dcn.mjs --verify [--from <original>] <file…>
 *   node scripts/migrate-dcn.mjs <file…>
 *   node scripts/migrate-dcn.mjs --threads [--dry-run|--verify [--from <copy>]] <file…>
 *
 * The old grammar: the hash run is `D`, the text after it carries an optional
 * leading clock (sometimes after a `{ N }` that only repeats the hash count), and
 * the body is every line up to the next heading. The new grammar: one marker
 * line, the title on its own line, the body verbatim, and `+ 00:00:00`.
 *
 * `D` is the hash count, `C` the thread id (a root's 1-based position among
 * roots, carried unchanged by everything under it), `N` the rank by clock across
 * the file (ties by document order). A file whose lines already start with a
 * marker is left untouched by the first pass.
 *
 * `--threads` is the second pass, for a note already written in the old
 * per-parent numbering: it rewrites only the `C` field of markers, onto the
 * thread id, and leaves every other byte alone.
 *
 * Plain Node, no dependencies.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const HASH = /^(#{1,6})[ \t]+(.*)$/;
/** A line that lost its newline in front of a heading still holds its heading. */
const REPAIR = /^([^\w\s#]{0,8})(#{1,6}[ \t]+\d{1,2}:\d{2}(?::\d{2})?.*)$/;
const MARKER = /^\{[ \t]*(\d{1,3})\.(\d{1,3})\.(\d{1,6})[ \t]*\}[ \t]*-[ \t]*(\d{1,2}:\d{2}(?::\d{2})?)/;
/** The same marker with the `C` field's span marked, for the `--threads` pass. */
const MARKER_SPAN =
  /^\{[ \t]*(\d{1,3})\.(\d{1,3})\.(\d{1,6})[ \t]*\}[ \t]*-[ \t]*(\d{1,2}:\d{2}(?::\d{2})?)/d;
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

/** `D.C.N` per entry, in document order: `N` by clock, `C` by thread. */
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
  let roots = 0;

  entries.forEach((entry, index) => {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (entries[top].d < entry.d) break;
      stack.pop();
    }

    // A root is its own 1-based position; everything under it carries that id,
    // however deep the branch goes.
    entry.c = stack.length === 0 ? ++roots : entries[stack[stack.length - 1]].c;
    stack.push(index);
  });

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

/**
 * The markers of a note, with each one's `C` span, in document order.
 *
 * Frontmatter and fenced code are skipped exactly as the parser in
 * `src/core/entries.ts` skips them, so a marker the plugin does not read is a
 * marker this pass does not touch.
 */
function markerLines(lines) {
  const { block, body } = splitFrontmatter(lines);
  const offset = block === null ? 0 : block.length;
  const marked = [];
  let fence = null;

  body.forEach((line, index) => {
    if (fence !== null) {
      const closing = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line);
      const run = closing?.[2];
      if (run !== undefined && run[0] === fence.character && run.length >= fence.length) fence = null;
      return;
    }

    const open = FENCE.exec(line);
    if (open !== null) {
      const run = open[2] ?? "`";
      fence = { character: run[0], length: run.length };
      return;
    }

    const match = MARKER_SPAN.exec(line);
    if (match === null) return;

    marked.push({
      line: offset + index,
      d: Number(match[1]),
      c: Number(match[2]),
      span: match.indices[2]
    });
  });

  return marked;
}

/** Every marker's thread id, and whether it is a root, from the `d` stack. */
function threadMarkers(marked) {
  const stack = [];
  let roots = 0;

  for (const marker of marked) {
    while (stack.length > 0 && stack[stack.length - 1].d >= marker.d) stack.pop();

    marker.root = stack.length === 0;
    marker.thread = marker.root ? ++roots : stack[stack.length - 1].thread;
    stack.push(marker);
  }

  return marked;
}

/**
 * `--threads`: walks the markers and rewrites only the `C` field, onto the
 * branch's thread id. Roots already hold theirs, so the pass is a no-op on a
 * note that has been threaded once.
 */
function threadPass(source) {
  const lines = source.split("\n");
  const marked = threadMarkers(markerLines(lines));
  let changed = false;

  for (const marker of marked) {
    if (marker.c === marker.thread) continue;
    const line = lines[marker.line];
    lines[marker.line] =
      line.slice(0, marker.span[0]) + String(marker.thread) + line.slice(marker.span[1]);
    changed = true;
  }

  return { source: lines.join("\n"), changed, count: marked.length };
}

/**
 * The `--threads` checks: same lines, same `D` and `N`, every root's `C` kept,
 * every deeper `C` equal to its root's, and no non-marker byte touched.
 */
function verifyThreads(before, after) {
  const problems = [];
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");

  if (beforeLines.length !== afterLines.length) {
    problems.push(`line count changed from ${beforeLines.length} to ${afterLines.length}`);
  }

  const was = new Map(markerLines(beforeLines).map((marker) => [marker.line, marker]));
  const now = new Map(markerLines(afterLines).map((marker) => [marker.line, marker]));

  if (was.size !== now.size) problems.push(`${now.size} marker(s) for ${was.size} before`);

  const limit = Math.min(beforeLines.length, afterLines.length);
  for (let line = 0; line < limit; line += 1) {
    const previous = was.get(line);
    const current = now.get(line);

    if (previous === undefined && current === undefined) {
      if (beforeLines[line] !== afterLines[line]) problems.push(`line ${line + 1} changed outside a marker`);
      continue;
    }
    if (previous === undefined || current === undefined) {
      problems.push(`line ${line + 1} became or stopped being a marker`);
      continue;
    }

    const before = MARKER.exec(beforeLines[line] ?? "");
    const after = MARKER.exec(afterLines[line] ?? "");
    if (before?.[1] !== after?.[1]) problems.push(`line ${line + 1}: D changed`);
    if (before?.[3] !== after?.[3]) problems.push(`line ${line + 1}: N changed`);
  }

  const threaded = threadMarkers(markerLines(afterLines));
  for (const marker of threaded) {
    if (marker.c !== marker.thread) {
      problems.push(`line ${marker.line + 1}: C is ${marker.c}, thread is ${marker.thread}`);
      continue;
    }

    if (!marker.root) continue;
    const previous = was.get(marker.line);
    if (previous !== undefined && previous.c !== marker.c) {
      problems.push(`line ${marker.line + 1}: a root's C moved`);
    }
  }

  return problems;
}

/** The first pass's checks: markers, durations, stats and survivor lines. */
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
const threads = args.includes("--threads");
const fromIndex = args.indexOf("--from");
const originalPath = fromIndex >= 0 ? args[fromIndex + 1] : null;

const files = args.filter((arg, index) => {
  if (arg.startsWith("--")) return false;
  if (fromIndex >= 0 && index === fromIndex + 1) return false;
  return true;
});

if (files.length === 0) {
  console.error(
    "usage: migrate-dcn.mjs [--threads] [--dry-run|--verify [--from <original>]] <file…>"
  );
  process.exit(2);
}

let failed = false;

for (const file of files) {
  const source = readFileSync(file, "utf8");

  if (threads) {
    const result = threadPass(source);

    if (mode === "dry-run") {
      process.stdout.write(result.source);
      continue;
    }

    if (mode === "verify") {
      // Without a copy of the note as it was, the file is its own baseline: the
      // checks that survive are the ones a note must satisfy on its own.
      const before = originalPath === null ? source : readFileSync(originalPath, "utf8");
      const problems = verifyThreads(before, source);
      if (problems.length > 0) {
        failed = true;
        console.error(`${file}: ${problems.join("; ")}`);
      } else {
        console.log(`${file}: ok`);
      }
      continue;
    }

    if (!result.changed) {
      console.log(`${file}: already threaded, left untouched`);
      continue;
    }

    writeFileSync(file, result.source);
    console.log(`${file}: ${result.count} markers threaded`);
    continue;
  }

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
