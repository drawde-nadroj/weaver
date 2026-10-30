#!/usr/bin/env node
/**
 * The design index: the code's own answer to "what is in here".
 *
 * TypeScript 7 ships no compiler API, so this is a small lexical reader rather
 * than a type-checked one. That is a deliberate trade: it needs no dependency,
 * it always runs, and every claim it makes is about text it can see — exports,
 * signatures, doc comments, imports, references, classes, commands — never about
 * types it cannot resolve. Anything it cannot be sure of, it does not say.
 *
 * Output: `docs/design/index.json`. Deterministic: no timestamps, no absolute
 * paths, sorted modules and symbols. `docs/design-md.mjs` renders it, and
 * `docs-check.mjs` fails when a document disagrees with it.
 *
 * Usage: node scripts/design-index.mjs [--verify]
 *   --verify  exit 1 when the committed index.json differs from a fresh scan.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "design", "index.json");

const LAYERS = [
  ["src/core/", "core"],
  ["src/editor/", "editor"],
  ["src/reading/", "reading"],
  ["src/entries/", "entries"],
  ["src/ui/", "ui"]
];

/** Every source file, in a stable order. */
function sourceFiles(dir = join(ROOT, "src")) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.mts")) out.push(path);
  }
  return out;
}

function testFiles(dir = join(ROOT, "tests")) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => join(dir, name));
}

const rel = (path) => relative(ROOT, path).split("\\").join("/");

const lineOf = (source, index) => source.slice(0, index).split("\n").length;

/** Collapse whitespace and drop a trailing brace, for a one-line signature. */
function signatureOf(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  const open = flat.indexOf("{");
  const head = open === -1 ? flat : flat.slice(0, open).trim();
  const trimmed = head.replace(/;$/, "").trim();
  return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
}

/**
 * The end of the declaration that starts at `index`.
 *
 * Brackets are counted with strings and comments skipped, so a `}` inside a
 * template literal cannot close a function early. Functions, classes,
 * interfaces and enums end at their matching brace; constants and type aliases
 * at the first `;` outside every bracket.
 */
function declarationEnd(source, index) {
  let depth = 0;
  let i = index;
  let seenBrace = false;

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") i += 2;
        else if (source[i] === char) break;
        else i += 1;
      }
      i += 1;
      continue;
    }

    if (char === "(" || char === "[" || char === "{") depth += 1;
    if (char === "}" || char === ")" || char === "]") {
      depth -= 1;
      if (depth === 0 && char === "}" && seenBrace) return i + 1;
    }
    if (char === "{" && depth === 1) seenBrace = true;
    if (char === ";" && depth === 0 && !seenBrace && source.slice(index, i).includes("=")) {
      return i + 1;
    }
    i += 1;
  }

  return source.length;
}

/** The `/** *\/` block immediately above `index`, if there is one. */
function docAbove(source, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(source[i])) i -= 1;
  if (i < 1 || source[i] !== "/" || source[i - 1] !== "*") return "";

  const open = source.lastIndexOf("/**", i);
  if (open === -1) return "";
  const between = source.slice(open, index);
  if (/\*\/.*\S/s.test(between.slice(between.indexOf("*/") === -1 ? 0 : between.indexOf("*/") + 2)))
    return "";

  return source
    .slice(open + 3, i - 1)
    .split("\n")
    .map((line) => line.replace(/^\s*\*? ?/, "").trimEnd())
    .join("\n")
    .trim();
}

const EXPORT_RE =
  /^export\s+(?:default\s+)?(?:async\s+)?(function|class|const|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/gm;

function exportsOf(source) {
  const out = [];
  EXPORT_RE.lastIndex = 0;
  let match;
  while ((match = EXPORT_RE.exec(source)) !== null) {
    const start = match.index;
    const name = match[2];
    const end = declarationEnd(source, start);
    const text = source.slice(start, end);
    const code = text.replace(/\/\*\*[\s\S]*?\*\//g, "");

    out.push({
      name,
      kind: match[1],
      line: lineOf(source, start),
      signature: signatureOf(text),
      doc: docAbove(source, start),
      hash: createHash("sha256").update(code.replace(/\s+/g, " ")).digest("hex").slice(0, 10),
      bytes: code.length
    });
  }
  return out;
}

const IMPORT_RE = /^import\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/gm;

function importsOf(source) {
  const out = [];
  IMPORT_RE.lastIndex = 0;
  let match;
  while ((match = IMPORT_RE.exec(source)) !== null) out.push(match[1]);
  return [...new Set(out)].sort();
}

function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) return specifier;
  return relative(ROOT, resolve(dirname(fromFile), specifier)).split("\\").join("/");
}

