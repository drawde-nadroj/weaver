#!/usr/bin/env node
/**
 * Proves the documentation gate can fail — and that it fails for the reason the
 * mutation names.
 *
 * A checker nobody has seen fail is a checker that may be checking nothing. Each
 * mutation below breaks one contract in a scratch copy of the repository and must
 * make `docs-check.mjs` exit non-zero *with the message that contract produces*.
 * "It went red" is not enough: a code mutation leaves the committed index stale,
 * and a gate that only ever says "stale" would pass this harness while checking
 * nothing it claims to check. So each case either rebuilds the derived artefacts
 * first (`rebuild: true`) or deliberately does not (`rebuild: false`, to test the
 * staleness rule itself), and matches its expected failure line.
 *
 * The first row is the control: the untouched copy must pass, or the harness is
 * the thing that is broken.
 *
 * Run: node scripts/docs-falsify.mjs        npm run docs:falsify
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SKIP = new Set(["node_modules", ".git", "main.js", "package-lock.json", ".DS_Store"]);

/** What a `rebuild` run may write: the index, the generated half, nothing else. */
const DERIVED = ["scripts/design-index.mjs", "scripts/design-md.mjs"];

function copyRepo() {
  const dir = mkdtempSync(join(tmpdir(), "weaver-falsify-"));
  cpSync(ROOT, dir, {
    recursive: true,
    filter: (source) => !SKIP.has(source.split("/").pop() ?? "")
  });
  return dir;
}

