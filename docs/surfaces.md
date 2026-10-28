# Weaver — surfaces

Four surfaces, and one rule: **the note is the record, the cards are the work and
the navigation, the settings are the look.** Everything else was removed in 0.4.0 —
the status strip, the Tapestry, the shuttle, the weave row, the draft blocks and
the in-page markers duplicated one of these. The entry palette is the one surface
0.5.0 added, and it writes only what `⏎`, `n` and `x` write.

## One verb per intent

| Intent | Verb | Where |
| --- | --- | --- |
| Begin | `⌘⇧E` *Start an entry* | anywhere, including inside an editor, Reading view, and no note at all |
| Go deeper by hand | `⌘⇧J` *Insert a child entry* | the caret's entry |
| Finish this entry | `⏎` | the open entry the caret is in, on every platform |
| Go deeper | `⏎` again, on a settled entry | the settled entry the caret is in |
| Work a list | `⌘⇧P` *Entry palette* | anywhere; it shows today's note |
| Make a newline | `⇧⏎` or `weaver:line-break` | the caret, in any entry |
| Go somewhere else | `⌘⇧⏎` *Travel to a draft* | anywhere |
| End the day | *Close the day* | anywhere |

`⏎` is two-way and stateless. In an open entry — `-` being written or `=` paused —
it settles the duration to `+` and stops the clock, and nothing else moves. In a
settled entry it opens a child one dimension deeper with the caret in that child's
prose. Nothing is remembered between presses, so `⏎` on yesterday's `+` entry
descends too. Every non-entry line is Obsidian's, as is every key Vim's normal mode
owns; Obsidian's own newline inside an entry is `⇧⏎`, and on a phone — where a soft
keyboard has no `⇧⏎` — `weaver:line-break` is the newline the toolbar can host.

`⌘⇧E` is bound twice on purpose. The command covers the caret that is not in an
editor; inside an editor CodeMirror's own keymap takes the same chord at
`Prec.highest`. It is `⌘⇧E` and not `⌘⏎` because Obsidian's core *Open link under
cursor in new tab* owns `⌘⏎` and its scope runs in the document's capture phase,
so no plugin keymap — at any precedence — ever sees that chord.

## The audit

Every surface must answer three questions; one that cannot is not a surface.

1. **What does it write?** The note says exactly. A surface that writes nothing
   says so, and a surface that writes something says what.
2. **What happens if it is wrong?** One undo reverses any single action: a plan is
   one transaction, including the sibling renumbering that an insert causes.
3. **What does it show when there is nothing?** Travel says
   `Weaver: no drafts to travel to.` and writes nothing. Insert says
   `put the cursor in an entry first. Nothing was written.` and writes nothing.

## Surface specs

### The entry, in the editor

- The marker line and the prose lines carry `--weaver-dcolor` and `--weaver-d`, so
  the stylesheet needs no per-level rule: colour and indent are one `calc()`.
- The marker keeps its text. Only its runs are marked up: digits are
  `.weaver-dcn-num` (white in both themes), punctuation `.weaver-dcn-ink` (the
  dimension's colour). The line therefore stays typable.
- The duration line is a block widget while the selection is elsewhere, and raw
  text while the selection touches it. Both come from a `StateField` — a block
  widget from a plugin throws.
- The widget ticks itself whenever the session is live, whatever sigil the file
  holds: while writing, the line reads `-` whether the file says `-` or not. It
  mutates the three `.weaver-duration-num` spans every second and nothing else, so
  there is no transaction, no re-render and no undo entry.
- Its `eq` ignores the elapsed time, so a refresh after a keystroke finds the same
  widget and leaves the DOM alone; the sigil, the liveness and the colour are
  repainted in place by `updateDOM`. The line's top stays identical to the pixel
  across a run of insertions — that hop was the old per-keystroke redraw.
- The ticker belongs to the element, not to the widget instance: CodeMirror calls
  `updateDOM` on the *new* widget while the previous instance may still hold an
  interval, and one writer per element is what keeps the digits from counting
  twice.
- The two `.weaver-duration-ink` colons are separate spans because they take the
  dimension's colour while the digits stay white.
- The widget is `display: block` with 6 px of bottom padding: a span cannot take
  vertical padding, and that padding is the only air between the stopwatch and
  whatever follows it.
- A marker line whose selection touches it gets `.weaver-entry-head-raw`.
- On a past-day note, ` - [[2026.10.26]]` is rendered after the clock and is never
  written to the file.

### The entry, in Reading view

The same shape, from a post processor: a `<p>` starting with a marker becomes
`div.weaver-entry-head` with the same span split; each following sibling becomes
`.weaver-entry-prose` until the next head or duration paragraph; a `<p>` that is
only a duration becomes `div.weaver-duration`. No wrapper is inserted, so margins
do not move, and inline markup inside the prose is untouched.

### The entry palette

- Self-mounted overlay with the travel card's geometry (`.weaver-travel-modal` for
  position, its own `.weaver-palette-card`), and the same refusal of a `Scope`.
