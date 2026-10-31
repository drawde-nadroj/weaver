# Weaver — user flows

Each flow states what it writes, what one undo reverses, and what happens when
there is nothing to do.

## Flow: start an entry

1. `⌘⇧E`, or *Start an entry* from the palette or the toolbar. Today's note is
   created if it does not exist; otherwise it is opened.
2. An empty root entry is started at the tip: `{ 1.k.m }`, one blank prose line,
   then its clock row `HH:MM:SS - 00:00:00`, and the caret on the blank line. `k` is
   one past the day's depth-1 entries; `m` is one past its largest sequence.

Writes: the marker and the clock row, plus the frontmatter block when the note is
created. Undo: one step, the whole entry. The write goes through the editor when the
note is open in one and through `Vault.process` otherwise — one writer per file,
never both — and the plan is built from the exact text being written, so the start
lands at the note's real end however much it grew since it was read. The file is
revealed in a tab of its own, never replacing the tab you are in.

## Flow: write

1. Type. Your own input in the entry starts the session with the draft's stored
   duration as the baseline. The vault reloading a note, and Weaver's own writes,
   start nothing: an entry nobody has typed in has no time in it.
2. The rendered duration reads `- HH:MM:SS` and ticks; the file still says
   `- 00:00:00` in the clock row.

Writes: nothing until the writing stops. The ticking widget mutates its own digit
spans, so no transaction and no undo entry is created by the clock.

## Flow: pause

1. Stop writing. Every interruption of writing is a pause: a caret move that is not
   a document change (an arrow key, a click, a tap), a blur of the editor, a wheel
   or a finger on the note, another leaf becoming active, the app hidden, the
   navigator opening, and the live entry being deleted.
2. The clock stops and the duration half of the entry's clock row becomes
   `= HH:MM:SS`.

Writes: the duration half of the clock row of the entry the clock was on, through
the same one writer as every other day-note write — the open editor when there is
one, `Vault.process` otherwise, re-read first and skipped if the entry is gone. The
moment keeps its own characters, so the row cannot move. Nothing is written when the
second has not changed — that guard is why a caret move costs at most one rewrite
per second. Not added to the undo history: a pause is not an edit you asked for.

Refused, silently, when the entry has been deleted or settled in the meantime.

## Flow: settle, then descend

1. `⏎` in an open entry — `-` being written or `=` paused.
2. The duration half becomes `+ HH:MM:SS`, the session ends, and nothing else moves:
   no child, no caret.
3. `⏎` again, on that settled entry: a child opens one dimension deeper, directly
   beneath it, above any older siblings, with the caret in its prose. It inherits
   the parent's `B` — a branch carries one branch id — and takes the next `N`. The
   place the caret left is the first row of the return stack.

Writes: the duration (one transaction), then the child's marker and clock row (a
second, single change: an insert renumbers nothing). Each is undoable on its own.
The child's own clock row reads `HH:MM:SS - 00:00:00`, and its stopwatch does not
start until the first keystroke.

A settled entry is final: `⏎` there descends, it never rewrites the `+` half.
Refused (nothing written, `⏎` not handled) only when the caret is not in an entry.
The rule is stateless, so `⏎` in yesterday's `+` entry descends too, and a stray
`⏎` while reading leaves an empty child that `x` or one undo removes.

The same descent is the command *Descend into a child entry*, for the palette and
the toolbar. On an open entry it settles first — the same two transactions — then
opens the child above older siblings. With the caret outside an entry it refuses:
`put the caret in an entry. Nothing was written.`

## Flow: delete an entry

1. `⌘⇧P`, select a row, `x` — or tap that row's `✕` twice.
2. The entry and everything under it goes, in one transaction, and every surviving
   branch whose branch id shifted is rewritten in the same transaction.

Writes: the block, the blank separator below it, and the repaired `B` values. Undo:
one step, the whole subtree and the old numbering. The row's `+N` child count is the
whole blast radius, and the list stays open on what is left.

## Flow: navigate today's entries

1. `⌘⇧P`, or a tap on the toolbar's list icon. Today's note is opened in source mode
   if it is not on screen, and the card lists the return stack and then every entry
   in document order, the caret's entry selected and marked.
2. `↑`/`↓` move the selection; `⏎` puts the caret in the selected entry; `⇧⏎` settles
   it and opens a child under it; `n` starts a root at the tip; `x` deletes the
   selection's whole subtree; `⌘[` walks back one stop; `Esc` closes and puts the
   caret back where the card opened.
3. On a phone the same list is a full-height sheet: a row taps to jump, the caret's
   own row taps to descend, and `✕` arms on the first tap.

Writes: one transaction per action — the child, the root, the deletion with its
branch repair. A jump writes nothing at all. Undo: one step each.

Opening pauses the stopwatch, which may write a `= ` duration — that is the only
write, and it is the pause you would get by leaving the note anyway. `⌘,` and every
other Obsidian chord still reach the app while the card is open: it never takes a
`Scope`.

Empty: `no entries yet — ＋ starts the first`, and nothing on screen. The first row
is `＋ start an entry`. The list is today's note, the same target *Start an entry*
writes to; reaching another day means opening that note.

## Flow: close the day

1. *Close the day* on today's note.
2. `✓ HH:MM:SS` is appended at the tip.
3. If *Write day counters* is on, `travels`, `depth` and `duration` are recomputed
   from the note in the same write.

Writes: the mark and, when a value changed, the frontmatter. Undo: one step.

Refused when the day already carries a mark (`this day is already closed`), when
the frontmatter is unclosed, when a code block is unclosed, or when the note still
uses the old marker format (`migrate it before closing the day`). The first
decision stands.

## Flow: read a day back

Nothing is written. The note itself is the view: each entry in its frame, the
marker centred on the top rail and the clock row on the bottom edge — moment at the
left corner, duration at the right — with both rails cut behind their labels, digits
in the text colour and punctuation in the dimension's colour, durations as they were
settled, and `[[day]]` after the moment on any note that is not today's.

## Flow: phone capture

1. The toolbar's `+` runs *Start an entry*. The note opens with the caret in the
   new entry.
2. Type: after every keystroke the clock row is pinned to the bottom of the writing
   band above the soft keyboard, with the caret line directly above it.
3. Scroll up without typing: the view stays where you put it, and the scroll itself
   pauses the clock. Tap back into the last prose line and type again: the clock
   resumes from that second and the stopwatch comes back to the bottom.
4. `⏎` settles the entry and opens nothing. A phone has no newline gesture: its
   prose is one paragraph.
5. The toolbar's *Descend into a child entry* opens a child under the caret's
   entry, settling it first when it is open.
6. `⌘⇧P`, or the toolbar's list icon, opens the navigator as a full-height sheet:
   rows are at least 44 px, the footer names the taps, and no keyboard covers the
   selection because the sheet has no input.

Writes: the same as desktop. Nothing about the pinning writes anything — it only
scrolls.