function run(script, dir) {
  const result = spawnSync(process.execPath, [join(dir, script)], {
    cwd: dir,
    encoding: "utf8"
  });
  return { code: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function rebuild(dir) {
  for (const script of DERIVED) {
    const result = run(script, dir);
    if (result.code !== 0) throw new Error(`rebuild failed: ${script}\n${result.output}`);
  }
}

function edit(dir, relativePath, from, to, all = false) {
  const path = join(dir, relativePath);
  const source = readFileSync(path, "utf8");
  if (!source.includes(from)) throw new Error(`mutation anchor not found in ${relativePath}: ${from}`);
  writeFileSync(path, all ? source.split(from).join(to) : source.replace(from, to));
}

function append(dir, relativePath, text) {
  const path = join(dir, relativePath);
  writeFileSync(path, `${readFileSync(path, "utf8")}\n${text}\n`);
}

/**
 * Each mutation names the contract it breaks, says whether the derived artefacts
 * are rebuilt before the gate runs, and the failure text that proves the right
 * rule fired.
 */
const MUTATIONS = [
  {
    name: "add an export the index has not seen",
    contract: "the index is derived from the tree",
    rebuild: false,
    expect: /index\.json is stale/,
    apply: (dir) => append(dir, "src/core/clock.ts", "/** A ghost, for the harness. */\nexport const GHOST = 1;")
  },
  {
    name: "rename an exported symbol the design document points at",
    contract: "an address must resolve",
    rebuild: true,
    expect: /not an exported symbol|exists nowhere in src/,
    apply: (dir) => {
      edit(dir, "src/core/insert.ts", "planChildEntry", "planChildEntryOf", true);
      edit(dir, "src/entries/engine.ts", "planChildEntry", "planChildEntryOf", true);
    }
  },
  {
    name: "settle to `=` instead of `+`",
    contract: "a claim's hash covers the declaration",
    rebuild: true,
    expect: /claim is stale/,
    apply: (dir) =>
      edit(
        dir,
        "src/entries/engine.ts",
        'const plan = planDuration(source, index, current, "+", ms);',
        'const plan = planDuration(source, index, current, "=", ms);'
      )
  },
  {
    name: "add a stylesheet rule nothing writes",
    contract: "no dead CSS",
    rebuild: true,
    expect: /rule for \.weaver-ghost is dead/,
    apply: (dir) => append(dir, "styles.css", ".weaver-ghost { color: red; }")
  },
  {
    name: "import Obsidian into src/core",
    contract: "core is Obsidian-free",
    rebuild: true,
    expect: /src\/core must not import obsidian/,
    apply: (dir) => {
      const path = join(dir, "src/core/clock.ts");
      writeFileSync(path, `import { Notice } from "obsidian";\n\n${readFileSync(path, "utf8")}`);
    }
  },
  {
    name: "delete an export's doc comment",
    contract: "every export says what it is",
    rebuild: true,
    expect: /export dimensionColor has no doc comment/,
    apply: (dir) =>
      edit(
        dir,
        "src/core/color.ts",
        "/** The colour of dimension `d`, memoised. Pure: nothing else is read. */\nexport function dimensionColor(",
        "export function dimensionColor("
      )
  },
  {
    name: "register a command the README does not list",
    contract: "command parity",
    rebuild: true,
    expect: /not in the command table/,
    apply: (dir) =>
      edit(
        dir,
        "src/main.ts",
        "  private registerCommands(): void {",
        '  private registerCommands(): void {\n    this.addCommand({ id: "ghost-command", name: "Ghost", icon: "ghost" });'
      )
  },
  {
    name: "change a setting default the document claims",
    contract: "DEFAULT_SETTINGS hash",
    rebuild: true,
    expect: /claim is stale/,
    apply: (dir) => edit(dir, "src/settings.ts", "entryFrames: true,", "entryFrames: false,")
  },
  {
    name: "write the vault without the one writer",
    contract: "one writer per note",
    rebuild: true,
    expect: /bypasses entries\/writer\.ts/,
    apply: (dir) =>
      edit(
        dir,
        "src/entries/engine.ts",
        "export class EntryEngine {",
        'function ghostWrite(app: App, file: TFile): void {\n  void app.vault.modify(file, "");\n}\n\nexport class EntryEngine {'
      )
  },
  {
    name: "use a code name that exists nowhere",
    contract: "no word in isolation",
    rebuild: false,
    expect: /exists nowhere in src\/: ghostSymbol/,
    apply: (dir) => append(dir, "SYSTEM-DESIGN.md", "The `ghostSymbol` does the rest.")
  },
  {
    name: "drop a claim's hash",
    contract: "a claim is verified, not remembered",
    rebuild: false,
    expect: /claim carries no hash/,
    apply: (dir) => {
      const path = join(dir, "SYSTEM-DESIGN.md");
      const source = readFileSync(path, "utf8");
      writeFileSync(path, source.replace(/(<!-- claim: [^\s@]+) @[0-9a-f]+/, "$1"));
    }
  }
];

const control = copyRepo();
const baseline = run("scripts/docs-check.mjs", control);
rmSync(control, { recursive: true, force: true });

if (baseline.code !== 0) {
  console.error("docs:falsify FAILED — the untouched copy does not pass:\n");
  console.error(baseline.output);
  process.exit(1);
}

const rows = [["control: the untouched tree", "pass", "pass"]];

for (const mutation of MUTATIONS) {
  const dir = copyRepo();
  let observed;

  try {
    mutation.apply(dir);
    if (mutation.rebuild) rebuild(dir);
    const result = run("scripts/docs-check.mjs", dir);
    const output = result.output;

    if (result.code === 0) {
      observed = "STILL GREEN";
    } else if (mutation.expect.test(output)) {
      observed = output
        .split("\n")
        .map((line) => line.trim())
        .find((line) => mutation.expect.test(line))
        ?.replace(/^ +/, "")
        .slice(0, 96) ?? "expected message";
    } else {
      const first = output
        .split("\n")
        .map((line) => line.trim())
        .find((line) => /^\S.*:\d+: /.test(line));
      observed = `WRONG REASON: ${(first ?? output.split("\n")[0]).slice(0, 80)}`;
    }
  } catch (error) {
    observed = `HARNESS: ${error.message.replace(/\s*\n\s*/g, " | ").slice(0, 220)}`;
  }

  rows.push([mutation.name, mutation.contract, observed]);
  rmSync(dir, { recursive: true, force: true });
}

const width = Math.max(...rows.map(([name]) => name.length));
let escaped = 0;

console.log("\nmutations of the tree, and what docs:check said\n");
for (const [name, contract, observed] of rows) {
  const ok = contract === "pass" ? observed === "pass" : !/STILL GREEN|WRONG REASON|HARNESS/.test(observed);
  if (!ok) escaped += 1;
  const mark = contract === "pass" ? (ok ? "ok    " : "FAIL  ") : ok ? "caught " : "ESCAPED";
  console.log(`  ${mark}  ${name.padEnd(width)}  →  ${observed}`);
}

console.log("");
if (escaped > 0) {
  console.error(`docs:falsify FAILED — ${escaped} mutation${escaped === 1 ? "" : "s"} went unnoticed or fired the wrong rule`);
  process.exit(1);
}
console.log(`docs:falsify ok — ${MUTATIONS.length} mutations, every one caught for the reason it names`);