- Rows are today's entries in document order: `D.C.N`, clock, title, `+N` children,
  and `+` settled or `→` open. The selection starts on the entry the caret is in,
  or the one directly above it.
- `⏎` settles the selection and descends under it, `n` appends a root at the tip,
  `x` deletes the selection's whole subtree in one undoable transaction. `n` and
  `x` are commands only while the query is empty and no filter is locked: the key
  event is left alone otherwise, so a bare letter reaches the input.
- The query is the travel grammar — `1`, `1.2`, `.14`, `1.2.14` — from the same
  `parseDcnQuery`/`filterRows` pair, locked with `⏎`. `Esc` clears the query, then
  the filter, then closes and leaves the CM caret on the selection's prose.
- Every action re-reads the index from the live document: the card never caches a
  line number across a write.
- Opening pauses the stopwatch, like the travel card.

### The travel card

- Self-mounted overlay, centred with `transform: translate(-50%, -50%)` from the
  note pane's rect (the visible viewport on a phone), re-measured on resize, on
  `visualViewport` changes and on `layout-change`.
- **It never takes a `Scope`.** A scope is what swallowed `⌘,`; here any chord with
  `⌘`/`⌃`/`⌥` is ignored before `preventDefault`.
- Composition: query input, day chips (`2026.10.26 · 3`), rows
  (`.weaver-travel-dcn` + clock + title), one hint line. Rows and chips are
  `<button>`s, so touch works with no keyboard.
- A locked filter regroups both axes: `←`/`→` walk only days that hold a match,
  `↑`/`↓` walk the matches inside the current day.
- Opening pauses the stopwatch. Travelling closes the card, focuses the editor and
  sets the travel target; it does **not** start the session.

### The travelled entry

`.weaver-travel-rect` is an absolutely positioned overlay inside the editor,
measured from `coordsAtPos` over the entry's prose lines. No padding, no border on
lines, no margins — turning it on moves nothing. It re-measures on scroll because
it lives outside the scroller, and it hides when the target's `N` is not in the
document.

### The close mark

`✓ HH:MM:SS` is banded in Live Preview (line decoration) and muted in Reading view
(paragraph class). It is never an entry and never enters `travels`.

## Settings

Twelve settings in four groups. **Writing** is the note's own convention, **Day**
is where the day note lives, **Look** is how the note is drawn, **Advanced** is the
past-day link and logging. There is no palette mode, no depth cap, no per-level
size field and no travel default level: colour is a function of `D` alone, and the
travel card always starts at the first day holding a draft.

## Mobile matrix

| Surface | Desktop | Phone |
| --- | --- | --- |
| Entry | mono marker, digits white, punctuation coloured | same, with `--weaver-indent-step-mobile` |
| Duration | block widget, ticks while live | same, pinned to the bottom of the writing band after each keystroke |
| Travel card | centred in the pane, 420 px | full width − 24 px, rows ≥ 44 px, centred on the visible viewport |
| Entry palette | same geometry, travel's row and query rules | same, rows ≥ 44 px, centred on the visible viewport |
| Travel keys | arrows, `⏎`, `Esc` | same keys plus tap targets; the soft keyboard never covers the selected row |

The phone pinning runs one pure decision — `shouldPinStopwatch` — that requires all
four of: a phone, the live session, the caret on the entry's last prose line, and a
duration line to pin. Moving the caret into the middle of a long entry scrolls
nothing.

## Record formats

```markdown
{ 1.1.1 } - 16:10:00
the first prose line is the title, the rest is the entry
+ 00:04:12
```

- Marker: `{ D.C.N } - HH:MM:SS`, matched as a prefix. `{1.2.3}-13:27` reads as
  13:27:00. A marker in frontmatter or a fenced block is text.
- Prose: everything after the marker up to the next marker or duration line,
  trimmed of blank lines at both ends.
- Duration: `[+-=] HH:MM:SS`, the same shape as the marker's clock. `-` is open and
  being written, `=` is open and paused, `+` alone is settled. Minutes and seconds
  are `0–59`, hours unbounded, and the field is the only mutable part of an entry.
  A settled entry is never rewritten.
- Frontmatter: `date`, `travels`, `depth`, `duration`. Written only when a value
  changes.
- Close: `✓ HH:MM:SS`, at most one per day.
