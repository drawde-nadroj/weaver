# Weaver — surfaces

Three surfaces, and one rule: **the note is the record, the navigator is the
navigation, the settings are the look.** Everything else was removed — the status
strip, the Tapestry, the shuttle, the weave row, the draft blocks, the in-page
addresses, the entry palette, the travel card and the travel rectangle each
duplicated one of these. The navigator is the one surface that moves the caret, and
it writes only what `⏎`, `n` and `x` write.

## One verb per intent

| Intent | Verb | Where |
| --- | --- | --- |
| Begin | `⌘⇧⏎` *Weave a Thread* | anywhere; opens a draft without creating a note |
| Finish this entry | `⏎` | the open entry the caret is in, on every platform |
| Go deeper | `⏎` again, on a settled entry, or *Descend into a child entry* | the settled entry the caret is in |
| Read or go elsewhere | `⌘⇧P` *Browse the Loom* | anywhere; opens the rendered reference without starting a draft |
| Make a newline | `⇧⏎`, or New line in the mobile composer | the prose; the note editor keeps its own desktop newline |
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

`⌘⇧⏎` is bound twice on purpose. The command covers the caret that is not in an
editor; inside an editor CodeMirror's own keymap takes the same chord at
`Prec.highest`. It is `⌘⇧⏎` and not `⌘⏎` because Obsidian's core *Open link under
cursor in new tab* owns `⌘⏎` and its scope runs in the document's capture phase,
so no plugin keymap — at any precedence — ever sees that chord.

Every command carries an icon, and the mobile toolbar is the writer's to configure:
Obsidian has no API that places a command on it, so *Weave a Thread* and *Browse
the Loom* are added under *Manage toolbar options*.

## The audit

Every surface must answer three questions; one that cannot is not a surface.

1. **What does it write?** The note says exactly. A surface that writes nothing
   says so, and a surface that writes something says what.
2. **What happens if it is wrong?** One undo reverses any single action: a plan is
   one transaction, including the branch renumbering that a deletion causes. An
   insert never renumbers anything — a child inherits its parent's `B`.
3. **What does it show when there is nothing?** The reference names an empty
   reading, and a new draft keeps Save disabled until there are words. A failed
   or unconfirmed save retains those words and reports the result; Check save
   resolves uncertainty before another write is offered.

## Surface specs

### The entry, in the editor

- One font: the note's. The address, the stopwatch and the close mark used to ask
  for `--font-monospace` while the prose did not, so one entry read as two
  typefaces. Everything Weaver writes now inherits `--font-text`, and clocks stay
  aligned by `font-variant-numeric: tabular-nums` instead of by a monospace face.
- The address line and the prose lines carry `--weaver-dcolor` and `--weaver-d`, so
  the stylesheet needs no per-level rule: colour and indent are one `calc()`.
- That `calc()` is stated at four classes —
  `.markdown-source-view.mod-cm6 .cm-line.weaver-entry-head` and the same for the
  prose — because Obsidian's `.markdown-source-view.mod-cm6 .cm-line { padding: 0 }`
  is three classes. At one class the indent never painted: the address and the prose
  sat at the pane's left edge at every level while the clock row, a block widget and
  not a `.cm-line`, indented alone, so the time drifted right of the text it
  belonged to. Measured at an 8 px step: level 1 at 52 px, level 2 at 60 px, level 3
  at 68 px, address, prose and stopwatch agreeing at every level.
- The address keeps its text. Only its runs are marked up: digits are
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
  both halves from one grammar, the same one the address uses, so the moment reads
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
- The recorded day is labelled when it is useful context. In a dated note, its
  reference is the note's own day, so another recorded day gets a persistent
  top-right label. In an ordinary note, its reference is the current local day:
  today's entries stay uncluttered and every other recorded day stays visible.
  `core/contexts.ts#entryDayLabel` makes that shared decision. When the day has a
  resolvable destination, `ui/day-link.ts` builds a keyboard-accessible link;
  otherwise it builds static text. An awaiting draft and a historical undated
  entry have no label. The address row positions the label absolutely in Live
  Preview, and the static frame does the same in Reading view. Caret, hover and
  focus never change visibility; keyboard focus retains its outline for a link.
  The label changes no text geometry. Opening or resuming an entry never redates
  it. Source mode carries no generated label. Weaver refreshes Live Preview
  decorations and re-renders open Reading views at the next local-day boundary,
  without writing a note.
