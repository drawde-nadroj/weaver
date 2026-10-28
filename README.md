# Weaver

Weaver is an Obsidian plugin where a day note is a linear list of **entries**. An
entry is a marker line `{ D.C.N } - HH:MM:SS`, its prose, and one duration line
`[+-=] HH:MM:SS`:

```markdown
{ 1.1.1 } - 16:10:00
sparked by [[2026.10.26 - Breaking Free and Building Thoughtware]]
- **kashmir Shaivism & Bhartrhari's Gammarian**
+ 00:04:12

{ 2.1.2 } - 16:12:00
the thought this one opened, one dimension deeper
= 00:01:30
```

`D` is the dimension, `C` the child ordinal (renumbered on insert), `N` the day
sequence (assigned once, only appended). `N` is identity, `C` is address, and the
duration is the only mutable field. Colour is a pure function of `D`, so nothing is
recalculated when a deeper entry appears: depth 7 looks the same before and after.

The note and one centred travel card are the whole surface. Writing happens in the
note; nothing is written until a command or a keystroke says so.

## Status

`0.5.0` — three sigils, the entry palette, and a clock in seconds. The suite covers
167 tests: parsing, plans, decorations, keys, the travel model and card, the entry
palette, both post processors, the day stats, the stopwatch widget, and both
migration passes. The duration algebra is a Bend module, `src/core/duration.bend`,
compiled to `src/core/bend/duration.mjs`; `LAWS.bend` states its seven laws and
`bend PROOF.bend` proves them.

The live surface was exercised against Obsidian 1.15 on 2026-10-28 through the
renderer, on this vault's real notes (which have Vim mode on): `⌘⇧E` writes the
entry and leaves the caret on its blank prose line with no clock running; a
keystroke starts the clock while the file keeps `- 00:00:00`; moving the caret out,
a wheel, and an arrow key inside the entry each write `=` at the current second;
`⏎` settles that line to `+` with no child and the caret still; `⏎` again opens a
child under it and sets the travel target; `⌘⇧P` lists today's entries with the
caret's entry selected, and its arrows, filter lock, `n`, `x` and `Esc` behave as
documented; five insertions at the caret leave the duration line's top identical to
the pixel, and two newlines move it exactly two line heights.

## The loop

1. **Start** an entry with `⌘⇧E` from anywhere, including inside an editor: it is
   appended at the tip of today's note with an empty prose line and `- 00:00:00`.
2. **Write.** The first keystroke starts the stopwatch; the rendered line ticks
   while the file still says `- 00:00:00`.
3. **Stop writing** — move the caret away, click out of the note, scroll with the
   wheel, open a card — and the clock pauses, writing `=` at that second.
4. **Settle** with `⏎`: the line becomes `+ HH:MM:SS`, the session ends and nothing
   else moves. `⏎` again on that settled entry opens a child one dimension deeper
   with the caret in its prose.
5. **Insert** a child by hand with `⌘⇧J` under the entry at the caret.
6. **Travel** with `⌘⇧⏎` to any draft, filtered by `1`, `1.2`, `.14` or `1.2.14`.
7. **Palette** with `⌘⇧P`: today's entries in one card, where `⏎` settles and
   descends, `n` starts a root at the tip, and `x` deletes the selection's subtree.
8. **Close** the day: one `✓ HH:MM:SS` mark, then the day's own stats.

A pause writes only when a whole second has accumulated, so moving the caret costs
at most one line rewrite per second and the value always reads back the same.
Editing a settled entry changes nothing: a `+` line is never rewritten.

The clock starts on the writer's own input — a typed character or a paste — and on
nothing else. The vault reloading a note from disk, or Weaver rewriting a line,
starts no clock: an entry nobody has touched has no time in it.

## Commands

| Command ID | Name | Default hotkey | Icon |
| --- | --- | --- | --- |
| `weaver:start-entry` | Start an entry | `Mod+Shift+E` | `plus` |
| `weaver:insert-entry` | Insert a child entry | `Mod+Shift+J` | `indent-increase` |
| `weaver:travel` | Travel to a draft | `Mod+Shift+Enter` | `compass` |
| `weaver:palette` | Entry palette | `Mod+Shift+P` | `list` |
| `weaver:line-break` | Insert a line break | — | `corner-down-left` |
| `weaver:close-day` | Close the day | — | `check-circle` |

