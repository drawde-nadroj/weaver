#!/usr/bin/env node
/**
 * Migrates a day note from `MM:SS:CS` durations to `HH:MM:SS`.
 *
 * Two meanings moved at once. The old third field was hundredths, which the line
 * no longer shows, so `00:22:30` — 22 s and 30 cs — becomes `00:00:22`; read
 * unchanged by the new build it would mean 22 min 30 s. And the old `=` meant
 * "settled", which is now `+`, so every settled line switches sigil. A `-` stays
 * `-`.
 *
 * `--expect mmsscs` is required and is what makes the pass one-shot: converted
 * text carries no hundredths, and running the conversion twice would zero every
 * value (`00:00:22` would become `00:00:00`).
 *
 *   migrate-duration.mjs --expect mmsscs --dry-run <file…>
 *   migrate-duration.mjs --expect mmsscs <file…>
 *   migrate-duration.mjs --expect mmsscs --verify --from <copy|dir> <file…>
 *
 * `--from` may be a directory, in which case each file is compared with the copy
 * of the same basename inside it. Every other byte, including frontmatter and
 * prose, must survive untouched.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/** The one shape this pass rewrites: sigil, space, `MM:SS:CS`. */
const DURATION = /^([+\-=]) (\d{2,}):(\d{2}):(\d{2})$/;

const USAGE =
  "usage: migrate-duration.mjs --expect mmsscs [--dry-run|--verify [--from <copy|dir>]] <file…>";

function pad2(value) {
  return String(value).padStart(2, "0");
}

/**
 * `MM:SS:CS` → `HH:MM:SS`. The third field is hundredths and is dropped, not
 * rounded: the writer's instruction is that hundredths are no longer needed.
 */
function convert(line) {
  const match = DURATION.exec(line);
  if (match === null) return null;

  const sigil = match[1] === "=" ? "+" : match[1];
  const secs = Number(match[2]) * 60 + Number(match[3]);
  const hh = pad2(Math.floor(secs / 3600));
  const mm = pad2(Math.floor((secs % 3600) / 60));
  const ss = pad2(secs % 60);
  return `${sigil} ${hh}:${mm}:${ss}`;
}

/** The migrated text and how many duration lines it rewrote. */
function migrate(source) {
  const lines = source.split("\n");
  let count = 0;

  const out = lines.map((line) => {
    const next = convert(line);
    if (next === null) return line;
    count += 1;
    return next;
  });

  return { source: out.join("\n"), count };
}

function verify(source, original) {
  const problems = [];
  const lines = source.split("\n");
  const before = original.split("\n");

  if (lines.length !== before.length) {
    problems.push(`${lines.length} line(s), the copy has ${before.length}`);
  }

  const shared = Math.min(lines.length, before.length);
  for (let index = 0; index < shared; index += 1) {
    const was = before[index] ?? "";
    const now = lines[index] ?? "";
    const wanted = convert(was) ?? was;
    if (now !== wanted) {
      problems.push(`line ${index + 1}: expected ${JSON.stringify(wanted)}`);
      break;
    }
  }

  return problems;
}

const args = process.argv.slice(2);

if (!args.includes("--expect") || args[args.indexOf("--expect") + 1] !== "mmsscs") {
  console.error(`this pass only converts from mmsscs; pass --expect mmsscs\n${USAGE}`);
  process.exit(2);
}

const mode = args.includes("--verify") ? "verify" : args.includes("--dry-run") ? "dry-run" : "write";
const fromIndex = args.indexOf("--from");
const fromPath = fromIndex >= 0 ? args[fromIndex + 1] : null;

const files = args.filter((arg, index) => {
  if (arg.startsWith("--")) return false;
  if (arg === "mmsscs") return false;
  if (fromIndex >= 0 && index === fromIndex + 1) return false;
  return true;
});

if (files.length === 0) {
  console.error(USAGE);
  process.exit(2);
}

let failed = false;

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const result = migrate(source);

  if (mode === "verify") {
    const copyOf = fromPath === null ? file : isDirectory(fromPath) ? join(fromPath, basename(file)) : fromPath;
    const problems = verify(source, readFileSync(copyOf, "utf8"));
    if (problems.length > 0) {
      failed = true;
      console.error(`${file}: ${problems.join("; ")}`);
    } else {
      console.log(`${file}: ok, ${result.count} line(s)`);
    }
    continue;
  }

  console.log(`${file}: ${result.count} line(s)`);
  if (mode === "write" && result.count > 0) writeFileSync(file, result.source);
}

process.exit(failed ? 1 : 0);

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
