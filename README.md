# Weaver

Weaver is an Obsidian plugin where a day note is a linear list of **entries**. An
entry is a marker line `{ D.B.N }`, its prose, and one clock row
`HH:MM:SS [+-=] HH:MM:SS`:

```markdown
{ 1.1.1 }
sparked by [[2026.10.26 - Breaking Free and Building Thoughtware]]
- **kashmir Shaivism & Bhartrhari's Gammarian**
16:10:00 + 00:04:12

{ 2.1.2 }
the thought this one opened, one dimension deeper
16:12:00 = 00:01:30
```

`D` is the dimension, `B` the branch id — a depth-1 entry's position among depth-1
entries, carried unchanged all the way down — and `N` the day sequence (assigned
once, only appended). `N` is identity, `B` is address, and the duration
half is the only mutable field. Colour is a pure function of `D`, so nothing is
recalculated when a deeper entry appears: depth 7 looks the same before and after.

The note and one navigator are the whole surface. Writing happens in the note;
nothing is written until a command or a keystroke says so, and every write of a day
note goes through one writer.

## Status

The version is `manifest.json`'s. The sigils are `DurationSigil`'s — open, paused
and settled — with one navigator, a clock in seconds, and a frame around every
entry. The suite's size is whatever `npm test` prints; what it covers, and what it
cannot, is the gate table in `SYSTEM-DESIGN.md`. The duration algebra is a Bend
module, `src/core/duration.bend`, compiled to `src/core/bend/duration.mjs`;
`LAWS.bend` states its laws and `bend PROOF.bend` proves them.

The frame, the navigator and the writer have no automated layout check: their
behaviour is unit-tested and their geometry is not, because no test can see a
pixel. The manual checks they need are at the end of this file.

## The loop

1. **Start** an entry with `⌘⇧E` from anywhere, including inside an editor: it is
   added at the tip of today's note with an empty prose line and a clock row of
   `HH:MM:SS - 00:00:00`.
2. **Write.** The first keystroke starts the stopwatch; the rendered duration ticks
   while the file still says `- 00:00:00`.
3. **Stop writing** — move the caret away, click out of the note, scroll with the
   wheel, open a card — and the clock pauses, writing `=` at that second.
4. **Settle** with `⏎`: the duration half becomes `+ HH:MM:SS`, the session ends and
   nothing else moves. `⏎` again on that settled entry opens a child one dimension
   deeper with the caret in its prose.
5. **Navigate** with `⌘⇧P`: today's entries in one card, where `⏎` jumps, `⇧⏎`
   settles and descends, `n` starts a root, `x` deletes the selection's
   subtree, and `⌘[` walks back a stop.
6. **Close** the day: one `✓ HH:MM:SS` mark, then the day's own stats.

A pause writes only when a whole second has accumulated, so moving the caret costs
at most one line rewrite per second and the value always reads back the same.
Editing a settled entry changes nothing: a `+` half is never rewritten.

The clock starts on the writer's own input — a typed character or a paste — and on
nothing else. The vault reloading a note from disk, or Weaver rewriting a line,
starts no clock: an entry nobody has touched has no time in it.

## Commands

| Command ID | Name | Default hotkey | Icon |
| --- | --- | --- | --- |
| `weaver:start-entry` | Start an entry | `Mod+Shift+E` | `plus` |
| `weaver:descend` | Descend into a child entry | — | `arrow-down-right` |
| `weaver:navigate` | Today's entries | `Mod+Shift+P` | `list` |
| `weaver:whisper-day` | Whisper the day | — | `sparkles` |
| `weaver:close-day` | Close the day | — | `check-circle` |

Every command carries an icon. Obsidian has no API that places a command on the
mobile toolbar; add *Start an entry* and *Descend into a child entry* under
*Manage toolbar options*.

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

