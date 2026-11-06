# Weaver — vision

## Epigraph and promise

> sparks create a new reality, it's only fitting that they be first dimension so
> that i can return back to things
>
> — `Chronomancer/2026.10.26.md`

The sentence names the whole system. A thought that sparked something else is not
decoration around a note; it is the first dimension of a new branch, and it is worth
being the first because returning is the point. Anything that cannot be returned to
is a thought the note will lose.

Since 0.5.0 the loop is **start → write → stop → settle → deeper**: writing has its
own beginning and its own end, and neither is a keystroke away from the other. It
happens in one place — the note. A day note is a linear list of entries, each one a
marker line, its prose, and its duration. Nothing else writes: every write of a day
note goes through one writer, which is the open editor when there is one and the
vault otherwise, never both.

The promise is unchanged: *begin where you are, and never leave the note to record
what you are writing in it.* A capture surface that opens a dialog over the note it
captures from has already failed the promise, because the dialog is a second place
to be. The navigator exists only to move the caret — start, descend, jump — and
never to write prose.

## Vocabulary

| Term | Means | Is not |
| --- | --- | --- |
| **Entry** | One unit of a day note: a marker line, its prose, and at most one clock row. | A Markdown heading, a block, a file. |
| **Marker** | `{ B.D.N }`, the first line of an entry. Plain text. | Frontmatter, a heading, a link. |
| **D** | The dimension: how deep the thought sits inside its branch. `1` is the top of a day. | A rank, a score, an order. |
| **B** | The branch id: a depth-1 entry's position among depth-1 entries, carried unchanged all the way down its subtree. Repaired only when a root is deleted. | Identity. It moves. |
| **N** | The day sequence: assigned once, only ever appended. | A sort key you can rewrite. |
| **Clock row** | The entry's last line: duration `[+-=] HH:MM:SS`, then creation moment `YYYY-MM-DD HH:MM:SS`. Either half may be absent; older undated moments inherit the filename day. | Prose, a heading, a timestamp in frontmatter. |
| **Duration** | `[+-=] HH:MM:SS` — how long this entry was written, in the same clock as its moment. The only mutable field. | Time of day, a stopwatch in frontmatter, evidence of work. |
| **Open** | An entry whose duration half reads `-` (being written) or `=` (paused): still resumable. | An unfinished note, a block in another store. |
| **Settle** | `⏎` on an open entry: the duration becomes `+`, once, and the clock stops. Nothing else moves. | Saving, syncing, submitting. |
| **Navigator** | The card that lists today's entries and the return stack, and starts, descends, jumps or deletes from it. | Search, a second editor, an outline, a dialog to write in. |
| **Stop** | The place a move left: an entry, a caret and a scroll offset, remembered in the return stack. | A bookmark in the file, a link. |
| **Close** | `✓ HH:MM:SS`, one line, at most once per day. A decision, not attendance. | A required step, a streak. |
| **Whisper** | The model's reading of an entry: one to three `~` rows above its prose — a name, then at most one each of `learn:`, `next:`, and the `ask:` question it leaves open. | A summary, a title, a heading, a second author. |
| **Day plane** | Today's day note, `Chronomancer/YYYY.MM.DD.md` — the file the core Daily Notes plugin opens. | The ingest ledger under `Autonomic Ingest/`, which is machine-written. |

**Rule.** Product copy says *entry* for the unit and *dimension* for its depth; the
word *heading* names only the Markdown syntax, and no hash-plus-number notation
appears in copy — depth reads `1D`…`nD`.

## The loops

| Loop | Trigger | What moves | Lives in |
| --- | --- | --- | --- |
| Start | `⌘⇧E` — *Start an entry* | An empty root entry at the tip of today's note, with `- 00:00:00`. Works inside an editor too. | Evidence |
| Write | The first committed text in an awaiting draft | The input's date and moment, once, and the session's clock; later input resumes without redating. | Evidence and session |
| Settle | `⏎` on an open entry | `-` or `=` becomes `+`, once, and the clock stops. Nothing else moves. | Evidence |
| Descend | `⏎` again, on a settled entry, or *Descend into a child entry* from the palette or toolbar | A child opens one dimension deeper with the caret in its prose. | Evidence |
| Delete | `x` in the navigator | One subtree, and the branch renumbering its deletion causes, in one edit. | Evidence |
| Jump | `⏎` in the navigator | The caret, and the note on screen. Nothing is written. | Session |
| Return | `⌘[` in the navigator | The caret, back to the last stop. Nothing is written. | Session |
| Pause | Leaving the note, hiding the app, opening the card | The draft's elapsed time, written back as `= `. | Evidence |
| Close | *Close the day* | One `✓` line, then the day's own stats. | Evidence |
| Whisper | the idle pause after typing, then `⏎`; or *Whisper the day* | One to three `~` rows above an entry's prose, written once and never rewritten. | Evidence (the model's, not the writer's) |

