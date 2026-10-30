# Weaver — agent notes

Weaver is an Obsidian plugin (TypeScript, esbuild, Vitest) whose day note is a
linear list of entries: `{ D.C.N } - HH:MM:SS`, prose, `[+-=] HH:MM:SS`.

**The map is `SYSTEM-DESIGN.md`.** Every mechanism sentence in it names the code
that implements it as `path#symbol`, and `npm run docs:check` fails when that
address, that declaration's hash, or a backticked name does not resolve. So the
rule is not "remember the architecture": it is read the map, then verify it
against the tree. The map's second half is generated from the code — modules,
every export with its signature and references, every setting and its readers,
every command, every DOM name — so it cannot quietly fall behind.

## Read before you change

| You are about to touch | Read | Verify with |
| --- | --- | --- |
| the product's vocabulary or the evidence/session rule | `README.md`, `docs/vision.md` | `npm run docs:check` |
| a surface (Live Preview, Reading view, navigator, settings) | `docs/surfaces.md` | the surface's test, then the live pass |
| the record, a plan, or a write path | `SYSTEM-DESIGN.md` §1–§4 | `npm test` |
| geometry or the frame | `SYSTEM-DESIGN.md` §5, `src/core/frame.ts`, `tests/frame.test.ts` | `npm test`, then the live pass |
| a setting | `SYSTEM-DESIGN.md` §7, `src/settings.ts` | `npm test` |
| the duration algebra | `src/core/duration.bend`, `LAWS.bend` | `npm run bend:proof` |

## The rule that replaces memory

If your change makes a sentence in a document false, **fix the sentence in the
same change** — or change the code so it is true again. `npm run docs:check` names
the document, the line and the reason. Never re-stamp a claim hash you have not
re-read: the hash exists to make that impossible, not to be bypassed.

- A claim is `<!-- claim: src/<file>.ts#<symbol> @hash -->`, where the hash is the
  declaration's own text. Editing the declaration turns the claim red until a
  person confirms the sentence still describes it, then
  `npm run docs:claims -- --write`.
- A backticked identifier in a document must exist in `src/`: no word stands
  alone, and no name is used that the code does not contain.
- The generated half of `SYSTEM-DESIGN.md` is never hand-edited. Run
  `npm run design`.

## The invariants, and where they live

- **The note is the record.** Evidence is plain text. Session state is
  device-local and becomes evidence only through `src/entries/writer.ts`; if the
  plugin vanished, the notes must still read.
- **One writer.** `vault.process`, `vault.modify` and `vault.append` appear only
  in `src/entries/writer.ts`; only `src/entries/day-note.ts` creates files. A
  document change is dispatched only in `src/entries/engine.ts` or the writer,
  and every entry change is a plan from `src/core/insert.ts`.
- **`src/core` imports no `obsidian`.** The gate checks it, because the day-note
  split exists for exactly that reason.
- **Nothing reflows.** Decorations and frames paint around text; the duration
  row's top must stay identical across insertions.
- **Colour and indent are functions of `D`.** No per-level CSS rules.
- **The marker stays plain text.** A prefix, never a widget or a heading.
- **One surface per intent.** The navigator is the only navigation.
- **The frame:** the marker row is the top-left rail label, the duration row the
  bottom-right; the rails pass through those rows' centres and are cut behind
  their labels; rows are found by `data-weaver-n`, not DOM position; the extent is
  `frameSpan`. No label is duplicated.
- **Mobile is not a fork.** One implementation; platform differences are
  geometry and row height only.
- **Vocabulary:** entry, dimension (`1D`…`nD`), marker, duration, thread, stop,
  settle, navigator. "Heading" is Markdown syntax only; no filing words. The v2
  `heading*` settings spellings survive in `LEGACY_SETTING_KEYS` and nowhere
  else.

## Commands (repo root)

| Command | What it does |
| --- | --- |
| `npm run typecheck` | strict `tsc --noEmit` |
| `npm test` | Vitest against the in-repo Obsidian stub and DOM shim |
| `npm run design` | rebuild `docs/design/index.json` and the generated half of `SYSTEM-DESIGN.md` |
| `npm run docs:check` | the documentation gate: addresses, claim hashes, doc comments, DOM names, settings, commands, core purity, one writer |
| `npm run docs:falsify` | break the tree in the ways `scripts/docs-falsify.mjs` lists and require the gate to go red for each named reason |
| `npm run docs:claims -- --write` | re-stamp claim hashes after re-reading the sentences |
| `npm run bend:build` / `npm run bend:proof` | regenerate / prove the duration algebra |
| `npm run check` | typecheck, tests, Bend proof, docs gate, production build, in that order |
| `npm run build` / `npm run dev` | production `main.js` / esbuild watch |
| `npm run deploy` | copy `main.js`, `manifest.json`, `styles.css` to the vault; never copy or edit `data.json` |

`npm run deploy` targets `$WEAVER_VAULT/.obsidian/plugins/weaver`, default
`/Users/jordan/Knowledge`. Migration scripts are `node scripts/migrate-dcn.mjs`
and `node scripts/migrate-duration.mjs`; dry-run and verify before any rewrite.

## Code conventions

- Strict TypeScript: no `any`, no unused locals or parameters, no non-null
  assertions unless the surrounding code already proves it.
- `null` means absent in the domain model; don't switch a field to `undefined`.
- Comments explain *why* and the invariant. A behaviour change updates the
  comment and the sentence in `SYSTEM-DESIGN.md` that states the contract.
- Every module and every export carries a doc comment; the gate fails without
  one, so there is no undocumented symbol to guess about.
- Reuse `core/color`, `core/document`, `core/insert`, `core/duration`, `ui/dcn`
  before adding a helper; new geometry belongs in `core/frame.ts`.
- No dead code, compatibility aliases or shims: rename every caller and delete
  the old path. New DOM names are contracts; a rename is a breaking change.
- Widget equality ignores elapsed time; the ticker owns the clock; never dispatch
  a transaction to tick.

## Verification and reporting

- Before yielding: `npm run check`. If the Bend toolchain is absent, say which
  gate could not run rather than implying it passed.
- Unit tests cannot see layout. Rendering needs the live pass: `npm run build &&
  npm run deploy`, reload the plugin, and check Live Preview and Reading view
  against the frame checks at the end of `README.md`.
- Say what was unit-tested and what was live-checked. Never claim a UI check you
  did not run.

## Git

- Work in this checkout; never revert or overwrite unrelated user changes.
- Don't commit, push, tag, or open PRs unless asked.
- Keep `manifest.json` and `package.json` versions in step for a release; version
  bumps are a maintainer step.
