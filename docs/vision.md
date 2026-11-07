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

Since 0.5.0 the loop is **start → write → save → return → branch**: writing has
its own beginning and its own end. A day note is a linear list of entries, each one
an address line, its prose, and its duration. Nothing else writes: every write of a
day note goes through one writer, which is the open editor when there is one and the
vault otherwise, never both.

The promise is unchanged: *begin where you are, and never leave the note to record
what you are writing in it.* The Loom is a compact, non-modal capture surface over
the note: the note stays visible and directly editable behind it, and the note
remains the only durable record. An earlier rejection of a separate capture surface
— because it made a second place to be — is superseded: the Loom does not replace
the note or hold a second copy of it. It holds one unsaved draft and writes it once,
on Save. The note's own editor is still where an entry is begun in place; the Loom
is for capture from anywhere. The Loom's reference is the only navigation that
replaces the outline — one thought at a time, walked and searched without writing.

## Vocabulary

| Term | Means | Is not |
| --- | --- | --- |
| **Entry** | One unit of a day note: an address line, its prose, and at most one clock row. | A Markdown heading, a block, a file. |
| **Dimensional Address** | `{ B.D.N }` — branch, dimension, sequence — the first line of an entry. Plain text. Called `address` in code. | Frontmatter, a heading, a link. |
| **D** | The dimension: how deep the thought sits inside its branch. `1` is the top of a day. | A rank, a score, an order. |
| **B** | The branch id: a depth-1 entry's position among depth-1 entries, carried unchanged all the way down its subtree. Repaired only when a root is deleted. | Identity. It moves. |
| **N** | The day sequence: assigned once, only ever appended. | A sort key you can rewrite. |
| **Clock row** | The entry's last line: duration `[+-=] HH:MM:SS`, then creation moment `YYYY-MM-DD HH:MM:SS`. Either half may be absent; older undated moments inherit the filename day. | Prose, a heading, a timestamp in frontmatter. |
| **Duration** | `[+-=] HH:MM:SS` — how long this entry was written, in the same clock as its moment. The only mutable field. | Time of day, a stopwatch in frontmatter, evidence of work. |
| **Open** | An entry whose duration half reads `-` (being written) or `=` (paused): still resumable. | An unfinished note, a block in another store. |
| **Thread** | A depth-1 entry and everything under it. `Thread` is capitalised in product copy; the stored `B`/`D`/`N` never change with it. | A file, a tag, a separate store. |
| **Branch** | A thought below a Thread's root: one dimension deeper than its parent, inside the same Thread and the same note. | A new Thread, a second root. |
| **Save** | The Loom's Save action (`⌘⏎` on desktop): one transaction writes address, prose and a finished `+` row, once. The stored entry's own `Settle` is the same act inside a note. | Saving, syncing, submitting. |
| **Realm** | A folder, a writing history and a remembered workspace: one place a thought can be written. `Main` is the one the Daily Notes plugin defines. | A tag, a vault, a filter. |
| **Opening** | A minute a schedule offers, `[04:33:00, 04:34:00)`. Writing that *begins* inside it was written through it; a minute nobody entered is gone. | A lock, a permission, a gate. |
| **Loom** | The one compact, non-modal surface a thought is written in from anywhere: a destination control, a dominant prose field, and one explicit Save. Its reference is optional and starts collapsed. It holds one unsaved draft and writes nothing until Save. | A modal, a second editor, a note. |
| **Invitation** | A schedule's call to action, one strip in the same surface. It never writes and never takes focus; whether writing counts is decided by the beginning, not by a click. | A locked window, a prepared slot, an obligation. |
| **Reference** | The Loom's optional upper panel: one thought at a time, its position and authored text, searched and walked without writing. | A second editor, the outline, a modal. |
| **Stop** | The place a move left: a thought, a caret and a scroll offset — or a whole workspace — remembered in the history. | A bookmark in the file, a link. |
| **Close** | `✓ HH:MM:SS`, one line, at most once per day. A decision, not attendance. | A required step, a streak. |
| **Whisper** | The model's reading of an entry: one to three `~` rows above its prose — a name, then at most one each of `learn:`, `next:`, and the `ask:` question it leaves open. | A summary, a title, a heading, a second author. |
| **Day plane** | Today's day note, `Chronomancer/YYYY.MM.DD.md` — the file the core Daily Notes plugin opens. | The ingest ledger under `Autonomic Ingest/`, which is machine-written. |

