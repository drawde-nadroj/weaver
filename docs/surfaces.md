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

- One font: the note's. The marker, the stopwatch and the close mark used to ask
  for `--font-monospace` while the prose did not, so one entry read as two
  typefaces. Everything Weaver writes now inherits `--font-text`, and clocks stay
  aligned by `font-variant-numeric: tabular-nums` instead of by a monospace face.
- The marker line and the prose lines carry `--weaver-dcolor` and `--weaver-d`, so
  the stylesheet needs no per-level rule: colour and indent are one `calc()`.
- The marker keeps its text. Only its runs are marked up: digits are
  `.weaver-dcn-num` (the note's own text colour), punctuation `.weaver-dcn-ink`
  (the dimension's colour). The line therefore stays typable.
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
  twice. `duration-ticker.ts` is the one writer, shared with the frame's clock.
- The two `.weaver-duration-ink` colons are separate spans because they take the
  dimension's colour while the digits keep the text colour.
- The widget is `display: block` with 6 px of bottom padding: a span cannot take
  vertical padding, and that padding is the only air between the stopwatch and
  whatever follows it.
- A marker line whose selection touches it gets `.weaver-entry-head-raw`.
- On a past-day note, ` - [[2026.10.26]]` is rendered after the clock and is never
  written to the file.

### The frame, around every entry

CodeMirror gives each line its own element and offers no way to wrap a range of
lines in a container, so the box is **drawn over the note**: one absolutely
positioned layer inside `.cm-scroller`, one box per entry, in document coordinates.

- `src/core/frame.ts` is the contract, ported from pi-frame's `frameRail` rather
  than imported (pi-frame is terminal cells; this is pixels). A frame starts at a
  limited width, grows with the text it encloses, and stops at the edge of the
  column. Below 120 px of room it is not drawn at all, and then nothing is hidden.
- The layer is `z-index: -1` inside the scroller, which CodeMirror already makes a
  stacking context. It therefore paints above the page and under the note's text,
  which is what lets a chip sit *behind* the file's own marker instead of over it.
- Nothing reflows: the box catches up to the text, never the other way round.
  `.cm-scroller` is already `position: relative`, so the boxes scroll with the
  content and a scroll costs no measurement; only a reflow or a resize schedules
  one, and the schedule is one `requestAnimationFrame` however many updates ask.
- The rails run through the middle of the rows they name. The marker's line and the
  duration line are at `opacity: 0` — laid out, caret-able, still in the
  accessibility tree — and the frame paints their runs on the rails. Put the caret
  on one of those rows and the line stops being transparent: the file's own text
  comes back, and a chip of page colour cuts the rail behind it. That is the same
  raw-text rule the duration widget has always followed.
- The hiding is scoped to `weaver-frames-live`, a class the layer puts on the
  scroller only while it has frames drawn. A pane too narrow to carry one, a
  surface the layer does not run on, and Source mode all keep the file's words
  visible.
- Labels render the canonical marker (`{ 1.2.3 } - 13:27:43`), not the file's raw
  prefix, and take the entry's colour with the digits in the text colour. They
  ellipsize rather than leave the rail; the width floor is a marker's worth so the
  clock is never the part that goes.
- The live entry's rails carry a highlight travelling counter-clockwise once every
  three seconds, and stop under `prefers-reduced-motion`. The bottom rail's clock
  is the same ticker as the widget's.
- Frames are Live Preview only. Source mode is the file's own text, which is the
  point of it.

### The entry, in Reading view

The same shape, from a post processor: a `<p>` starting with a marker becomes the
frame's top label, each following sibling becomes `.weaver-entry-prose` inside the
frame, and a `<p>` that is only a duration becomes the frame's bottom label — with
the wrapper and the labels both drawn by CSS. The browser does the hugging: the
frame is a real element, so `width: fit-content` is the whole measurement, with the
same width floor and the same one-row gap between frames.

The wrapper is inserted on purpose; the older shape promised no wrapper at all.
Nesting is carried by the frame's left margin rather than by padding on the text
inside it, and the text inside gives up its own indent so it is not indented twice.
Inline markup inside the prose is untouched, and only the marker's own characters
leave the marker paragraph — a title typed after the clock, with its links and
emphasis, stays in the DOM exactly as Obsidian made it.

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

Thirteen settings in four groups. **Writing** is the note's own convention, **Day**
is where the day note lives, **Look** is how the note is drawn (including whether
it is framed at all), **Advanced** is the past-day link and logging. There is no
palette mode, no depth cap, no per-level size field and no travel default level:
colour is a function of `D` alone, and the travel card always starts at the first
day holding a draft.

## Mobile matrix

| Surface | Desktop | Phone |
| --- | --- | --- |
| Entry | marker on the frame's top rail, digits in the text colour, punctuation coloured | same, with `--weaver-indent-step-mobile` |
| Frame | hugs the text, one row of air between frames | same; the width floor and the pane edge are the only limits |
| Duration | block widget, ticks while live, drawn on the frame's bottom rail | same, pinned to the bottom of the writing band after each keystroke |
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
