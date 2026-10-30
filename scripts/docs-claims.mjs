#!/usr/bin/env node
/**
 * Stamps every claim in the documents with the current hash of the declaration
 * it points at.
 *
 * A claim is `<!-- claim: src/x.ts#symbol @hash -->`. The hash is the whole
 * reason the mechanism works: it is what `docs-check.mjs` compares, so a change
 * to the declaration is a red gate until a person re-reads the sentence and runs
 * this script again. The script never edits the sentence — only the hash.
 *
 * Usage:
 *   node scripts/docs-claims.mjs --write     re-stamp every claim
 *   node scripts/docs-claims.mjs             list claims and their state
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const write = process.argv.includes("--write");

const CLAIM = /<!--\s*claim:\s*([^\s@]+)(?:\s+@([0-9a-f]+))?\s*-->/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith(".md")) out.push(path);
  }
  return out;
}

const index = JSON.parse(readFileSync(join(ROOT, "docs", "design", "index.json"), "utf8"));
const hashes = new Map(
  index.modules.flatMap((module) => module.exports.map((symbol) => [`${module.file}#${symbol.name}`, symbol.hash]))
);

const docs = [
  join(ROOT, "README.md"),
  join(ROOT, "AGENTS.md"),
  join(ROOT, "SYSTEM-DESIGN.md"),
  ...walk(join(ROOT, "docs"))
];

let stamped = 0;
let unknown = 0;

for (const doc of docs) {
  const source = readFileSync(doc, "utf8");
  let next = source;
  let touched = false;

  next = source.replace(CLAIM, (whole, target, hash) => {
    const current = hashes.get(target);
    if (current === undefined) {
      console.error(`${relative(ROOT, doc)}: no such exported symbol: ${target}`);
      unknown += 1;
      return whole;
    }
    if (current === hash) return whole;
    stamped += 1;
    touched = true;
    return `<!-- claim: ${target} @${current} -->`;
  });

  if (touched && write) writeFileSync(doc, next);
}

const verb = write ? "stamped" : "would stamp";
console.log(`${verb} ${stamped} claim${stamped === 1 ? "" : "s"}; ${unknown} unknown target${unknown === 1 ? "" : "s"}`);
if (!write && stamped > 0) console.log("Run: npm run docs:claims -- --write");
process.exit(unknown === 0 ? 0 : 1);
