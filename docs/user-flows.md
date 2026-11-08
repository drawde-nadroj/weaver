# Weaver — user flows

Each flow states what it writes, what one undo reverses, and what happens when
there is nothing to do.

## Flow: weave a Thread

1. `⌘⇧⏎`, or *Weave a Thread* from the palette or the toolbar, or `Weave` on a
   Realm in the navigator. One surface opens at the bottom edge. The note you were
   reading does not move, and no note is created.
2. Its header names the writing Realm once — `<name> ▾` opens the destination
   popover without travelling, and never swaps the prose for a panel. When viewing
   differs from writing, a quiet line says `viewing <realm>`. Choosing another
   destination with words present still requires accepting the proposed change; it
   never silently retargets the draft.
3. Before typing, the clock icon shows the current time; the stopwatch shows zero.
   The first committed character freezes the local beginning the note will record
   and starts counting composing time, while the clock keeps counting the present
   beside it. A pause is labelled explicitly and holds the stopwatch. Letters and
   arrows in the prose stay ordinary writing and text selection.
4. `⏎` saves it. `Shift-⏎` is a newline, a soft keyboard's Return is a save, and
   `Esc` hides the surface without losing a word.

Writes: nothing until `⏎`. The draft — its text, its beginning, its timing, its
selection, the openings it qualified for — is device-local through `CaptureStoreV2`
so a reload does not lose it. Undo: the save is one
transaction, so one undo removes the address, the prose and the clock row together.

## Flow: save a Thread

1. `⏎` in the composer. The request is frozen: Realm, prose, beginning, duration,
   and the openings if there were any.
2. `Saving…`, with the submitted prose read-only. Nothing in the note was visible
   before this, so there is no empty entry to finish.
3. The same prose pane becomes a rendered reading with its real, colour-coded
   address. Branch and New Thread replace Save in the same action rail. The
   clock and stopwatch stay in place and read the note's beginning and duration,
   preserving the last painted second. A fresh Enter branches from the saved
   thought; modified Enter starts a new Thread. Pending saves and held-key repeats
   queue neither action. Escape hides without another write.
4. The entry lands in the daily note for the day the thought **began**, which may be
   yesterday's file. A branch lands in its parent's note, one dimension deeper, with
   the parent's `B`.

Writes: one settled entry, and the opening's record when the thought was a root
whose first committed input fell inside that opening's minute. Undo: one step, in
the note that received it — one undo unit in an open editor, and nothing claimed for
a file that was never opened.

Refused, with the text kept: a Realm that is gone or unreadable, a parent that is no
longer in its note, a note whose frontmatter or code block is unclosed, a note in
the old entry format, and prose that would break out of its own block (an unclosed
fence, another address line, a clock-shaped line). A record that cannot be *added*
never refuses the thought: the entry is written and the evidence is dropped.
Unconfirmed — an exception rather than a refusal — becomes *Check save*, which reads
the note and either accepts it, offers one more `⏎`, or says the note changed in a
way this save cannot explain.

## Flow: branch from a Thread

1. After saving or while browsing, press `↵ · Branch`. The displayed thought is
   validated as the parent; its compact excerpt remains above the focused draft.
   This draft has a fresh provisional clock and zero duration, never its parent's.
2. Type and press `⏎`. The child lands in the parent's file, one dimension deeper.

An empty branch can be hidden without writing anything. New Thread starts a fresh
red root in the displayed thought's destination. Browsing with an unfinished
hidden draft offers Resume draft instead, preserving its words, selection and parent.

## Flow: travel to a destination

1. `Open workspace` on a destination row in the Loom's popover.
2. The current layout is stored as that destination's own, the draft's clock is
   frozen and the draft stored, and the destination's last-used workspace is
   restored — panes, files, and each pane's own caret and scroll.
3. A destination visited for the first time opens today's note in it; that note is
   created, because a visit is explicit.
4. A destination that cannot be opened rolls back, keeps the draft and says
   `Could not open <name>. Your draft is safe.` If even the rollback fails, the real
   screen is left alone and labelled `Current workspace`.

Writes: nothing but the note a first visit creates, and its frontmatter. Undo: not
applicable — travel is navigation, and it stores layout, not note text.

## Flow: write

1. Type. In an awaiting entry the first text and its recorded beginning are one
   transaction: the day and moment come from that input's own timestamp, so an
   entry made before midnight and typed after it records the day it was written
   in. One undo takes the text and the beginning back together; a redo restores
   them without restarting a clock. Undoing the beginning of a running entry ends
   its clock without writing anything, and the redo that follows never revives
   it. Later input is ordinary editor input. An IME
   composition stays native while it is preedit: only the committed text is
   captured, with the beginning written into the composition's own undo group;
   a cancelled composition records nothing.
2. Your own input starts the session with the draft's stored duration as the
   baseline. The vault reloading a note, and Weaver's own writes, start nothing:
   an entry nobody has typed in has no time in it.