- The frame's labels — address, entry-day label, stopwatch and moment —
  carry the note's own weight; nothing sets one, and there is no weight setting. They
  are told apart from the prose by colour, tabular figures and position, not by
  weight.
- Where a frame starts is a setting. *Frame follows the indent* (on by default) gives
  the address, the prose and the clock row the same indent, and because the frame's left
  edge sits a fixed air left of the address, the boxes step right with the nesting. Off,
  only the prose is indented: the address and the clock row stay in the left margin, the
  frame's edge follows them, and addresses and times form one column each down the note.
  The body class is `weaver-frame-fixed`. Measured at a 12 px step, level 3: on, the
  address, prose, raw row and clock widget all at `24 px`; off, the address, raw row and
  clock widget at `0` with only the prose at `24 px`.
- Two spacing settings sit beside it. *Space below each Thread* is air above every
  depth-1 entry after the note's first Thread, so a Thread's subtree does not run into
  the next. *Space between branches* is air above each branch whose predecessor is also
  a branch, so the first branch stays close to its root and later siblings separate.
  `weaver-thread-start` and `weaver-branch-start` carry the decision: on the address row
  in Live Preview and on the static frame in Reading view. Both default to zero, and
  both are the same number on desk and phone.
- The address's characters are the top rail's label, punctuation and all: one
  `.weaver-frame-label` mark over the whole address, whose background covers the rail
  behind it. No character of the label belongs to the box instead of the text.

### The frame, around every entry

CodeMirror gives each line its own element and offers no way to wrap a range of
lines in a container, so the box is **drawn over the note**: one absolutely
positioned layer inside `.cm-scroller`, one box per entry, in document coordinates.

- The layer draws the border and the live highlight, and no text at all. The label
  is the entry's own: the address row sits on the box's top rail, its clock row on
  the bottom edge — duration at the left corner, moment at the right. Each appears
  once, from the file, and is never dimmed, hidden or duplicated. The one generated
  label is the day link on another day; the entry decoration draws it in the address
  row, not this layer, so it stays clickable above the text.
- Both rails run through the *middle* of the row that labels them, and the label's
  own background — `.weaver-frame-label`, note-background fill plus an 8 px shadow —
  paints over the rail behind it. That is the whole mechanism: no second rendering of
  the row, no masked rail, no character moved. The rails keep a short stub beside
  each corner, which is what makes the box read as a frame rather than a box.
- The box spans the text column with `16 px + 0.45em` outside the address's ink
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
  that makes the address line and by the clock widget itself — never by a DOM
  position. Asking CodeMirror for the position of the widget's element named the
  wrong line, so the clock was measured as something else. A row that has scrolled
  out of the render range falls back to its line block, whose centre is still the
  label's centre.
- Sibling boxes never cross: a box is withheld when the next entry's top rail is
  closer than 8 px to its bottom rail. There is no trimming — a rail is a label's
  centre or it is nothing — so a box is never drawn at a height that cuts its own
  clock. When the rails touch or cross, there is no interior and no box.
- An address row that also carries prose (the inline-title case, `{ B.D.N } a title`)
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
  portals use the ordinary static frame; prose and address colours still follow dimension.
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

### The Loom and its openings

An opening names a minute; an invitation offers a beginning. The Loom owns both
the idle invitation and the writing surface, but never draws an invitation inside
an active draft. An arriving invitation cannot change its destination, text,
selection or timing, and hiding a draft shows its resume strip, not another offer.