`⇧⏎` is the newline, on a desk. A phone's soft keyboard has no `⇧⏎`, and `⏎`
settles everywhere, so a phone has no newline gesture: an entry's prose is one
paragraph there, and multi-line prose is written on a desk or pasted. In
Vim normal mode `⏎` is Vim's, as is every other key Vim owns: the entry keys live
in the editor keymap, and Vim's own normal-mode map runs before it.

## The navigator

`⌘⇧P` shows today's note, put into source mode, with one card over it. On a phone
the same card is a full-height sheet. It is the only navigation: start, descend and
jump, with the return stack inside it.

| Key | Effect |
| --- | --- |
| `↑` `↓` | move the selection (clamped, no wrap) |
| `⏎` | put the caret in the selected entry |
| `⇧⏎` | settle the selection if it is open, then open a child under it |
| `n` | start a root at the tip of the day |
| `x` | delete the selection's whole subtree |
| `⌘[` | walk back one stop |
| `Esc` | close, and put the caret back where the card opened |

On touch: a row taps to jump, the caret's own row taps to descend, and `✕` arms on
the first tap and deletes on the second. The footer names the gestures the platform
can make.

The first row is `＋ start an entry`, then a `return` block — one row per place a move
left — then `today`: every entry in document order, `D.B.N`, clock, title, `+N`
children (that count is the blast radius of `x`), with the caret's own entry marked.
`x` asks for no confirmation: the whole subtree goes in one undoable transaction,
the surviving branches' `B` values are repaired in that same transaction, and one
undo brings both back.

The card never takes a `Scope`, so `⌘,` and every other Obsidian chord reach the app
while it is open. Every action re-reads the document; the card never caches a line
number across a write. The list is today's note — the same target *Start an entry*
writes to — so reaching another day means opening that note.

## Record formats

**Marker line** — `{ D.B.N }`, matched as a prefix, so a title typed after it
becomes the first prose line. Whitespace inside the braces is optional:
`{1.2.3}` reads the same. A marker inside frontmatter or a fenced code block is
text. `B` is the branch id: a depth-1 entry's position among depth-1 entries,
carried unchanged all the way down its subtree, and repaired only when a root is
deleted. On a framed surface the marker's characters are the box's top rail label:
the rail runs through the middle of the row and is cut behind it, so the file's
own text is what names the box.

**Clock row** — the entry's last line: an optional moment `HH:MM:SS`, then an
optional duration `[+-=] HH:MM:SS`. Either half may be absent, so a hand-written
`09:14:22` and a stray `+ 00:04:12` are both clock rows. When both are there the
row reads as one line, `09:14:22 + 00:04:12`: the moment at the left corner of the
frame's bottom edge, the duration at the right. Both halves read alike — white
digits around dimension-coloured colons, the same grammar as the marker, and at the
note's own weight. A half that is absent labels no corner, so the frame never shows a value the file does not hold. The moment is
written once, when the entry is created, and never moves; settling rewrites only
the tail. Minutes and seconds are `0–59`; hours are unbounded. One sigil decides
what the entry is: `-` is open and being written, `=` is open and paused, and `+`
alone is settled. A settled entry is final — nothing rewrites it, not a pause, not
a settle, not a session that wandered in. The duration half is the only mutable
field of an entry.

A marker that still carries its old `- HH:MM:SS` clock is refused, not read: the
new prefix would otherwise take the clock for the first prose line. The migration
below moves it.

The clock ticks in whole seconds, so the file changes at most once a second, and
only when the writer stops.

**Frontmatter** — `date`, `travels` (entry count), `depth` (deepest `D`),
`duration` (`HH:MM:SS`, the sum of every duration). Written only when a value
changes, and only when *Write day counters* is on.

**Close mark** — `✓ HH:MM:SS` on its own line, at most one per day.

