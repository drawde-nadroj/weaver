#!/usr/bin/env node
/**
 * Reorders a day note's markers and clock row onto the current grammar.
 *
 *   node scripts/migrate-order.mjs --expect dbn --dry-run <file…>
 *   node scripts/migrate-order.mjs --expect dbn --verify [--from <copy|dir>] <file…>
 *   node scripts/migrate-order.mjs --expect dbn <file…>
 *
 * The old marker was `{ D.B.N }` and the old clock row `HH:MM:SS [+-=] HH:MM:SS`.
 * The current one is `{ B.D.N }` and `[+-=] HH:MM:SS HH:MM:SS`: branch first,
 * dimension second; duration first, moment second. This pass swaps the fields and
 * nothing else — it does not repair a drifted branch id. Run
 * `migrate-dcn.mjs --branches` after it when the note still carries the old
 * per-parent `B`.
 *
 * `--expect dbn` is required and is what keeps the pass one-shot: running it a
 * second time would swap the fields back. `--from` may be a file or a directory;
 * a directory is matched by basename, as `migrate-duration.mjs` does.
 *
 * Plain Node, no dependencies.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const DELIMITER = /^(---|\.\.\.)[ \t]*$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})/;
/** The marker prefix, old order: D, then B, then N. */
const MARKER = /^\{[ \t]*(\d{1,3})\.(\d{1,3})\.(\d{1,6})[ \t]*\}/;
/** An old clock row with both halves: moment first, duration second. */
const OLD_BOTH =
  /^([ \t]*)(\d{1,2}:\d{2}(?::\d{2})?)([ \t]+)([+\-=])([ \t]+)(\d{1,}:[0-5]\d:[0-5]\d)([ \t]*)$/;
/** A row that is already duration first: the pass reports it rather than swapping twice. */
const NEW_BOTH =
  /^([ \t]*)([+\-=])([ \t]+)(\d{1,}:[0-5]\d:[0-5]\d)([ \t]+)(\d{1,2}:\d{2}(?::\d{2})?)([ \t]*)$/;

const USAGE =
  "usage: migrate-order.mjs --expect dbn [--dry-run|--verify [--from <copy|dir>]] <file…>";

function splitFrontmatter(lines) {
  if (lines.length === 0 || !DELIMITER.test(lines[0] ?? "")) return { block: null, body: lines };
  for (let index = 1; index < lines.length; index += 1) {
    if (DELIMITER.test(lines[index] ?? "")) {
      return { block: lines.slice(0, index + 1), body: lines.slice(index + 1) };
    }
  }
  return { block: null, body: lines };
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

/** The migrated text, plus what the pass saw. */
function migrate(source) {
  const lines = source.split("\n");
  const { block, body } = splitFrontmatter(lines);
  const skip = fenceState(body);
  let markers = 0;
  let rows = 0;

  for (let index = 0; index < body.length; index += 1) {
    if (skip.has(index)) continue;
    const line = body[index] ?? "";

    const marker = MARKER.exec(line);
    if (marker !== null) {
      markers += 1;
      const [, d, b, n] = marker;
      body[index] = `{ ${b}.${d}.${n} }${line.slice(marker[0].length)}`;
      continue;
    }

    const row = OLD_BOTH.exec(line);
    if (row === null) continue;
    rows += 1;
    body[index] = `${row[1]}${row[4]} ${row[6]} ${row[2]}${row[7]}`;
  }

  const text = [...(block ?? []), ...body].join("\n");
  return { source: text, markers, rows };
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

function verify(source, original, file) {
  const problems = [];
  const lines = source.split("\n");
  const { body } = splitFrontmatter(lines);
  const skip = fenceState(body);

  if (original !== null) {
    const expected = migrate(original).source;
    if (source !== expected) {
      const before = expected.split("\n");
      const now = source.split("\n");
      const limit = Math.min(before.length, now.length);
      let at = -1;
      for (let index = 0; index < limit; index += 1) {
        if (before[index] !== now[index]) {
          at = index;
          break;
        }
      }
      if (at < 0 && before.length !== now.length) at = limit;
      problems.push(
        at < 0
          ? "the migrated text is not the copy's own conversion"
          : `line ${at + 1}: expected ${JSON.stringify(before[at] ?? "")}`
      );
    }

    if (frontmatterValue(original, "travels") !== frontmatterValue(source, "travels")) {
      problems.push("travels changed");
    }
    if (frontmatterValue(original, "depth") !== frontmatterValue(source, "depth")) {
      problems.push("depth changed");
    }
    if (frontmatterValue(original, "duration") !== frontmatterValue(source, "duration")) {
      problems.push("duration changed");
    }
  }

  let markers = 0;
  let oldRows = 0;
  let newRows = 0;
  for (let index = 0; index < body.length; index += 1) {
    if (skip.has(index)) continue;
    const line = body[index] ?? "";
    if (!MARKER.test(line)) {
      if (OLD_BOTH.test(line)) oldRows += 1;
      else if (NEW_BOTH.test(line)) newRows += 1;
      continue;
    }
    markers += 1;
    if (!/^\{ \d+\.\d+\.\d+ \}/.test(line)) {
      problems.push(`line ${index + 1}: malformed marker: ${line}`);
    }
  }

  if (markers === 0) problems.push("no markers found");
  if (oldRows > 0) problems.push(`${oldRows} moment-first clock row(s) left`);

  if (problems.length > 0) console.error(`${file}: ${problems.join("; ")}`);
  return problems.length === 0;
}

const args = process.argv.slice(2);

if (!args.includes("--expect") || args[args.indexOf("--expect") + 1] !== "dbn") {
  console.error(`this pass only converts from D.B.N + moment-first; pass --expect dbn\n${USAGE}`);
  process.exit(2);
}

const mode = args.includes("--verify") ? "verify" : args.includes("--dry-run") ? "dry-run" : "write";
const fromIndex = args.indexOf("--from");
const fromPath = fromIndex >= 0 ? args[fromIndex + 1] : null;

const files = args.filter((arg, index) => {
  if (arg.startsWith("--")) return false;
  if (arg === "dbn") return false;
  if (fromIndex >= 0 && index === fromIndex + 1) return false;
  return true;
});

if (files.length === 0) {
  console.error(USAGE);
  process.exit(2);
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

let failed = false;

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const result = migrate(source);

  if (mode === "dry-run") {
    process.stdout.write(result.source);
    continue;
  }

  if (mode === "verify") {
    const original =
      fromPath === null
        ? null
        : readFileSync(isDirectory(fromPath) ? join(fromPath, basename(file)) : fromPath, "utf8");
    if (!verify(source, original, file)) failed = true;
    else console.log(`${file}: ok, ${markers} marker(s), ${newRows} clock row(s)`);
    continue;
  }

  writeFileSync(file, result.source);
  console.log(`${file}: ${result.markers} marker(s), ${result.rows} row(s)`);
}

process.exit(failed ? 1 : 0);