When no draft exists, the reduced row names one outstanding invitation, its Realm,
its local opening time and whether it is upcoming or available. Opening it starts
ordinary writing; dismissing it writes nothing. The scheduler still limits
availability to the opening's own minute. The UI draws no ticking deadline,
closed-minute farewell or second Weave action in the writing field.
The idle invitation's thin, static spectrum border identifies an offer; the draft
keeps its dimension colour.

The first committed non-whitespace character still freezes the beginning and asks
which openings that instant qualifies for. That evidence rule is separate from the
offer: a root begun within its opening's minute qualifies, a branch does not, and
finishing later changes nothing. Clearing the prose resets the association.

An opening is a whole minute, so a one-off schedule configured at `05:11:04` is
refused rather than silently snapped. Evidence never costs the words: a record
that cannot be added is dropped while the thought is still written. Unreadable
existing evidence is refused rather than overwritten.

`src/ui/loom.ts` owns one compact non-modal surface. Desktop keeps header, identity,
prose and action rails through drafting, saving, reading and branching. The identity
uses normal-text digits and dimension-coloured punctuation; a draft names its kind
and dimension, never an invented address. Mobile omits that identity and places
actions beside the prose. `src/ui/loom-timing.ts` draws the clock and duration
halves; mobile shows duration alone. Both use normal-text digits and
dimension-coloured colons, distinguished by icons.
The clock half carries a `ClockFace`: the shared sample while the draft is being
written, or a moment the note recorded. Before input it shows the current time
beside zero duration, without a label. The first committed input freezes the
beginning the note will record, and the clock keeps counting the present beside the
running stopwatch instead of stopping on its first tick. A paused draft says Paused
and holds its displayed duration while the clock continues. Saved or browsed timing
comes from the note; missing values remain unknown, never invented zero.
When a reference and draft are visible together, each has its own timing group.

- Header: a compact, left-aligned destination control (`🧵 Main ▾`), Reference and
  More. The writing control opens the chooser; browsing shares the emoji and name
  with a sequence position. There is no repeated branch label in the header;
  when viewing differs from writing, one quiet line names the viewing Realm.
- Editing: one persistent native Obsidian Markdown editor grows with its content
  rather than reserving an empty field. It is a fileless native view: no note is
  bound, so native autosave cannot publish it. Native formatting and toolbar
  commands target that draft. Desktop `⇧⏎` inserts a newline and `⏎` threads.
  Mobile Return inserts a newline; the visible Thread action commits.
  `⌘⏎` / `Ctrl⏎` are captured inside
  the Loom before Obsidian's scope can claim them; IME confirmation never saves.
  Desktop drafts keep a dashed frame and separate prose-focus outline; mobile
  uses a compact solid top edge. The drawn CodeMirror caret uses an explicit
  normal-text-colour stroke, not the native contenteditable caret.
  `⌘⇧⏎` retrieves and focuses the existing draft or saved reading, including
  after clicking elsewhere or hiding a draft; it never toggles or starts a new
  Thread while one is open. Draft text and selection survive retrieval.
- Saving: the prose is read-only and the status says `Threading…`. A failed or
  unconfirmed save keeps the text, timing and reason. `Check save` reads without
  writing; only a proven-absent write offers `Retry save`, guarded against a note
  that changed since the attempt. Reading view writes through the vault, never
  into its dormant editor buffer.
- Saved: the same prose pane becomes read-only and its frame becomes solid.
  Branch and New Thread occupy the action slot that held Thread;
  the status persistently says Threaded. On desktop the real address replaces
  the draft identity without adding a row; mobile omits the identity row.
  Enter branches from the saved thought; modified Enter starts a new Thread.
  Escape puts the reading away without another write; mobile has Hide / Done.
  Pending saves and held-key repeats never queue a continuation.
  Timing and status sit below the action controls, without an Escape hint.
  Branch uses the next dimension's colour; New Thread uses first-dimension red.
  Both share Thread's tinted fill, border and text treatment. Branch restores
  focus to the new draft after its parent has been validated.
  A saved address starts at the prose's left edge; an empty state label adds no indent.
  Changes to the note's clock row refresh the saved timing; if the thought no
  longer matches the record, the old time and duration are not presented as current.
