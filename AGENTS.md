# Weaver — agent notes

Weaver is an Obsidian plugin (TypeScript, esbuild, Vitest) whose day note is a
linear list of entries: `{ D.C.N } - HH:MM:SS`, prose, `[+-=] HH:MM:SS`.
Read `README.md` for the product, `docs/vision.md` for vocabulary and the
evidence/session rule, and `docs/surfaces.md` for every surface before changing
one.

## Commands (repo root)

- `npm run typecheck` — strict `tsc --noEmit`.
- `npm test` — Vitest against the in-repo Obsidian stub and DOM shim.
- `npm run check` — the gate: typecheck, tests, Bend proof, production build.
- `npm run build` — production `main.js` (generated; never edit it by hand).
- `npm run dev` — esbuild watch.
- `npm run deploy` — copy `main.js`, `manifest.json`, `styles.css` to
  `$WEAVER_VAULT/.obsidian/plugins/weaver` (default `/Users/jordan/Knowledge`).
  Never copy or edit `data.json`.
- `npm run bend:build` / `npm run bend:proof` — regenerate/verify the duration
  algebra (`src/core/duration.bend` → `src/core/bend/duration.mjs`).
- Migration scripts: `node scripts/migrate-dcn.mjs --dry-run|--verify …` and
  `node scripts/migrate-duration.mjs --expect mmsscs --dry-run|--verify …`.
  Dry-run and verify before any rewrite.

## Architecture

- `src/core/` — pure, no `obsidian` import, unit-tested in Node: entries,
  document, insert plans, duration (+ Bend), clock, close, day stats, colour,
  frame geometry, navigator stack.
- `src/editor/` — CodeMirror/Obsidian: `entry-field.ts` (index), `entry-decorations.ts`
  (StateField decorations), `entry-frame.ts` (drawn overlay), `entry-keys.ts`,
  `stopwatch-widget.ts` + `duration-ticker.ts`, `close-decorations.ts`,
  `view-registry.ts`.
- `src/reading/` — post processors for Reading view.
- `src/entries/` — `writer.ts` is the only writer of a day note; `engine.ts`
  decides what to write; `session.ts` is device-local.
- `src/ui/` — injected CSS variables (`css.ts`), navigator, DCN runs, platform.
- `src/main.ts`, `settings.ts`, `settings-tab.ts` — wiring and settings.

## Rules that must not bend

- **The note is the record.** Evidence is plain text (marker, prose, duration,
  close, frontmatter counters). Session state is device-local, never synced, and
  becomes evidence only through the writer. If the plugin vanished, the notes
  must still read.
- **One writer.** Every day-note write goes through `entries/writer.ts`, called
  by `entries/engine.ts`. No surface edits a file directly.
- **Nothing reflows.** Decorations and frames paint around text; they never move
  it. The duration row's top must stay identical across insertions.
- **Colour and indent are functions of D.** No per-level CSS rules; `--weaver-d`
  carries depth and `--weaver-dcolor` the colour.
- **The marker stays plain text.** It is a prefix, never a widget or a heading.
- **One surface per intent.** The navigator is the only navigation and writes
  only what `⏎`, `n`, `x` write; don't add a second capture or editor surface.
- **The frame:** the marker row is the top-left rail label, the duration row the
  bottom-right. The rails pass through the centres of those rows and are cut
  behind their labels; the prose is the interior. Rows are found by
  `data-weaver-n` on the head line and the duration row, not by DOM positions.
  The box's extent is `frameSpan` in `src/core/frame.ts`. A marker row that
  carries prose keeps the rail above itself. No label is ever duplicated.
- **Mobile is not a fork.** Phone and desktop share one implementation; platform
  differences are geometry and row height only.
- **Vocabulary:** entry, dimension (`1D`…`nD`), marker, duration, thread, stop,
  settle, navigator. "Heading" is Markdown syntax only; no filing words.

## Code conventions

- Strict TypeScript: no `any`, no unused locals/parameters, no non-null
  assertions unless the surrounding code already proves it.
- `null` means absent in the domain model; don't switch a field to `undefined`.
- Comments explain *why* and the invariant, in prose. A behaviour change updates
  the comment and the doc that states the contract.
- Reuse `core/color`, `core/document`, `core/insert`, `core/duration`, `ui/dcn`
  before adding a helper. New geometry belongs in `core/frame.ts` and is tested
  in `tests/frame.test.ts`.
- No dead code, compatibility aliases, or shims: rename every caller and delete
  the old path.
- Decorations: classes and `data-*` attributes are part of the contract; keep
  them stable. Widget equality ignores elapsed time; the ticker owns the clock;
  don't dispatch transactions to tick.
- Settings: add only for a documented need; normalize and default in
  `settings.ts`, test both.

## Verification and reporting

- Before yielding: `npm run check` (or typecheck + tests + build if the Bend
  toolchain is absent, and say which gate could not run).
- Unit tests cannot see layout. For rendering, run the live pass: `npm run build
  && npm run deploy`, reload the plugin in Obsidian, and check Live Preview and
  Reading view against the frame checks at the end of `README.md` plus the
  reference behaviour: rails through the marker/duration centres, labels cutting
  the rails, prose inside, no overlapping frames, live shimmer, Source mode no
  frames.
- Say what was unit-tested and what was live-checked; never claim a UI check you
  did not run.

## Git

- Work in this checkout; never revert or overwrite unrelated user changes.
- Don't commit, push, tag, or open PRs unless asked.
- Keep `manifest.json` and `package.json` versions in step for a release; version
  bumps are a maintainer step.