**Rule.** Product copy says *entry* for the unit and *dimension* for its depth; the
word *heading* names only the Markdown syntax, and no hash-plus-number notation
appears in copy — depth reads `1D`…`nD`.

## The loops

| Loop | Trigger | What moves | Lives in |
| --- | --- | --- | --- |
| Weave | `⌘⇧⏎` — *Weave a Thread* | One Loom, above the workspace, holding one draft. No note changes. Works inside an editor, in Reading view, or from nowhere. | Session |
| Write | The first committed character in the Loom, or the first text in an awaiting draft | The draft's beginning — its day, its moment — once, and a clock that counts only writing time; inside a note, the moment is recorded at settle. | Evidence and session |
| Settle | `⏎` on an open entry | `-` or `=` becomes `+`, once, and the clock stops. Nothing else moves. | Evidence |
| Save | The Save action, or `⌘⏎` on desktop | Address, prose and a `+` row with the draft's own day, moment and duration, in one transaction; the Loom then keeps the saved thought visible. | Evidence |
| Branch | The Branch action on the saved thought, or *Branch from this thought* in the note | A child one dimension deeper, in its parent's note, with the caret in its prose. | Evidence |
| Descend | `⏎` again, on a settled entry, or *Branch from this thought* from the palette or toolbar | A child opens one dimension deeper with the caret in its prose. | Evidence |
| Delete | The note's own guarded deletion | One subtree, and the branch renumbering its deletion causes, in one edit. | Evidence |
| Jump | *Open in note* / an explicit reference action | The caret, and the note on screen. Nothing is written. | Session |
| Travel | `Travel` on a Realm row | That Realm's last-used workspace, and every pane's own position. The draft is untouched, and its destination does not follow. | Session |
| Return | `⌘[` and `⌘]`, or the *Back* and *Forward* commands | The recorded stop — the exact screen or caret, not the Realm's latest one. Nothing is written. | Session |
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
plugin: address lines, prose, clock rows, `✓` close lines, whisper rows, and the
frontmatter fields `date`, `travels`, `depth`, `duration` and `weaver-alignments`.
Evidence is written by a command, first committed text, `⏎`, leaving the note,
and — once, after the writing ended — the model. Invitation history records actual
beginnings, never passive offers or missed attempts. A whisper is the only
reading the writer did not author.

Session is where this installation is working right now: which entry is being
written, its baseline, the visit history, the caret. Session state is
device-local. It is never synced and never counted. It becomes evidence only at the
moment the engine writes it. That boundary is **publish**: a sigil and an elapsed
time become the clock row; settle (`+`) and pause (`=`) are its two intents. A
whisper crosses a different boundary — the model's reading of text that is already
evidence — and it crosses it once, guarded by a fingerprint of the text it read.

An invitation is session, not evidence: it has no entry sequence, and dismissing
one writes nothing. A draft is session too, held on this device, and it crosses
into evidence only when it is settled — then as prose, a recorded beginning, a
duration and, when an invitation really applied, its history event, all in one
transaction. Alignment is a reading of exact recorded seconds, never a target,
score or obligation.

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
| Entry | `[[<note>\|<alias>]]` plus the clock below it | A specific thought. An address is plain text, so it cannot be a link target. |
| Passage | `[[<note>#^<id>\|<short alias>]]` | A passage. The `^id` is appended to the end of the referenced line. |

Because entry addresses are plain text, Obsidian's outline, folding and
`[[#heading]]` links no longer address an entry. That is the accepted cost of
addresses: the trade is that depth 7 is exactly as cheap and as stable as depth 1,
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
- New surfaces take note vocabulary — entry, address, duration, branch, stop, settle, navigator, whisper.
- New surfaces do not take filing vocabulary — inbox, queue, folder, archive.
