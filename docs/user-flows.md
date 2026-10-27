# Weaver — user flows

Ten flows, each with the five fields that make it executable: what starts it, what
the person does, what lands on disk, what can go wrong, and what it looks like on a
phone. "Written" is the honest disk result — when a flow writes nothing, it says so.

## Flow: Open a day

**Trigger.** You open today's note, or the core Daily Notes plugin creates `Chronomancer/YYYY.MM.DD.md` for the first time.

**Steps.**
1. Open the day note, or run *Open today's daily note*.
2. The strip reads the note and names the dimension the caret is in, then what is unfinished: `1D Breaking Free ▸ 2D Why now · 1 untitled · 2 drafts`.
3. Read, or start writing at the tip.

**Written.** nothing — opening a day records no event about you.

**Failure.** No day note exists: the Tapestry's Day scope offers to create it, and creating it writes only the frontmatter block. The ingest day note under `Autonomic Ingest/` exists while the human one does not: the strip and the Tapestry read the human note and report `no marks yet` rather than importing ledger rows.

**Touch.** The strip is pinned above the note; a tap opens the Tapestry sheet at Day scope.

## Flow: Spark

**Trigger.** *Spark* (`Mod+Shift+K`) with text selected, with the caret inside a dimension, or with no selection at all.

**Steps.**
1. Select the passage that caused the thought, or put the caret where the thread starts.
2. Run *Spark*. A new 1D dimension is written at the Spark target.
3. Type the title in the note itself; the caret is already at the end of the title line.

**Written.** The target note gains `# <HH:mm> - <Title>` and, beneath it, a source line: `✦ [[<note>#^<id>|<alias>]]` when you spark from a selection, and a bare `✦` line when you do not. A selection in another note also gains ` ^<id>` at the end of its last line, so sparking from a selection into Today writes to two files: the source gets the id, the day note gets the thread. The day note's counters are rewritten in the same pass.

**Failure.** Spark target changed mid-edit: the resolved target at the moment of the command is the one used, and the notice names it. A source file that has become read-only leaves the id unwritten and the notice says the spark was recorded without a source. A day note that cannot be created (read-only vault, sync lock) fails with "today's day note could not be found" and writes nothing at all — there is no silent fallback to the current note.

**Touch.** Select with the native handles, then *Spark* from the sheet; the day note opens under your thumb with the caret on the title.

## Flow: Load the shuttle

**Trigger.** *Shuttle* (`Mod+Shift+G`), from a selection, a dimension or a note.

**Steps.**
1. Select a passage, or put the caret inside a dimension, or open the note you want.
2. Run *Shuttle*. The context is loaded and the palette opens with the new row at the top, its header counting what is held.
3. Optionally run it again with another source.

**Written.** nothing — the shuttle is session state, and the vault is unchanged.

**Failure.** No active file and no selection with an empty palette: `Weaver: nothing to load.` and nothing is loaded. A successful load says nothing else: the open palette is the acknowledgement, so there is no toast over the row it describes. Loading the same target twice moves the row to the front instead of adding a duplicate, so the count reflects distinct sources; loading a 51st distinct source drops the oldest row.

**Touch.** The same command from the sheet; the palette is a bottom sheet above the keyboard.

## Flow: Weave in a loaded source

**Trigger.** `↵` on a shuttle row, with the caret in the note.

**Steps.**
1. Open the shuttle (`Mod+Shift+G`) and move to the row.
2. Press `↵`. The reference is inserted at the caret in the form the source kind dictates.
3. Keep writing around it.

**Written.** One reference form lands in the note: `[[<note>]]` for a note, `[[<note>#<HH:mm - Title>|<HH:mm Title>]]` for a dimension, `[[<note>#^<id>|<short alias>]]` for words — the last of which also appends ` ^<id>` to the end of the referenced line, reusing a trailing id rather than adding a second one.

**Failure.** The source was deleted or renamed: the link is still inserted (a link to a note that no longer exists is honest evidence of what you meant), and opening it later creates the note rather than failing silently. A caret inside a fenced code block or unclosed frontmatter refuses with the close-the-block notice and writes nothing.

**Touch.** `↵` is a tap on the row; the palette stays open so a second source costs one more tap.

## Flow: Deepen a thread

**Trigger.** *Insert dimension* (`Mod+Shift+J`), *Start a draft* (`Mod+Shift+D`), or *Weave rows* (`Mod+Shift+L`).

**Steps.**
1. Put the caret in the thread you want to deepen.
2. *Insert dimension* writes one dimension at the caret's own site, one level below its parent and capped at the configured maximum depth, and puts the caret in the title: you type it in the note.
3. *Weave rows* opens the inline row instead. `⏎` adds another row, `⌘⏎` weaves them all, `Esc` cancels.

