#!/usr/bin/env node
/**
 * The documentation gate.
 *
 * Every check here exists because the corresponding sentence was once false.
 * A document is trusted only where the tree can be asked:
 *
 *  1. the index and the generated half are current, not remembered;
 *  2. every `path#symbol` address resolves to bytes in this checkout;
 *  3. every claim's hash still matches the declaration it describes;
 *  4. every exported symbol and every module has a doc comment;
 *  5. no CSS rule is dead, and no command or setting is one-sided;
 *  6. `src/core` imports no Obsidian runtime;
 *  7. no write to a day note bypasses the one writer, and no entry change
 *     bypasses a plan;
 *  8. a backticked code name in a document is a name that exists.
 *
 * Run: node scripts/docs-check.mjs        npm run docs:check
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const checked = { addresses: 0, claims: 0, names: 0, files: 0 };

/** Backticked words that are not code names: products, formats, and keys. */
const ALLOWED_WORDS = new Set([
  "README",
  "SYSTEM",
  "DESIGN",
  "AGENTS",
  "Obsidian",
  "Markdown",
  "TypeScript",
  "JavaScript",
  "CodeMirror",
  "Vitest",
  "Bend",
  "Lean",
  "OKLab",
  "TOIS",
  "JSON",
  "YAML",
  "CSS",
  "DOM",
  "HTML",
  "Bash",
  // Names that are real, and are not code in this repository.
  "WEAVER_VAULT",
  "PATH",
  "elan"
]);

const rel = (path) => relative(ROOT, path).split("\\").join("/");
const fail = (file, line, message) => failures.push(`${file}:${line}: ${message}`);
const lineAt = (source, index) => source.slice(0, index).split("\n").length;

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

// ── 1. derived artefacts are derived ────────────────────────────────────────

for (const script of ["design-index.mjs", "design-md.mjs"]) {
  try {
    execFileSync(process.execPath, [join(ROOT, "scripts", script), "--verify"], {
      cwd: ROOT,
      stdio: "pipe"
    });
  } catch (error) {
    const text = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    fail(`scripts/${script}`, 1, text.split("\n").slice(-2).join(" "));
  }
}

const index = JSON.parse(read("docs/design/index.json"));
const modules = new Map(index.modules.map((module) => [module.file, module]));
const exportsByFile = new Map(index.modules.map((module) => [module.file, new Map(module.exports.map((e) => [e.name, e]))]));

// ── 2 + 3 + 8. the documents ────────────────────────────────────────────────

/** Files a document may name that are not source: vault data, and build output. */
const EXTERNAL_FILES = new Set(["data.json", "main.js"]);

const DOCS = [
  "README.md",
  "AGENTS.md",
  "SYSTEM-DESIGN.md",
  ...walk(join(ROOT, "docs"))
    .map(rel)
    .filter((path) => path.endsWith(".md"))
];

// Every name the repository actually contains, not just TypeScript: the duration
// algebra is Bend, and a document may point at `clock` or `field_value`.
const srcText = walk(join(ROOT, "src"))
  .filter((path) => /\.(ts|bend|mjs)$/.test(path))
  .map((path) => read(rel(path)))
  .join("\n");
const identifiers = new Set(srcText.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []);
const fileText = new Map();