Writes: nothing until the writing stops, beyond the first text's one transaction.
The ticking widget mutates its own digit spans, so no transaction and no undo
entry is created by the clock; the file's duration half still says `- 00:00:00`
until a stop.

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
number written is the last second the clock painted, not a fresh reading taken as
the clock stops: the row keeps exactly the digits that were on screen. The
moment keeps its own characters, so the row cannot move. Nothing is written when the
second has not changed — that guard is why a caret move costs at most one rewrite
per second. Not added to the undo history: a pause is not an edit you asked for.

Refused, silently, when the entry has been deleted or settled in the meantime. A
write that fails says so and holds the clock at the second it stopped on: the stop
is not lost, a retry writes the same digits, and only fresh typing restarts the
count from there.

## Flow: settle, then descend

1. `⏎` in an open entry — `-` being written or `=` paused.
2. The duration half becomes `+ HH:MM:SS`, the session ends, and nothing else moves:
   no child, no caret.
3. `⏎` again, on that settled entry: a child opens one dimension deeper, directly
   beneath it, above any older siblings, with the caret in its prose. It inherits
   the parent's `B` — a branch carries one branch id — and takes the next `N`. The
   place the caret left is recorded in the visit history.

Writes: the duration (one transaction), then the child's address and clock row (a
second, single change: an insert renumbers nothing). Each is undoable on its own.
The duration written is the last second on screen: `⏎` never refreshes the clock,
so settling cannot move a visible digit. The child's own clock row reads
`- 00:00:00`, and its stopwatch does not start until the first keystroke, which
also records its date and moment.

A settled entry is final: `⏎` there descends, it never rewrites the `+` half.
Refused (nothing written, `⏎` not handled) only when the caret is not in an entry.
The rule is stateless, so `⏎` in yesterday's `+` entry descends too, and a stray
`⏎` while reading leaves an empty child that `x` or one undo removes.

The same descent is the command *Descend into a child entry*, for the palette and
the toolbar. On an open entry it settles first — the same two transactions — then
opens the child above older siblings. With the caret outside an entry it refuses:
`put the caret in an entry. Nothing was written.`

## Flow: whisper

Every settled entry may carry a **whisper**: one to three `~` rows above its prose —
the subject (a bare name, the anchor the navigator and a search both use), what it
names but has not settled (`learn:`), what it would do next (`next:`), and the
question it leaves open (`ask:`). It is written once and never rewritten or
retracted — editing the prose afterwards leaves the row where it is, and the
writer's own edit is the only thing that removes one.

1. **Warm.** While a draft is being written, an idle pause of 800 ms asks the model
   once. If the answer is back when `⏎` settles the entry, the rows and the `+` land
   in one transaction: one `⌘Z` removes both. Nothing about the entry moves except
   its height.
2. **Cold.** `⏎` pressed before the answer arrives settles exactly as it did before
   whispers existed: `+` alone, immediately, nothing waiting. The answer is asked for
   at settle; when it comes — a second or two later — it is written as its own
   undoable transaction, above the prose.
3. **Held while you are there.** A deferred whisper never lands while the caret is
   inside that entry: a line arriving between two keystrokes moves the text being
   read. It stays unwhispered until the caret leaves, and *Whisper the day* is the
   repair for the ones that were missed.
4. **Discarded when the text moved.** Every answer is guarded by a fingerprint of
   the prose and the ancestors' first lines it was asked over. If the prose changed
   in the meantime, the answer is dropped — that is the whole invalidation rule, and
   it is why `-`→`+` and a neighbour's own whisper never throw one away.
5. **You can see it is reading.** Once a request has been pending for 200 ms, the
   entry's frame shows one ring leaving its centre and dying at the edge, again every
   1.6 s, instead of the travel that means "being written". A request that answers
   inside 200 ms shows nothing at all. It stops the moment the answer lands, and it is
   what tells you a held landing is still coming. With reduced motion the ring becomes
   a still dashed rule inside the box.
6. ***Whisper the day.*** One pass over **the day note on screen** — today's when no
   day note is open, because a past day's note is the same shape and its settled
   entries are the same entries: every settled entry that has no whisper, no name
   typed after its address, and prose to read is asked about, in document order, each
   child after its parent's new name. A note whose filename carries no day is not a
   day note, so the pass falls back to today rather than write into it. All of it
   lands in one transaction, one undo.

With *Place each entry in its day* on, one further request per entry asks which earlier
entry it repeats or picks up, and a validated answer becomes a `thread:` row — cited by
the earlier entry's address, and refused when it cites nothing or cites itself. The
branch already draws ancestry, so only a cross-branch relation earns the row; a 4B
produces roughly one usable placement per day's twenty entries, which is why the
setting is off by default.

Writes: the whisper rows, above the first prose line. A warm answer shares settle's
transaction; anything else is one transaction of its own. Undo: one step for each.

