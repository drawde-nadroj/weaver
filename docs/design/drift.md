# Drift, as it actually was

This is the record of one audit, kept because "the docs are checked now" is a
claim about work that was done, and a claim needs evidence. Every line here was
false in the tree or in the prose at the time it was found. Nothing in this file
is a contract; the contracts are in `SYSTEM-DESIGN.md`, and `npm run docs:check`
is what enforces them.

The audit happened on 2026-10-29, against the working tree, with no changes
committed. The method was simple: for each mechanism a document asserted, find the
symbol that implements it. When no symbol existed, the sentence was either wrong
or describing something that had been deleted.

## What was false

| Where | What it said | What was true |
| --- | --- | --- |
| `docs/vision.md`, the loop table | `⏎` on a draft turns `-` into `=` | there are three transitions — settle to `+`, pause to `=`, descend — introduced in 0.5.0; the table had the pre-0.5.0 pair |
| `docs/vision.md`, the loop table | a pause writes its elapsed time back as `-` | a pause writes `=`; `-` means the clock is running |
| `README.md`, status | the suite covers a stated number of tests | the suite's size is not a fact a document can hold; it changes with every test, and the number had already drifted |
| `README.md`, status | a live Obsidian pass on a named date, with named observations | there is no record of that run in the repository, and geometry is not unit-tested; the paragraph asserted a check no one could reproduce |
| `README.md`, architecture | every write goes through `entries/writer.ts` | the editor path dispatches a transaction in `entries/engine.ts`; the writer owns disk, the engine owns the open editor |
| the old core day-note module | it began with a doc comment saying `src/core` is pure | it imported `obsidian` for `TFile`, so `core` was not pure in the one place the rule was written |
| `SYSTEM-DESIGN.md` | n/a — it did not exist | there was no map, so every sentence about the architecture lived in a different file with a different age |

The last row is the structural one. The other six are symptoms: prose that had no
address went stale, and nothing failed when it did.

## What was changed

- The old core day-note module was split. The pure half — `dayKey`, `dayNotePath`,
  `dayKeyFromName`, `dayFrontmatter` — is `src/core/day.ts`. The vault half —
  `ensureDayNote`, `resolveDayNote`, the Daily Notes lookup — is
  `src/entries/day-note.ts`. Imports and tests were moved with it, and the old
  path was deleted rather than kept as a re-export.
- The `heading*` settings names became `entry*`: `entrySize`, `entryWeight`,
  `equalizeEntrySizes`, `isValidEntrySize`. `heading` now names Markdown syntax
  and nothing else. The persisted v2 spellings are read in exactly one place,
  `LEGACY_SETTING_KEYS`, so an upgrade keeps a writer's size and weight instead
  of silently resetting them. The data model is `version: 3`.
- `tests/fixtures/day-note.md` is the record example, and
  `tests/record-format.test.ts` parses it: three entries, a title on the first
  prose line, two settled and one draft, one close, and frontmatter that
  `recountDay` agrees with. `SYSTEM-DESIGN.md` embeds the file's bytes, so the
  documented example and the tested example cannot be two documents.
- Every module and every exported symbol gained a doc comment — the generated
  module table states the current count, and the gate fails when one is missing.
  That is why the number can be stated there and nowhere else.
- `SYSTEM-DESIGN.md` was written: ten authored sections, each mechanism tied to
  `path#symbol`, plus a generated half (modules, symbols with signatures and
  textual references, settings and their readers, commands, DOM names, the record
  example, per-module coverage).
- `AGENTS.md` became the pointer file rather than a second copy of the
  architecture: a read-first table, the update-or-fail rule, the invariants with
  their addresses, and the gates.
- `docs/surfaces.md` stopped asserting a settings count and points at the
  generated table instead.

## The checks that now exist

| Check | Fails when |
| --- | --- |
| `npm run design` | never — it writes; `docs:check` runs both generators with `--verify` |
| `npm run docs:check` | an address does not resolve; a claim hash is stale or missing; a module or export has no doc comment; a styled class is written nowhere; a setting is never read; a registered command is not in the README table; `src/core` imports `obsidian`; a vault write bypasses the writer; a document holds a test count; a backticked name exists nowhere in `src/` |
| `npm run docs:falsify` | the untouched tree does not pass, or a deliberate breakage does not turn the gate red for the reason that mutation names |

The falsification list is the part that matters. A checker nobody has seen fail is
a checker that may be checking nothing, so each mutation names the contract it
breaks — a renamed symbol, a settle written as `=`, a dead CSS rule, an Obsidian
import in `core`, a deleted doc comment, an undocumented command, a changed
setting default, a vault write outside the writer, a name that exists nowhere, a
dropped claim hash, an export the index has not seen.

## What survived from the earlier ontology

The prior design was examined for the questions it asked, not the words it used.
Four of its distinctions still hold, and each one became a mechanism rather than
a paragraph:

| The earlier distinction | The question it asks | The check here |
| --- | --- | --- |
| evidence vs derived reading | which bytes are authored, and which are computed from them? | the generated half of `SYSTEM-DESIGN.md` is derived from the tree; frontmatter is recounted from the note by `recountDay`, and the fixture test requires its own frontmatter to be the recount |
| a structural node (a part) vs a text segment (a span) | what is a thing, and what is the text that names it? | a module is a structural node; a claim is a span of prose bound to one declaration's hash, so the prose and the thing it describes are checked against each other |
| a census that counts each unit once | what is counted, and once per what? | every module and every export is counted once in the index; the doc-comment rule is a census that fails on a unit with nothing said about it |
| authored versus composed | which document is written, and which is assembled? | `SYSTEM-DESIGN.md` has an authored half and a generated half, separated by markers; `design-md.mjs --verify` fails when they disagree |

What was rejected is the derived layer that duplicates the record. A plane, a
census and a separate reading store are all views of text that is already in the
note; here the note is the only store, and every view is recomputed. That is why
the gate can be small: there is only one source to be wrong about.

## Debt that remains, stated

- **The index is lexical, not semantic.** TypeScript 7 ships no compiler API, so
  `scripts/design-index.mjs` reads text: exports, signatures, imports, references,
  classes, attributes. "Used by" is a textual reference, not a resolved call
  graph, and the generated table says so. A symbol mentioned only in a comment
  counts as a reference; that is the price of running everywhere with no
  dependency.
- **Claims cover declarations, not whole documents.** A sentence between two
  claims can be edited into nonsense without turning the gate red. The backticked
  name rule narrows that gap; it does not close it.
- **Layout has no automated check.** `frameBox` and `frameSpan` are pure and
  unit-tested, but whether the rails land on the rows' centres is a pixel
  question. The live pass in `README.md` is the only check, and it is manual.
- **The docs gate runs in Node, not in the editor.** It can prove that a class is
  written and styled; it cannot prove Obsidian applied the style.
- **The prior-art document is external.** `~/chronomancer-me/docs/design/ontology.md`
  is history. Nothing in this repository is checked against it, and its vocabulary
  — planes, sparks, census — does not bind this one.
