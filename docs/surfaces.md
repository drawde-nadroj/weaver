# Weaver — surfaces

Three surfaces, and one rule: **the note is the record, the navigator is the
navigation, the settings are the look.** Everything else was removed — the status
strip, the Tapestry, the shuttle, the weave row, the draft blocks, the in-page
markers, the entry palette, the travel card and the travel rectangle each
duplicated one of these. The navigator is the one surface that moves the caret, and
it writes only what `⏎`, `n` and `x` write.

## One verb per intent

| Intent | Verb | Where |
| --- | --- | --- |
| Begin | `⌘⇧E` *Append an entry* | anywhere, including inside an editor, Reading view, and no note at all |
| Finish this entry | `⏎` | the open entry the caret is in, on every platform |
| Go deeper | `⏎` again, on a settled entry | the settled entry the caret is in |
| Go deeper, or somewhere else | `⌘⇧P` *Today's entries* | anywhere; the card shows today's note |
| Make a newline | `⇧⏎` or `weaver:line-break` | the caret, in any entry |
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
   one transaction, including the branch renumbering that a deletion causes. An
   insert never renumbers anything — a child inherits its parent's `C`.
3. **What does it show when there is nothing?** The navigator says
   `no entries yet — ＋ appends the first` and writes nothing. *Append an entry*
   whose day note cannot be created says `today's day note could not be found.
   Nothing was written.`

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
  twice. `duration-ticker.ts` is the one writer; the frame draws no clock of its
  own.
- The two `.weaver-duration-ink` colons are separate spans because they take the
  dimension's colour while the digits keep the text colour.
- The widget is the bottom rail's label: `display: block`, `width: fit-content`,
  pushed right by `margin-left: auto`, with `10 px` of right padding and `6 px`
  below. Its own background paints over the rail behind it, which is why it needs no
  second element to cut the rail and no character moves when it appears.
- On a past-day note, ` - [[2026.10.26]]` is rendered after the clock and is never
  written to the file. It is part of the marker row, so it is part of the top rail's
  label and cuts the rail behind itself.
- The marker's characters are the top rail's label, punctuation and all: one
  `.weaver-frame-label` mark over the whole marker, whose background covers the rail
  behind it. The hyphen is punctuation like the braces, never a second drawing of
  the rail, and no character of the label belongs to the box instead of the text.

### The frame, around every entry

CodeMirror gives each line its own element and offers no way to wrap a range of
lines in a container, so the box is **drawn over the note**: one absolutely
positioned layer inside `.cm-scroller`, one box per entry, in document coordinates.

- The layer draws the border and the live highlight, and no text at all. The label
  is the entry's own: the marker row sits on the box's top rail, its own duration
  row on the bottom rail. Each appears once, from the file, and is never dimmed,
  hidden or duplicated.
- Both rails run through the *middle* of the row that labels them, and the label's
  own background — `.weaver-frame-label`, note-background fill plus an 8 px shadow —
  paints over the rail behind it. That is the whole mechanism: no second rendering of
  the row, no masked rail, no character moved. The rails keep a short stub beside
  each corner, which is what makes the box read as a frame rather than a box.
- The box spans the text column: one label inset (`32 px`: corner `10` + stub `14` +
  label pad `8`) outside the marker's ink on the left, and `20 px` past the text
  column's right edge. A box that hugged its text could not put a clock in its own
  corner without a second rendering of the row. `src/core/frame.ts` is the whole
  geometry, two pure functions: `frameBox` and `frameSpan`.
- Nothing reflows: the box catches up to the text, never the other way round.
  `.cm-scroller` is already `position: relative`, so the boxes scroll with the
  content and a scroll costs no measurement; only a reflow or a resize schedules
  one, and the schedule is one `requestAnimationFrame` however many updates ask.
- The rows are found by their own `data-weaver-n` stamp — written by the decoration
  that makes the marker line and by the duration widget itself — never by a DOM
  position. Asking CodeMirror for the position of the widget's element named the
  wrong line, so the clock was measured as something else. A row that has scrolled
  out of the render range falls back to its line block, whose centre is still the
  label's centre.
- Sibling boxes never cross: a box is withheld when the next entry's top rail is
  closer than 8 px to its bottom rail. There is no trimming — a rail is a label's
  centre or it is nothing — so a box is never drawn at a height that cuts its own
  clock. When the rails touch or cross, there is no interior and no box.
- A marker row that also carries prose (the legacy title case, `{ D.C.N } - HH:MM:SS
  a title`) keeps its rail *above* the row, by 12 px, or the rail would cut the
  entry's own first line.
- An entry without a duration has no bottom label, so its box closes 8 px below its
  last prose row — on air, not on a rail.
- There is no width below which a box is withheld: a narrow pane gets a narrow box.
  The only way to have no frame is to have measured nothing yet — a frame is never
  a function of the caret, the scroll position or the width of the pane.
- The duration row is right-aligned while nothing else is, so the clock reads in the
  box's bottom-right corner on every surface. It keeps `tabular-nums`, so a ticking
  second never moves the line.
- The live entry's border carries a highlight travelling counter-clockwise once
  every three seconds, and stops under `prefers-reduced-motion`. The labels paint
  over it, so the shimmer travels the visible rails only.
