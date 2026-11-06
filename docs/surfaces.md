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
| Begin | `⌘⇧E` *Start an entry* | anywhere, including inside an editor, Reading view, and no note at all |
| Finish this entry | `⏎` | the open entry the caret is in, on every platform |
| Go deeper | `⏎` again, on a settled entry, or *Descend into a child entry* | the settled entry the caret is in |
| Go deeper, or somewhere else | `⌘⇧P` *Today's entries* | anywhere; the card shows today's note |
| Make a newline | `⇧⏎` | the caret, in any entry, on a desk |
| Read the settled entries | *Whisper the day* | the day note on screen, else today's |
| End the day | *Close the day* | anywhere |

`⏎` is two-way and stateless. In an open entry — `-` being written or `=` paused —
it settles the duration to `+` and stops the clock, and nothing else moves. In a
settled entry it opens a child one dimension deeper with the caret in that child's
prose. Nothing is remembered between presses, so `⏎` on yesterday's `+` entry
descends too. Every non-entry line is Obsidian's, as is every key Vim's normal mode
owns; Obsidian's own newline inside an entry is `⇧⏎`, on a desk. A phone's soft
keyboard has no `⇧⏎` and `⏎` settles everywhere, so a phone has no newline gesture
inside an entry: its prose is one paragraph, and multi-line prose is written on a
desk or pasted.

`⌘⇧E` is bound twice on purpose. The command covers the caret that is not in an
editor; inside an editor CodeMirror's own keymap takes the same chord at
`Prec.highest`. It is `⌘⇧E` and not `⌘⏎` because Obsidian's core *Open link under
cursor in new tab* owns `⌘⏎` and its scope runs in the document's capture phase,
so no plugin keymap — at any precedence — ever sees that chord.

Every command carries an icon, and the mobile toolbar is the writer's to configure:
Obsidian has no API that places a command on it, so *Start an entry* and *Descend
into a child entry* are added under *Manage toolbar options*.

## The audit

Every surface must answer three questions; one that cannot is not a surface.

1. **What does it write?** The note says exactly. A surface that writes nothing
   says so, and a surface that writes something says what.
2. **What happens if it is wrong?** One undo reverses any single action: a plan is
   one transaction, including the branch renumbering that a deletion causes. An
   insert never renumbers anything — a child inherits its parent's `B`.
3. **What does it show when there is nothing?** The navigator says
   `no entries yet — ＋ starts the first` and writes nothing. *Start an entry*
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
- That `calc()` is stated at four classes —
  `.markdown-source-view.mod-cm6 .cm-line.weaver-entry-head` and the same for the
  prose — because Obsidian's `.markdown-source-view.mod-cm6 .cm-line { padding: 0 }`
  is three classes. At one class the indent never painted: the marker and the prose
  sat at the pane's left edge at every level while the clock row, a block widget and
  not a `.cm-line`, indented alone, so the time drifted right of the text it
  belonged to. Measured at an 8 px step: level 1 at 52 px, level 2 at 60 px, level 3
  at 68 px, marker, prose and stopwatch agreeing at every level.
