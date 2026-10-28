# Weaver — user flows

Each flow states what it writes, what one undo reverses, and what happens when
there is nothing to do.

## Flow: start an entry

1. `⌘⇧E`. Today's note is created if it does not exist; otherwise it is opened.
2. An empty root entry is appended at the tip: `{ 1.k.m } - HH:MM:SS`, one blank
   prose line, `- 00:00:00`, and the caret on the blank line.

Writes: the marker, the duration line, and (when it is created) the frontmatter
block. Undo: one step, the whole entry. Already on screen: the write goes through
the editor, so the undo is the editor's own; otherwise through `Vault.process` and
the note is revealed in a tab of its own — never replacing the tab you are in.

## Flow: write

1. Type. Your own input in the entry starts the session with the draft's stored
   duration as the baseline. The vault reloading a note, and Weaver's own writes,
   start nothing: an entry nobody has typed in has no time in it.
2. The rendered duration reads `- HH:MM:SS` and ticks; the file still says
   `- 00:00:00`.

Writes: nothing until the writing stops. The ticking widget mutates its own digit
spans, so no transaction and no undo entry is created by the clock.

## Flow: pause

1. Stop writing. Every interruption of writing is a pause: a caret move that is not
   a document change (an arrow key, a click, a tap), a blur of the editor, a wheel
   or a finger on the note, another leaf becoming active, the app hidden, the
   travel card or the palette opening, and the live entry being deleted.
2. The clock stops and the entry's line becomes `= HH:MM:SS`.

Writes: the duration line of the entry the clock was on, through the editor when
the note is on screen and through `Vault.process` otherwise (re-read first, skipped
if the entry is gone). Nothing is written when the second has not changed — that
guard is why a caret move costs at most one rewrite per second. Not added to the
undo history: a pause is not an edit you asked for.

Refused, silently, when the entry has been deleted or settled in the meantime.

## Flow: settle, then descend

1. `⏎` in an open entry — `-` being written or `=` paused.
2. The duration becomes `+ HH:MM:SS`, the session ends, and nothing else moves: no
   child, no caret.
3. `⏎` again, on that settled entry: a child opens one dimension deeper, directly
   beneath it, with the caret in its prose. It becomes the travel target, so the
   outline moves with the caret.

Writes: the duration (one transaction), then the child's marker plus the sibling
`C` renumbering it disturbs (a second transaction). Each is undoable on its own.
The child's own line reads `- 00:00:00`, and its stopwatch does not start until the
first keystroke.

A settled entry is final: `⏎` there descends, it never rewrites the `+` line.
Refused (nothing written, `⏎` not handled) only when the caret is not in an entry.
The rule is stateless, so `⏎` in yesterday's `+` entry descends too, and a stray
`⏎` while reading leaves an empty child that `x` or one undo removes.

## Flow: insert a child

1. Put the caret in an entry, `⌘⇧J`.
2. A child appears at the end of that entry's subtree: `D+1`, the next child
   ordinal, the next sequence, a blank prose line and `- 00:00:00`.

Writes: the child and, in the same transaction, the sibling `C` renumbering it
disturbs. Undo: one step.

Refused with `put the cursor in an entry first. Nothing was written.` when the
caret is not inside an entry — a note with no entries at all gets no entry from
this command; *Start an entry* is the one that begins a note.

## Flow: work today's entries from one card

1. `⌘⇧P`. Today's note is opened in source mode if it is not on screen, and the card
   lists every entry in document order, the caret's entry selected.
2. `↑`/`↓` select; `⏎` settles the selection and opens a child under it; `n` starts a
   root at the tip of the day; `x` deletes the selection's whole subtree.
3. Typing `1`, `1.2`, `.14` or `1.2.14` and pressing `⏎` locks that filter and puts
   the selection on the first match. `Esc` clears the query, then the filter, then
   closes and leaves the caret on the selection's prose.

Writes: one transaction per action — the settle, the child, the root, the deletion
with its renumbering. Undo: one step each.

`n` and `x` are commands only while the query is empty and no filter is locked, so a
bare letter is never eaten out of a number being typed. An unparseable query is not
a command: the card stays open with the text intact. `x` asks for no confirmation —
the row's `+N` child count is the whole blast radius, and one undo brings it back.

## Flow: travel

1. `⌘⇧⏎`. The card lists every draft in the day-note folder, by day.
2. `←`/`→` move between days, `↑`/`↓` between drafts. Typing `1`, `1.2`, `.14` or
   `1.2.14` and pressing `⏎` locks that filter; `Esc` clears it, a second `Esc`
   closes.
3. `⏎` on a draft opens its note, switches the leaf to source mode if it was in
   preview, puts the caret in the prose, and outlines the entry.

Writes: nothing. Opening the card pauses the clock, which may write a `= `
duration — that is the only write, and it is the pause you would get by leaving the
note anyway. `⌘,` and every other Obsidian chord still reach the app while the card
is open.

Empty: `Weaver: no drafts to travel to.` and nothing on screen. A day whose entries
are all settled — `+` — has nothing to travel to.

## Flow: close the day

1. *Close the day* on today's note.
2. `✓ HH:MM:SS` is appended at the tip.
3. If *Write day counters* is on, `travels`, `depth` and `duration` are recomputed
   from the note in the same write.

Writes: the mark and, when a value changed, the frontmatter. Undo: one step.

Refused when the day already carries a mark (`this day is already closed`), when
the frontmatter is unclosed, or when a code block is unclosed. The first decision
stands.

## Flow: read a day back

Nothing is written. The note itself is the view: digits white, punctuation in the
dimension's colour, durations as they were settled, and `- [[day]]` after the clock
on any note that is not today's.

## Flow: phone capture

1. `⌘⇧E` from the mobile toolbar. The note opens with the caret in the new entry.
2. Type: after every keystroke the duration line is pinned to the bottom of the
   writing band above the soft keyboard, with the caret line directly above it.
3. Scroll up without typing: the view stays where you put it, and the scroll itself
   pauses the clock. Tap back into the last prose line and type again: the clock
   resumes from that second and the stopwatch comes back to the bottom.
4. `⏎` settles the entry and opens nothing; the newline is `weaver:line-break` in the
   toolbar, since a soft keyboard has no `⇧⏎`.
5. `⌘⇧⏎` and `⌘⇧P` open their cards at the visible viewport centre; rows are at
   least 44 px and the soft keyboard never covers the selected row.

Writes: the same as desktop. Nothing about the pinning writes anything — it only
scrolls.