**Whisper rows** — two or three lines above an entry's first prose line, each
beginning `~ `: a bare name (up to ten words, the subject you would search for), then
at most one each of `learn: <what it has not settled>` (twelve words), `next: <an
imperative>` (twelve), and `ask: <a question, ending in "?">` (fourteen). The name is
the anchor — it is what the navigator shows — and the other rows carry the reading.
A question mark belongs to `ask:` alone, and the first person's own negations ("i
need not fear", "the data doesn't lie") are allowed: what the register refuses is the
antithesis, `X, not Y`. The
glyph is the provenance — it is how a reader, and a reload, tells the model's
reading from the writer's prose, and a note carries nothing else to do it with. A
single leading `~` is inert in Markdown, `~~` can never form (the row needs a space
after the glyph, and its text may not contain a second one), and a `~` line inside a
fenced block is text. Whisper rows are not prose: the title is still the first line
the writer typed, and the caret, the duration row and the title all refer to the
writer's own words. The rows take the note's own text colour — the one row that does
not take the dimension's — and the navigator labels an entry with its whisper name
before its title.

## Settings

| Group | Setting | Default | Effect |
| --- | --- | --- | --- |
| Writing | Write day counters | on | Keep `travels`, `depth` and `duration` in the day note's frontmatter. |
| Day | Day note folder | `Chronomancer` | Used only when the core Daily Notes plugin cannot be read. |
| Day | Day note format | `YYYY.MM.DD` | Same fallback, for the filename. |
| Look | Equalize entry sizes | on | One size for every entry, whatever its depth. Off steps deeper entries down. |
| Look | Entry size | `1em` | CSS length for the entry text. |
| Look | Indent step (desktop) | 18px | Left padding added per dimension level. |
| Look | Indent step (mobile) | 12px | Same, on phones. |
| Look | Indent maximum level | 8 | Levels beyond this stop indenting. |
| Look | Port `em`/`strong` colours | on | Orange `em`, red `strong`. |
| Look | Frame each entry | on | Draw a rounded box around every entry: the marker row is its top rail, and the clock row its bottom edge — the moment labels the bottom-left corner, the duration the bottom-right, each running through the middle of the row and cut behind its label. |
| Look | Frame follows the indent | on | A nested entry's frame starts further right, so nesting reads as a staircase. Off, every frame starts in the left margin and only the prose is indented, so the markers and the times line up down the note. |
| Whisper | Whisper settled entries | off | Write one to three `~` rows above a settled entry: the model's reading of what it holds. |
| Whisper | Place each entry in its day | off | One extra request per entry, asking which earlier entry it repeats or picks up. A small model answers thinly — measured, about one usable placement per day's twenty entries — so it is off by default. |
| Whisper | Endpoint | `http://127.0.0.1:8000/v1` | An address this device can reach. `127.0.0.1` is this machine only; the machine's own reachable name makes whispers work on a phone too. |
| Whisper | Model | `Qwen3.5-4B-MLX-4bit` | The model's name at that endpoint. A **thinking** model spends the whole 160-token answer budget on its reasoning and returns no text, so turn thinking off in that model's own settings (in oMLX, the model's settings: **Enable thinking** off), or use a non-thinking model. |
| Whisper | API key | empty | Kept in `data.json` in plain text, and it syncs with the vault. Empty for a local endpoint. |
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

## Working on the code

`SYSTEM-DESIGN.md` is the map: every mechanism in it names the code that
implements it, and its second half is generated from the tree. Agents and people
read it before changing a surface; it is not optional context.

```sh
npm run typecheck      # strict tsc --noEmit
npm test               # Vitest, in Node, against the in-repo Obsidian stub
npm run design         # rebuild docs/design/index.json and the generated half
npm run docs:check     # addresses, claim hashes, doc comments, DOM names, settings, commands, one writer
npm run docs:falsify   # break the tree on purpose and require docs:check to go red
npm run check          # typecheck, tests, Bend proof, docs gate, production build
```

A sentence in the documents carries `<!-- claim: src/<file>.ts#<symbol> @hash -->` when
it describes a specific declaration. Changing that declaration turns the gate red
until someone re-reads the sentence; `npm run docs:claims -- --write` re-stamps it
afterwards. A backticked identifier in a document must exist in `src/`, so a name
cannot survive the code that gave it meaning.

## The duration algebra

One format, both directions: `HH:MM:SS` out of seconds, and seconds back out of
`HH:MM:SS` or `0` when the text is not that shape. `src/core/duration.bend` holds
it — `clock` and `parseClock`, with the `field`/`verdict` chain underneath — `bend
src/core/duration.bend -o src/core/bend/duration.mjs` compiles it, and
`src/core/duration.ts` is the typed facade that rounds milliseconds into seconds,
reads the sigil, and answers "not a clock row" for anything else. The generated
module is committed, so `npm test` needs no Bend install.

`LAWS.bend` states the laws and `PROOF.bend` proves them:

```sh
npm run bend:proof     # bend PROOF.bend, then bend PROOF.bend --verdict
```

`bend` is at `$HOME/.bend/bin/bend`; `--verdict` needs Lean (elan, toolchain
`leanprover/lean4:v4.34.0`, on PATH as `$HOME/.elan/bin`). `npm run check` runs the typecheck, the suite, the proof gate, the
documentation gate and the build, in that order. The gate
fails loudly rather than skipping: a law left open prints `SOME PROOFS FAIL`.

Nothing else is in Bend, and that is a rule rather than a preference: a part
belongs there when it is pure and total, closed-form or structurally inductive so
`{==}` discharges it without lemmas Base does not carry, and off the per-keystroke
path. `parseEntries` and `repairBranches` fail the last test; `dimensionColor`
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

`D` is the hash count, `B` the branch id (a root's position among roots, carried
down its branch), `N` the rank by clock across the file (ties by document order).
Every non-heading line survives byte for byte; a file whose lines already start
with a marker is left untouched.

Notes already in marker form from an earlier build carry the old per-parent `B`.
One pass rewrites them onto their branch ids, and it rewrites nothing but those `B`
fields:

```sh
node scripts/migrate-dcn.mjs --branches --dry-run <file…>   # print, write nothing
node scripts/migrate-dcn.mjs --branches <file…>             # branch in place
node scripts/migrate-dcn.mjs --branches --verify --from <copy> <file…>
```

Roots already hold their own `B`, so the only bytes that differ are the `B` fields of
depth-2 and deeper markers. `--verify` checks that the marker count, every `D`, every
`N`, every root's `B` and every non-marker byte survived, and that every deeper `B`
equals its root's. Run it once; a branched file reports `already branched`. The
plugin never rewrites a note's numbering on load: an unmigrated note reads as the
file says, and the next deletion repairs every drifted `B` in the same undoable
transaction.

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

The clock grew its own row, so a note written before that needs one one-shot pass:

```sh
node scripts/migrate-clock-row.mjs --dry-run <file…>          # print, write nothing
node scripts/migrate-clock-row.mjs <file…>                    # migrate in place
node scripts/migrate-clock-row.mjs --verify <file…>           # self-consistency
node scripts/migrate-clock-row.mjs --verify --from <original> <file…>  # plus line survival
```

`{ 1.2.3 } - 13:27:43` becomes `{ 1.2.3 }` with `13:27:43` at the head of the
entry's clock row; a title written after the old clock moves to the line below the
marker, where the parser already reads it. An entry with no duration line gains
`+ 00:00:00`, because it was settled. Frontmatter, fenced code, prose, blank lines
and the close mark are copied verbatim. The plugin refuses an unmigrated note and
says so — it never rewrites a note because it opened it.

## Manual checks

These need a live Obsidian and are not covered by `npm test`:

- `⌘⇧E` with the caret in the editor of another note: today's note gains
  `{ 1.1.1 }`, a blank line and a clock row `HH:MM:SS - 00:00:00`, the caret sits
  on the blank line, and no session has started yet.
- Two keystrokes: the clock ticks in seconds. Moving the caret out of the entry
  writes `=` in the duration half; so does an arrow key inside it. The next
  keystroke resumes from that second and the rendered sigil returns to `-` without
  the file moving.
- `⏎` on the open entry: the duration half becomes `+ HH:MM:SS`, no child appears
  and the caret does not move. `⏎` again: a child `{ 2.1.2 }` with its own clock row
  appears directly under it, with the caret in its prose.
- Prose renders in the dimension's colour, the stopwatch's two colons render in
  that colour while its digits keep the note's own text colour, and the clock row
  keeps its height while the digits change.
- `⇧⏎` inside an open entry adds a line, on a desk.
- The palette lists exactly *Start an entry*, *Descend into a child entry*,
  *Today's entries*, *Whisper the day* and *Close the day*; there is no line-break
  command, and every row shows its icon.
- *Descend into a child entry* with the caret in a settled entry puts the child
  immediately under the parent, above any older siblings.
- *Descend into a child entry* on an open entry settles it first, then opens the
  child.
- *Descend into a child entry* with the caret outside every entry writes nothing and
  says `put the caret in an entry`.
- Deleting the live entry then pressing `⌘⇧E`: the new entry's stopwatch reads
  `- 00:00:00` and stays there until the first keystroke.
- Type into a settled entry: its duration half never changes, and a `+` entry is
  never rewritten.
- `⌘⇧P`: the card lists today's entries with the caret's entry selected; `↓` moves
the selection; `⏎` puts the caret in the selected entry; `⇧⏎` settles it and opens a
child; `n` starts a root at the tip; `x` removes the selected subtree in one undo;
`⌘[` walks back a stop and the list reopens where it landed; `Esc` closes and puts
the caret back where the card opened. `⌘,` still opens Obsidian settings with the
card open.
- Phone: `⏎` settles the open entry and never opens a child, from any line of it.
  There is no newline gesture inside an entry. Rows ≥ 44 px, the sheet fills
  the screen, and *Start an entry* lands the caret in the new entry's prose even
  from Reading view.
- Vim: `⏎` in normal mode still moves down outside a draft.
- Frames, the start column: with *Frame follows the indent* off, every box starts in
  the same place and the markers and the times run down one column each; only the
  prose steps right. With it on, the boxes step right with the nesting.
- Frames, Live Preview: every entry is enclosed by one unbroken box spanning the
  text column; the box's top rail runs through the middle of the entry's own marker
  row and its bottom edge through the middle of its own clock row, each exactly
  once and never dimmed. The bottom edge is labelled twice: the moment at the
  left corner, the duration at the right, with the rail visible between them, and
  both labels read as white digits around dimension-coloured colons. The day's date
  Marker, moment and stopwatch all read at the note's own weight — no bold, and no
  date: the filename is the day. Both rails are cut behind their labels,
  with a short stub left beside each corner — `16 px` on the left, `10 px` on the
  right — so the box reads as running into its own text, and no glyph or label
  background is clipped at the row's bottom. Scroll to the middle of a long entry:
  the box stays whole with its last line still off-screen. Two neighbouring boxes
  never overlap — 8 px of clear space, at least, between one entry's clock centre
  and the next entry's marker centre.
- Frames, the caret: put the caret on the marker row or on the clock row — the
  text stays exactly where it is, both labels keep cutting their rails, and nothing
  steps aside. On the clock row the raw line keeps the widget's air, so crossing it
  moves nothing vertically either. *Frame each entry* applies in Live Preview at once;
  Reading view redraws its frames when the note is rendered, not on the settings change. Turning *Frame each entry* off removes every box and leaves the lines
  untouched; Source mode never draws one.
- Frames, live: while an entry is being written its border shimmers counter-
  clockwise along the visible rails, and the shimmer is hidden behind the labels; a
  still entry does not shimmer.
- Frames, Reading view: the same boxes, one per entry, with the prose inside and no
  second indent; a nested entry's frame starts one indent step further right; the
  marker hangs half a line over the top rail and the clock half a line over the
  bottom one, both centred on their rails, with the frame's air halved to `0.45em`
  either side.
- Frames, phone: the box reaches the pane's edge, and the moment and the duration
  read on one line at the bottom two corners.
- Whisper, warm: with *Whisper settled entries* on and oMLX answering, write about
  forty dictated words, pause two seconds, press `⏎`. The `~` rows appear above the
  prose in the same undo as `+` — one `⌘Z` removes both — neutral where the prose is
  tinted, and the navigator row shows the whisper name.
- Whisper, cold: type continuously and press `⏎` inside a second. `+` lands at once
  and nothing waits; a second or two later the rows appear above the prose without
  the landing moving the caret, as their own undo step.
- Whisper, the hold: the same, with the caret kept in that entry. No whisper lands
  while the caret is there; moving to the next entry lets it land.
- Whisper, the day: open a note with five unwhispered entries — today's or any past
  day, the command follows the note on screen — and run *Whisper the day*: one
  notice, then one notice with the count, every entry carrying a whisper, and one
  `⌘Z` removing all five.
- Whisper, a dead endpoint: point the endpoint at a port that refuses connections.
  `⏎` behaves exactly as before and no notice appears; after two failed requests
  nothing more is asked, and `[Weaver]` logs `the endpoint did not answer` once with
  *Debug logging* on. *Whisper the day* then says
  `No whisper was written: the endpoint did not answer.` — and, on an endpoint that
  wants a key it was not given, `the endpoint refused this device (HTTP 401): API key
  required.` A status is never flattened into one verdict: a 404 says the endpoint has
  no such model, a 5xx says it failed, and each carries the server's own sentence
  (`… does not fit under the dynamic memory ceiling`) because that is the one with the
  fix in it.
- Whisper, Reading view: the rows render as plain text at the entry's indent, in the
  note's colour, inside the frame, with the static frame's rails unchanged.
- Whisper, in flight: type, pause, and watch the entry's frame. Once the request has
  been pending for 200 ms the travel stops and one ring leaves the box's centre and
  dies at its edge, again every 1.6 s, behind the words; it disappears when the answer
  lands. A request answered inside 200 ms shows nothing. With *Reduce motion* on, the
  ring is a still dashed rule instead, and it still appears and disappears.
- Whisper, phone: a note whispered on the desktop renders its rows neutral, indented
  by the phone step, inside the frame. Capturing on the phone with the default
  loopback endpoint settles with no delay and asks nothing.

## Known limits

- Entry markers are plain text, so Obsidian's outline, folding and `[[#heading]]`
  links do not list entries. The navigator is the only navigation, and it lists
  today's note: another day is reached by opening that note.
- The navigator has no query: a sixty-entry day is scrolled, or walked with the
  arrows. Filtering is a contained addition (one input, one filter), not a redesign.
- The frame's box is full-width by design: a hugging box could not put the clock in
  its own bottom-right corner without rendering the row twice.
- Durations are whole seconds: a session under half a second reads `00:00:00`, and
  a hundredth of a second is not recoverable.
- A phone has no newline gesture inside an entry: its prose is one paragraph.
  Multi-line prose is written on a desk or pasted.
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
npm run check     # typecheck + tests + proof gate + production build
```

`src/core` is pure and has no `obsidian` import; the editor, reading and entries
layers sit on top of it. `src/entries/writer.ts` is the one writer to disk — the
open editor when there is one, the vault otherwise, never both — and
`src/entries/engine.ts` is the only place an entry is changed through the editor.
Every change to entry text is a plan from `src/core/insert.ts`. `SYSTEM-DESIGN.md`
is the map: what each module is for, and which sentence is checked by which gate.