The two writes the table names — settle and pause — are `planDuration` with `+`
and `=`, and nothing else can change a duration half.

<!-- claim: src/core/insert.ts#planDuration @546c356091 -->

## Evidence versus session

The boundary rule is one test: **if the plugin vanished, the notes must still mean
something.**

Evidence is what a reader of the vault would find and understand without the
plugin: marker lines, prose, clock rows, `✓` close lines, whisper rows, and the
frontmatter fields `date`, `travels`, `depth`, `duration` and `weaver-alignments`.
Evidence is written by a command, first committed text, `⏎`, leaving the note,
and — once, after the writing ended — the model. Portal history records actual
beginnings, never passive invitations or missed attempts. A whisper is the only
reading the writer did not author.

Session is where this installation is working right now: which entry is being
written, its baseline, the return stack, the caret. Session state is
device-local. It is never synced and never counted. It becomes evidence only at the
moment the engine writes it. That boundary is **publish**: a sigil and an elapsed
time become the clock row; settle (`+`) and pause (`=`) are its two intents. A
whisper crosses a different boundary — the model's reading of text that is already
evidence — and it crosses it once, guarded by a fingerprint of the text it read.

An approaching portal is session, not evidence: it has no entry sequence.
Preparation only holds a place for first text. The actual first input crosses
into evidence atomically as prose, a recorded beginning and its history event.
Alignment is a reading of exact recorded seconds, never a target, score or obligation.

Two consequences follow, and both are implemented as such:

- **The clock's own writes are `=` only.** A pause writes the open entry's elapsed
  time back as `=`, which still reads as open; `+` is written once, by the settle
  that ends the writing, and a settled line is never rewritten. The clock starts on
  the writer's own input and on nothing else — the vault reloading a note starts
  nothing — and it stops at every interruption of writing: a caret move, a blur, a
  wheel, a finger, another leaf, a card opening.
- **Beginning date and time are written once, on first input.** A new root or child
  has only a duration until text is committed. The same observed input instant
  records both day and moment, even in an older note or across midnight. Historical
  undated moments inherit the filename day and remain untouched. Reading, resuming,
  pausing and settling never redate an entry; an untouched settled entry stays momentless.

## Progression

Nothing in Weaver is a score. There are no streaks, no quality grades, no
attendance. The day's frontmatter carries three derived readings and one date:

1. `travels` — how many entries the day holds;
2. `depth` — the deepest dimension reached;
3. `duration` — the sum of every duration, `HH:MM:SS`.

They are recomputed from the note and written only when a value changes, so a count
can never disagree with the text above it. Closing is a decision, not a
requirement: an open day is open, not a gap to be repaired.

## Reference forms

| Kind | Rendered form | When |
| --- | --- | --- |
| Note | `[[<note>]]` | The whole entry matters. |
| Entry | `[[<note>\|<alias>]]` plus the clock below it | A specific thought. A marker is plain text, so it cannot be a link target. |
| Passage | `[[<note>#^<id>\|<short alias>]]` | A passage. The `^id` is appended to the end of the referenced line. |

Because entry markers are plain text, Obsidian's outline, folding and
`[[#heading]]` links no longer address an entry. That is the accepted cost of
markers: the trade is that depth 7 is exactly as cheap and as stable as depth 1,
and that no palette re-spreads when a deeper level appears. The navigator is the
navigation that replaces the outline.

## Prior art

- **Information scraps.** Small pulled-out items elude filing tools, so capture has
  to be one gesture and schema-free. Bernstein, "Information Scraps", TOIS 26(4),
  2008 — https://people.csail.mit.edu/msbernst/papers/CSW-2007.pdf
- **Incremental formalization.** Informal notes become structured on demand rather
  than up front. Shipman & McCall, CHI '94 —
  https://dl.acm.org/doi/10.1145/191666.191768
- **Reference mechanisms and their brittleness.** Purple numbers and block ids buy
  addressability by tying a link to a position or an opaque id. Brander, "Block
  reference mechanisms", 2022 —
  https://newsletter.squishy.computer/p/block-reference-mechanisms
- **This project's own prior iteration.** An earlier design separated evidence
  (what was authored) from derived readings (what could be recounted), and held
  that viewing a note writes nothing. Weaver keeps both rules and drops the
  derived surfaces that would duplicate the note. The current form of the first
  is `src/core/day-stats.ts#recountDay`: the day's numbers are recomputed from
  the text, never incremented. The earlier document is external history, not a
  contract, and nothing in this repository is checked against it.

<!-- claim: src/core/day-stats.ts#recountDay @89a9e7f928 -->

## Naming rule for future docs

- Product word for the unit: **entry**. For its depth: **dimension**.
- No hash-plus-number notation in copy: `1D`…`nD` only.
- New surfaces take note vocabulary — entry, marker, duration, branch, stop, settle, navigator, whisper.
- New surfaces do not take filing vocabulary — inbox, queue, folder, archive.