/**
 * A DOM name Weaver writes: a class, an id, or an attribute value.
 *
 * The lookbehind is what keeps CSS custom properties (`--weaver-d`) and data
 * attributes (`data-weaver-n`) out of the class list — they are separate
 * contracts and get their own table.
 */
const CLASS_RE = /(?<![-\w])weaver-[a-z0-9-]+/g;

function classesIn(source) {
  return [...new Set(source.match(CLASS_RE) ?? [])].sort();
}

const DATA_RE = /data-weaver-[a-z-]+/g;

function dataAttrsIn(source) {
  return [...new Set(source.match(DATA_RE) ?? [])].sort();
}

function bodyClassesIn(source) {
  const match = /const BODY_CLASSES = \[([\s\S]*?)\]/.exec(source);
  if (match === null) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
}

/**
 * Every `addCommand` call, whatever its layout.
 *
 * Reading the block rather than fixed newlines matters: a command written on one
 * line is still a registered command, and an index that missed it would let the
 * README table drift.
 */
function commandsIn(source) {
  const out = [];
  const re = /addCommand\(\{([\s\S]*?)\}\)/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const block = match[1];
    const id = /\bid:\s*"([^"]+)"/.exec(block);
    const name = /\bname:\s*"([^"]+)"/.exec(block);
    const icon = /\bicon:\s*"([^"]+)"/.exec(block);
    if (id === null || name === null || icon === null) continue;
    const hotkey = /modifiers:\s*\[([^\]]+)\],\s*key:\s*"([^"]+)"/.exec(block);
    out.push({
      id: id[1],
      name: name[1],
      icon: icon[1],
      hotkey: hotkey === null ? null : `${hotkey[1].replace(/["\s]/g, "")}+${hotkey[2]}`
    });
  }
  return out;
}

function settingsDefaults(source) {
  const match = /export const DEFAULT_SETTINGS: WeaverSettings = \{([\s\S]*?)\n\};/.exec(source);
  if (match === null) return [];
  return [...match[1].matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):\s*(.+?),?$/gm)].map((m) => ({
    field: m[1],
    value: m[2].replace(/,$/, "").trim()
  }));
}

function cssSelectors() {
  const source = readFileSync(join(ROOT, "styles.css"), "utf8");
  const defined = new Set(source.match(/\.weaver-[a-z0-9-]+/g) ?? []);
  const bodyOnly = new Set(
    (source.match(/body(?:\.weaver-[a-z0-9-]+|:not\(\.weaver-[a-z0-9-]+\))/g) ?? []).flatMap(
      (selector) => selector.match(/weaver-[a-z0-9-]+/g) ?? []
    )
  );
  return { defined: [...defined].sort(), bodyOnly: [...bodyOnly].sort(), bytes: source.length };
}