- Branching: one compact parent excerpt is shown above the prose, expandable on
  request. A destination or parent change with words in the draft is still a
  proposal, revalidated when applied.
- Hidden: the Loom reduces to one short resume strip — destination and a draft
  excerpt — anchored above the visible bottom controls and the keyboard boundary.
  `Resume` restores the draft and caret *before* focusing. The strip measures itself,
  never a height retained from the expanded card.
- Reference: rendered Markdown with its own dimension colour and frame-style
  address. Its sequence position is in the header. Previous, Next and Search
  appear once, in the bottom toolbar, with shortcut prefixes; there is no duplicate
  instruction paragraph or Invitations tab. Unmodified up/down arrows and slash
  apply only while navigation owns focus, never while selecting prose or typing.
  Left/right retain native text behaviour; modified navigation shortcuts are listed
  in More. Enter branches from the displayed thought; modified Enter starts a
  red first-dimension Thread in that thought's destination. Search Enter accepts
  the loaded match before a fresh Enter can branch. A retained draft takes
  precedence: Resume draft restores its text, selection and original parent.
- More contains Open in note, Copy text, Discard draft and Keyboard shortcuts,
  not duplicate navigation. Open in note is offered for an available reference.
  Copy follows the displayed reading or draft; Discard is only for an editable
  unsaved draft. The menu supports arrows, Home/End and Escape. Destructive
  confirmation defaults to Keep writing and restores editor focus on cancellation.
- The chooser has a visible Back action and preserves the mounted editor,
  selection, undo history and scroll position. Escape still cancels search,
  returns from the chooser or hides without discarding; its hint is not displayed.

Its box follows the content up to the usable viewport. `loomKeyboardViewport`
in `src/core/frame.ts` intersects browser bounds with the native keyboard boundary;
`loomAnchor` reserves any intersecting toolbar. This handles keyboards that
overlay the webview without resizing it, without subtracting the keyboard twice.
The mobile renderer converts that boundary into body-relative coordinates and
grows upward, flush to the controls below, without duplicated safe-area padding.
The body and circular actions share one content-sized row; identity, beginning
clock and desktop hints are hidden. Native editor chrome and note-sized padding
are removed; only the prose itself contributes writing height.
There is no plugin formatting toolbar. While editing, the native fileless editor
owns Obsidian's active command context; leaving it restores the previous owner
unless another editor has already taken focus. Native keyboard events, the host's
keyboard-height style and toolbar geometry all trigger layout.
Long prose and the body scroll independently while the header and footer remain
fixed. Resizing reveals the caret inside the prose viewport, not the entire
unbounded editor document.
The current usable width chooses the stacked or split arrangement on viewport
updates, without requiring another keystroke.
Opening the Loom freezes the note's own clock first. Desktop controls are 32px
high, with no native button shadows; mobile and coarse-pointer targets are 44px,
without filling every target's background. Mobile Thread, Branch and New thread
are labeled 44px circles on the right. Only desktop actions prefix shortcuts.

Reading view draws no opening at all: a note is a record, and the surface floats
above every leaf regardless of which one is showing.

### The entry, in Reading view

The same shape, from a post processor: a `<p>` starting with an address becomes the
frame's first child — the file's own address characters, split into digit runs — each
following sibling becomes `.weaver-entry-prose` inside the frame. Obsidian can
render a signed clock as a separate list block; the processor reads its exact
source row, places the clock at the frame's bottom edge, and hides that separate
section without changing the note. The wrapper is a real element because a box
needs one to enclose, and the browser needs no measurement at all to draw it.
The address's own soft break is removed too, so the first prose line starts
directly below the top label with only the 8 px clearance its background needs.
Later author-written breaks and inline markup remain intact.
A paused or moment-only clock can remain inside the address's Markdown paragraph;
it is extracted onto the bottom rail too, so the creation date is never repeated
inside the prose.
An unprocessed next address ends the current frame too: processing two entry
paragraphs in one render batch cannot accidentally nest their frames.

