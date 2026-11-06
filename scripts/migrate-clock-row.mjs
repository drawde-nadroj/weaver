#!/usr/bin/env node
/**
 * Migrates a day note from the address's own clock to the clock row.
 *
 *   node scripts/migrate-clock-row.mjs --dry-run <file…>
 *   node scripts/migrate-clock-row.mjs --verify [--from <original>] <file…>
 *   node scripts/migrate-clock-row.mjs <file…>
 *
 * The old grammar put the moment on the address:
 *
 *   { 2.1.3 } - 13:27:43
 *   the prose
 *   + 00:04:12
 *
 * The new grammar gives the address its own line and puts the duration and the
 * moment together on the entry's last line:
 *
 *   { 2.1.3 }
 *   the prose
 *   + 00:04:12 13:27:43
 *
 * A title written after the old clock moves to the line below the address, where
 * the parser already reads it. An entry with no duration line gains `+ 00:00:00`
 * (it was settled: nothing was running). Every other byte is left alone —
 * frontmatter, fenced code, prose, blank lines and the close mark are copied
 * verbatim, which is what `--verify` checks against `--from`.
 *
 * One pass, and the plugin refuses a note this script has not touched: the new
 * address accepts anything after it, so an unmigrated note would parse as an
 * entry whose prose begins with its own clock. Plain Node, no dependencies.
 */

import { readFileSync, writeFileSync } from "node:fs";

const DELIMITER = /^(---|\.\.\.)[ \t]*$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})/;
/** `{ B.D.N } - HH:MM:SS` with an optional title after it. */
const LEGACY = /^\{[ \t]*(\d{1,3})\.(\d{1,3})\.(\d{1,6})[ \t]*\}[ \t]*-[ \t]*(\d{1,2}:\d{2}(?::\d{2})?)(.*)$/;
/** Any address, old or new: the boundary between two entries. */
const ADDRESS = /^\{[ \t]*\d{1,3}\.\d{1,3}\.\d{1,6}[ \t]*\}/;
/** A clock row's duration half, as the old duration line always was. */
const DURATION = /^([+\-=])[ \t]+(\d{2,}:[0-5]\d:[0-5]\d)[ \t]*$/;
/** The day's close mark: a decision, not the entry's prose. */
const CLOSE = /^✓[ \t]+\d{1,2}:\d{2}(?::\d{2})?$/;
/** A clock row, duration first; the parser's own shape, lightly. */
const CLOCK_ROW = /^([+\-=])[ \t]+(\d{2,}:[0-5]\d:[0-5]\d)(?:[ \t]+(\d{1,2}:\d{2}(?::\d{2})?))?[ \t]*$/;

function pad(value) {
  return String(value).padStart(2, "0");
}

function normalizeClock(clock) {
  const [hours = "0", minutes = "00", seconds = "00"] = clock.split(":");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/** Frontmatter and fenced code are text, exactly as the plugin reads them. */
function fenceState(lines) {
  const inside = new Set();
  let fence = null;

  lines.forEach((line, index) => {
    if (fence !== null) {
      inside.add(index);
      const closing = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line);
      const run = closing?.[2];
      if (run !== undefined && run[0] === fence.character && run.length >= fence.length) fence = null;
      return;
    }

    const open = FENCE.exec(line);
    if (open === null) return;
    const run = open[2] ?? "`";
    fence = { character: run[0], length: run.length };
    inside.add(index);
  });

  return inside;
}

function splitFrontmatter(lines) {
  if (lines.length === 0 || !DELIMITER.test(lines[0] ?? "")) return { block: null, body: lines };
  for (let index = 1; index < lines.length; index += 1) {
    if (DELIMITER.test(lines[index] ?? "")) {
      return { block: lines.slice(0, index + 1), body: lines.slice(index + 1) };
    }
  }
  return { block: null, body: lines };
}

/** One old entry: its line range, its moment, and its optional duration. */
function oldEntries(body, skip) {
  const entries = [];
  let current = null;

  body.forEach((line, index) => {
    if (skip.has(index)) return;

    if (ADDRESS.test(line)) {
      if (current !== null) {
        current.end = index;
        entries.push(current);
        current = null;
      }
      const legacy = LEGACY.exec(line);
      if (legacy === null) return;
      current = {
        line: index,
        b: legacy[1],
        d: legacy[2],
        n: legacy[3],
        time: normalizeClock(legacy[4] ?? "0:00"),
        title: (legacy[5] ?? "").trim(),
        end: body.length
      };
      return;
    }
  });

  if (current !== null) entries.push(current);
  return entries;
}