Refused silently, with nothing written and no notice: an answer that breaks the
register (a row past its word limit, a question mark outside `ask:`, an `ask:` row
that does not ask, the antithesis, an em dash, a second `~`, the entry's own opening
line, its address, a line an ancestor already carries), a note whose frontmatter or
code block is unclosed, an address row the writer already named, and an entry that
already has a whisper.

Because `Whisper the day` is a command the writer chose, it reports what it actually
did, not merely that it finished. `Nothing to whisper: every settled entry already
has one, or a name.` means exactly that — there was no candidate. Otherwise the
sentence carries the count it wrote out of the candidates it tried, and the reason
the rest did not land. A status is reported as the thing it says — the endpoint
`refused this device (HTTP 401)`, `has no such model (HTTP 404)`, `is rate-limiting
(HTTP 429)`, `failed (HTTP 507)`, `rejected the request (HTTP 400)` — followed by the
server's own message when it sent one, because that is the sentence with the fix in
it (`… does not fit under the dynamic memory ceiling`). The other two reasons are
`the endpoint did not answer` (nothing came back at all) and `the model returned no
text`, and the last is how many answers did not fit the register. Two failed requests in a row end the pass instead of spending
one request per entry on an address that is not answering. With the setting off, or
an address this device cannot reach, it says
`No whisper endpoint is reachable from this device.` and writes nothing.

Two transport failures in a row and this device stops asking until the plugin
reloads — silently, with one line in the console when *Debug logging* is on. A
validation failure is not counted: the endpoint answered, the register was not met.

## Flow: delete an entry

1. `⌘⇧P`, select a row, `x` — or tap that row's `✕` twice.
2. The entry and everything under it goes, in one transaction, and every surviving
   branch whose branch id shifted is rewritten in the same transaction.

Writes: the block, the blank separator below it, and the repaired `B` values. Undo:
one step, the whole subtree and the old numbering. The row's `+N` child count is the
whole blast radius, and the list stays open on what is left.

## Flow: the navigator

1. `⌘⇧P`, or the toolbar's list command, opens the Loom's reading without
   creating a note or draft. The header's pill names the reading's Realm and says
   `Reading destination`.
2. The scoped Tapestry appears as one list, in time order: a thread mark, an
   address, a first line and a recorded moment per row, with the search field and a
   live count above them. The same clock and stopwatch as the composer show the
   selected thought's recorded beginning and writing duration. Unknown values
   remain unknown; there is no Invitations tab.
3. Up/down walk the list, Home and End reach its ends, and `/` starts a scoped
   search. The keys apply only while the list has focus; the search field and both
   editors retain native arrows, including left/right.
4. Enter opens the selected row into its whole rendered Markdown, with Branch and
   Open in note beside it; a second Enter closes it. Modified Enter starts a new
   Thread in the selected thought's destination. Search Enter accepts the loaded
   match before anything else can act. A hidden unfinished draft is resumed by its
   own `Resume draft` control, never replaced.
5. More offers Open in note. Escape cancels search, closes a front layer, or hides
   the surface. Less-common modified arrows are documented in Keyboard shortcuts
   rather than repeated on the main surface.

Writes: navigation and beginning a draft write nothing. Saving that draft creates
one entry through the ordinary writer. Leaving an active note can still pause its
own stopwatch through the note's existing session rule.

Unavailable or changed thoughts are not branch targets. Reading reports missing
records rather than guessing, and never turns missing timing into zero.

## Flow: close the day

1. *Close the day* on today's note.
2. `✓ HH:MM:SS` is appended at the tip.
3. If *Write day counters* is on, `travels`, `depth` and `duration` are recomputed
   from the note in the same write.

Writes: the mark and, when a value changed, the frontmatter. Undo: one step.

Refused when the day already carries a mark (`this day is already closed`), when
the frontmatter is unclosed, when a code block is unclosed, or when the note still
uses the old address format (`migrate it before closing the day`). The first
decision stands.

## Flow: read a day back

Nothing is written. The note itself is the view: each entry in its frame, the
address centred on the top rail and the clock row on the bottom edge — duration at
the left corner, moment at the right — with both rails cut behind their labels, digits
in the text colour and punctuation in the dimension's colour, durations as they were
settled. On any note that is not today's, a link to today's daily note cuts the top
rail at the top-right corner and opens the current date.

## Flow: phone capture

1. The toolbar's `+` runs Weave a Thread. Its empty draft shows the same provisional
   beginning clock and zero stopwatch as desktop.
2. First input freezes the beginning and starts the stopwatch. The same timing and
   action rails stay above the usable keyboard boundary; long prose scrolls within
   the retained editor.
3. Soft Return saves; the visible New line control inserts a newline. Saved reading
   offers Branch and New Thread with the same dimension colours as desktop.
4. Browsing uses that same surface, timing and bottom controls. Pointer targets
   are 44 px; keyboard navigation applies only when its toolbar owns focus.

Writes: the same as desktop. Keyboard resize and layout do not write note bytes.