**Written.** One dimension line per committed row, all inside a single transaction, so one undo removes the whole commit. A draft writes the `⟪draft⟫` pair instead and becomes a dimension only when woven. Nothing is written before the commit, so cancelling leaves the file byte-identical.

**Failure.** Every row empty: the Weave button is disabled and the footer reads `type a title to weave` — preventing the empty commit rather than refusing it afterwards. Unclosed frontmatter or an unclosed code block: refused with the matching notice, which ends `Nothing was written.` A level above the maximum depth is clamped, never written out of range. In Reading view the command refuses with `Weaver: this needs an editable note. Nothing was written.`

**Touch.** The same row above the keyboard; the level stepper is two tap targets.

## Flow: Return

**Trigger.** *Return to source* (`Mod+Shift+Enter`) with the caret inside a spark that records a source.

**Steps.**
1. Put the caret in a spark.
2. Run *Return to source*. The reading position jumps to the `✦` source.
3. Run it again to come back to where you were writing.

**Written.** nothing — the return place is session state.

**Failure.** The spark has no `✦` line: `Weaver: this spark has no source. Nothing was written.` and nothing moves. The source was deleted: the link opens as a new empty note, and no return target is stored from the spark itself. The caret is above the first 1D dimension: the same no-source notice, because there is no spark to return from.

**Touch.** The `↩` mark on the spark and the same command in the sheet; returning puts you back where the keyboard was.

## Flow: Review

**Trigger.** Open the Tapestry's Day scope, or open tomorrow's day note.

**Steps.**
1. Click the strip, or run *Open Tapestry* (`Mod+Shift+T`). The Tapestry opens as a tab of its own.
2. Read the sections: `Threads`, `Census`, `Review`, `Drafts`, in two columns at width and one in a narrow window.
3. Follow any row into the note if it needs work. Every pending row in `Review` — drafts, loaded sources, untitled sparks — leads somewhere.

**Written.** nothing. Reviewing writes nothing, and browsing every scope must leave the vault unchanged.

**Failure.** No day note for today: the Day scope offers to create it and shows no threads until it exists. An empty day reports `no marks yet` rather than zeros dressed up as progress. A draft that no longer parses as a draft block is absent from the list and still visible as text in the note.

**Touch.** The Tapestry sheet, same sections, same words, 44px rows.

## Flow: Close the day

**Trigger.** *Close the day*, from the command palette or from the end of the Review section.

**Steps.**
1. Run *Close the day*.
2. The closing mark is appended and the counters are recomputed.
3. The strip flips to `closed HH:mm` and the toast names the time: `Weaver: day closed at 21:29:04.` The Review's button becomes `Day closed` and stops.

**Written.** One line `✓ <time>` at the end of the day note, using the note's timestamp format, and the recomputed `sparks`, `dimensions` and `sources` counters. The closing mark is never a heading.

**Failure.** The day is already closed: the second close returns nothing and shows `Weaver: this day is already closed. Nothing was written.` A day with no note: `Weaver: today's day note could not be found. Nothing was written.` A count that would go negative cannot happen by construction — the counters are recomputed from the note, never incremented blind.

**Touch.** A button in the sheet's Review section; the mark is appended and the sheet stays open on the refreshed review.

## Flow: Read the Tapestry

**Trigger.** *Open Tapestry* (`Mod+Shift+T`) or the strip.

**Steps.**
1. Pick a scope: `Note`, `Day`, `Month` or `All`.
2. Read the sections for that scope.
3. Click a row to open it.

**Written.** nothing — the Tapestry is a derived reading and writes no file.

**Failure.** Month and All scopes read counters from the metadata cache; when a day note carries no counters the cell shows 0 intensity rather than an estimate. A note that fails to parse (unclosed frontmatter) contributes nothing to Note scope and does not block the other scopes. A missing metadata cache falls back to reading the single file, never to inventing numbers.

**Touch.** The Tapestry sheet with stacked sections; the calendar keeps 10px cells and carries its detail in each cell's label.

## Flow: Phone capture

**Trigger.** A thought arrives while the phone is in hand.

**Steps.**
1. In the note, select the passage that caused it.
2. Run *Spark* from the sheet.
3. The day note opens with the caret on the new title.
4. Type the title, then deepen it with the inline control row if it needs a second dimension.
5. Optionally load a source into the shuttle for later.

**Written.** The same records as the desktop flows: the 1D dimension and its mark in the day note, ` ^<id>` in the source when the spark came from a selection elsewhere, and the counters.

**Failure.** No keyboard-safe space left on screen: the control row is kept above the keyboard and the sheet scrolls instead of the widget. A sync lock mid-write fails that one command with a notice and leaves the day note as it was. Backgrounding the app with the shuttle open loses nothing, because the shuttle is saved plugin data.

**Touch.** This flow *is* the phone form: pinned strip, one sheet, one inline control row, and no dialog over the text.