- Frames are Live Preview only. Source mode is the file's own text, which is the
  point of it.

### The entry, in Reading view

The same shape, from a post processor: a `<p>` starting with a marker becomes the
frame's first child — the file's own marker characters, split into digit runs — each
following sibling becomes `.weaver-entry-prose` inside the frame, and a `<p>` that is
only a duration becomes its last child. The wrapper is a real element because a box
needs one to enclose, and the browser needs no measurement at all to draw it.

The frame's edges are the rails, so the first and last children *hang half a line
over them*: `align-self` shrink-wraps each one to its own text, and a negative
`margin-top`/`margin-bottom` of `0.675em` (half of the `1.35` line height) puts its
centre on the edge. Neither gets padding — a label must never move a character — so
the rail is cut by the label's own background and its 8 px shadow. The 1.8em vertical
margin is the measured Live Preview gap between one entry's clock centre and the next
marker centre, 58 px at 32 px type. A duration paragraph with no entry above it is
never labelled: it has no rail to cut.

Nesting is carried by the frame's left margin rather than by padding on the text
inside it, and the text inside gives up its own indent so it is not indented twice.
Inline markup inside the prose is untouched, and only the marker's own characters
leave the marker paragraph — a title typed after the clock, with its links and
emphasis, stays in the DOM exactly as Obsidian made it.

### The navigator

One component, one list, on both platforms: append, descend and jump in the same
card, with the return stack inside it.

- Self-mounted overlay, not a `Modal`: it must never take a `Scope`. A scope is what
  swallowed `⌘,` and stopped Obsidian's own settings from opening. Keys are handled
  on the card in the capture phase, and every chord it does not claim reaches
  Obsidian untouched.
- The first row is `＋ end of day`. Below it, when there are stops, a `return` block:
  one row per place a move left — `↩ D.C.N` while that entry exists. Below that,
  `today`: every entry in document order — `D.C.N`, clock, title, `+N` children — with
  the caret's own entry marked `is-current` and the selection marked `is-selected`.
- Keys: `↑`/`↓` move, `⏎` jump, `⇧⏎` settle and descend under the selection, `n`
  append, `x` delete the selection's whole subtree, `⌘[` walk back one stop, `Esc`
  close and put the caret back where the card opened. Every handled key is
  prevented and stopped; `⌘[` is the only chord claimed.
- Touch: a row taps to jump, the caret's own row taps to descend, and `✕` arms on
  the first tap and deletes on the second. The footer names the gestures the
  platform can make.
- Opening pauses the stopwatch, like leaving the note. Every action re-reads the
  document: the card never caches a line number across a write.
- The list is today's note, the same target *Append an entry* writes to. Reaching
  another day means opening that note.
- The stack lives in `src/core/navigator-stack.ts`: eight stops, no duplicate top
  (the same entry and the same caret), and a pop that hands the stop back.

### The close mark

`✓ HH:MM:SS` is banded in Live Preview (line decoration) and muted in Reading view
(paragraph class). It is never an entry and never enters `travels`.

## Settings

Thirteen settings in four groups. **Writing** is the note's own convention, **Day**
is where the day note lives, **Look** is how the note is drawn (including whether
it is framed at all), **Advanced** is the past-day link and logging. There is no
navigator mode, no depth cap and no per-level size field: colour is a function of
`D` alone, and the navigator always opens on today's note with the caret's entry
selected.

## Mobile matrix

| Surface | Desktop | Phone |
| --- | --- | --- |
| Entry | the marker row is the frame's top rail label, digits in the text colour, punctuation coloured | same, with `--weaver-indent-step-mobile` |
| Frame | rails through the marker and duration rows' centres, cut behind their labels | same, identically: one layer, one rule, no platform branch |
| Duration | block widget, ticks while live, the bottom rail's label at the frame's bottom-right | same, pinned to the bottom of the writing band after each keystroke |
| Navigator | card centred over the note, keys in its footer | full-screen sheet, rows ≥ 44 px, taps in its footer |
| Navigator keys | arrows, `⏎`, `⇧⏎`, `n`, `x`, `⌘[`, `Esc` | tap to jump, tap the caret row to descend, `✕` twice to delete |

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
  13:27:00. A marker in frontmatter or a fenced block is text. In a frame it is the
  box's top rail label; the hyphen is ordinary punctuation of that label.
- `C` is the thread: a depth-1 entry's `C` is its position among depth-1 entries, and
  everything under it carries that same `C` all the way down. An insert inherits it;
  deleting a root renumbers the survivors, in the same undoable transaction.
- Prose: everything after the marker up to the next marker or duration line,
  trimmed of blank lines at both ends.
- Duration: `[+-=] HH:MM:SS`, the same shape as the marker's clock. `-` is open and
  being written, `=` is open and paused, `+` alone is settled. Minutes and seconds
  are `0–59`, hours unbounded, and the field is the only mutable part of an entry.
  A settled entry is never rewritten.
- Frontmatter: `date`, `travels`, `depth`, `duration`. Written only when a value
  changes.
- Close: `✓ HH:MM:SS`, at most one per day.