`⌘⇧E`, not `⌘⏎`: Obsidian's core *Open link under cursor in new tab* owns
`⌘⏎`, and its scope runs in the document's capture phase, so no plugin keymap —
not even a `Prec.highest` one — ever sees that chord. `⌘⇧E` belongs to nothing
else, so it works from the sidebar, from Reading view, and from inside an editor.

`⌘⇧E` is bound twice on purpose: the command covers the caret that is not in an
editor, and CodeMirror's keymap handles the same chord inside the editor.

`⏎` is not a command, and it is two-way and stateless. The caret is in an entry, so
`⏎` looks at that entry's own sigil: an **open** entry — `-` being written or `=`
paused — settles to `+` and stops the clock, and a **settled** one opens a child
under it. Nothing is stored to remember which entry was just settled, so `⏎` on
yesterday's `+` entry opens a child under it too, and a stray `⏎` while reading
leaves an empty child that `x` or one undo removes.

`⇧⏎` stays the newline; so does `weaver:line-break`, which is the one a phone's
toolbar can host — a soft keyboard has no `⇧⏎`, and `⏎` now settles everywhere. In
Vim normal mode `⏎` is Vim's, as is every other key Vim owns: the entry keys live
in the editor keymap, and Vim's own normal-mode map runs before it.

## The entry palette

`⌘⇧P` shows today's note, put into source mode, with one card listing every entry
in document order. The selection starts on the entry the caret is in, or the one
directly above it.

| Key | Effect |
| --- | --- |
| `↑` `↓` | move the selection (clamped, no wrap) |
| `1`, `1.2`, `.14`, `1.2.14` then `⏎` | lock that filter, and put the selection on the first match |
| `⏎` with an empty query | settle the selection, then open a child under it |
| `n` | a new root at the tip of the day |
| `x` | delete the selection's whole subtree |
| `Esc` | clear the query, then the filter, then leave the caret on the selection |

`n` and `x` act only while the query is empty and no filter is locked, so a bare
letter is never eaten out of a number being typed. Each row shows `D.C.N`, the
entry's clock, its title, `+N` when it has children (that count is the blast radius
of `x`), and a `+` for settled or `→` for open. `x` asks for no confirmation: its
whole subtree goes in one undoable transaction, and one undo brings it back.

## Travel

`⌘⇧⏎` opens one card, centred in the note pane:

| Key | Effect |
| --- | --- |
| `←` `→` | previous/next day that holds a draft (no wrap) |
| `↑` `↓` | previous/next draft in that day |
| `1`, `1.2`, `.14`, `1.2.14` then `⏎` | lock that filter; days and rows regroup around the matches |
| `⏎` with an empty query | travel to the selected draft |
| `Esc` | clear the query, then close |

Rows are touch targets as well as keys. The card never takes a `Scope`, so `⌘,`
and every other Obsidian chord reach the app while it is open. Travel puts the
caret in the entry's prose and outlines it without moving a single line: the
rectangle is an absolute overlay, never padding or a border.

## Record formats

**Marker line** — `{ D.C.N } - HH:MM:SS`, matched as a prefix, so a title typed
after the clock becomes the first prose line. Tokens are optional in the file:
`{1.2.3}-13:27` reads as 13:27:00. A marker inside frontmatter or a fenced code
block is text.

**Duration line** — `[+-=] HH:MM:SS`, the first such line under a marker, in the
same shape as the marker's own clock so the two can be read against each other.
Minutes and seconds are `0–59`; hours are unbounded. One sigil decides what the
entry is: `-` is open and being written, `=` is open and paused, and `+` alone is
settled. A settled entry is final — nothing rewrites it, not a pause, not a
settle, not a session that wandered in. A duration line is the only mutable field
of an entry.

The clock ticks in whole seconds, so the file changes at most once a second, and
only when the writer stops.

**Frontmatter** — `date`, `travels` (entry count), `depth` (deepest `D`),
`duration` (`HH:MM:SS`, the sum of every duration). Written only when a value
changes, and only when *Write day counters* is on.