/** The migrated text, plus what the pass saw. */
function migrate(source) {
  const lines = source.split("\n");
  const { block, body } = splitFrontmatter(lines);
  const skip = fenceState(body);
  const entries = oldEntries(body, skip);

  if (entries.length === 0) return { source, entries: [], changed: false };

  // Work backwards so an insertion never shifts an earlier entry's indices.
  for (const entry of [...entries].reverse()) {
    let durationAt = -1;
    for (let index = entry.line + 1; index < entry.end; index += 1) {
      if (skip.has(index)) continue;
      if (DURATION.test(body[index] ?? "")) {
        durationAt = index;
        break;
      }
    }

    const duration =
      durationAt < 0
        ? "+ 00:00:00"
        : (body[durationAt] ?? "").trim().replace(/[ \t]+/g, " ");
    const clockRow = `${duration} ${entry.time}`;

    if (durationAt >= 0) {
      body[durationAt] = clockRow;
    } else {
      // The clock row is the entry's last line: after its last non-blank prose,
      // before the blank separator — and before the day's close mark, which is
      // not prose the entry wrote.
      let after = entry.line;
      for (let index = entry.line + 1; index < entry.end; index += 1) {
        if (skip.has(index)) continue;
        const line = body[index] ?? "";
        if (line.trim() === "" || CLOSE.test(line)) continue;
        after = index;
      }
      body.splice(after + 1, 0, clockRow);
    }

    const replacement = [`{ ${entry.b}.${entry.d}.${entry.n} }`];
    if (entry.title !== "") replacement.push(entry.title);
    body.splice(entry.line, 1, ...replacement);
  }

  const text = [...(block ?? []), ...body].join("\n");
  return { source: text, entries, changed: true };
}

/** The non-blank lines a migrated note must still contain, in order.
 *
 * Trailing whitespace is trimmed on both sides of the comparison: `present`
 * compares against lines it has already trimmed, and a note that keeps a space
 * after a line is not missing that line. */
function survivingLines(source) {
  const lines = source.split("\n");
  const { body } = splitFrontmatter(lines);
  const skip = fenceState(body);
  return body
    .filter(
      (line, index) =>
        !skip.has(index) &&
        line.trim() !== "" &&
        !LEGACY.test(line) &&
        !DURATION.test(line)
    )
    .map((line) => line.trimEnd());
}

/** The first clock row between an address and the next one, or null. */
function clockRowOf(body, start, end, skip) {
  for (let index = start + 1; index < end; index += 1) {
    if (skip.has(index)) continue;
    const match = CLOCK_ROW.exec(body[index] ?? "");
    if (match !== null) return match;
  }
  return null;
}

function verify(source, original) {
  const problems = [];
  const lines = source.split("\n");
  const { body } = splitFrontmatter(lines);
  const skip = fenceState(body);

  let addresses = 0;
  for (let index = 0; index < body.length; index += 1) {
    if (skip.has(index)) continue;
    const line = body[index] ?? "";
    if (!ADDRESS.test(line)) continue;
    addresses += 1;

    if (LEGACY.test(line)) {
      problems.push(`line ${index + 1}: the old address survived`);
      continue;
    }
    if (!/^\{ \d+\.\d+\.\d+ \}$/.test(line)) {
      problems.push(`line ${index + 1}: malformed address: ${line}`);
      continue;
    }

    let end = body.length;
    for (let next = index + 1; next < body.length; next += 1) {
      if (!skip.has(next) && ADDRESS.test(body[next] ?? "")) {
        end = next;
        break;
      }
    }
    if (clockRowOf(body, index, end, skip) === null) {
      problems.push(`line ${index + 1}: address has no clock row`);
    }
  }

  if (addresses === 0) problems.push("no addresses found");

  if (original !== null) {
    const wanted = survivingLines(original);
    const present = body.filter((line) => line.trim() !== "").map((line) => line.trimEnd());
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
  console.error("usage: migrate-clock-row.mjs [--dry-run|--verify [--from <original>]] <file…>");
  process.exit(2);
}

let failed = false;

for (const file of files) {
  const source = readFileSync(file, "utf8");

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

  const result = migrate(source);

  if (mode === "dry-run") {
    process.stdout.write(result.source);
    continue;
  }

  if (!result.changed) {
    console.log(`${file}: already migrated, left untouched`);
    continue;
  }

  writeFileSync(file, result.source);
  console.log(`${file}: ${result.entries.length} entries`);
}

process.exit(failed ? 1 : 0);