- The marker keeps its text. Only its runs are marked up: digits are
  `.weaver-dcn-num` (the note's own text colour), punctuation `.weaver-dcn-ink`
  (the dimension's colour). The line therefore stays typable.
- The clock row is a block widget while the selection is elsewhere, and raw text
  while the selection touches it. Both come from a `StateField` — a block widget
  from a plugin throws.
- The row has three states, and they decide both corners. `fixed` draws the file
  and never ticks. `awaiting` is a draft whose clock row holds a duration and no
  moment yet: the left corner still reads zero and the right corner carries the
  live wall clock the first input will record. `running` is the live session for
  this entry, whatever sigil the file holds: the left corner reads `-` and the
  duration the session has painted, the right corner the moment already recorded.
- No widget owns a timer. `EntryClock` (`entries/clock.ts`) is one shared clock per
  plugin instance: a tick samples the real time once, floors the elapsed
  milliseconds to whole seconds, paints every subscriber synchronously, and only
  then commits that painted value to the session. A stop therefore writes the last
  second a surface actually showed, never a fresher wall-clock sample that the
  writer never saw.
- A subscription paints the last snapshot before joining the tick, so a second
  pane, an adopted element or a redraw never advances the digits and never
  restarts the count. The timer runs at the nearest of the next wall second and
  the next session second, derived from the actual time on every wakeup, so a
  delayed callback reconciles instead of replaying or drifting. It keeps sampling
  while a session is live even with no surface mounted, and stops when neither is
  true.
- While nothing is mounted the clock still commits, and while a row is mounted the
  widget writes only the half that moves: the duration half's three digit spans,
  scoped to `.weaver-duration-clock` — the moment carries `.weaver-duration-num`
  spans too. There is no transaction, no re-render and no undo entry per second.
- Its `eq` ignores the elapsed time, so a refresh after a keystroke finds the same
  widget and leaves the DOM alone; the sigil, the mode, the colour and the moment
  are repainted in place by `updateDOM`. The row's top stays identical to the pixel
  across a run of insertions — that hop was the old per-keystroke redraw.
- The subscription belongs to the element, not to the widget instance: CodeMirror
  calls `updateDOM` on the *new* widget while the previous instance may still hold
  a subscription, and one writer per element is what keeps the digits from counting
  twice. Adopting an element releases the previous writer before subscribing.
- Each half is three digit spans around two `.weaver-duration-ink` colons: digits in
  the note's own text colour, colons in the dimension's. `appendClockRuns` builds
  both halves from one grammar, the same one the marker uses, so the moment reads
  exactly like the stopwatch beside it.
- The widget is one flex row with two labels: the duration at the left corner and
  the moment at the right, each `.weaver-frame-label` with its own background. The
  row itself is transparent, so the rail runs visibly between them. `display: flex`
  is stated `!important`, because Obsidian's `.cm-content > *` rule sets
  `display: block` at higher specificity and would inert `justify-content` and
  `margin-left: auto`. `margin-left: auto` on the moment half is what keeps a
  moment-only row's label at the right corner; a duration-only row stays at the
  left. The sigil is followed by a real space text node, so the rendered row reads
  `+ 00:04:12`, exactly like the file.
- Neither half overhangs the row: Obsidian's `contain: paint` on a block widget clips
  at the row's padding box, so a `-32px` margin or a `padding-right` never painted
  past the text column. Instead the row carries `3px` of padding above and below —
  the air that keeps each label's background and 8 px shadow inside the clip — and
  the frame's own gutter is the stub beside the corner. The raw row, which is what
  the file's text is while the caret sits on it, carries the same `3px` and the same
  line height, so crossing the row with the caret moves nothing. Its selector is
  `.markdown-source-view.mod-cm6 .cm-line.weaver-duration-raw` — four classes on
  purpose: at three it would only tie Obsidian's `.cm-line { padding: 0 }`, and the
  row would jump by the air whenever the caret crossed it, depending on stylesheet
  order.
- A half the row does not carry is not drawn: the frame labels only what the note
  holds, never an invented `00:00:00`.
- New entries are written as `- 00:00:00` and gain their recorded day and moment
  on the first text, from that input's own timestamp, so an entry made before
  midnight and typed after it records the day it was written in. Existing dates
  and moments are never replaced, and a settled entry never acquires one.
  Historical undated entries inherit the filename day.
- The recorded day is labelled only when it differs from the note's own day: a
  creation day other than the filename day has a permanently visible top-right
  link in the note's date style. An awaiting draft has no recorded beginning, so
  it has no date link — the filename's day would claim a creation day the first
  input has not chosen yet — and a captured same-day entry and a historical
  undated entry have none either, including no hidden keyboard stop.
  `core/day.ts` makes that shared decision in `entryDayLinkTarget`;
  `ui/day-link.ts` builds the link. The marker row positions it absolutely in
  Live Preview, and the static frame does the same in Reading view. Caret,
  hover and focus never change visibility; keyboard focus retains its outline.
  The link changes no text geometry. Opening or resuming an entry never redates it.
  Source mode and non-day notes carry no generated link.
- The frame's labels — marker, entry-day link, stopwatch and moment —
  carry the note's own weight; nothing sets one, and there is no weight setting. They
  are told apart from the prose by colour, tabular figures and position, not by
  weight.
- Where a frame starts is a setting. *Frame follows the indent* (on by default) gives
  the marker, the prose and the clock row the same indent, and because the frame's left
  edge sits a fixed air left of the marker, the boxes step right with the nesting. Off,
  only the prose is indented: the marker and the clock row stay in the left margin, the
  frame's edge follows them, and markers and times form one column each down the note.
  The body class is `weaver-frame-fixed`. Measured at a 12 px step, level 3: on, the
  marker, prose, raw row and clock widget all at `24 px`; off, the marker, raw row and
  clock widget at `0` with only the prose at `24 px`.
- Two spacing settings sit beside it. *Space below each Thread* is air above every
  depth-1 entry after the note's first Thread, so a Thread's subtree does not run into
  the next. *Space between branches* is air above each branch whose predecessor is also
  a branch, so the first branch stays close to its root and later siblings separate.
  `weaver-thread-start` and `weaver-branch-start` carry the decision: on the marker row
  in Live Preview and on the static frame in Reading view. Both default to zero, and
  both are the same number on desk and phone.
- The marker's characters are the top rail's label, punctuation and all: one
  `.weaver-frame-label` mark over the whole marker, whose background covers the rail
  behind it. No character of the label belongs to the box instead of the text.

### The frame, around every entry

CodeMirror gives each line its own element and offers no way to wrap a range of
lines in a container, so the box is **drawn over the note**: one absolutely
positioned layer inside `.cm-scroller`, one box per entry, in document coordinates.

- The layer draws the border and the live highlight, and no text at all. The label
  is the entry's own: the marker row sits on the box's top rail, its clock row on
  the bottom edge — duration at the left corner, moment at the right. Each appears
  once, from the file, and is never dimmed, hidden or duplicated. The one generated
  label is the day link on another day; the entry decoration draws it in the marker
  row, not this layer, so it stays clickable above the text.
- Both rails run through the *middle* of the row that labels them, and the label's
  own background — `.weaver-frame-label`, note-background fill plus an 8 px shadow —
  paints over the rail behind it. That is the whole mechanism: no second rendering of
  the row, no masked rail, no character moved. The rails keep a short stub beside
  each corner, which is what makes the box read as a frame rather than a box.
- The box spans the text column with `16 px + 0.45em` outside the marker's ink
  on the left and past the text column's right edge, matching Reading view —
  the stub the rail leaves there. A box that hugged its text could not put the duration
  at one bottom corner and the moment at the other without a second rendering of the
  row. `src/core/frame.ts` owns `frameBox`, `frameSpan`, and the shared
  `frameLabelInset` clearance.
- Nothing reflows: the box catches up to the text, never the other way round.
  `.cm-scroller` is already `position: relative`, so the boxes scroll with the
  content and a scroll costs no measurement; only a reflow or a resize schedules
  one, and the schedule is one `requestAnimationFrame` however many updates ask.
- The rows are found by their own `data-weaver-n` stamp — written by the decoration
  that makes the marker line and by the clock widget itself — never by a DOM
  position. Asking CodeMirror for the position of the widget's element named the
  wrong line, so the clock was measured as something else. A row that has scrolled
  out of the render range falls back to its line block, whose centre is still the
  label's centre.
- Sibling boxes never cross: a box is withheld when the next entry's top rail is
  closer than 8 px to its bottom rail. There is no trimming — a rail is a label's
  centre or it is nothing — so a box is never drawn at a height that cuts its own
  clock. When the rails touch or cross, there is no interior and no box.
- A marker row that also carries prose (the inline-title case, `{ B.D.N } a title`)
  keeps its rail *above* the row, by 12 px, or the rail would cut the entry's own
  first line. `.weaver-entry-inline` raises any different-day label above the
  row too, without joining the text flow.
- An entry without a clock row has no bottom label, so its box closes 8 px below its
  last prose row — on air, not on a rail.
- There is no width below which a box is withheld: a narrow pane gets a narrow box.
  The only way to have no frame is to have measured nothing yet — a frame is never
  a function of the caret, the scroll position or the width of the pane.
- The clock row is one flex row: the duration at the box's bottom-left corner, the
  moment at the bottom-right, and the rail visible between them. Both keep
  `tabular-nums`, so a ticking second never moves the row.
- An ordinary live entry's border carries a highlight travelling counter-clockwise
  once every three seconds, stopped under `prefers-reduced-motion`. A captured
  live portal instead uses an eight-second multicolour pulse. Paused or settled
  portals use the ordinary static frame; prose and marker colours still follow dimension.
- One effect at a time, chosen by precedence in `src/editor/frame-effects.ts`. While
  a whisper request for an entry has been pending for 200 ms, that box shows the
  reading effect *instead of* the travel: one ring leaves the box's centre, dies at
  its edge and starts again every 1.6 s. It paints behind the text — the whole layer
  is below the note's words — so the ring crosses a glyph without competing with it.
  A request that answers inside 200 ms shows nothing, so a fast model does not blink.
  Under `prefers-reduced-motion` the ring becomes a still dashed rule inside the
  box: the state still shows, and nothing moves.
- Exact-second portal alignment shows one 800 ms acknowledgment above all other
  effects, then yields. Precedence is alignment, whisper reading, live portal,
  ordinary liveness; effects never stack. Reduced motion uses static treatment.
- Frames are Live Preview only. Source mode is the file's own text, which is the
  point of it.

### The composer and its openings

An opening is a minute, and the composer is where a thought is written. They are
one surface, not two competing cards: `src/ui/composer.ts` owns the element, and
`src/ui/portal.ts` draws the opening's status *inside* it — as the whole surface
when no draft exists, and as one line of the status row when one does.

An opening is not a permission that waits to be used. For `04:33` the interval is
`[04:33:00, 04:34:00)`: writing that *begins* inside it was written through it, and
finishing later changes nothing. A minute nobody entered is gone, and waking after
a sleep replays nothing, because the eligibility is derived from the calendar
rather than accumulated from timers.

There is no special gesture to enter an opening. The first committed non-whitespace
character of a root samples the instant once, freezes the beginning, and asks which
openings that instant qualifies for; a branch qualifies for none, because only a
root is written into a minute. Clearing every character resets the timing *and* the
association. Clicking `Weave` therefore does one thing — opens or resumes normal
writing in that Realm.

Two rules keep that honest at the edges. An opening is a whole minute, so a one-off
schedule configured at `05:11:04` is refused when read rather than silently snapped:
a record names a minute, and a beginning is measured against one. And evidence never
costs the words: when a record cannot be added to a note — an id that is not a whole
minute, say — the thought is written without it, because the entry *is* the record
and the alignment is extra. A note whose own history cannot be *read* is still
refused outright, because writing over evidence that cannot be parsed is worse than
declining to write.

The strip says the opening once: its Realm, its own local `HH:MM`, and what it is
doing — `opens in 06:05`, or `open · 00:39 left`, or `closed · writing normally`
when it closed under an empty composer. It has two homes and is moved between them,
never duplicated: when nothing is being written it *is* the surface, and while a
draft is open it is one line of that draft's status row. The rainbow belongs to an
opening that can still be entered and goes the moment its minute does;
`portalMotion` sets its duration, and `off` pins the angle while keeping the six
colours.

`src/ui/composer.ts` is the one bottom surface, and it speaks the note's own visual
language: the draft's dimension colour, the same rounded frame, two rails cut behind
their labels, the duration at the bottom-left and the moment at the bottom-right,
and the same digit grammar for an address. It is a labelled non-modal region — no
`aria-modal`, no focus trap, no dimming — mounted in the focused window's document
above every leaf, so a layout change cannot destroy the draft's input.

- Header: one `Realm: <name>` control, which opens the navigator's Realms tab
  without changing the destination or travelling. When viewing differs from writing,
  one quiet line says `Writing to <realm> · viewing <realm>`, and nothing repeats it.
- Editing: `Save ↵`, `Hide · Esc`, and a `More` menu holding `New Thread` and
  `Discard draft`. Saving is the draft's own accent rather than a second product's
  colour. `Shift-Enter` is a newline; a soft keyboard's Return is a save; a committed
  IME composition is one beginning, and its confirmation `Enter` is never a save; a
  held key never saves twice.
- Saving: the prose is read-only and the status says `Saving…`. A distinct second
  `Enter` dismisses, but only once the write is confirmed, and the note gains one
  settled entry either way.
- Resting: the saved thought is drawn from its note by `renderMarkdown`, the
  selection is the focusable target, `Branch · N` opens a child in the next
  dimension and `New Thread · T` a root, `More` holds `Edit in note`, and
  `Close · Enter` — a quiet action — closes.
- Structural motions on the saved selection: `j`/`↓` next thought, `k`/`↑` previous,
  `h`/`←` parent, `l`/`→` first child, all in document preorder over the Thread's own
  nodes. They are claimed only where no editable control or native button has focus,
  so `Tab` still reaches the surface's actions.
- `Hide` is not a dismissal: the words stay, the caret is remembered, and the clock
  stops on the second that was on screen. A hidden draft leaves one strip,
  `Resume · <realm> — <excerpt>`, which expands *then* restores the caret *then*
  focuses. An untouched root has nothing to resume and closes; a chosen branch is
  kept even while empty, because opening one was an intent.
- Choosing a Realm or another parent with words in the draft is a *proposal*, not an
  edit: the same draft is paused, the current and proposed parent are shown side by
  side, `Use this parent ↵` revalidates and applies, and `Keep original · Esc`
  changes nothing. The words, the beginning and the seconds on screen survive either
  way, and no saved entry ever moves.
- A failed save keeps the text, the timing and the reason; an unconfirmed one offers
  `Check save` and never a second write. A save that completes while the surface is
  hidden never expands it or takes focus.

Its box is measured, never inherited: `floatingComposerBox` puts it in the active
pane's text column, on the bottom edge of the visual viewport, and it grows upward by
exactly the height it rendered — a phone's keyboard and toolbar are reserved, not
overlapped. Opening it freezes the note's own clock first, so two clocks never run
for one thought.

Reading view draws no opening at all: a note is a record, and the surface floats
above every leaf regardless of which one is showing.

### The entry, in Reading view

The same shape, from a post processor: a `<p>` starting with a marker becomes the
frame's first child — the file's own marker characters, split into digit runs — each
following sibling becomes `.weaver-entry-prose` inside the frame. Obsidian can
render a signed clock as a separate list block; the processor reads its exact
source row, places the clock at the frame's bottom edge, and hides that separate
section without changing the note. The wrapper is a real element because a box
needs one to enclose, and the browser needs no measurement at all to draw it.
The marker's own soft break is removed too, so the first prose line starts
directly below the top label with only the 8 px clearance its background needs.
Later author-written breaks and inline markup remain intact.
A paused or moment-only clock can remain inside the marker's Markdown paragraph;
it is extracted onto the bottom rail too, so the creation date is never repeated
inside the prose.
An unprocessed next marker ends the current frame too: processing two entry
paragraphs in one render batch cannot accidentally nest their frames.

The frame's edges are the rails, so the first and last children *hang half a line
over them*: `align-self` shrink-wraps each one to its own text, and a negative
`margin-top`/`margin-bottom` of `0.675em` (half of the `1.35` line height) puts its
centre on the edge. Neither gets padding — a label must never move a character — so
the rail is cut by the label's own background and its 8 px shadow. The 1.8em vertical
margin is the measured Live Preview gap between one entry's clock centre and the next
marker centre, 58 px at 32 px type. A duration paragraph with no entry above it is
never labelled: it has no rail to cut.

The frame adds 16 px of horizontal air outside the existing `0.45em` inset:
negative outer margins cancel the extra padding, so the prose stays in place
while the labels' 8 px background halos no longer erase the curved corners. An
8 px row gap keeps those same halos off the prose's ascenders and descenders.
The clock row's `3px` of vertical padding is carried in its own negative margin
(`calc(-0.675em - 3px)`) so the rail still lands on the glyphs' centre. Static
frames allow overflow so the raised labels remain intact; unlike the editor's
paint-only overlay they also accept pointer events. In fixed mode the left
margin is `-16px`, cancelling the extra air without following the dimension.

Nesting is carried by the frame's left margin rather than by padding on the text
inside it, and the text inside gives up its own indent so it is not indented twice.
Inline markup inside the prose is untouched, and only the marker's own characters
leave the marker paragraph — a title typed after the clock, with its links and
emphasis, stays in the DOM exactly as Obsidian made it. A different-day entry's
creation-day link is appended to the static frame at its top-right corner; it
is a child of the frame, not of the shrink-wrapped head.

### The navigator

One component, one list, on both platforms: three tabs over the same card.

- Self-mounted overlay, not a `Modal`: it must never take a `Scope`. A scope is what
  swallowed `⌘,` and stopped Obsidian's own settings from opening. Keys are handled
  on the card in the capture phase, and every chord it does not claim reaches
  Obsidian untouched.
- `History` is one chronology for the chosen day, read from every recognised day
  note at once — including a branch written today inside yesterday's file. A row
  carries its address, its recorded time, and the reading or the first words, and a
  Realm tag only when the filter is `All Realms`. Rows with no recorded moment stay
  in their own group rather than at a fabricated midnight. The Realm filter is a
  picker that offers `All Realms` explicitly, and the day is a date field: both keep
  their native keys.
- `Realms` lists every Realm with one current indicator, and two different acts:
  `Travel` is a deliberate visit and `Write here` makes it the draft's destination
  without moving the screen. `Manage Realms` opens Weaver's settings rather than a
  second configuration surface.
- `Portals` lists the openings that can still be entered, the one that closed a
  moment ago, and the captures the notes really recorded — linked by their own note
  path and a validated entry, so a recorded row stays listed even when its entry is
  gone, with `Open` disabled and the reason beside it.
- Actions belong to the selected row, not to every row: `Open`, `Continue Thread`,
  `Branch`, and `Delete` behind a second press. There is no per-row delete control
  and no non-actionable heading to walk past.
- Keys: `j`/`↓` and `k`/`↑` move; `⏎` activates the selected row; `⇧⏎` and `n`
  branch, which opens a draft under that thought and writes nothing; `t` starts a new
  Thread; `c` continues the row's Thread; `Delete` arms and confirms; `⌘[` back and
  `⌘]` forward work while Weaver holds focus; `Esc` cancels a confirmation and then
  closes. On the tab list the arrows change tabs, so `h`/`l` never silently travel a
  Realm. Every handled key is prevented and stopped.
- Focus and selection are one model: a stable key identifies the row, a roving
  `tabindex` puts focus on it, and mouse and keyboard update the same value. A
  countdown tick rewrites the text of the rows that changed instead of rebuilding
  the list, so a ticking second never steals the row the writer is on.
- Opening pauses the stopwatch, like leaving the note. Every action re-reads the
  document: the card never caches a line number across a write.
- Travel is centralised in `src/main.ts`: `visitRealm` and `visitThought` capture the
  departure, refresh the current history stop to it, and append the arrival only
  after it succeeded. `Back` and `Forward` restore the recorded stop — the exact
  screen, not the Realm's latest one — so the history lives in
  `src/core/navigation.ts` as a cursor over up to sixty-four visits. A failed
  navigation changes neither the history nor the screen, and two overlapping ones are
  refused rather than raced.

### The close mark

`✓ HH:MM:SS` is banded in Live Preview (line decoration) and muted in Reading view
(paragraph class). It is never an entry and never enters `travels`.

## Settings

The groups are **Writing** (the note's own convention), **Day** (where the day note
lives), **Look** (how the note is drawn, including whether it is framed at all),
**Whisper** (whether a settled entry is read, and by which model — a thinking one needs
its reasoning turned off in the server's own model settings, because the answer budget
is 160 tokens and reasoning would spend all of it) and **Advanced** (logging only). The fields, their defaults and every
reader are the generated settings table in `SYSTEM-DESIGN.md`; this page does not
restate them. There is no navigator mode, no depth cap and no per-level size field:
colour is a function of `D` alone, and the navigator always opens on today's note
with the caret's entry selected.

## Mobile matrix

| Surface | Desktop | Phone |
| --- | --- | --- |
| Entry | the marker row is the frame's top rail label, digits in the text colour, punctuation coloured; a whisper row is neutral at the entry's indent | same, with `--weaver-indent-step-mobile`, and the same neutral whisper |
| Frame | rails through the marker and clock rows' centres, cut behind their labels; `16 px` left and `10 px` right; the date link at the top-right on another day; follows the indent or starts fixed | same, identically: one layer, one rule, no platform branch |
| Clock row | flex widget, ticks while live, the duration at the bottom-left corner and the moment at the bottom-right | same, pinned to the bottom of the writing band after each keystroke |
| Navigator | card centred over the note, keys in its footer | full-screen sheet, rows ≥ 44 px, taps in its footer |
| Navigator keys | `j`/`k`/`↑`/`↓`, `⏎`, `⇧⏎`, `n`, `t`, `c`, `Delete`, `⌘[`, `⌘]`, `Esc` | tap a row to select it, its action buttons to act, `Delete` twice to remove |
| Composer | bottom-anchored card in the text column with rails, dimension colour and the measured box | same surface, reserved toolbar and safe area, ≥ 44 px targets |
| Toolbar | *Weave a Thread*, *Branch from this thought*, *Back*, *Forward*, *Navigator*, *Whisper the day*, *Close the day* — every command carries an icon | the same seven, added under *Manage toolbar options* |
| Whisper | asked during a pause in typing and again at settle; the answer lands as its own undo | rendered identically; asked only when the endpoint is an address the phone can reach, so a default loopback endpoint generates nothing there |

The phone pinning runs one pure decision — `shouldPinStopwatch` — that requires all
four of: a phone, the live session, the caret on the entry's last prose line, and a
clock row to pin. Moving the caret into the middle of a long entry scrolls
nothing.

## Record formats

```markdown
{ 1.1.1 }
~ a whisper row: the model's name for what this holds
the first prose line is the title, the rest is the entry
16:10:00 + 00:04:12
```

- Marker: `{ B.D.N }`, matched as a prefix. `{1.2.3}` reads the same. A marker in
  frontmatter or a fenced block is text. In a frame it is the box's top rail label.
- `B` is the branch id: a depth-1 entry's `B` is its position among depth-1 entries,
  and everything under it carries that same `B` all the way down. An insert inherits
  it; deleting a root renumbers the survivors, in the same undoable transaction.
- Prose: everything after the marker up to the next marker or clock row, trimmed of
  blank lines at both ends.
- Clock row: the entry's last line, an optional duration `[+-=] HH:MM:SS` then an
  optional moment `HH:MM:SS`. Either half may be absent. `-` is open and being
  written, `=` is open and paused, `+` alone is settled. Minutes and seconds are
  `0–59`, hours unbounded, and the duration half is the only mutable part of an
  entry. A settled entry is never rewritten; the moment keeps its own characters.
- Legacy: a marker that still carries `- HH:MM:SS` sets `legacyFormat`; every plan
  refuses the note and the plugin says to migrate it.
- Frontmatter: `date`, `travels`, `depth`, `duration`. Written only when a value
  changes.
- Close: `✓ HH:MM:SS`, at most one per day.
- Whisper: a line beginning `~ `, then a bare name, `learn: <noun phrase>`,
  `next: <imperative>`, or `ask: <question ending in "?">`. One to three per entry,
  at most one of each kind, and the name goes first; the prompt asks the model for
  two or three. A name is at most ten words and
  the other rows at most twelve (fourteen for `ask:`). A question mark is allowed on
  `ask:` alone; the antithesis (`X, not Y`, `rather than`, `instead of`) is refused
  everywhere, while the writer's own negations are ordinary prose. The name may reuse
  the note's words — it is a selection from them — but never its whole opening line,
  and never the entry's address. The glyph is the provenance: it is how a reader — and a reload —
  tells the model's reading from the writer's prose, and a note carries no other
  metadata to do it with. A single leading `~` is inert in Markdown, and `~~` can
  never form, because the row needs a space after the glyph and its text may not
  contain a second one. A `~` line inside a fenced block is text. The row takes the
  note's own text colour — the one row that does not take the dimension's — and in
  Reading view it keeps its class rather than becoming `.weaver-entry-prose`. The
  navigator labels an entry with `whisper[0] ?? title`.