**Close mark** — `✓ HH:MM:SS` on its own line, at most one per day.

## Settings

| Group | Setting | Default | Effect |
| --- | --- | --- | --- |
| Writing | Write day counters | on | Keep `travels`, `depth` and `duration` in the day note's frontmatter. |
| Day | Day note folder | `Chronomancer` | Used only when the core Daily Notes plugin cannot be read. |
| Day | Day note format | `YYYY.MM.DD` | Same fallback, for the filename. |
| Look | Equalize entry sizes | on | One size for every entry, whatever its depth. Off steps deeper entries down. |
| Look | Entry size | `1em` | CSS length for the entry text. |
| Look | Entry weight | 600 | Font weight of the marker line. |
| Look | Indent step (desktop) | 18px | Left padding added per dimension level. |
| Look | Indent step (mobile) | 12px | Same, on phones. |
| Look | Indent maximum level | 8 | Levels beyond this stop indenting. |
| Look | Port `em`/`strong` colours | on | Orange `em`, red `strong`. |
| Advanced | Link past days | on | Render ` - [[2026.10.26]]` after the clock on any note that is not today's. |
| Advanced | Debug logging | off | Verbose console output. |

No setting is read while colouring: `dimensionColor(7)` is the same value in every
vault. Levels 1–6 are the anchors (red, orange, yellow, green, blue, purple); past
them the path continues as an OKLCH spiral, so every nine steps the hue returns to
the purple anchor at a lower lightness and level 16 is still distinguishable from
level 7.

## Install from source

```sh
npm install
npm run bend:build     # regenerates src/core/bend/duration.mjs (needs Bend)
npm run build
npm run deploy
```

`npm run deploy` copies `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/weaver` and never touches `data.json`. Set
`WEAVER_VAULT` to deploy somewhere other than `/Users/jordan/Knowledge`.

Then reload Obsidian and enable **Weaver** under **Settings → Community plugins**.

## The duration algebra

One format, both directions: `HH:MM:SS` out of seconds, and seconds back out of
`HH:MM:SS` or `0` when the text is not that shape. `src/core/duration.bend` holds
it — `clock` and `parseClock`, with the `field`/`verdict` chain underneath — `bend
src/core/duration.bend -o src/core/bend/duration.mjs` compiles it, and
`src/core/duration.ts` is the typed facade that rounds milliseconds into seconds,
reads the sigil, and answers "not a duration line" for anything else. The generated
module is committed, so `npm test` needs no Bend install.

`LAWS.bend` states the laws and `PROOF.bend` proves them:

```sh
npm run bend:proof     # bend PROOF.bend, then bend PROOF.bend --verdict
```

`bend` is at `$HOME/.bend/bin/bend`; `--verdict` needs Lean (`elan`, toolchain
`leanprover/lean4:v4.34.0`, on `PATH` as `$HOME/.elan/bin`). `npm run check` runs
the typecheck, the suite, the proof gate and the build, in that order. The gate
fails loudly rather than skipping: a law left open prints `SOME PROOFS FAIL`.

Nothing else is in Bend, and that is a rule rather than a preference: a part
belongs there when it is pure and total, closed-form or structurally inductive so
`{==}` discharges it without lemmas Base does not carry, and off the per-keystroke
path. `parseEntries` and `renumberMarkers` fail the last test; `dimensionColor`
fails the second; everything that touches CodeMirror or Obsidian fails the first.

## Migrating a day note

Earlier builds wrote dimensions as ATX headings (`##### 16:49 - title`). The
script converts a note to entries, repairs heading lines that lost their newline,
rewrites the frontmatter and verifies the result:

```sh
node scripts/migrate-dcn.mjs --dry-run <file…>          # print, write nothing
node scripts/migrate-dcn.mjs <file…>                    # migrate in place
node scripts/migrate-dcn.mjs --verify <file…>           # self-consistency
node scripts/migrate-dcn.mjs --verify --from <original> <file…>   # plus line survival
```

`D` is the hash count, `C` the sibling ordinal in document order, `N` the rank by
clock across the file (ties by document order). Every non-heading line survives
byte for byte; a file whose lines already start with a marker is left untouched.

`0.5.0` changed what a duration line means, so notes written before it need one
one-shot pass:

```sh
node scripts/migrate-duration.mjs --expect mmsscs --dry-run <file…>   # counts, writes nothing
node scripts/migrate-duration.mjs --expect mmsscs <file…>             # convert in place
node scripts/migrate-duration.mjs --expect mmsscs --verify --from <copy|dir> <file…>
```

`--expect mmsscs` is required and is what keeps the pass one-shot: a converted file
carries no hundredths, and converting twice would zero every value. The old third
field is hundredths and is **dropped, not rounded** — `00:22:30` was 22.3 seconds
and becomes `00:00:22` — and the old `=` sigil, which meant settled, becomes `+`. A
`-` stays `-`. Every other byte survives, and `--verify` checks that against a copy
of the note taken before the pass.

## Manual checks

These need a live Obsidian and are not covered by `npm test`:

- `⌘⇧E` with the caret in the editor of another note: today's note gains
  `{ 1.1.1 } - HH:MM:SS`, a blank line and `- 00:00:00`, the caret sits on the
  blank line, and no session has started yet.
- Two keystrokes: the clock ticks in seconds. Moving the caret out of the entry
  writes `= HH:MM:SS`; so does an arrow key inside it. The next keystroke resumes
  from that second and the rendered sigil returns to `-` without the file moving.
- `⏎` on the open entry: the line becomes `+ HH:MM:SS`, no child appears and the
  caret does not move. `⏎` again: a child `{ 2.1.2 } - HH:MM:SS` with `- 00:00:00`
  appears directly under it, with the caret in its prose and the travel rectangle
  around it.
- Prose renders in the dimension's colour, the stopwatch's two colons render in
  that colour while its digits stay white, and the duration line keeps its height
  while the digits change.
- `⇧⏎` inside an open entry adds a line; `weaver:line-break` does the same from the
  toolbar.
- Deleting the live entry then pressing `⌘⇧E`: the new entry's stopwatch reads
  `- 00:00:00` and stays there until the first keystroke.
- Type into a settled entry: its duration line never changes, and a `+` entry is
  never rewritten.
- `⌘⇧P`: the card lists today's entries with the caret's entry selected; `↓` moves
  the selection; `1.5` then `⏎` locks the filter on that entry; `n` while the query
  is non-empty goes into the query and creates nothing; `n` on an empty query
  appends a root at the tip; `x` removes the selected subtree in one undo; `Esc`
  clears the query, then the filter, then leaves the CM caret on the selection.
- `⌘⇧⏎`: the card is centred in the note pane, `⌘,` opens Obsidian settings with
  the card open, the sidebar moves the card with the pane, `3` then `⏎` locks the
  dimension filter.
- Travelling shows the rounded rectangle around the prose without moving it, and
  the stopwatch still reads `-` until the first keystroke.
- Phone: `⏎` settles the open entry and never opens a child, from any line of it.
  `weaver:line-break` in the toolbar is the newline. Rows ≥ 44 px, the card fits
  the visible viewport, and `Start an entry` lands the caret in the new entry's
  prose even from Reading view.
- Vim: `⏎` in normal mode still moves down outside a draft.

## Known limits

- Entry markers are plain text, so Obsidian's outline, folding and `[[#heading]]`
  links do not list entries. Travel is the only navigation.
- Travel lists drafts only — `-` and `=` — so a day whose entries are all `+` has
  nothing to travel to.
- The day index scans the day-note folder only, capped at 5000 files and 2 MB per
  file; a failed scan keeps the previous results.
- Durations are whole seconds: a session under half a second reads `00:00:00`, and
  a hundredth of a second is not recoverable.
- Setext (`===` underlined) headings are not parsed, and a marker inside frontmatter
  or a fenced code block is text.
- With *Write day counters* off, the frontmatter keeps whatever it already says.

## Development

```sh
npm run dev       # esbuild watch, writes main.js
npm run typecheck # tsc --noEmit
npm test          # vitest
npm run build     # production bundle
npm run deploy    # copy main.js, manifest.json, styles.css into the vault
npm run check     # typecheck + tests + production build
```

`src/core` is pure and has no `obsidian` import; the editor and UI layers sit on
top of it. `src/entries/engine.ts` is the only writer of entry text.