The frame's edges are the rails, so the first and last children *hang half a line
over them*: `align-self` shrink-wraps each one to its own text, and a negative
`margin-top`/`margin-bottom` of `0.675em` (half of the `1.35` line height) puts its
centre on the edge. Neither gets padding — a label must never move a character — so
the rail is cut by the label's own background and its 8 px shadow. The 1.8em vertical
margin is the measured Live Preview gap between one entry's clock centre and the next
address centre, 58 px at 32 px type. A duration paragraph with no entry above it is
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
Inline markup inside the prose is untouched, and only the address's own characters
leave the address paragraph — a title typed after the clock, with its links and
emphasis, stays in the DOM exactly as Obsidian made it. A different-day entry's
creation-day link is appended to the static frame at its top-right corner; it
is a child of the frame, not of the shrink-wrapped head.

### The Loom's upper panels

The Loom is one non-modal, bottom-anchored dialog; its upper area is the reading
surface, and the same area swaps to the Tapestry chooser or the invitation list.

- The reference shows one thought at a time: position, colour-coded address and
  authored Markdown. In its navigation toolbar, `↑`/`↓` move, `/` starts search,
  and `Enter` opens the selected original. Enter in the search field accepts a
  match; Escape cancels before closing the panel. Prose selection keeps its own
  arrow keys. Browsing itself never opens or changes a note.
- The Tapestry chooser lists every destination with `Write here` (retarget the open
  draft) and `Open workspace` (a deliberate travel). Choosing a row for writing
  does not move the screen.
- The invitation list and idle invitation row read the same outstanding offers.
  Neither inserts a second action into an active draft.

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
| Entry | the address row is the frame's top rail label, digits in the text colour, punctuation coloured; a whisper row is neutral at the entry's indent | same, with `--weaver-indent-step-mobile`, and the same neutral whisper |
| Frame | rails through the address and clock rows' centres, cut behind their labels; `16 px` left and `10 px` right; the date link at the top-right on another day; follows the indent or starts fixed | same, identically: one layer, one rule, no platform branch |
| Clock row | flex widget, ticks while live, the duration at the bottom-left corner and the moment at the bottom-right | same, pinned to the bottom of the writing band after each keystroke |
| Navigator | card centred over the note, keys in its footer | full-screen sheet, rows ≥ 44 px, taps in its footer |
| Navigator keys | `j`/`k`/`↑`/`↓`, `⏎`, `⇧⏎`, `n`, `t`, `c`, `Delete`, `⌘[`, `⌘]`, `Esc` | tap a row to select it, its action buttons to act, `Delete` twice to remove |
| Loom | bottom-anchored card in the text column with rails, dimension colour and the measured box | same surface, reserved toolbar and safe area, ≥ 44 px targets |
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

- Dimensional Address: `{ B.D.N }`, matched as a prefix. `{1.2.3}` reads the same. A
  Dimensional Address in frontmatter or a fenced block is text. In a frame it is
  the box's top rail label.
- `B` is the branch id: a depth-1 entry's `B` is its position among depth-1 entries,
  and everything under it carries that same `B` all the way down. An insert inherits
  it; deleting a root renumbers the survivors, in the same undoable transaction.
- Prose: everything after the address up to the next address or clock row, trimmed of
  blank lines at both ends.
- Clock row: the entry's last line, an optional duration `[+-=] HH:MM:SS` then an
  optional moment `HH:MM:SS`. Either half may be absent. `-` is open and being
  written, `=` is open and paused, `+` alone is settled. Minutes and seconds are
  `0–59`, hours unbounded, and the duration half is the only mutable part of an
  entry. A settled entry is never rewritten; the moment keeps its own characters.
- Legacy: an address that still carries `- HH:MM:SS` sets `legacyFormat`; every plan
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