function build() {
  const files = sourceFiles();
  const tests = testFiles();
  const testSources = new Map(tests.map((path) => [rel(path), readFileSync(path, "utf8")]));
  const sources = new Map(files.map((path) => [rel(path), readFileSync(path, "utf8")]));

  const modules = [];
  const exportsAll = [];

  for (const [file, source] of sources) {
    const layer = LAYERS.find(([prefix]) => file.startsWith(prefix))?.[1] ?? "root";
    const imports = importsOf(source).map((specifier) => resolveImport(join(ROOT, file), specifier));
    const exported = exportsOf(source).map((symbol) => {
      const refs = [];
      let refCount = 0;
      for (const [other, text] of sources) {
        if (other === file) continue;
        const count = (text.match(new RegExp(`\\b${symbol.name}\\b`, "g")) ?? []).length;
        if (count > 0) {
          refs.push(other);
          refCount += count;
        }
      }
      const testedBy = [...testSources]
        .filter(([, text]) => new RegExp(`\\b${symbol.name}\\b`).test(text))
        .map(([path]) => path);

      const entry = { ...symbol, refs, refCount, testedBy };
      exportsAll.push({ file, layer, ...entry });
      return entry;
    });

    modules.push({
      file,
      layer,
      lines: source.split("\n").length,
      doc: "",
      obsidian: imports.includes("obsidian"),
      imports,
      exports: exported,
      classes: classesIn(source),
      dataAttrs: dataAttrsIn(source)
    });
  }

  // A module's own header comment, read from the top of the file.
  for (const module of modules) {
    const source = sources.get(module.file);
    const head = /^\s*\/\*\*([\s\S]*?)\*\//.exec(source);
    module.doc = head === null ? "" : head[1].split("\n").map((l) => l.replace(/^\s*\*? ?/, "").trimEnd()).join("\n").trim();
  }

  const usedClasses = new Set(modules.flatMap((m) => m.classes));
  const css = cssSelectors();
  const definedClasses = new Set([
    ...css.defined.map((name) => name.replace(/^\./, "")),
    ...(sources.get("src/ui/css.ts")?.match(/\.weaver-[a-z0-9-]+/g) ?? []).map((name) =>
      name.replace(/^\./, "")
    )
  ]);
  const bodyClasses = bodyClassesIn(sources.get("src/main.ts") ?? "");

  const defaults = settingsDefaults(sources.get("src/settings.ts") ?? "");
  const settings = defaults.map(({ field, value }) => ({
    field,
    value,
    readers: [...sources]
      .filter(([file, text]) => file !== "src/settings.ts" && new RegExp(`\\b${field}\\b`).test(text))
      .map(([file]) => file)
  }));

  const fixturePath = join(ROOT, "tests", "fixtures", "day-note.md");
  let fixture = null;
  try {
    fixture = {
      file: "tests/fixtures/day-note.md",
      text: readFileSync(fixturePath, "utf8").replace(/\n$/, "")
    };
  } catch {
    fixture = null;
  }

  return {
    generatedBy: "scripts/design-index.mjs",
    generatedDoc: "SYSTEM-DESIGN.md",
    counts: {
      modules: modules.length,
      exports: exportsAll.length,
      classes: usedClasses.size,
      testFiles: tests.length
    },
    modules: modules.sort((a, b) => a.file.localeCompare(b.file)),
    settings,
    commands: commandsIn(sources.get("src/main.ts") ?? ""),
    css: {
      defined: css.defined.map((name) => name.replace(/^\./, "")),
      definedByScript: [...new Set(sources.get("src/ui/css.ts")?.match(/\.weaver-[a-z0-9-]+/g) ?? [])]
        .map((name) => name.replace(/^\./, ""))
        .sort(),
      bodyClasses,
      unstyled: [...usedClasses].filter((c) => !definedClasses.has(c)).sort(),
      unused: css.defined
        .map((name) => name.replace(/^\./, ""))
        .filter((c) => !usedClasses.has(c) && !bodyClasses.includes(c))
        .sort(),
      unusedBody: bodyClasses.filter((c) => !css.bodyOnly.includes(c) && !usedClasses.has(c)).sort()
    },
    fixture
  };
}

const index = build();
const json = `${JSON.stringify(index, null, 2)}\n`;

if (process.argv.includes("--verify")) {
  let committed = "";
  try {
    committed = readFileSync(OUT, "utf8");
  } catch {
    committed = "";
  }
  if (committed !== json) {
    console.error("docs/design/index.json is stale. Run: npm run design");
    process.exit(1);
  }
  console.log("design index is current");
} else {
  writeFileSync(OUT, json);
  console.log(`wrote ${rel(OUT)}: ${index.counts.modules} modules, ${index.counts.exports} exports`);
}