for (const doc of DOCS) {
  const source = read(doc);
  fileText.set(doc, source);
  checked.files += 1;
  const lines = source.split("\n");

  // Addresses: `src/x.ts#symbol`, and bare `tests/x.test.ts` paths.
  for (const match of source.matchAll(/((?:src|tests|scripts|docs)\/[A-Za-z0-9_./-]+\.(?:ts|mjs|md|json|css))#([A-Za-z0-9_$]+)/g)) {
    checked.addresses += 1;
    const [, path, symbol] = match;
    const line = lineAt(source, match.index ?? 0);
    const absolute = join(ROOT, path);
    if (!existsSync(absolute)) {
      fail(doc, line, `address names a file that does not exist: ${path}`);
      continue;
    }
    if (!fileText.has(path)) fileText.set(path, read(path));
    if (!new RegExp(`\\b${symbol.replace(/\$/g, "\\$")}\\b`).test(fileText.get(path))) {
      fail(doc, line, `address names a symbol that is not in ${path}: ${symbol}`);
    }
  }

  for (const match of source.matchAll(/`((?:src|tests|scripts|docs)\/[A-Za-z0-9_./-]+\.(?:ts|mjs|md|json|css))`/g)) {
    const path = match[1];
    if (path.includes("#")) continue;
    if (!existsSync(join(ROOT, path))) {
      fail(doc, lineAt(source, match.index ?? 0), `path does not exist: ${path}`);
    }
  }

  // A backticked file at the repository root: LAWS.bend, manifest.json, ...
  for (const match of source.matchAll(/`([A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:bend|md|json|css|mjs|js))`/g)) {
    const path = match[1];
    if (path.includes("/") || path.includes("#")) continue;
    if (EXTERNAL_FILES.has(path)) continue;
    if (!existsSync(join(ROOT, path))) {
      fail(doc, lineAt(source, match.index ?? 0), `file does not exist: ${path}`);
    }
  }

  // Claims: an address plus the declaration's hash.
  for (const match of source.matchAll(/<!--\s*claim:\s*([^\s@]+)(?:\s+@([0-9a-f]+))?\s*-->/g)) {
    checked.claims += 1;
    const [, target, hash] = match;
    const line = lineAt(source, match.index ?? 0);
    const [path, symbol] = target.split("#");

    if (symbol === undefined) {
      fail(doc, line, `claim is not a path#symbol: ${target}`);
      continue;
    }

    const exported = exportsByFile.get(path)?.get(symbol);
    if (exported === undefined) {
      fail(doc, line, `claim targets something that is not an exported symbol: ${target}`);
      continue;
    }
    if (!hash) {
      fail(doc, line, `claim carries no hash; run: npm run docs:claims -- --write (${target})`);
      continue;
    }
    if (hash !== exported.hash) {
      fail(
        doc,
        line,
        `claim is stale: ${target} was @${hash}, is @${exported.hash}. Re-read the sentence, then: npm run docs:claims -- --write`
      );
    }
  }

  // Bare code names: they must exist in the source, so no word stands alone.
  const inGenerated = new Set();
  const begin = source.indexOf("<!-- design:begin");
  const end = source.indexOf("<!-- design:end -->");
  if (begin !== -1 && end !== -1) {
    for (let line = lineAt(source, begin); line <= lineAt(source, end); line += 1) inGenerated.add(line);
  }

  lines.forEach((text, offset) => {
    if (inGenerated.has(offset + 1)) return;
    for (const match of text.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]*)`/g)) {
      const name = match[1];
      if (name.length < 4) continue;
      if (identifiers.has(name)) continue;
      if (ALLOWED_WORDS.has(name)) continue;
      checked.names += 1;
      fail(doc, offset + 1, `backticked name exists nowhere in src/: ${name}`);
    }
  });
}

// ── 4. every module and every export says what it is ────────────────────────

for (const module of index.modules) {
  if (module.doc.trim() === "") fail(module.file, 1, "module has no doc comment");
  for (const symbol of module.exports) {
    if (symbol.doc.trim() === "") {
      fail(module.file, symbol.line, `export ${symbol.name} has no doc comment`);
    }
  }
}

// ── 5. no dead rule, no one-sided setting or command ────────────────────────

for (const name of index.css.unused) {
  fail("styles.css", 1, `rule for .${name} is dead: no code writes that class`);
}

for (const setting of index.settings) {
  if (setting.readers.length === 0) {
    fail("src/settings.ts", 1, `setting ${setting.field} is never read outside the model`);
  }
  if (!read("SYSTEM-DESIGN.md").includes(setting.field)) {
    fail("SYSTEM-DESIGN.md", 1, `setting ${setting.field} is not named in the design document`);
  }
}

const readme = read("README.md");
for (const command of index.commands) {
  checked.addresses += 1;
  if (!readme.includes(`weaver:${command.id}`)) {
    fail("README.md", 1, `command weaver:${command.id} is registered but not in the command table`);
  }
}

// A count in prose is a claim about a run nobody re-ran. A generated block is
// exempt because the generator reads the tree every time it runs.
for (const doc of DOCS) {
  const source = fileText.get(doc) ?? read(doc);
  const begin = source.indexOf("<!-- design:begin");
  const end = source.indexOf("<!-- design:end -->");
  const hasGenerated = begin !== -1 && end !== -1;
  const first = hasGenerated ? lineAt(source, begin) : -1;
  const last = hasGenerated ? lineAt(source, end) : -1;

  source.split("\n").forEach((text, offset) => {
    const line = offset + 1;
    if (hasGenerated && line >= first && line <= last) return;
    if (/\b\d+\s+tests?\b/i.test(text)) {
      fail(doc, line, "a test count in prose drifts; point at `npm test` instead");
    }
  });
}

// ── 6. core is Obsidian-free ────────────────────────────────────────────────

for (const module of index.modules) {
  if (module.layer !== "core") continue;
  const source = read(module.file);
  if (/from\s+["']obsidian["']/.test(source)) {
    fail(module.file, 1, "src/core must not import obsidian");
  }
}

// ── 7. one writer, and every change is a plan ───────────────────────────────

const VAULT_WRITERS = new Set(["src/entries/writer.ts"]);
const CREATORS = new Set(["src/entries/day-note.ts"]);
const CHANGE_EMITTERS = new Set(["src/entries/engine.ts", "src/entries/writer.ts"]);

for (const module of index.modules) {
  const source = read(module.file);

  for (const match of source.matchAll(/\bvault\.(process|modify|append)\s*\(/g)) {
    if (VAULT_WRITERS.has(module.file)) continue;
    fail(module.file, lineAt(source, match.index ?? 0), `vault.${match[1]} bypasses entries/writer.ts`);
  }
  for (const match of source.matchAll(/\bvault\.(create|createFolder)\s*\(/g)) {
    if (CREATORS.has(module.file)) continue;
    fail(module.file, lineAt(source, match.index ?? 0), `vault.${match[1]} belongs to entries/day-note.ts`);
  }
  for (const match of source.matchAll(/dispatch\(\s*\{[^}]*\bchanges\s*:/gs)) {
    if (CHANGE_EMITTERS.has(module.file)) continue;
    fail(module.file, lineAt(source, match.index ?? 0), "a document change outside engine.ts/writer.ts");
  }
  for (const match of source.matchAll(/\beditor\.(replaceRange|setValue)\s*\(/g)) {
    fail(module.file, lineAt(source, match.index ?? 0), `editor.${match[1]} bypasses the plans`);
  }
}

// ── report ──────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`docs:check FAILED — ${failures.length} problem${failures.length === 1 ? "" : "s"}\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error("");
  process.exit(1);
}

console.log(
  `docs:check ok — ${checked.files} documents, ${checked.addresses} addresses, ${checked.claims} claims, ` +
    `${index.counts.modules} modules, ${index.counts.exports} exported symbols`
);
