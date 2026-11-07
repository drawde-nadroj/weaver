# Weaver — system design

This is the map, not the story. Every mechanism below names the code that
implements it as `path#symbol`, and `npm run docs:check` fails if that address
does not resolve. Sentences that carry a hash are *claims*: the hash is the
current text of the declaration, so editing that declaration without
re-verifying the sentence turns the gate red. Nothing here asks you to remember
anything — the document is checked, and the check says what to do.

Two halves. The half above `<!-- design:begin -->` is authored: judgements,
invariants, and the reasons behind them. The half below is generated from the
tree by `scripts/design-index.mjs` and `scripts/design-md.mjs`: every module,
every exported symbol, every setting, every command, every DOM name. Do not edit
it — run `npm run design`.

| Question | Answered by |
| --- | --- |
| What exists, and where? | the generated symbol tables at the end |
| What does it write? | §1–§4 and the surface table in §6 |
| What must never happen? | the invariant lines in each section, each tied to a symbol |
| Is this sentence still true? | `npm run docs:check` |
| Is the check itself real? | `npm run docs:falsify` — it breaks the code and expects red |

## 1. The record

An entry is an address line, its prose, and at most one clock row. A day note is a
list of them plus the day's frontmatter. Everything else in the plugin exists to
draw that list, move a caret through it, or write one of its fields.

The clock row is the frame's bottom edge: the duration and the moment sit at its
two ends, so the row you write is the row the frame is labelled with. Both halves
are digit and punctuation runs — white digits around dimension-coloured colons —
the same grammar the Dimensional Address is drawn in. The duration comes first
because it is the half that moves: settling rewrites its characters and leaves the
moment's alone.

| Field | Written by | Read by | Shape |
| --- | --- | --- | --- |
| Dimensional Address | `formatAddress` | `parseAddressPrefix`, `parseEntries` | `{ B.D.N }`, matched as a prefix |
| Prose | the writer's own typing | `parseEntries` | every line between the address and the clock row that is not a whisper row, trimmed at both ends |
| Whisper | the model, at settle or after it | `parseWhisperLine` | `~ <text>` (a name), `~ learn: <text>`, `~ next: <text>`, or `~ ask: <text?>` — one to three rows (the prompt asks for two or three); a `thread:` row may be appended later |
| Moment | `planEntryBeginning`, `planCaptureEntry` | `parseClockRow` | `YYYY-MM-DD HH:MM:SS` frozen on the first committed input and copied unchanged when the Loom saves; an undated historical moment inherits the filename day |
| Duration | `formatDurationLine` | `parseClockRow` | `[+-=] HH:MM:SS` at the head of the clock row; `-` open, `=` paused, `+` settled |
| Close | `closeLine` | `parseClose` | `✓ HH:MM:SS`, at most one, never an entry |
| Frontmatter | `dayFrontmatter`, `applyDayStats`, `mergeAlignment` | `scanFrontmatter`, `recountDay`, `readAlignments` | `date`, `travels`, `depth`, `duration`, and structured `weaver-alignments` |

<!-- claim: src/core/entries.ts#formatAddress @1abc672aad -->
<!-- claim: src/core/entries.ts#parseEntries @867ab254f7 -->
<!-- claim: src/core/duration.ts#parseClockRow @8f42ef87a2 -->
<!-- claim: src/core/close.ts#parseClose @1690b1d5c0 -->
<!-- claim: src/core/day-stats.ts#recountDay @89a9e7f928 -->

`D` is depth, `B` is the branch id, `N` is the day sequence. `N` is identity and
only ever appended (`src/core/entries.ts#nextSeq`); `B` is address, inherited by
an insert (`planChildEntry` copies the parent's `B`) and repaired only when a root
is deleted (`planDeleteEntry` → `repairBranches`). `D` is structural: a child is
its parent's `D` plus one, and a depth-1 entry starts a new branch
(`nextBranch`).

<!-- claim: src/core/entries.ts#nextBranch @8b5cb2e473 -->

### Destinations, and the day across them

A *destination* is a folder and a filename format that a thought may be woven
into. `main` is the vault's own day note: it resolves through the core Daily
Notes plugin when that can be read, and through `dayNoteFolder`/`dayNoteFormat`
when it cannot. Every other destination is an explicit row, and Daily Notes never
overrides one.

`src/core/contexts.ts#readContexts` is the boundary: a stored row becomes a typed
definition only when it has an id, a unique name, a folder inside the vault and a
filename format in the `YYYY`/`MM`/`DD` language. The same small language is what
makes the inverse exist — `src/core/contexts.ts#contextDayForPath` matches a whole
vault path back to the destination and day it names, round-tripping the calendar
so February 30 is refused. `src/core/contexts.ts#mainContext` and
`effectiveContexts` put `main` first, which is the picker's order;
`src/core/contexts.ts#contextDayPath` expands a day into a path.

Resolution always takes the day it is for, never a fresh reading of the clock:
`src/entries/day-note.ts#resolveContextDay` answers with a path and the file when
it exists, and an unknown or unreadable destination is an error rather than a
silent fall back to `main`. Creating is separate and explicit:
`src/entries/day-note.ts#ensureDayNote` makes every missing folder in order and
accepts only a `TFile` at the exact path, so a concurrent create that wins the
race is the file the caller asked for.

Two consequences run through the rest of this document. A created day that differs
from the note's filename is a link in that destination's own format —
`src/core/contexts.ts#entryDayLinkTarget` — and a note no destination recognises is
read by its basename, as it always was. And the reading index is derived, not stored:
`src/entries/thought-index.ts#ThoughtIndex` reads every recognised note, prefers an
open editor's own text, and selects a thought by its recorded day or, for an
undated entry, its note's.

<!-- claim: src/core/contexts.ts#readContexts @93b53b25de -->
<!-- claim: src/core/contexts.ts#contextDayForPath @133fade252 -->
<!-- claim: src/entries/day-note.ts#resolveContextDay @283d4405d2 -->
<!-- claim: src/entries/day-note.ts#ensureDayNote @210f61c1da -->
<!-- claim: src/core/entries.ts#repairBranches @511204537d -->

The parser is a prefix match, so `{ 1.2.3 } a title` is one entry whose first
prose line is `a title`; the Dimensional Address inside frontmatter or a fenced block is text
(`src/core/document.ts#scanFrontmatter`, `src/core/document.ts#scanFences`). The
clock row is the entry's last line, and either half may be absent: a row with
only a moment, or only a duration, is still a clock row. An address that still
carries its old `- HH:MM:SS` clock sets `EntryIndex.legacyFormat`; every plan
refuses such a note rather than read the clock as its first prose line. The
documented example below is a file the tests parse, not a retyped sample.

## 2. The one writer

A day note has exactly one writer at a time, and one module owns it.

- `rewriteDay` looks the file up in the editor registry. If a live editor holds
  it, the rewrite is a `view.dispatch`; otherwise it is `vault.process` — never
  both, never a plain `vault.modify`.
- The callback receives the exact string that is about to be replaced, so a plan
  can never be built against a stale read.
- `planRewrite` adapts an `InsertPlan` builder into that callback; `minimalChange`
  turns a before/after pair into the single change spanning the difference.
- Every write carries `programmaticWrite`, so the edit listener cannot mistake
  Weaver's own write for the writer typing.

<!-- claim: src/entries/writer.ts#rewriteDay @ed29801c71 -->
<!-- claim: src/entries/writer.ts#planRewrite @b52e9a19bf -->
<!-- claim: src/editor/entry-field.ts#programmaticWrite @e59e28301b -->

Callers of `rewriteDay`, exhaustively —
`src/entries/engine.ts#publish` (the ambient pause),
`src/entries/engine.ts#capture` (one settled thought, through the Loom),
`src/main.ts#closeDay`, `src/main.ts#refreshDayStats`, and the two whisper writes,
`src/entries/engine.ts#landWhisper` (one answer arriving after its entry settled)
and `src/entries/engine.ts#whisperDay` (a whole-day pass merged into one
transaction). `capture` is the one caller that passes the writer's optional hooks:
`beforeCommit` records a receipt before the note is touched, and
`confirmPersistence` re-reads the file afterwards, because the Loom's save is
the one write whose outcome the writer has to be told about. The editor path is
`src/entries/engine.ts#EntryEngine` itself: settle, descend and deleteEntry
dispatch plans from `core/insert.ts` there, and §3 lists those plans. Nothing else writes a day note. The gate fails if
`vault.process`, `vault.modify` or `vault.append` appears outside
`src/entries/writer.ts`; if `vault.create` or `vault.createFolder` appears
outside `src/entries/day-note.ts`; if `editor.replaceRange` appears anywhere; or
if a `dispatch` that carries `changes` appears outside `src/entries/engine.ts`
and `src/entries/writer.ts`.

The fileless composer also sends its document changes through
`src/entries/writer.ts#dispatchDraftChange`. Its only caller supplies the pane's
own newly created editor, not a file-bound Obsidian view; no file or vault is
passed and no evidence is published. Input and synchronization keep their own
history annotations. Saving still goes through the capture plan and note writer.

Reading view may retain a CodeMirror buffer without saving it.
`src/editor/view-registry.ts#findEditorViewForFile` excludes that dormant buffer,
so `src/entries/writer.ts#rewriteDay` uses the vault unless an editing view owns
the file; its save-owner lookup also excludes Reading leaves. An absent uncertain
capture reaches a visible Retry save only after
`src/entries/capture-model-controller.ts#CaptureModelController` checks the receipt
against the note; a retry keeps the original compare-before-write guard.

<!-- claim: src/entries/engine.ts#EntryEngine @b59b21c084 -->

## 3. The plans

A plan is a list of changes plus the selection to leave behind. One plan is one
transaction, so one undo reverses all of it.

| Plan | Intent | Changes | Renumbers |
| --- | --- | --- | --- |

| `planChildEntry` | open a child under a settled entry, above older siblings | address, blank line, `- 00:00:00` | no — inherits `B` |
| `planEntryBeginning` | stamp a draft's beginning on first input | the clock row's day and moment, duration bytes untouched | no |
| `planCaptureEntry` | write one settled thought | address, prose, a `+` clock row with its own duration and moment, and the invitation's record when it applies | no — new `N`, next branch or the parent's `B` |
| `planDeleteEntry` | remove a subtree | the block, its blank separator, and nulling deleted history associations | yes — surviving `B` values |
| `planDuration` | write the clock | the duration half of the clock row, moment untouched | no |
| `planWhisper` | name an entry | whisper rows above the first prose line | no |
| `planThread` | place an entry in its day | one `thread:` row below the last whisper row | no |
| `planAppendLine` | the shared append primitive | one insertion at the tip | no |
| `planCloseDay` | close the day | `✓ HH:MM:SS` | no |

<!-- claim: src/core/insert.ts#planCaptureEntry @e81a399167 -->
<!-- claim: src/core/insert.ts#planChildEntry @5cc924783b -->
<!-- claim: src/core/insert.ts#planEntryBeginning @3e58476127 -->
<!-- claim: src/core/insert.ts#planDeleteEntry @f800e9f3b2 -->
<!-- claim: src/core/insert.ts#planDuration @546c356091 -->
<!-- claim: src/core/insert.ts#planWhisper @ddb2eef9bb -->
<!-- claim: src/core/insert.ts#planThread @a8069bde30 -->
<!-- claim: src/core/close.ts#planCloseDay @e36f434d57 -->

`planCaptureEntry` is the only plan that writes a whole settled entry. It
allocates `N` itself, places a root at the tip or a child under its parent above
older siblings, and then **parses the result back**: the written note must contain
exactly the allocated entry, at the intended parent and depth, with the typed prose
between the address and the planned clock row, beginning on the row immediately
after the address without an inserted blank row. A paste that leaves a fence open, or
prose ending in a line that reads as an address or as a clock row, therefore refuses
instead of writing a record that describes a different entry. An invitation's
evidence joins the same plan only when the thought is a root, an opening was really
announced, and the first committed input fell inside that opening's own minute —
`portalContainsBeginning` is re-checked here, at the one place a record is written,
so a caller that got the rule wrong writes an ordinary entry rather than an untrue
record. A branch, a draft begun before its opening and a draft begun after it closed
carry none, and finishing a qualified draft later changes nothing. A record that
cannot be *added* — an id that names no whole minute, say — is dropped while the
thought is still written, because the entry is the record and the alignment is
extra; a note whose existing history cannot be *read* is still refused outright.

Two invariants hold across every plan, and both are tested against
`applyPlanToSource`, the pure oracle: **a settled `+` half is never rewritten**
(`planDuration` returns null for a settled entry), and **an insert never
renumbers anything** (`planChildEntry` carries the parent's `B`). A third holds
for beginnings: **an existing day or moment is never replaced**, including a
historical moment with no written day, so only a genuinely momentless draft
gains one, and only from the first input's own timestamp. `cmChanges`
converts a plan to CodeMirror's shape; the editor gets two dispatches, the change
and then the caret, because Obsidian maps a spec's selection through its own
changes and a caret past the old end cannot be expressed in one.

<!-- claim: src/core/insert.ts#applyPlanToSource @c5b022f97b -->
<!-- claim: src/core/insert.ts#cmChanges @7f311f1a35 -->

## 4. Session versus evidence

The note is the record. Session state is what this installation is doing right
now, and it is device-local: it is never synced, never written, and becomes
evidence only when the engine writes it.

**Publish** is the session-to-evidence boundary: a sigil and an elapsed time
become the entry's clock row, or nothing when the entry is gone or settled. Its
two intents are settle (`+`, the editor path in
`src/entries/engine.ts#EntryEngine`) and pause (`=`,
`src/entries/engine.ts#publish`). Settle writes into the open editor; publish
re-reads the file and writes through the one writer. Neither has its own
command: `⏎` settles, leaving the note pauses, and *Descend into a child entry*
settles only as its first half.

`EntrySession` holds at most one `src/entries/session.ts#ActiveEntry` — the file
path, the entry's `N`, a monotonically increasing session id, the baseline
milliseconds, the resume instant, and the last painted whole-second duration.
`src/entries/clock.ts#EntryClock` samples elapsed time, synchronously paints
subscribers, then commits that snapshot. Pause and settle read the snapshot
without advancing it. A stop's result names the session id it captured, so a
replacement session is never cleared by a late pause, and a failed stop retains
the frozen snapshot until a successful retry or fresh input.

<!-- claim: src/entries/session.ts#EntrySession @0e482e7312 -->

The transitions, and where each lives:

| Transition | Trigger | Code | Write |
| --- | --- | --- | --- |
| Start | the writer's own input in a draft | `src/entries/engine.ts#afterEdit` | none |
| Draft beginning | the first committed character in the Loom | `src/core/capture.ts#captureInstantAt`, `src/entries/portals.ts#PortalController.captureAt` | nothing — the day, the moment and the openings that instant qualifies for are held in the draft until it settles |
| Save | the Loom's Save action (`⌘⏎` on desktop) | `src/entries/engine.ts#capture` | one settled entry, and the invitation's record in the same transaction |
| Pause | a caret move, blur, wheel, touch, leaf change, hidden app, the Loom open, the live entry deleted | `src/entries/engine.ts#pause` | `= HH:MM:SS`, not undoable |
| Settle | `⏎` on an open entry | `src/entries/engine.ts#settle` | `+ HH:MM:SS`, plus the day and moment when the row has none — undoable, and with the whisper rows when the idle pause already answered |
| Drop | the entry being written is deleted | `src/entries/engine.ts#deleteEntry` | none |

<!-- claim: src/entries/engine.ts#EntryEngine @b59b21c084 -->

`afterEdit` is the only place a clock starts, and it starts on an input
observation only: `{ path, seq, at }`, read from the transaction's own selection
and the instant the input arrived. It is never re-derived from the caret when the
deferred listener finally runs, so a keystroke that landed in one entry cannot
start a clock in another. `null` — a delete, an undo, a redo, a vault reload, a
decoration refresh, a jump, an append, a settle — starts nothing. A session whose
entry loses its recorded beginning (an undo) or becomes settled ends without a
write: the row itself is the evidence, and a later redo cannot revive the clock. A
deferred input observation is also dropped when the document is replaced without
input (an undo, a redo, a reload, another surface's write), so a callback that
outlives its own text cannot start a clock on the text that replaced it; typing
afterwards records a new generation with its own timestamp. The first text
of an awaiting entry is the one input the engine writes itself:
`EntryEngine.captureInput` merges the text, the entry's recorded day and moment,
and the mapped caret into one transaction carrying `capturedInput`, so the pair is
one undo and one redo. An IME composition is left native while it is preedit;
`EntryEngine.captureComposition` writes only the beginning after the commit, in a
transaction named `input.type.compose` so history joins it to the composition's
own undo group, and a cancelled composition (the document unchanged) stamps
nothing. A commit into an entry that already recorded its beginning writes
nothing at all: it is handed to `afterEdit` as ordinary input, so a paused or held
draft resumes at the committed instant even when the composition's end produces no
further document change, while a settled entry never starts a clock. The commit
belongs to the note, range and entry the composition began in — recorded at
`compositionstart` — so a caret that moved, a replaced view, or identical text
elsewhere in the note cannot retarget it. The shared clock writes no document:
subscribers paint digit spans through
`src/editor/duration-ticker.ts#writeDigits`. Additional views and widget
adoption read the current snapshot without advancing it; the duration half is the
file's own or the live session's second, the moment half is nothing, the recorded
moment, or the wall clock, and each half ticks only while its own axis is live —
so a paused draft can keep a live wall clock beside a fixed duration. No tick costs
a transaction or an undo entry.

<!-- claim: src/editor/stopwatch-widget.ts#DurationWidget @65db3859d4 -->

### Invitations

A portal is now an *invitation*: a scheduled call to action that opens the same
Loom every other gesture opens. It holds no note, no preparation and no
permission to write, so there is nothing to unlock and nothing that can expire in
the writer's hands. `src/core/portals.ts#occurrencesBetween` and
`src/core/portals.ts#rhythmOccurrences` enumerate the *actual* local minutes a
schedule offers — a daylight-saving gap produces nothing and a repeated hour
produces two distinct instants — and `src/core/portals.ts#dueOpening` takes the
newest occurrence this device has neither outlived nor answered.
`src/core/portals.ts#portalPhase` has three states: approaching, available during
the opening's own minute, and expired. `src/core/portals.ts#portalAlignments` recognises every
coincident boundary, hour echo and minute echo from the actual input second, and
that recognition is what the entry's frame acknowledges.

`src/entries/portals.ts#PortalController` derives one outstanding invitation per
schedule from the instant, the settings and what this device has answered. A
schedule is examined from its activation — the instant it was created — and never
replays an opening from before it; a later occurrence of the *same* schedule
renews its own invitation, while different schedules stay distinct even at the same
minute. Each carries the generation it belongs to, so a late answer cannot clear a
newer invitation. Dismissing acknowledges exactly the occurrence named; `Weave`
acknowledges only after the first successful settlement of a matching root, so
collapsing or failing costs nothing. The controller owns no writer, no editor and
no navigation, and it writes nothing to a note.

Settings hold the schedules as raw rows: `src/core/portals.ts#readPortalSchedules`
turns them into typed recurrences — hourly minute, selected weekdays at a time, or
one instant — and reports the row it could not use rather than dropping it. The
built-in rhythm stays its own switch, because its minutes are not any single
recurrence shape; `src/entries/portals.ts#PortalSource` is what lets the dock list
the rhythm and the configured schedules together.

## 5. Geometry

Nothing reflows. The text decides where the box is, never the reverse.

- `frameBox` is pure: column, the text's left edge, the label inset → the box's
  `left`/`width`, or `drawn: false`.
- `src/core/frame.ts#frameColumn` supplies the pane-clamped column entry boxes are
  drawn in. Editor content padding is excluded from it, so a padded theme cannot
  give two entries different right rails.
- `frameSpan` is pure: this entry's two rails and the next entry's top rail →
  `top`/`bottom`, or `drawn: false` when they leave no interior.
- `src/editor/entry-frame.ts` is the only measuring code. It finds each entry's
  rows by their own `data-weaver-n` stamp
  (`src/editor/entry-frame.ts#renderedRows`), measures the ink of the row
  (`src/editor/entry-frame.ts#inkRect`), and schedules one
  `requestAnimationFrame` per batch (`src/editor/entry-frame.ts#schedule`). A row
  that has scrolled out of the render range falls back to its line block, whose
  centre is still the label's centre.
- `src/core/frame.ts#floatingComposerBox` places the one floating surface. It has
  no flow to inherit, so it is told its box: the active pane's text column when one
  can be measured, up to 720 px centred in the pane when none can, clamped to the
  visual viewport with one inset of air, and never taller than 45% of the usable
  height on a desk or 60% on a phone. Width is the *text* column — no widening for
  the surface and no child indentation — and when the usable height cannot hold a
  preview and an input, the preview goes rather than the box overflowing.
- The constants that turn "a box" into this box — `MIN_AIR`, `NO_CLOCK_PAD`,
  `INLINE_TITLE_PAD` — stay in the measuring layer. The shared side clearance is
  `src/core/frame.ts#frameLabelInset`: `16 px + 0.45em`, using the rendered address's
  font size, exactly the inset Reading view uses. The labels' background halos
  therefore leave both rounded corners visible without moving the text.
  Nothing renders into that air. The labels cannot overhang the
  row, because Obsidian's `contain: paint` clips a block widget at its padding box;
  a label that needs the corner is drawn inside the text column instead, and the
  gutter is the margin that keeps the rail off the ink.
- Where a frame starts is a setting with two answers. On (`frameFollowsIndent`, the
  default) the address, the prose and the clock row all take the indent, and because
  the frame's left edge is pinned a fixed air left of the address, the boxes step right
  with the nesting. Off, only the prose is indented: the address and the clock row stay
  in the left margin, the frame's edge follows them, and every box starts in the same
  column — which puts the addresses and the times in one column each down the note. The
  body class is `weaver-frame-fixed`; both modes are four CSS declarations.
- Vertical rhythm is two settings, both air above an address row. `threadSpacing` is
  the gap above every depth-1 entry after the note's first Thread, so one Thread's
  subtree does not run into the next; `branchSpacing` is the gap above each branch
  whose predecessor is also a branch, so the first branch stays close to its Thread's
  root and later siblings separate. `src/editor/entry-decorations.ts#entryDecorationSet`
  stamps `weaver-thread-start` and `weaver-branch-start` on the address line, where
  padding moves the row, its prose and its frame together;
  `src/reading/entry-processor.ts#createEntryProcessor` stamps the same names on the
  static frame, where the top margin does the work. Both default to zero, and the
  frame measures ink rather than the line box, so the top rail stays on its label
  whatever the padding.
- `src/core/insert.ts#planChildEntry`
  writes a duration-only row, `- 00:00:00`: the block exists, but it has not begun.
  `src/core/insert.ts#planEntryBeginning` stamps the actual local day and moment
  from the first input's one timestamp, even inside an older note, and copies the
  duration bytes unchanged — so an entry made before midnight but typed after it
  records the real day without moving the note. Existing days and moments are
  never replaced. `src/core/duration.ts#parseClockRow` exposes the day
  and time; undated historical moments use the filename day without a rewrite.
  `src/core/contexts.ts#entryDayLinkTarget` returns a link only when the recorded
  day differs from the note's, as a full path in the containing destination's own
  format — or, for a note no destination recognises, in the filename's style. Same-day
  and historical undated entries carry no date label or hidden tab stop, and an
  awaiting draft carries none either: it has not recorded a day for the link to
  name.
  `src/editor/entry-decorations.ts#DayLinkWidget` and
  `src/reading/entry-processor.ts#createEntryProcessor` render that link
  persistently at the top-right, independent of caret, hover or focus. Legacy
  inline prose in Live Preview uses `.weaver-entry-inline` to put its date above
  the row, beside the raised rail. Its background halo extends only sideways,
  rather than adding vertical clearance over adjacent rows.
- `src/core/frame.ts#loomAnchor` places the Loom from visual-viewport bounds and
  only intersecting toolbar bounds. `src/ui/loom.ts#Loom` anchors its bottom edge
  there and grows upward, so a resized window height cannot confuse a fixed
  containing block's coordinates. Only the body scrolls; the editor survives
  keyboard resize and panning with its selection intact.

<!-- claim: src/core/frame.ts#frameBox @cbb958de1d -->
<!-- claim: src/core/frame.ts#frameSpan @324739146a -->
<!-- claim: src/editor/entry-frame.ts#entryFrameExtension @049f956468 -->

A box can also be *doing* something, with one effect class chosen by
`src/editor/frame-effects.ts#frameEffect`. Highest precedence wins:
an 800 ms alignment acknowledgment at 30, whisper reading at 20, a live portal
at 15, and ordinary liveness at 10. `src/main.ts#portalEntered` owns the short
acknowledgment window; a paused or settled portal has its ordinary static frame.
`src/editor/frame-effects.ts#FRAME_EFFECTS` is the registry, so effects never
stack. The stylesheet uses the six anchor custom properties emitted by
`src/ui/css.ts#buildCss`; reduced motion makes the multicolour rail static.

<!-- claim: src/editor/frame-effects.ts#frameEffect @6b669bb17e -->
<!-- claim: src/editor/frame-effects.ts#FRAME_EFFECTS @9ce8e0101f -->

Frames are Live Preview only: `src/editor/entry-frame.ts#measure` returns early
unless `editorLivePreviewField` is true. Source mode is the file's own text. In
Reading view the same shape is a real element made by the post processor, so no
measurement is involved at all.

`src/reading/entry-processor.ts#createEntryProcessor` reads source section
addresses to attach a signed clock to its entry even when Markdown rendered it
as a separate list block. That clock section is hidden independently of render
order. Static frames allow overflow so their rail labels are never clipped.
The address's soft break is removed with its text, not carried into the first
prose line as a blank row; later prose breaks and inline markup are retained.

## 6. Surfaces

One row per surface that can be touched. "Writes" is the complete list of
document bytes it can cause; "empty" is what it shows with nothing to show.

| Surface | Code | Writes | One undo | Empty |
| --- | --- | --- | --- | --- |
| Entry decoration | `src/editor/entry-decorations.ts#entryDecorationSet` | nothing | — | draws nothing (it renders the address's runs, the frame label, and a different-day entry's creation-day link) |
| Clock row | `src/editor/stopwatch-widget.ts#DurationWidget` | nothing (ticks its own DOM) | — | — |
| Frame layer | `src/editor/entry-frame.ts#entryFrameExtension` | nothing | — | draws nothing |
| Entry keys | `src/editor/entry-keys.ts#handleEnterKey` | settle `+`, or a child | the plan | not handled outside an entry |
| Loom | `src/ui/loom.ts#Loom` | one settled thought, when it is settled — nothing before | the plan | asked for nothing; a draft's top rail says `Thread` or `Branch`, never a fabricated address |
| Invitation strip | `src/ui/loom.ts#Loom` | nothing | — | one idle offer; opening or dismissing never interrupts an active or hidden draft, and no countdown or Weave action appears inside the draft |
| Reading view | `src/reading/entry-processor.ts#createEntryProcessor` | nothing | — | leaves the paragraph alone (it frames the entry and adds a creation-day link only when the day differs from the note) |
| Close mark | `src/reading/close-processor.ts#createCloseProcessor` | nothing | — | leaves the paragraph alone |
| Whisper the day | `src/entries/engine.ts#whisperDay` | one whisper per settled entry that has none | the whole pass | `Nothing to whisper: every settled entry already has one, or a name.` |
| Descend command | `src/main.ts#WeaverPlugin` | settle `+`, or a child | the plan, once per transaction | `this needs an editable note.` or `put the caret in an entry.` — nothing written |
| Close day | `src/main.ts#WeaverPlugin` | `✓` plus the counters | the plan | `this day is already closed. Nothing was written.` |
| Settings tab | `src/settings-tab.ts#WeaverSettingTab` | `data.json` only | — | — |

<!-- claim: src/editor/entry-keys.ts#handleEnterKey @05f01a81d6 -->
<!-- claim: src/reading/entry-processor.ts#createEntryProcessor @39d5cddb58 -->

A command's target is the day plane, and *Whisper the day* aims at the day note on
screen — `src/entries/engine.ts#dayToWhisper` — falling back to today's note only
when the open file's filename carries no day. A past day is a day: the note has the
same shape and its entries are the same entries, so the pass follows the reader
rather than the clock. Nothing else writes into a note it was not pointed at.

The Loom's reference is the only navigation: it never takes an Obsidian key scope
while closed, never writes prose, and reads the recognised notes through
`src/entries/thought-index.ts#ThoughtIndex`. The phone pinning is one pure decision,
`shouldPinStopwatch`, true only when all four of phone, live session, caret on
the last prose line, and a clock row exist.

The upper area has three panels: the reference (`ReferenceController`), the
Tapestry chooser, and the invitation list.
`src/core/portal-history.ts#portalHistoryRows` returns recorded facts only — a list
of upcoming openings is the live controller's, never reconstructed from a note —
and `src/core/portal-history.ts#linkedPortalEntry` checks sequence, day and moment
before a historical jump. `src/core/navigation.ts#record` keeps a cursor, so back
and forward walk the same path, and the cursor moves only after a navigation
succeeds.

`src/ui/markdown-pane.ts#MarkdownPane` owns a persistent fileless CodeMirror
editor for formatting while typing and Obsidian-rendered HTML for read-only
content. It never mounts a private native file editor and never writes a note.
Mode changes retain the editor's source, selection and undo history; a genuinely
new empty draft resets history, while a path change or the user's own deletion
does not. Native rendering is tied to a generation and source path, so a late
result cannot replace a newer reading. Internal links use the public workspace
router with that source path and Obsidian's modifier-key disposition. Editing
decorates Markdown source; it does not claim native Live Preview parity.

`src/ui/loom.ts#Loom` keeps header, identity, prose and action rail in the same
order across draft and saved states. The rail has status and one bottom-left
timing label: writing duration and frozen start time while drafting, then the
entry's recorded duration and creation time after saving. Saved timing is read
through `src/entries/thought-index.ts#ThoughtIndex`, never from the cleared draft
clock; `src/ui/loom.ts#refreshTiming` re-reads it when the note changes, and late
reads cannot replace a newer draft's timing. A changed or unreadable thought
shows unknown timing instead of retaining an old stamp. Changed shared-clock ticks commit their
painted second to the capture model; incidental renders never advance an existing
draft's clock or overwrite a committed stop. A pause or save retains the last
displayed second. The empty draft retains the footer's height without numbers;
no separate timestamp row is added. Each reading owns its
dimension colour, and `src/ui/dcn.ts#appendDigitRuns` gives its real address the
same normal-text digits and coloured punctuation as a note frame. Reference
navigation belongs to its focusable toolbar; editing or selecting prose never
walks the thought sequence. `src/main.ts#openReference` explicitly shows a
reading-only surface without beginning a draft.
`src/main.ts#openLoom` retrieves the existing draft or saved reading on an unnamed
open, restores the writing pane and its selection, and focuses it without starting
another Thread. `src/ui/loom.ts#rememberFocus` retains the last outside focus
target across repeated retrievals so Hide can return there.
The draft's dashed frame and the prose-focus outline are independent signals;
the drawn CodeMirror caret has an explicit normal-text-colour stroke. A saved
reading has a solid frame and persistent completion status with a desktop
Enter-to-hide hint. Two compact metadata lines keep timing stationary as the
status changes.
The entry actions share Save's tinted fill and border. Branch previews the saved
thought's next dimension through `src/core/color.ts#dimensionColorVars`; New Thread
always uses the red first dimension, independent of the current reading.
The contextual copy action reads the draft, saved prose or reference-only
snapshot. Destructive confirmation defaults to Keep writing; cancelling it or
finishing a destination proposal returns focus to the retained editor.
The writing slot retains its identity and at least one full prose line even with
reference and keyboard open together. `src/core/frame.ts#revealScrollDelta`
reveals the prose viewport in the body, then the editing caret inside that prose
scroller, without panning the window or changing the selection.
The viewport pass in `src/ui/loom.ts#Loom` also chooses the stacked or split
arrangement; resizing never waits for another edit.

<!-- claim: src/editor/entry-keys.ts#shouldPinStopwatch @eefa36e514 -->

## 7. Settings, colour, and the look

Colour is a pure function of `D` — for the address and the prose.
`dimensionColor(7)` is the same value in every vault and at every moment, and
`dimensionColorVars` packages the two custom properties a line carries. A whisper
row is the one row that takes the note's own text colour, because the glyph alone
does not survive being read next to prose. Nothing is generated per level; the stylesheet is one
`calc()` over `--weaver-d`, and the runtime variables are written by `buildCss`
into one `<style id="weaver-style">` element.

<!-- claim: src/core/color.ts#dimensionColor @bbd0b078df -->
<!-- claim: src/ui/css.ts#buildCss @b828401558 -->

Settings land in one of the places listed here, never in a surface of their own:
values that change the drawing go through `buildCss` (variables), values that
change state go through `src/main.ts#syncBodyClasses` (body classes), and
everything else is read where it is needed (the generated table lists every
field's readers). The settings model is the only place a persisted name exists;
`normalizeSettings` clamps and defaults, and `LEGACY_SETTING_KEYS` is the single
place an older spelling is read — the v2 `heading*` names. A stored name with no
current name at all (`entryWeight`, dropped with the per-entry weight slider;
`entryDate`, dropped with the per-entry date) is simply dropped.

<!-- claim: src/settings.ts#normalizeSettings @aba553f890 -->
<!-- claim: src/settings.ts#DEFAULT_SETTINGS @fb8d0b2893 -->

Two settings are persisted raw rather than normalised: `contexts` and
`portalSchedules`. A row this build cannot read is the writer's data, so it is
reported with its index and left exactly as it is; only validated rows ever resolve
a path or offer an invitation. `portalMotion` is the one motion setting, and it
changes the invitation's rainbow duration and nothing else — no padding, no label
placement, no second animation.

**Vocabulary is a coupling, not a preference.** The unit is an *entry*, its depth
a *dimension*, its state *open* or *settled*. A depth-1 entry starts a **Thread**
and the Thread includes its descendants; a deeper thought is a **branch**. Product
copy capitalises Thread; the stored `B`/`D`/`N` and the internal plan names do not
change with it. `heading` names Markdown syntax and
nothing else, which is why the settings fields are `entrySize` and
`equalizeEntrySizes` and why the v2 names appear once, in the migration. The
frame's labels — address, the date link on another day, stopwatch and moment — carry
the note's own weight, so no setting exists for theirs.

## 8. Every sentence the user sees

`src/notices.ts` owns the text: the notice durations and every refusal and
confirmation — including a whisper pass's own two (`NOTICE_WHISPERING`, and the
outcome `noticeWhispered` reports: what it wrote, out of what it tried, and why the
rest did not land) and the refusal a device with no reachable endpoint earns
(`NOTICE_WHISPER_UNREACHABLE`). A surface imports the string; it never retypes one. That is what
keeps `docs/surfaces.md`'s "what does it show when there is nothing" honest — the
sentence it quotes is a constant, and the generated module table says where it is
used.

<!-- claim: src/notices.ts#NOTICE_NO_DAY_NOTE @f247389f09 -->

## 9. The gates

`npm run check` is the whole gate. Each part proves something different, and the
last line says what it cannot prove.

| Gate | Proves | Cannot prove |
| --- | --- | --- |
| `npm run typecheck` | every reference resolves and every type holds | that the types mean what the product means |
| `npm test` | the pure rules, the plans, the decorations, the writer, both processors | layout, pixels, Obsidian's own behaviour |
| `npm run bend:proof` | the duration algebra's seven laws | anything that touches the editor |
| `npm run design` | the index and the generated half match the tree | that the authored half is right |
| `npm run docs:check` | every address resolves, every claim's hash is current, classes and settings and commands exist on both sides, `core` is Obsidian-free, no write bypasses the writer | that the prose is well judged |
| `npm run docs:falsify` | the checker fails for the reason the changed code names, not merely because the index is stale | that a human read the result |
| `npm run build` | the bundle compiles | that it runs |

Layout is verified by hand: `npm run build && npm run deploy`, reload, and check
Live Preview and Reading view against the frame checks at the end of `README.md`.
No unit test can see a pixel, and this document does not pretend otherwise.

## 10. If you change…

| You change | Also change |
| --- | --- |
| an address or duration shape | `core/entries.ts`, `core/duration.ts`, `core/duration.bend` + `LAWS.bend`, the fixture, §1 |
| what a plan changes | `core/insert.ts`, its test in `tests/entry-plans.test.ts`, §3 |
| when a clock starts or stops | `entries/engine.ts#afterEdit`, `editor/entry-keys.ts`, §4 |
| a geometry constant | `editor/entry-frame.ts`, `tests/frame.test.ts`, §5 |
| a setting | `settings.ts` (field, default, normalizer), `settings-tab.ts`, the reader, a test for both normalization paths, §7 |
| a user-facing sentence | `notices.ts` only — then whatever quotes it |
| a class or `data-` attribute | `styles.css` or the writer, `tests/` that selects it, the generated DOM table |
| a command | `main.ts`, `README.md`'s command table, the generated command table |
| a whisper rule | `core/whisper.ts`, `tests/whisper.test.ts`, and `WHISPER_PROMPT_VERSION` when the prompt's text moves |
| an export | its doc comment — the gate requires one — and the sentence here that names it |

If a change makes a sentence in this file false, the gate will say which one.
That is the point: the document is not maintained by memory, it is maintained by
`npm run docs:check` and repaired where it points.

<!-- design:begin — generated by scripts/design-md.mjs; do not edit by hand -->

### Modules

62 files, 493 exported symbols, 53 test files.

| file | layer | lines | exports | imports `obsidian` |
| --- | --- | --- | --- | --- |
| `src/core/alignments.ts` | core | 484 | 8 | no |
| `src/core/capture-state.ts` | core | 987 | 25 | no |
| `src/core/capture.ts` | core | 494 | 32 | no |
| `src/core/clock.ts` | core | 16 | 2 | no |
| `src/core/close.ts` | core | 61 | 5 | no |
| `src/core/color.ts` | core | 123 | 7 | no |
| `src/core/contexts.ts` | core | 480 | 21 | no |
| `src/core/day-stats.ts` | core | 90 | 4 | no |
| `src/core/day.ts` | core | 72 | 6 | no |
| `src/core/document.ts` | core | 92 | 6 | no |
| `src/core/duration.ts` | core | 157 | 6 | no |
| `src/core/entries.ts` | core | 426 | 15 | no |
| `src/core/frame.ts` | core | 369 | 22 | no |
| `src/core/insert.ts` | core | 681 | 14 | no |
| `src/core/loom.ts` | core | 379 | 12 | no |
| `src/core/navigation.ts` | core | 150 | 12 | no |
| `src/core/portal-history.ts` | core | 213 | 5 | no |
| `src/core/portals.ts` | core | 512 | 24 | no |
| `src/core/reference.ts` | core | 353 | 21 | no |
| `src/core/reviews.ts` | core | 337 | 18 | no |
| `src/core/value.ts` | core | 15 | 1 | no |
| `src/core/whisper.ts` | core | 407 | 19 | no |
| `src/editor/close-decorations.ts` | editor | 82 | 2 | yes |
| `src/editor/duration-ticker.ts` | editor | 23 | 2 | no |
| `src/editor/editor-path.ts` | editor | 11 | 1 | yes |
| `src/editor/entry-decorations.ts` | editor | 311 | 2 | yes |
| `src/editor/entry-field.ts` | editor | 62 | 6 | no |
| `src/editor/entry-frame.ts` | editor | 411 | 3 | yes |
| `src/editor/entry-keys.ts` | editor | 496 | 15 | no |
| `src/editor/frame-effects.ts` | editor | 86 | 4 | no |
| `src/editor/stopwatch-widget.ts` | editor | 278 | 4 | no |
| `src/editor/view-registry.ts` | editor | 68 | 6 | yes |
| `src/entries/capture-model-controller.ts` | entries | 967 | 5 | no |
| `src/entries/capture-store.ts` | entries | 482 | 6 | no |
| `src/entries/capture.ts` | entries | 1187 | 5 | no |
| `src/entries/clock.ts` | entries | 131 | 3 | no |
| `src/entries/context-workspaces.ts` | entries | 554 | 4 | yes |
| `src/entries/day-note.ts` | entries | 170 | 5 | yes |
| `src/entries/engine.ts` | entries | 1381 | 3 | yes |
| `src/entries/local-state.ts` | entries | 491 | 13 | no |
| `src/entries/loom.ts` | entries | 205 | 8 | no |
| `src/entries/plugin-data.ts` | entries | 461 | 4 | no |
| `src/entries/portals.ts` | entries | 523 | 3 | no |
| `src/entries/reference.ts` | entries | 545 | 13 | no |
| `src/entries/session.ts` | entries | 165 | 4 | no |
| `src/entries/thought-index.ts` | entries | 271 | 2 | no |
| `src/entries/writer.ts` | entries | 250 | 11 | yes |
| `src/main.ts` | root | 1134 | 1 | yes |
| `src/model/whisper-model.ts` | root | 186 | 6 | yes |
| `src/model/whisper-runner.ts` | root | 227 | 5 | no |
| `src/notices.ts` | root | 169 | 23 | no |
| `src/reading/close-processor.ts` | reading | 39 | 1 | yes |
| `src/reading/entry-processor.ts` | reading | 347 | 1 | yes |
| `src/settings-tab.ts` | root | 785 | 1 | yes |
| `src/settings.ts` | root | 325 | 8 | no |
| `src/ui/css.ts` | ui | 88 | 4 | no |
| `src/ui/day-link.ts` | ui | 51 | 2 | no |
| `src/ui/dcn.ts` | ui | 74 | 6 | no |
| `src/ui/invitation.ts` | ui | 44 | 5 | no |
| `src/ui/loom.ts` | ui | 2137 | 4 | yes |
| `src/ui/markdown-pane.ts` | ui | 879 | 3 | yes |
| `src/ui/platform.ts` | ui | 38 | 4 | yes |

### Commands

| id | name | icon | hotkey |
| --- | --- | --- | --- |
| `weaver:start-entry` | Weave a Thread | `plus` | `Mod,Shift+Enter` |
| `weaver:descend` | Branch from this thought | `arrow-down-right` | — |
| `weaver:back` | Back | `arrow-left` | — |
| `weaver:forward` | Forward | `arrow-right` | — |
| `weaver:navigate` | Browse the Loom | `list` | `Mod,Shift+P` |
| `weaver:view-today` | View Today | `calendar` | `Mod,Alt+t` |
| `weaver:loom-previous-tapestry` | Previous Tapestry | `chevron-left` | `Mod,Alt+ArrowLeft` |
| `weaver:loom-next-tapestry` | Next Tapestry | `chevron-right` | `Mod,Alt+ArrowRight` |
| `weaver:loom-reference` | Show the Loom reference | `book-open` | `Mod,Alt+ArrowUp` |
| `weaver:loom-write` | Return to writing | `pencil` | `Mod,Alt+ArrowDown` |
| `weaver:whisper-day` | Whisper the day | `sparkles` | — |
| `weaver:close-day` | Close the day | `check-circle` | — |

### Settings

| field | default | read in |
| --- | --- | --- |
| `writeDayCounters` | `true` | `main.ts`<br>`settings-tab.ts` |
| `portalsEnabled` | `true` | `main.ts`<br>`settings-tab.ts` |
| `rhythmicPortalsEnabled` | `true` | `main.ts`<br>`settings-tab.ts` |
| `portalSchedules` | `[]` | `main.ts`<br>`settings-tab.ts` |
| `portalMotion` | `"normal"` | `main.ts`<br>`settings-tab.ts` |
| `dayNoteFolder` | `"Chronomancer"` | `entries/day-note.ts`<br>`settings-tab.ts` |
| `dayNoteFormat` | `"YYYY.MM.DD"` | `entries/day-note.ts`<br>`settings-tab.ts` |
| `contexts` | `[]` | `core/contexts.ts`<br>`core/reference.ts`<br>`editor/entry-decorations.ts`<br>`entries/capture-model-controller.ts`<br>`entries/capture.ts`<br>`entries/context-workspaces.ts`<br>`entries/day-note.ts`<br>`entries/engine.ts`<br>`entries/thought-index.ts`<br>`main.ts`<br>`reading/entry-processor.ts`<br>`settings-tab.ts`<br>`ui/loom.ts` |
| `equalizeEntrySizes` | `true` | `main.ts`<br>`settings-tab.ts` |
| `entrySize` | `"1em"` | `settings-tab.ts`<br>`ui/css.ts` |
| `indentStep` | `18` | `settings-tab.ts`<br>`ui/css.ts` |
| `mobileIndentStep` | `12` | `settings-tab.ts`<br>`ui/css.ts` |
| `indentMaxLevel` | `8` | `settings-tab.ts`<br>`ui/css.ts` |
| `portEmphasisColors` | `true` | `main.ts`<br>`settings-tab.ts` |
| `entryFrames` | `true` | `editor/entry-frame.ts`<br>`settings-tab.ts` |
| `frameFollowsIndent` | `true` | `main.ts`<br>`settings-tab.ts` |
| `threadSpacing` | `0` | `settings-tab.ts`<br>`ui/css.ts` |
| `branchSpacing` | `0` | `settings-tab.ts`<br>`ui/css.ts` |
| `whisperEnabled` | `false` | `main.ts`<br>`settings-tab.ts` |
| `whisperEndpoint` | `"http://127.0.0.1:8000/v1"` | `main.ts`<br>`settings-tab.ts` |
| `whisperModelId` | `"Qwen3.5-4B-MLX-4bit"` | `main.ts`<br>`settings-tab.ts` |
| `whisperApiKey` | `""` | `main.ts`<br>`settings-tab.ts` |
| `whisperThreads` | `false` | `entries/engine.ts`<br>`settings-tab.ts` |
| `debug` | `false` | `main.ts`<br>`settings-tab.ts` |

The names on disk are these names: `settings.ts#LEGACY_SETTING_KEYS` maps the v2 spellings and nothing else reads them.

### DOM names

A name is a contract: a user's snippet may hang off any of them, so a rename is a breaking change and a `hook` is deliberate rather than dead. `styled` means a rule exists in `styles.css` or is generated by `src/ui/css.ts`; `body state` means `main.ts` toggles it on `<body>`; `hook` means Weaver writes it and nothing styles it — the tests or a user's CSS do.

| name | state | written in |
| --- | --- | --- |
| `weaver-alignments` | hook | `core/alignments.ts`<br>`core/portal-history.ts` |
| `weaver-branch-start` | styled | `editor/entry-decorations.ts`<br>`reading/entry-processor.ts` |
| `weaver-close-mark` | styled | `reading/close-processor.ts` |
| `weaver-close-mark-line` | styled | `editor/close-decorations.ts` |
| `weaver-composer` | styled | `ui/loom.ts` |
| `weaver-composer-actions` | styled | `ui/loom.ts` |
| `weaver-composer-body` | styled | `ui/loom.ts` |
| `weaver-composer-branch` | styled | `ui/loom.ts` |
| `weaver-composer-card` | styled | `ui/loom.ts` |
| `weaver-composer-check` | styled | `ui/loom.ts` |
| `weaver-composer-chooser` | styled | `ui/loom.ts` |
| `weaver-composer-chooser-empty` | hook | `ui/loom.ts` |
| `weaver-composer-chooser-here` | styled | `ui/loom.ts` |
| `weaver-composer-chooser-row` | styled | `ui/loom.ts` |
| `weaver-composer-chooser-title` | styled | `ui/loom.ts` |
| `weaver-composer-chooser-travel` | styled | `ui/loom.ts` |
| `weaver-composer-chooser-write` | styled | `ui/loom.ts` |
| `weaver-composer-context` | styled | `ui/loom.ts` |
| `weaver-composer-context-label` | hook | `ui/loom.ts` |
| `weaver-composer-dest` | styled | `ui/loom.ts` |
| `weaver-composer-editor` | styled | `ui/loom.ts` |
| `weaver-composer-elapsed` | styled | `ui/loom.ts` |
| `weaver-composer-footer` | styled | `ui/loom.ts` |
| `weaver-composer-header` | styled | `ui/loom.ts` |
| `weaver-composer-hide` | styled | `ui/loom.ts` |
| `weaver-composer-identity` | styled | `ui/loom.ts` |
| `weaver-composer-identity-address` | styled | `ui/loom.ts` |
| `weaver-composer-identity-label` | styled | `ui/loom.ts` |
| `weaver-composer-keyhint` | styled | `ui/loom.ts` |
| `weaver-composer-menu` | styled | `ui/loom.ts` |
| `weaver-composer-menu-item` | styled | `ui/loom.ts` |
| `weaver-composer-more` | styled | `ui/loom.ts` |
| `weaver-composer-new` | styled | `ui/loom.ts` |
| `weaver-composer-newline` | hook | `ui/loom.ts` |
| `weaver-composer-prose` | styled | `ui/loom.ts` |
| `weaver-composer-quiet-close` | styled | `ui/loom.ts` |
| `weaver-composer-ref-toggle` | styled | `ui/loom.ts` |
| `weaver-composer-reference` | styled | `ui/loom.ts` |
| `weaver-composer-reference-address` | styled | `ui/loom.ts` |
| `weaver-composer-reference-invitations` | hook | `ui/loom.ts` |
| `weaver-composer-reference-nav` | styled | `ui/loom.ts` |
| `weaver-composer-reference-next` | hook | `ui/loom.ts` |
| `weaver-composer-reference-notice` | styled | `ui/loom.ts` |
| `weaver-composer-reference-open` | hook | `ui/loom.ts` |
| `weaver-composer-reference-position` | styled | `ui/loom.ts` |
| `weaver-composer-reference-prev` | hook | `ui/loom.ts` |
| `weaver-composer-reference-prose` | styled | `ui/loom.ts` |
| `weaver-composer-reference-search` | styled | `ui/loom.ts` |
| `weaver-composer-reference-search-toggle` | hook | `ui/loom.ts` |
| `weaver-composer-reference-tab` | hook | `ui/loom.ts` |
| `weaver-composer-reference-tabs` | styled | `ui/loom.ts` |
| `weaver-composer-reference-tools` | styled | `ui/loom.ts` |
| `weaver-composer-resume` | styled | `ui/loom.ts` |
| `weaver-composer-resume-dismiss` | styled | `ui/loom.ts` |
| `weaver-composer-resume-open` | styled | `ui/loom.ts` |
| `weaver-composer-retry` | styled | `ui/loom.ts` |
| `weaver-composer-save` | styled | `ui/loom.ts` |
| `weaver-composer-save-alt` | styled | `ui/loom.ts` |
| `weaver-composer-shortcut` | styled | `ui/loom.ts` |
| `weaver-composer-shortcuts` | styled | `ui/loom.ts` |
| `weaver-composer-shortcuts-close` | styled | `ui/loom.ts` |
| `weaver-composer-shortcuts-list` | styled | `ui/loom.ts` |
| `weaver-composer-shortcuts-title` | styled | `ui/loom.ts` |
| `weaver-composer-state` | styled | `ui/loom.ts` |
| `weaver-composer-status` | styled | `ui/loom.ts` |
| `weaver-composer-use` | styled | `ui/loom.ts` |
| `weaver-composer-viewing` | styled | `ui/loom.ts` |
| `weaver-composer-writing` | styled | `ui/loom.ts` |
| `weaver-dcn-ink` | styled | `ui/dcn.ts` |
| `weaver-dcn-num` | styled | `ui/dcn.ts` |
| `weaver-duration` | styled | `editor/entry-frame.ts`<br>`editor/stopwatch-widget.ts`<br>`reading/entry-processor.ts` |
| `weaver-duration-clock` | hook | `editor/stopwatch-widget.ts`<br>`reading/entry-processor.ts` |
| `weaver-duration-ink` | styled | `ui/dcn.ts` |
| `weaver-duration-moment` | styled | `editor/stopwatch-widget.ts`<br>`reading/entry-processor.ts` |
| `weaver-duration-num` | styled | `editor/stopwatch-widget.ts`<br>`ui/dcn.ts` |
| `weaver-duration-raw` | styled | `editor/entry-decorations.ts`<br>`editor/entry-frame.ts` |
| `weaver-duration-sigil` | styled | `editor/stopwatch-widget.ts`<br>`reading/entry-processor.ts` |
| `weaver-entry-daylink` | styled | `ui/day-link.ts` |
| `weaver-entry-head` | styled | `editor/entry-decorations.ts`<br>`editor/entry-frame.ts`<br>`reading/entry-processor.ts`<br>`ui/css.ts` |
| `weaver-entry-inline` | styled | `editor/entry-decorations.ts` |
| `weaver-entry-prose` | styled | `editor/entry-decorations.ts`<br>`reading/entry-processor.ts`<br>`ui/css.ts` |
| `weaver-entry-whisper` | styled | `editor/entry-decorations.ts`<br>`reading/entry-processor.ts`<br>`ui/css.ts` |
| `weaver-frame` | styled | `editor/entry-frame.ts`<br>`reading/entry-processor.ts` |
| `weaver-frame-fixed` | styled | `main.ts` |
| `weaver-frame-label` | styled | `editor/entry-decorations.ts`<br>`editor/entry-frame.ts`<br>`editor/stopwatch-widget.ts`<br>`reading/entry-processor.ts`<br>`ui/day-link.ts` |
| `weaver-frame-layer` | styled | `editor/entry-frame.ts` |
| `weaver-markdown` | styled | `ui/markdown-pane.ts` |
| `weaver-markdown-content` | hook | `ui/loom.ts`<br>`ui/markdown-pane.ts` |
| `weaver-markdown-editor` | styled | `ui/markdown-pane.ts` |
| `weaver-markdown-editor-host` | hook | `ui/markdown-pane.ts` |
| `weaver-markdown-error` | styled | `ui/markdown-pane.ts` |
| `weaver-markdown-reading` | styled | `ui/loom.ts`<br>`ui/markdown-pane.ts` |
| `weaver-md-codeblock` | styled | `ui/markdown-pane.ts` |
| `weaver-md-h1` | styled | `ui/markdown-pane.ts` |
| `weaver-md-h2` | styled | `ui/markdown-pane.ts` |
| `weaver-md-h3` | styled | `ui/markdown-pane.ts` |
| `weaver-md-h4` | styled | `ui/markdown-pane.ts` |
| `weaver-md-h5` | styled | `ui/markdown-pane.ts` |
| `weaver-md-h6` | styled | `ui/markdown-pane.ts` |
| `weaver-md-hr` | styled | `ui/markdown-pane.ts` |
| `weaver-md-image` | styled | `ui/markdown-pane.ts` |
| `weaver-md-list-item` | styled | `ui/markdown-pane.ts` |
| `weaver-md-mark` | styled | `ui/markdown-pane.ts` |
| `weaver-md-quote` | styled | `ui/markdown-pane.ts` |
| `weaver-md-table-cell` | styled | `ui/markdown-pane.ts` |
| `weaver-md-table-delimiter` | styled | `ui/markdown-pane.ts` |
| `weaver-md-table-pipe` | styled | `ui/markdown-pane.ts` |
| `weaver-md-table-row` | styled | `ui/markdown-pane.ts` |
| `weaver-md-wikilink` | styled | `ui/markdown-pane.ts` |
| `weaver-no-emphasis` | styled | `main.ts`<br>`ui/css.ts` |
| `weaver-phone` | styled | `main.ts` |
| `weaver-platform-mobile` | body state | `main.ts` |
| `weaver-settings` | styled | `settings-tab.ts` |
| `weaver-style` | hook | `ui/css.ts` |
| `weaver-tablet` | body state | `main.ts` |
| `weaver-thread-start` | styled | `editor/entry-decorations.ts`<br>`reading/entry-processor.ts` |
| `weaver-unequal` | styled | `main.ts`<br>`ui/css.ts` |

**Dead CSS check.** Every class styled in `styles.css` must be written by the code. Unstyled rules right now: none.

| attribute | written in |
| --- | --- |
| `data-weaver-close-processed` | `reading/close-processor.ts` |
| `data-weaver-d` | `reading/entry-processor.ts` |
| `data-weaver-entry-processed` | `reading/entry-processor.ts` |
| `data-weaver-motion` | `main.ts` |
| `data-weaver-n` | `editor/entry-decorations.ts`<br>`editor/entry-frame.ts`<br>`editor/stopwatch-widget.ts` |

### The record example

This is `tests/fixtures/day-note.md`, verbatim — the same bytes `tests/record-format.test.ts` parses. Its frontmatter agrees with its own text: `applyDayStats` returns it unchanged.

```markdown
---
date: 2026-10-29
travels: 3
depth: 2
duration: 00:09:05
---

{ 1.1.1 }
sparked by [[2026.10.26 - Breaking Free and Building Thoughtware]]
+ 00:04:12 16:10:00

{ 1.2.2 }
the thought this one opened, one dimension deeper
+ 00:01:30 16:14:12

{ 1.2.3 }
and the one beside it, still open
= 00:03:23 16:15:42

✓ 17:02:00
```

### Coverage, as it actually is

Derived, not asserted: a module whose exports no test names is listed here until a test names one. It is a report, not a gate — but it cannot go missing.

| module | exports named by a test | exports |
| --- | --- | --- |
| `src/core/document.ts` | 0 | 6 |
| `src/core/value.ts` | 0 | 1 |
| `src/editor/duration-ticker.ts` | 0 | 2 |
| `src/editor/editor-path.ts` | 0 | 1 |
| `src/editor/entry-frame.ts` | 0 | 3 |
| `src/entries/engine.ts` | 0 | 3 |
| `src/ui/css.ts` | 0 | 4 |
| `src/ui/dcn.ts` | 0 | 6 |
| `src/ui/invitation.ts` | 0 | 5 |
| `src/ui/markdown-pane.ts` | 0 | 3 |

Modules with no symbol named by any test: 10.

### Symbols

One table per module. `used by` is a textual reference from another file — a caller, a type annotation, a test — not a resolved call graph; this repository has no compiler API to resolve one, and the document must not claim what it cannot show.

#### `src/core/alignments.ts`

Portal history: the openings a day note actually entered, and the frontmatter

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `ALIGNMENTS_KEY` | const | 23 | `export const ALIGNMENTS_KEY = "weaver-alignments"` | — | — |
| `AlignmentRecord` | interface | 35 | `export interface AlignmentRecord` | `core/insert.ts`<br>`core/portal-history.ts` | `tests/alignments.test.ts`<br>`tests/portal-history.test.ts` |
| `AlignmentRead` | type | 43 | `export type AlignmentRead = \|` | — | — |
| `AlignmentWrite` | type | 48 | `export type AlignmentWrite = \|` | — | — |
| `formatLocalTimestamp` | function | 88 | `export function formatLocalTimestamp(date: Date): string` | `core/capture.ts` | `tests/alignments.test.ts` |
| `readAlignments` | function | 348 | `export function readAlignments(source: string): AlignmentRead` | `core/insert.ts`<br>`core/portal-history.ts`<br>`main.ts` | `tests/alignments.test.ts`<br>`tests/capture-end-to-end.test.ts`<br>`tests/entry-plans.test.ts`<br>`tests/writer.test.ts` |
| `mergeAlignment` | function | 442 | `export function mergeAlignment(source: string, record: AlignmentRecord): AlignmentWrite` | `core/insert.ts` | `tests/alignments.test.ts` |
| `detachAlignments` | function | 470 | `export function detachAlignments(source: string, deleted: ReadonlySet<number>): AlignmentWrite` | `core/insert.ts` | `tests/alignments.test.ts` |

#### `src/core/capture-state.ts`

The lower half of the Loom as one tagged state: the draft, the correction, and

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `TextSelection` | interface | 38 | `export interface TextSelection` | `entries/capture-store.ts` | — |
| `DraftData` | interface | 48 | `export interface DraftData` | `entries/capture-store.ts` | `tests/capture-store.test.ts` |
| `DraftWork` | type | 63 | `export type DraftWork = Omit<DraftData, "durationMs"> &` | — | — |
| `RestorableWork` | type | 72 | `export type RestorableWork = \|` | `entries/capture-model-controller.ts`<br>`entries/capture-store.ts` | — |
| `RevisionData` | interface | 78 | `export interface RevisionData` | `entries/capture-model-controller.ts`<br>`entries/capture-store.ts` | — |
| `WriteIntent` | type | 89 | `export type WriteIntent = \|` | `entries/capture-model-controller.ts`<br>`entries/capture-store.ts` | — |
| `ReceiptBase` | interface | 104 | `export interface ReceiptBase` | `entries/capture-store.ts` | — |
| `WriteReceipt` | type | 112 | `export type WriteReceipt = \| (ReceiptBase &` | `entries/capture-model-controller.ts`<br>`entries/capture-store.ts` | `tests/capture-state.test.ts` |
| `PendingWrite` | type | 121 | `export type PendingWrite = \|` | `entries/capture-model-controller.ts`<br>`entries/capture-store.ts`<br>`entries/loom.ts` | `tests/capture-store.test.ts`<br>`tests/loom-controller.test.ts` |
| `CaptureState` | type | 140 | `export type CaptureState = \|` | `entries/capture-model-controller.ts` | `tests/capture-state.test.ts`<br>`tests/capture-store.test.ts` |
| `CaptureNotice` | interface | 167 | `export interface CaptureNotice` | — | — |
| `CaptureModel` | interface | 173 | `export interface CaptureModel` | `entries/capture-model-controller.ts`<br>`entries/loom.ts` | `tests/capture-state.test.ts`<br>`tests/loom-controller.test.ts` |
| `CaptureEffect` | type | 187 | `export type CaptureEffect = \|` | `entries/capture-model-controller.ts` | — |
| `CapturePersistence` | type | 197 | `export type CapturePersistence = "none" \| "best-effort" \| "required"` | `entries/capture-model-controller.ts` | — |
| `CaptureTransition` | interface | 200 | `export interface CaptureTransition` | — | — |
| `CaptureAction` | type | 210 | `export type CaptureAction = \|` | `entries/capture-model-controller.ts`<br>`entries/loom.ts` | `tests/loom-controller.test.ts` |
| `CaptureResultEvent` | type | 239 | `export type CaptureResultEvent = \|` | — | — |
| `CaptureEvent` | type | 273 | `export type CaptureEvent = CaptureAction \| CaptureResultEvent` | `entries/capture-model-controller.ts` | — |
| `initialCaptureModel` | function | 276 | `export function initialCaptureModel(): CaptureModel` | `entries/capture-model-controller.ts` | `tests/capture-state.test.ts`<br>`tests/loom-controller.test.ts` |
| `draftProjection` | function | 281 | `export function draftProjection(work: DraftWork): DraftData` | — | `tests/capture-state.test.ts` |
| `captureHasWork` | function | 294 | `export function captureHasWork(model: CaptureModel): boolean` | `entries/capture-model-controller.ts` | `tests/capture-state.test.ts` |
| `reduceCapture` | function | 374 | `export function reduceCapture(model: CaptureModel, event: CaptureEvent): CaptureTransition` | `entries/capture-model-controller.ts` | `tests/capture-state.test.ts` |
| `StoredCaptureState` | type | 912 | `export type StoredCaptureState = \|` | `entries/capture-store.ts` | — |
| `storedOf` | function | 925 | `export function storedOf(state: CaptureState): StoredCaptureState` | `entries/capture-model-controller.ts` | `tests/capture-store.test.ts` |
| `restoredOf` | function | 971 | `export function restoredOf(stored: StoredCaptureState): CaptureState` | `entries/capture-model-controller.ts` | `tests/capture-store.test.ts` |

#### `src/core/capture.ts`

One thought being written outside its note: the facts a capture is made of.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `CaptureInstant` | interface | 35 | `export interface CaptureInstant` | `core/capture-state.ts`<br>`entries/capture-model-controller.ts`<br>`entries/capture-store.ts`<br>`entries/capture.ts`<br>`ui/loom.ts` | — |
| `CaptureInvitation` | interface | 55 | `export interface CaptureInvitation` | `core/capture-state.ts`<br>`entries/capture-model-controller.ts`<br>`entries/capture-store.ts`<br>`entries/capture.ts`<br>`entries/engine.ts`<br>`entries/local-state.ts` | `tests/capture-state.test.ts`<br>`tests/capture.test.ts` |
| `DraftTarget` | type | 77 | `export type DraftTarget = \|` | `core/capture-state.ts`<br>`entries/capture-model-controller.ts`<br>`entries/capture-store.ts`<br>`entries/capture.ts` | — |
| `ThoughtRef` | interface | 89 | `export interface ThoughtRef` | `core/capture-state.ts`<br>`core/loom.ts`<br>`core/navigation.ts`<br>`core/reference.ts`<br>`core/reviews.ts`<br>`entries/capture-model-controller.ts`<br>`entries/capture-store.ts`<br>`entries/capture.ts`<br>`entries/engine.ts`<br>`entries/local-state.ts`<br>`entries/plugin-data.ts`<br>`entries/reference.ts`<br>`entries/thought-index.ts`<br>`main.ts`<br>`ui/loom.ts` | `tests/capture-model-controller.test.ts`<br>`tests/capture-state.test.ts`<br>`tests/capture-store.test.ts`<br>`tests/capture.test.ts`<br>`tests/loom-surface.test.ts`<br>`tests/loom.test.ts`<br>`tests/plugin-data.test.ts`<br>`tests/reference-controller.test.ts`<br>`tests/reviews.test.ts` |
| `CaptureRequest` | interface | 107 | `export interface CaptureRequest` | `core/insert.ts`<br>`entries/capture-model-controller.ts`<br>`entries/capture.ts`<br>`entries/engine.ts` | `tests/capture-end-to-end.test.ts`<br>`tests/capture-model-controller.test.ts`<br>`tests/capture.test.ts`<br>`tests/entry-plans.test.ts`<br>`tests/loom.test.ts`<br>`tests/writer.test.ts` |
| `CaptureResult` | type | 123 | `export type CaptureResult = \|` | `entries/capture.ts`<br>`entries/engine.ts` | `tests/capture.test.ts`<br>`tests/loom.test.ts` |
| `SavedThought` | type | 134 | `export type SavedThought =` | `core/capture-state.ts`<br>`entries/capture-model-controller.ts`<br>`entries/capture-store.ts`<br>`entries/capture.ts` | — |
| `CapturePhase` | type | 137 | `export type CapturePhase = "closed" \| "editing" \| "submitting" \| "uncertain" \| "resting"` | `entries/capture-model-controller.ts`<br>`entries/capture.ts` | — |
| `DraftClock` | interface | 147 | `export interface DraftClock` | `core/capture-state.ts`<br>`entries/capture.ts` | — |
| `DraftRecord` | interface | 154 | `export interface DraftRecord` | `entries/capture.ts`<br>`entries/local-state.ts` | — |
| `CaptureReceipt` | interface | 188 | `export interface CaptureReceipt` | `entries/capture-model-controller.ts`<br>`entries/capture-store.ts`<br>`entries/capture.ts`<br>`entries/engine.ts`<br>`entries/local-state.ts` | `tests/capture-model-controller.test.ts`<br>`tests/capture-store.test.ts`<br>`tests/capture.test.ts` |
| `wholeSeconds` | function | 208 | `export function wholeSeconds(ms: number): number` | `core/capture-state.ts`<br>`core/insert.ts`<br>`entries/capture.ts`<br>`entries/session.ts` | — |
| `freshCaptureId` | function | 213 | `export function freshCaptureId(): string` | `entries/engine.ts` | — |
| `captureInstantAt` | function | 226 | `export function captureInstantAt(at: number): CaptureInstant` | `core/capture-state.ts`<br>`entries/capture-model-controller.ts`<br>`entries/capture.ts` | `tests/capture-end-to-end.test.ts`<br>`tests/capture-model-controller.test.ts`<br>`tests/capture-state.test.ts`<br>`tests/capture-store.test.ts`<br>`tests/capture.test.ts`<br>`tests/entry-plans.test.ts`<br>`tests/writer.test.ts` |
| `idleClock` | function | 237 | `export function idleClock(): DraftClock` | `core/capture-state.ts`<br>`entries/capture.ts` | — |
| `elapsedOf` | function | 242 | `export function elapsedOf(clock: DraftClock, now: number): number` | `entries/capture-model-controller.ts`<br>`entries/capture.ts` | — |
| `shownOf` | function | 248 | `export function shownOf(clock: DraftClock, now: number): number` | `entries/capture-model-controller.ts`<br>`entries/capture.ts` | — |
| `resumeClock` | function | 259 | `export function resumeClock(clock: DraftClock, at: number): DraftClock` | `core/capture-state.ts`<br>`entries/capture.ts` | — |
| `pauseClock` | function | 272 | `export function pauseClock(clock: DraftClock): DraftClock` | `core/capture-state.ts`<br>`entries/capture.ts` | — |
| `commitShown` | function | 278 | `export function commitShown(clock: DraftClock, ms: number): DraftClock` | `core/capture-state.ts`<br>`entries/capture.ts` | — |
| `proseOf` | function | 284 | `export function proseOf(index: EntryIndex, entry: Entry): string` | `entries/engine.ts` | — |
| `rootEntryOf` | function | 296 | `export function rootEntryOf(index: EntryIndex, entry: Entry): Entry` | `entries/capture-model-controller.ts`<br>`entries/capture.ts`<br>`entries/engine.ts`<br>`entries/thought-index.ts` | — |
| `thoughtRefOf` | function | 307 | `export function thoughtRefOf(index: EntryIndex, entry: Entry, path: string): ThoughtRef` | `core/reference.ts`<br>`entries/capture-model-controller.ts`<br>`entries/capture.ts`<br>`entries/engine.ts`<br>`entries/thought-index.ts` | `tests/capture.test.ts`<br>`tests/entry-plans.test.ts` |
| `resolveThought` | function | 328 | `export function resolveThought(index: EntryIndex, ref: ThoughtRef): Entry \| null` | `core/insert.ts`<br>`entries/capture-model-controller.ts`<br>`entries/capture.ts`<br>`entries/engine.ts`<br>`entries/thought-index.ts` | `tests/capture.test.ts` |
| `excerptOf` | function | 338 | `export function excerptOf(prose: string, words = 6): string` | — | — |
| `ThreadNode` | interface | 350 | `export interface ThreadNode` | — | — |
| `ThreadView` | interface | 373 | `export interface ThreadView` | — | — |
| `ThreadMove` | type | 384 | `export type ThreadMove = "previous" \| "next" \| "parent" \| "child"` | — | — |
| `threadViewOf` | function | 393 | `export function threadViewOf( index: EntryIndex, path: string, target: ThoughtRef \| null ): ThreadView \| null` | — | — |
| `moveThreadSelection` | function | 461 | `export function moveThreadSelection(view: ThreadView, direction: ThreadMove): ThoughtRef \| null` | — | — |
| `branchLabel` | function | 484 | `export function branchLabel(parent: ThoughtRef): string` | — | `tests/capture.test.ts` |
| `openingLabel` | function | 491 | `export function openingLabel(portal: PortalInstant): string` | — | — |

#### `src/core/clock.ts`

Pads a clock component to two digits.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `pad2` | function | 2 | `export function pad2(value: number): string` | `core/alignments.ts`<br>`core/capture.ts`<br>`core/day.ts`<br>`core/insert.ts`<br>`core/portal-history.ts`<br>`core/portals.ts`<br>`ui/invitation.ts` | `tests/clock.test.ts` |
| `formatClock` | function | 11 | `export function formatClock(date: Date): string` | `core/capture.ts`<br>`core/close.ts`<br>`core/day-stats.ts`<br>`core/duration.ts`<br>`core/insert.ts`<br>`editor/duration-ticker.ts`<br>`editor/stopwatch-widget.ts`<br>`main.ts`<br>`reading/entry-processor.ts`<br>`ui/loom.ts` | `tests/clock.test.ts`<br>`tests/duration.test.ts`<br>`tests/entry-plans.test.ts` |

#### `src/core/close.ts`

Closing the day.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `CLOSE_MARK` | const | 15 | `export const CLOSE_MARK = /^✓\s+(\d` | `editor/close-decorations.ts`<br>`reading/close-processor.ts` | — |
| `CloseScan` | interface | 18 | `export interface CloseScan` | — | — |
| `parseClose` | function | 26 | `export function parseClose(source: string): CloseScan` | `main.ts` | `tests/close.test.ts`<br>`tests/record-format.test.ts` |
| `closeLine` | function | 48 | `export function closeLine(time: string): string` | — | `tests/close.test.ts` |
| `planCloseDay` | function | 53 | `export function planCloseDay(source: string, now: Date): InsertPlan \| null` | `main.ts` | `tests/close.test.ts` |

#### `src/core/color.ts`

Colour is a pure function of the dimension number.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `ANCHORS` | const | 15 | `export const ANCHORS = [ "#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7" ] as const` | `ui/css.ts` | `tests/color.test.ts` |
| `srgbToLinear` | function | 30 | `export function srgbToLinear(channel: number): number` | — | — |
| `linearToSrgb` | function | 35 | `export function linearToSrgb(channel: number): number` | — | — |
| `hexToOklab` | function | 44 | `export function hexToOklab(hex: string): [number, number, number]` | — | `tests/color.test.ts` |
| `oklabToHex` | function | 71 | `export function oklabToHex(L: number, a: number, b: number): string` | — | `tests/color.test.ts` |
| `dimensionColor` | function | 108 | `export function dimensionColor(d: number): string` | `editor/entry-decorations.ts`<br>`editor/entry-frame.ts`<br>`ui/loom.ts` | `tests/color.test.ts` |
| `dimensionColorVars` | function | 119 | `export function dimensionColorVars(d: number): string` | `editor/entry-decorations.ts`<br>`reading/entry-processor.ts`<br>`ui/loom.ts` | `tests/color.test.ts` |

#### `src/core/contexts.ts`

The destinations Weaver may weave into, and the way back from a path.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `MAIN_CONTEXT_ID` | const | 28 | `export const MAIN_CONTEXT_ID = "main"` | `entries/capture-model-controller.ts`<br>`entries/capture.ts`<br>`entries/engine.ts`<br>`main.ts` | — |
| `MAIN_CONTEXT_NAME` | const | 31 | `export const MAIN_CONTEXT_NAME = "Main"` | — | — |
| `WeavingContext` | interface | 34 | `export interface WeavingContext` | `core/reference.ts`<br>`editor/entry-decorations.ts`<br>`entries/capture-model-controller.ts`<br>`entries/capture.ts`<br>`entries/context-workspaces.ts`<br>`entries/day-note.ts`<br>`entries/thought-index.ts`<br>`main.ts`<br>`reading/entry-processor.ts`<br>`ui/loom.ts` | `tests/capture.test.ts`<br>`tests/context-workspaces.test.ts`<br>`tests/contexts.test.ts`<br>`tests/loom.test.ts`<br>`tests/thought-index.test.ts` |
| `ContextDay` | interface | 46 | `export interface ContextDay` | — | — |
| `ContextError` | interface | 55 | `export interface ContextError` | `entries/day-note.ts`<br>`settings-tab.ts` | — |
| `ContextRow` | interface | 62 | `export interface ContextRow` | — | — |
| `ContextRead` | interface | 69 | `export interface ContextRead` | — | — |
| `DayTemplate` | interface | 77 | `export interface DayTemplate` | — | — |
| `DayToken` | type | 89 | `export type DayToken = "YYYY" \| "MM" \| "DD"` | — | — |
| `parseDayTemplate` | function | 139 | `export function parseDayTemplate( folder: string, format: string ):` | — | `tests/contexts.test.ts` |
| `templateNamesADay` | function | 173 | `export function templateNamesADay(template: DayTemplate): boolean` | — | — |
| `contextDayForPath` | function | 238 | `export function contextDayForPath( path: string, contexts: readonly WeavingContext[] ): ContextDay \| null` | `core/reference.ts`<br>`entries/capture-model-controller.ts`<br>`entries/capture.ts`<br>`entries/engine.ts` | `tests/contexts.test.ts` |
| `contextDayPath` | function | 267 | `export function contextDayPath(context: WeavingContext, day: string): string` | `entries/context-workspaces.ts`<br>`entries/day-note.ts`<br>`ui/loom.ts` | `tests/contexts.test.ts` |
| `mainContext` | function | 272 | `export function mainContext(options: DayNoteOptions): WeavingContext` | — | `tests/capture.test.ts`<br>`tests/context-workspaces.test.ts`<br>`tests/contexts.test.ts`<br>`tests/loom.test.ts` |
| `effectiveContexts` | function | 277 | `export function effectiveContexts( options: DayNoteOptions, additional: readonly WeavingContext[] ): WeavingContext[]` | `entries/day-note.ts` | `tests/contexts.test.ts` |
| `contextById` | function | 291 | `export function contextById( contexts: readonly WeavingContext[], id: string ): WeavingContext \| null` | `entries/day-note.ts` | — |
| `freshContextId` | function | 299 | `export function freshContextId(): string` | `settings-tab.ts` | — |
| `readContexts` | function | 361 | `export function readContexts(value: unknown, main?: DayNoteOptions): ContextRead` | `entries/day-note.ts`<br>`settings-tab.ts`<br>`settings.ts` | `tests/contexts.test.ts` |
| `contextDraftError` | function | 422 | `export function contextDraftError(folder: string, format: string): string \| null` | `settings-tab.ts` | `tests/contexts.test.ts` |
| `sourceDayOf` | function | 439 | `export function sourceDayOf(path: string, contexts: readonly WeavingContext[]): string \| null` | `main.ts` | `tests/contexts.test.ts` |
| `entryDayLinkTarget` | function | 459 | `export function entryDayLinkTarget( day: string \| null, sourcePath: string, contexts: readonly WeavingContext[] ): string \| null` | `editor/entry-decorations.ts`<br>`reading/entry-processor.ts` | `tests/contexts.test.ts` |

#### `src/core/day-stats.ts`

The day's own numbers, and the frontmatter that carries them.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `DayStats` | interface | 14 | `export interface DayStats` | — | — |
| `countDay` | function | 22 | `export function countDay(index: EntryIndex, closedAt: string \| null): DayStats` | — | `tests/day-stats.test.ts` |
| `applyDayStats` | function | 36 | `export function applyDayStats( source: string, stats: DayStats, day: string \| null ):` | `main.ts` | `tests/day-stats.test.ts`<br>`tests/record-format.test.ts` |
| `recountDay` | function | 87 | `export function recountDay(source: string, closedAt: string \| null): DayStats` | `main.ts` | `tests/day-stats.test.ts`<br>`tests/record-format.test.ts` |

#### `src/core/day.ts`

The day's name, and nothing else.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `DayNoteOptions` | interface | 18 | `export interface DayNoteOptions` | `core/contexts.ts`<br>`entries/day-note.ts` | — |
| `dayKey` | function | 24 | `export function dayKey(now: Date): string` | `core/capture.ts`<br>`core/insert.ts`<br>`core/portals.ts`<br>`entries/context-workspaces.ts`<br>`entries/engine.ts`<br>`main.ts`<br>`ui/loom.ts` | `tests/day-note.test.ts`<br>`tests/entry-plans.test.ts` |
| `dayNotePathFor` | function | 36 | `export function dayNotePathFor(day: string, options: DayNoteOptions): string` | `core/contexts.ts` | `tests/day-note.test.ts` |
| `dayNotePath` | function | 46 | `export function dayNotePath(now: Date, options: DayNoteOptions): string` | — | `tests/day-note.test.ts`<br>`tests/start-entry.test.ts` |
| `dayKeyFromName` | function | 54 | `export function dayKeyFromName(basename: string): string \| null` | `core/contexts.ts`<br>`core/reference.ts`<br>`entries/engine.ts` | `tests/day-note.test.ts` |
| `dayFrontmatter` | function | 61 | `export function dayFrontmatter(day: string): string` | `entries/day-note.ts` | `tests/day-note.test.ts` |

#### `src/core/document.ts`

The line-level facts every parser in Weaver shares: where each line starts,

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `CodeFence` | interface | 9 | `export interface CodeFence` | `core/entries.ts` | — |
| `FenceScan` | interface | 18 | `export interface FenceScan` | — | — |
| `lineStartsOf` | function | 30 | `export function lineStartsOf(source: string): number[]` | `core/entries.ts`<br>`core/insert.ts` | — |
| `FrontmatterScan` | interface | 42 | `export interface FrontmatterScan` | — | — |
| `scanFrontmatter` | function | 48 | `export function scanFrontmatter(lines: readonly string[]): FrontmatterScan` | `core/alignments.ts`<br>`core/close.ts`<br>`core/day-stats.ts`<br>`core/entries.ts` | — |
| `scanFences` | function | 61 | `export function scanFences(lines: readonly string[]): FenceScan` | `core/close.ts`<br>`core/entries.ts` | — |

#### `src/core/duration.ts`

The clock row of an entry, and the clocks it is written with.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `DurationSigil` | type | 30 | `export type DurationSigil = "+" \| "-" \| "="` | `core/entries.ts`<br>`core/insert.ts`<br>`editor/stopwatch-widget.ts`<br>`entries/engine.ts` | — |
| `formatClock` | function | 36 | `export function formatClock(ms: number): string` | `core/capture.ts`<br>`core/clock.ts`<br>`core/close.ts`<br>`core/day-stats.ts`<br>`core/insert.ts`<br>`editor/duration-ticker.ts`<br>`editor/stopwatch-widget.ts`<br>`main.ts`<br>`reading/entry-processor.ts`<br>`ui/loom.ts` | `tests/clock.test.ts`<br>`tests/duration.test.ts`<br>`tests/entry-plans.test.ts` |
| `formatDurationLine` | function | 41 | `export function formatDurationLine(sigil: DurationSigil, ms: number): string` | `core/insert.ts` | — |
| `ClockRow` | interface | 56 | `export interface ClockRow` | `reading/entry-processor.ts` | — |
| `parseClockRow` | function | 98 | `export function parseClockRow(text: string): ClockRow \| null` | `core/entries.ts`<br>`core/insert.ts`<br>`reading/entry-processor.ts` | `tests/duration.test.ts` |
| `formatClockRow` | function | 146 | `export function formatClockRow( time: string \| null, sigil: DurationSigil, ms: number, day: string \| null ): string` | `core/insert.ts` | `tests/duration.test.ts` |

#### `src/core/entries.ts`

The entry: the unit a day note is made of.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `Entry` | interface | 36 | `export interface Entry` | `core/capture.ts`<br>`core/insert.ts`<br>`core/portal-history.ts`<br>`core/reference.ts`<br>`editor/entry-decorations.ts`<br>`editor/entry-keys.ts`<br>`entries/capture-model-controller.ts`<br>`entries/engine.ts`<br>`entries/thought-index.ts`<br>`settings-tab.ts` | `tests/settings-tab.test.ts` |
| `EntryIndex` | interface | 85 | `export interface EntryIndex` | `core/capture.ts`<br>`core/day-stats.ts`<br>`core/insert.ts`<br>`core/portal-history.ts`<br>`core/reference.ts`<br>`editor/entry-field.ts`<br>`editor/entry-keys.ts`<br>`entries/capture-model-controller.ts`<br>`entries/capture.ts`<br>`entries/engine.ts`<br>`entries/thought-index.ts` | `tests/capture.test.ts` |
| `AddressPrefix` | interface | 113 | `export interface AddressPrefix` | — | — |
| `parseAddressPrefix` | function | 128 | `export function parseAddressPrefix(text: string): AddressPrefix \| null` | `reading/entry-processor.ts` | — |
| `parseEntries` | function | 166 | `export function parseEntries(source: string): EntryIndex` | `core/close.ts`<br>`core/day-stats.ts`<br>`core/insert.ts`<br>`core/portal-history.ts`<br>`editor/entry-field.ts`<br>`editor/entry-keys.ts`<br>`entries/capture-model-controller.ts`<br>`entries/capture.ts`<br>`entries/engine.ts`<br>`entries/thought-index.ts`<br>`main.ts`<br>`reading/entry-processor.ts` | `tests/capture-end-to-end.test.ts`<br>`tests/capture.test.ts`<br>`tests/color.test.ts`<br>`tests/day-stats.test.ts`<br>`tests/entries.test.ts`<br>`tests/entry-keys.test.ts`<br>`tests/entry-plans.test.ts`<br>`tests/portal-history.test.ts`<br>`tests/record-format.test.ts`<br>`tests/reference.test.ts`<br>`tests/start-entry.test.ts`<br>`tests/stopped-clock-render.test.ts`<br>`tests/whisper-act.test.ts`<br>`tests/whisper.test.ts`<br>`tests/writer.test.ts` |
| `findEntryAtLine` | function | 344 | `export function findEntryAtLine(index: EntryIndex, line: number): Entry \| null` | — | `tests/entries.test.ts` |
| `findEntryAtOffset` | function | 353 | `export function findEntryAtOffset(index: EntryIndex, offset: number): Entry \| null` | `editor/entry-keys.ts`<br>`entries/engine.ts` | `tests/entries.test.ts` |
| `findCurrentEntry` | function | 361 | `export function findCurrentEntry(index: EntryIndex, line: number): Entry \| null` | — | `tests/entries.test.ts` |
| `entryBySeq` | function | 371 | `export function entryBySeq(index: EntryIndex, n: number): Entry \| null` | `core/insert.ts`<br>`core/portal-history.ts`<br>`editor/entry-keys.ts`<br>`entries/engine.ts`<br>`main.ts` | `tests/entries.test.ts` |
| `childrenOf` | function | 379 | `export function childrenOf(index: EntryIndex, entry: Entry \| null): Entry[]` | `core/insert.ts` | `tests/entries.test.ts` |
| `endOfSubtree` | function | 385 | `export function endOfSubtree(index: EntryIndex, entry: Entry): number` | `core/insert.ts` | — |
| `nextSeq` | function | 390 | `export function nextSeq(index: EntryIndex): number` | `core/insert.ts` | `tests/entries.test.ts` |
| `nextBranch` | function | 395 | `export function nextBranch(index: EntryIndex): number` | `core/insert.ts` | `tests/entries.test.ts` |
| `formatAddress` | function | 400 | `export function formatAddress(b: number, d: number, n: number): string` | `core/capture.ts`<br>`core/insert.ts`<br>`entries/engine.ts`<br>`ui/loom.ts` | `tests/entries.test.ts` |
| `repairBranches` | function | 411 | `export function repairBranches(index: EntryIndex): TextChange[]` | `core/insert.ts` | `tests/entries.test.ts` |

#### `src/core/frame.ts`

The frame around one entry: a box, and nothing else.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `frameLabelInset` | function | 25 | `export function frameLabelInset(fontSize: number): number` | `editor/entry-frame.ts` | — |
| `FrameColumn` | interface | 30 | `export interface FrameColumn` | — | `tests/frame.test.ts` |
| `FrameColumnInput` | interface | 36 | `export interface FrameColumnInput` | — | — |
| `frameColumn` | function | 55 | `export function frameColumn(input: FrameColumnInput): FrameColumn` | `editor/entry-frame.ts` | `tests/frame.test.ts` |
| `FrameBoxInput` | interface | 63 | `export interface FrameBoxInput` | — | — |
| `FrameBox` | interface | 72 | `export interface FrameBox` | — | — |
| `frameBox` | function | 85 | `export function frameBox(input: FrameBoxInput): FrameBox` | `editor/entry-frame.ts` | `tests/frame.test.ts` |
| `ComposerBox` | interface | 92 | `export interface ComposerBox` | — | — |
| `ComposerBoxInput` | interface | 103 | `export interface ComposerBoxInput` | — | — |
| `composerHeightShare` | function | 123 | `export function composerHeightShare(phone: boolean): number` | — | — |
| `floatingComposerBox` | function | 148 | `export function floatingComposerBox(input: ComposerBoxInput): ComposerBox` | — | `tests/frame.test.ts` |
| `FrameSpanInput` | interface | 194 | `export interface FrameSpanInput` | — | — |
| `FrameSpan` | interface | 206 | `export interface FrameSpan` | — | `tests/frame.test.ts` |
| `frameSpan` | function | 227 | `export function frameSpan(input: FrameSpanInput): FrameSpan` | `editor/entry-frame.ts` | `tests/frame.test.ts` |
| `LoomViewport` | interface | 235 | `export interface LoomViewport` | `ui/loom.ts` | — |
| `LoomBoxInput` | interface | 243 | `export interface LoomBoxInput` | — | — |
| `LoomBox` | interface | 263 | `export interface LoomBox` | — | — |
| `loomWidth` | function | 276 | `export function loomWidth(viewportWidth: number):` | — | `tests/frame.test.ts` |
| `LoomAnchor` | interface | 285 | `export interface LoomAnchor` | `ui/loom.ts` | — |
| `loomAnchor` | function | 300 | `export function loomAnchor( viewport: LoomViewport, toolbar: LoomViewport \| null ): LoomAnchor` | `ui/loom.ts` | `tests/frame.test.ts` |
| `loomLayout` | function | 330 | `export function loomLayout(input: LoomBoxInput): LoomBox` | — | `tests/frame.test.ts` |
| `revealScrollDelta` | function | 364 | `export function revealScrollDelta(top: number, bottom: number, targetTop: number, targetBottom: number): number` | `ui/loom.ts` | `tests/frame.test.ts` |

#### `src/core/insert.ts`

The plans that write entry text, and the arithmetic every plan shares.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `TextChange` | interface | 41 | `export interface TextChange` | `core/entries.ts`<br>`entries/engine.ts`<br>`entries/writer.ts` | — |
| `InsertPlan` | interface | 48 | `export interface InsertPlan` | `core/close.ts`<br>`entries/engine.ts`<br>`entries/writer.ts` | `tests/entry-plans.test.ts` |
| `planAppendLine` | function | 72 | `export function planAppendLine(source: string, text: string, caret: number = text.length): InsertPlan` | `core/close.ts` | — |
| `planChildEntry` | function | 112 | `export function planChildEntry( _source: string, index: EntryIndex, parent: Entry ): InsertPlan \| null` | `entries/engine.ts` | `tests/entry-plans.test.ts` |
| `planEntryBeginning` | function | 178 | `export function planEntryBeginning( _source: string, index: EntryIndex, entry: Entry, beganAt: Date ): InsertPlan \| null` | — | `tests/entry-plans.test.ts` |
| `planCaptureEntry` | function | 255 | `export function planCaptureEntry( source: string, index: EntryIndex, request: CaptureRequest ): InsertPlan \| null` | `entries/engine.ts` | `tests/entry-plans.test.ts`<br>`tests/writer.test.ts` |
| `planDeleteEntry` | function | 356 | `export function planDeleteEntry( source: string, index: EntryIndex, entry: Entry ): InsertPlan \| null` | `entries/engine.ts` | `tests/entry-plans.test.ts` |
| `planDuration` | function | 419 | `export function planDuration( _source: string, index: EntryIndex, entry: Entry, sigil: DurationSigil, ms: number ): InsertPlan \| null` | `entries/engine.ts` | `tests/entry-plans.test.ts`<br>`tests/writer.test.ts` |
| `planSettleEntry` | function | 456 | `export function planSettleEntry( _source: string, index: EntryIndex, entry: Entry, ms: number, publishedAt: Date ): InsertPlan \| null` | `entries/engine.ts` | `tests/entry-plans.test.ts` |
| `planWhisper` | function | 500 | `export function planWhisper( _source: string, index: EntryIndex, entry: Entry, whisper: readonly WhisperItem[] ): InsertPlan \| null` | `entries/engine.ts` | `tests/entry-plans.test.ts` |
| `planThread` | function | 529 | `export function planThread( source: string, index: EntryIndex, entry: Entry, item: WhisperItem ): InsertPlan \| null` | `entries/engine.ts` | — |
| `offsetToLineCh` | function | 552 | `export function offsetToLineCh(source: string, offset: number):` | — | — |
| `cmChanges` | function | 565 | `export function cmChanges( changes: readonly TextChange[] ):` | `entries/engine.ts`<br>`entries/writer.ts` | `tests/entry-plans.test.ts` |
| `applyPlanToSource` | function | 572 | `export function applyPlanToSource(source: string, plan: InsertPlan):` | `entries/engine.ts`<br>`entries/writer.ts`<br>`main.ts` | `tests/close.test.ts`<br>`tests/entry-plans.test.ts` |

#### `src/core/loom.ts`

The Loom's own state: whether it is showing, what its upper half holds, which

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `UpperPanel` | type | 24 | `export type UpperPanel = \| "reference" \| "tapestries" \| "reviews" \| "review-form" \| "ancestry" \| "invitations"` | — | — |
| `FrontLayer` | type | 37 | `export type FrontLayer = \|` | — | — |
| `ExpandedContent` | type | 58 | `export type ExpandedContent = \|` | — | — |
| `LoomSurface` | type | 73 | `export type LoomSurface = \|` | — | — |
| `FocusIntent` | interface | 79 | `export interface FocusIntent` | `entries/loom.ts` | — |
| `TapestryActivity` | interface | 87 | `export interface TapestryActivity` | `entries/loom.ts` | — |
| `ReviewSetup` | interface | 98 | `export interface ReviewSetup` | — | `tests/loom-surface.test.ts` |
| `LoomModel` | interface | 111 | `export interface LoomModel` | `entries/loom.ts` | `tests/loom-controller.test.ts`<br>`tests/loom-surface.test.ts` |
| `LoomTransition` | interface | 122 | `export interface LoomTransition` | — | — |
| `LoomAction` | type | 136 | `export type LoomAction = \|` | `entries/loom.ts` | `tests/loom-surface.test.ts` |
| `initialLoomModel` | function | 164 | `export function initialLoomModel(): LoomModel` | `entries/loom.ts` | `tests/loom-controller.test.ts`<br>`tests/loom-surface.test.ts` |
| `reduceLoom` | function | 209 | `export function reduceLoom(model: LoomModel, action: LoomAction): LoomTransition` | `entries/loom.ts` | `tests/loom-surface.test.ts` |

#### `src/core/navigation.ts`

Where you have been: a real history, with a cursor, not a stack that eats itself.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `NoteStop` | interface | 27 | `export interface NoteStop` | `entries/engine.ts` | `tests/navigation.test.ts` |
| `WorkspaceStop` | interface | 53 | `export interface WorkspaceStop` | — | `tests/navigation.test.ts` |
| `Stop` | type | 66 | `export type Stop = NoteStop \| WorkspaceStop` | `main.ts` | `tests/navigation.test.ts` |
| `NavigationHistory` | interface | 69 | `export interface NavigationHistory` | `main.ts` | `tests/navigation.test.ts` |
| `HISTORY_LIMIT` | const | 76 | `export const HISTORY_LIMIT = 64` | — | `tests/navigation.test.ts` |
| `initialHistory` | function | 79 | `export function initialHistory(): NavigationHistory` | `main.ts` | `tests/navigation.test.ts` |
| `record` | function | 91 | `export function record(history: NavigationHistory, stop: Stop, limit = HISTORY_LIMIT): NavigationHistory` | `core/alignments.ts`<br>`core/capture.ts`<br>`core/insert.ts`<br>`core/portal-history.ts`<br>`core/portals.ts`<br>`core/reference.ts`<br>`core/reviews.ts`<br>`core/whisper.ts`<br>`editor/entry-decorations.ts`<br>`editor/entry-keys.ts`<br>`editor/stopwatch-widget.ts`<br>`entries/capture-store.ts`<br>`entries/capture.ts`<br>`entries/context-workspaces.ts`<br>`entries/engine.ts`<br>`entries/local-state.ts`<br>`entries/loom.ts`<br>`entries/plugin-data.ts`<br>`entries/portals.ts`<br>`entries/reference.ts`<br>`entries/thought-index.ts`<br>`main.ts`<br>`model/whisper-model.ts`<br>`reading/close-processor.ts`<br>`ui/loom.ts` | `tests/alignments.test.ts`<br>`tests/capture-model-controller.test.ts`<br>`tests/capture-store.test.ts`<br>`tests/capture.test.ts`<br>`tests/context-workspaces.test.ts`<br>`tests/day-stats.test.ts`<br>`tests/duration.test.ts`<br>`tests/entry-keys.test.ts`<br>`tests/entry-plans.test.ts`<br>`tests/local-state.test.ts`<br>`tests/loom.test.ts`<br>`tests/navigation.test.ts`<br>`tests/portal-controller.test.ts`<br>`tests/portal-history.test.ts`<br>`tests/portals.test.ts`<br>`tests/record-format.test.ts`<br>`tests/reference-controller.test.ts`<br>`tests/reference.test.ts`<br>`tests/reviews.test.ts`<br>`tests/thought-index.test.ts`<br>`tests/writer.test.ts` |
| `back` | function | 108 | `export function back(history: NavigationHistory):` | `core/capture-state.ts`<br>`core/capture.ts`<br>`core/color.ts`<br>`core/contexts.ts`<br>`core/day.ts`<br>`core/duration.ts`<br>`core/entries.ts`<br>`core/frame.ts`<br>`core/insert.ts`<br>`core/loom.ts`<br>`core/portals.ts`<br>`core/whisper.ts`<br>`editor/entry-decorations.ts`<br>`editor/entry-frame.ts`<br>`entries/capture-model-controller.ts`<br>`entries/capture-store.ts`<br>`entries/capture.ts`<br>`entries/context-workspaces.ts`<br>`entries/day-note.ts`<br>`entries/engine.ts`<br>`entries/reference.ts`<br>`entries/writer.ts`<br>`main.ts`<br>`model/whisper-runner.ts`<br>`notices.ts`<br>`settings.ts`<br>`ui/loom.ts`<br>`ui/markdown-pane.ts` | `tests/capture-store.test.ts`<br>`tests/context-workspaces.test.ts`<br>`tests/contexts.test.ts`<br>`tests/day-note.test.ts`<br>`tests/entry-decorations.test.ts`<br>`tests/loom-surface.test.ts`<br>`tests/navigation.test.ts`<br>`tests/plugin.test.ts`<br>`tests/reference-controller.test.ts`<br>`tests/settings.test.ts`<br>`tests/thought-index.test.ts`<br>`tests/whisper-act.test.ts`<br>`tests/writer.test.ts` |
| `forward` | function | 115 | `export function forward(history: NavigationHistory):` | `core/capture-state.ts`<br>`entries/loom.ts`<br>`main.ts`<br>`notices.ts` | `tests/navigation.test.ts`<br>`tests/plugin.test.ts` |
| `canGoBack` | function | 124 | `export function canGoBack(history: NavigationHistory): boolean` | `main.ts` | `tests/navigation.test.ts` |
| `canGoForward` | function | 129 | `export function canGoForward(history: NavigationHistory): boolean` | `main.ts` | `tests/navigation.test.ts` |
| `sameStop` | function | 140 | `export function sameStop(left: Stop, right: Stop): boolean` | — | `tests/navigation.test.ts` |

#### `src/core/portal-history.ts`

The day's portal history, as rows a surface can list.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `RecordedPortalHistoryRow` | interface | 108 | `export interface RecordedPortalHistoryRow` | — | — |
| `PortalHistoryRow` | type | 121 | `export type PortalHistoryRow = RecordedPortalHistoryRow` | — | `tests/portal-history.test.ts` |
| `PortalHistory` | type | 124 | `export type PortalHistory = \|` | — | — |
| `linkedPortalEntry` | function | 137 | `export function linkedPortalEntry(record: AlignmentRecord, index: EntryIndex): Entry \| null` | — | `tests/portal-history.test.ts` |
| `portalHistoryRows` | function | 160 | `export function portalHistoryRows(source: string): PortalHistory` | — | `tests/portal-history.test.ts` |

#### `src/core/portals.ts`

Invitations: when Weaver may offer to weave, and which offer is outstanding.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `PortalInstant` | interface | 29 | `export interface PortalInstant` | `core/capture-state.ts`<br>`core/capture.ts`<br>`core/insert.ts`<br>`core/portal-history.ts`<br>`entries/capture-store.ts`<br>`entries/local-state.ts`<br>`entries/portals.ts` | `tests/entry-plans.test.ts` |
| `AlignmentKind` | type | 39 | `export type AlignmentKind = "boundary" \| "hour-echo" \| "minute-echo"` | `core/portal-history.ts` | — |
| `RHYTHM_SCHEDULE_ID` | const | 42 | `export const RHYTHM_SCHEDULE_ID = "rhythm"` | `entries/portals.ts` | — |
| `DEFAULT_LEAD_MINUTES` | const | 45 | `export const DEFAULT_LEAD_MINUTES = 11` | `entries/portals.ts` | — |
| `PortalWhen` | type | 54 | `export type PortalWhen = /** Every hour at `minute`, on the device's current local wall clock. */ \|` | — | — |
| `PortalSchedule` | interface | 63 | `export interface PortalSchedule` | `entries/portals.ts` | `tests/portal-controller.test.ts`<br>`tests/portals.test.ts` |
| `PortalSource` | interface | 84 | `export interface PortalSource` | `entries/portals.ts` | `tests/portals.test.ts` |
| `PortalOccurrence` | interface | 96 | `export interface PortalOccurrence` | `entries/portals.ts`<br>`ui/invitation.ts` | — |
| `PortalPhase` | type | 106 | `export type PortalPhase = "approaching" \| "available" \| "expired"` | `entries/portals.ts` | — |
| `OPENING_WINDOW_MS` | const | 109 | `export const OPENING_WINDOW_MS = 60_000` | `entries/portals.ts` | — |
| `PortalScheduleError` | interface | 112 | `export interface PortalScheduleError` | — | — |
| `PortalScheduleRead` | interface | 118 | `export interface PortalScheduleRead` | — | — |
| `portalAt` | function | 160 | `export function portalAt(opensAt: number): PortalInstant` | — | `tests/entry-plans.test.ts`<br>`tests/portals.test.ts`<br>`tests/writer.test.ts` |
| `occurrencesBetween` | function | 205 | `export function occurrencesBetween( when: PortalWhen, from: number, to: number ): PortalInstant[]` | — | `tests/portals.test.ts` |
| `rhythmOccurrences` | function | 246 | `export function rhythmOccurrences(from: number, to: number): PortalInstant[]` | — | `tests/portals.test.ts` |
| `portalTime` | function | 265 | `export function portalTime(portal: PortalInstant): string` | `main.ts` | — |
| `portalContainsBeginning` | function | 278 | `export function portalContainsBeginning(portal: PortalInstant, beganAt: number): boolean` | `core/insert.ts`<br>`entries/local-state.ts`<br>`entries/portals.ts` | `tests/portals.test.ts` |
| `portalPhase` | function | 291 | `export function portalPhase(portal: PortalInstant, now: number): PortalPhase` | `entries/portals.ts` | `tests/portals.test.ts` |
| `portalAlignments` | function | 297 | `export function portalAlignments(portal: PortalInstant, beganAt: number): readonly AlignmentKind[]` | `core/portal-history.ts`<br>`main.ts` | `tests/portals.test.ts` |
| `sourceOccurrences` | function | 318 | `export function sourceOccurrences(source: PortalSource, from: number, to: number): PortalInstant[]` | `entries/portals.ts` | `tests/portals.test.ts` |
| `dueOpening` | function | 335 | `export function dueOpening( source: PortalSource, now: number, activatedAt: number, acknowledgedThrough: number \| null ): PortalInstant \| null` | `entries/portals.ts` | `tests/portals.test.ts` |
| `nextOpening` | function | 352 | `export function nextOpening(source: PortalSource, now: number): PortalInstant \| null` | `entries/portals.ts` | `tests/portals.test.ts` |
| `scheduleKey` | function | 359 | `export function scheduleKey(schedule: PortalSchedule): string` | — | — |
| `readPortalSchedules` | function | 483 | `export function readPortalSchedules(value: unknown): PortalScheduleRead` | `main.ts`<br>`settings-tab.ts` | `tests/portals.test.ts` |

#### `src/core/reference.ts`

Reading a note's thoughts: the values a reference is drawn from and walked by.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `ReferenceScope` | type | 27 | `export type ReferenceScope = \|` | `core/reviews.ts` | — |
| `ReadingOrder` | type | 43 | `export type ReadingOrder = "time" \| "connections"` | `core/reviews.ts` | — |
| `SearchQuery` | type | 52 | `export type SearchQuery = \|` | — | — |
| `ReferenceQuery` | interface | 58 | `export interface ReferenceQuery` | `core/reviews.ts`<br>`entries/reference.ts`<br>`entries/thought-index.ts` | `tests/reference-controller.test.ts`<br>`tests/thought-index.test.ts` |
| `ReferenceStop` | interface | 65 | `export interface ReferenceStop` | `entries/reference.ts` | — |
| `ThoughtSnapshot` | interface | 79 | `export interface ThoughtSnapshot` | `core/capture-state.ts`<br>`entries/reference.ts`<br>`entries/thought-index.ts` | `tests/capture-model-controller.test.ts`<br>`tests/capture-state.test.ts`<br>`tests/reference-controller.test.ts` |
| `ThoughtSnapshotResult` | type | 92 | `export type ThoughtSnapshotResult = \|` | `entries/thought-index.ts`<br>`ui/loom.ts` | — |
| `ReferenceReadError` | interface | 97 | `export interface ReferenceReadError` | `entries/reference.ts`<br>`entries/thought-index.ts` | — |
| `ThoughtRecord` | interface | 106 | `export interface ThoughtRecord` | `entries/reference.ts`<br>`entries/thought-index.ts` | `tests/reference-controller.test.ts`<br>`tests/reference.test.ts` |
| `ReferenceSequence` | interface | 129 | `export interface ReferenceSequence` | `entries/reference.ts`<br>`entries/thought-index.ts` | `tests/reference-controller.test.ts` |
| `ReferenceMove` | type | 135 | `export type ReferenceMove = "previous" \| "next" \| "parent" \| "child" \| "first" \| "last"` | `entries/reference.ts` | — |
| `recognisePath` | function | 138 | `export function recognisePath( path: string, contexts: readonly WeavingContext[] ):` | `entries/thought-index.ts` | `tests/thought-index.test.ts` |
| `thoughtRecordOf` | function | 151 | `export function thoughtRecordOf( index: EntryIndex, entry: Entry, path: string, tapestryId: string \| null, noteDay: string ): ThoughtRecord` | `entries/thought-index.ts` | `tests/reference.test.ts` |
| `recordInScope` | function | 175 | `export function recordInScope(record: ThoughtRecord, scope: ReferenceScope): boolean` | `entries/thought-index.ts` | `tests/reference.test.ts` |
| `searchQueryOf` | function | 189 | `export function searchQueryOf(text: string): SearchQuery` | `entries/reference.ts` | `tests/reference.test.ts` |
| `recordMatches` | function | 214 | `export function recordMatches(record: ThoughtRecord, search: SearchQuery): boolean` | `entries/thought-index.ts` | `tests/reference.test.ts` |
| `compareThoughtTime` | function | 236 | `export function compareThoughtTime(left: ThoughtRecord, right: ThoughtRecord): number` | — | `tests/reference.test.ts` |
| `orderRecords` | function | 260 | `export function orderRecords( records: readonly ThoughtRecord[], order: ReadingOrder ): ThoughtRecord[]` | `entries/thought-index.ts` | `tests/reference.test.ts` |
| `firstRecord` | function | 306 | `export function firstRecord(records: readonly ThoughtRecord[]): ThoughtRecord \| null` | `entries/reference.ts` | `tests/reference.test.ts` |
| `lastRecord` | function | 311 | `export function lastRecord(records: readonly ThoughtRecord[]): ThoughtRecord \| null` | `entries/reference.ts` | `tests/reference.test.ts` |
| `moveRecord` | function | 323 | `export function moveRecord( records: readonly ThoughtRecord[], current: ThoughtRef \| null, move: ReferenceMove ): ThoughtRecord \| null` | `entries/reference.ts` | `tests/reference.test.ts` |

#### `src/core/reviews.ts`

Reviews as shared data: a named selection of thoughts, with an independently

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `ReviewStamp` | interface | 25 | `export interface ReviewStamp` | `entries/plugin-data.ts`<br>`entries/reference.ts` | `tests/reviews.test.ts` |
| `ReviewDefinition` | interface | 32 | `export interface ReviewDefinition` | `entries/reference.ts` | `tests/plugin-data.test.ts`<br>`tests/reviews.test.ts` |
| `ReviewCursor` | interface | 46 | `export interface ReviewCursor` | `entries/plugin-data.ts`<br>`entries/reference.ts` | `tests/plugin-data.test.ts` |
| `StampedDefinition` | interface | 52 | `export interface StampedDefinition` | — | — |
| `StampedCursor` | interface | 58 | `export interface StampedCursor` | — | — |
| `ReviewRecord` | interface | 64 | `export interface ReviewRecord` | `entries/plugin-data.ts` | `tests/reviews.test.ts` |
| `ReviewMap` | type | 73 | `export type ReviewMap = Readonly<Record<string, ReviewRecord>>` | `entries/plugin-data.ts`<br>`settings.ts` | `tests/reviews.test.ts` |
| `ReviewSave` | interface | 76 | `export interface ReviewSave` | `entries/plugin-data.ts` | — |
| `compareStamps` | function | 84 | `export function compareStamps(left: ReviewStamp, right: ReviewStamp): number` | `entries/plugin-data.ts` | `tests/reviews.test.ts` |
| `advanceStamp` | function | 98 | `export function advanceStamp( observed: ReviewStamp \| null, deviceId: string, wallMs: number ): ReviewStamp` | `entries/plugin-data.ts` | `tests/reviews.test.ts` |
| `validateReviewDefinition` | function | 130 | `export function validateReviewDefinition(definition: ReviewDefinition): Readonly<Record<string, string>>` | — | `tests/reviews.test.ts` |
| `reviewScopeOf` | function | 141 | `export function reviewScopeOf(definition: ReviewDefinition): ReferenceScope` | — | `tests/reviews.test.ts` |
| `reviewQueryOf` | function | 151 | `export function reviewQueryOf(definition: ReviewDefinition): ReferenceQuery` | — | `tests/reviews.test.ts` |
| `reviewNameSuggestion` | function | 156 | `export function reviewNameSuggestion(from: string, through: string): string` | — | `tests/reviews.test.ts` |
| `mergeReviewMaps` | function | 173 | `export function mergeReviewMaps(local: ReviewMap, remote: ReviewMap): ReviewMap` | `entries/plugin-data.ts` | `tests/reviews.test.ts` |
| `liveReviews` | function | 219 | `export function liveReviews(reviews: ReviewMap): ReviewRecord[]` | — | `tests/reviews.test.ts` |
| `tombstoneOf` | function | 226 | `export function tombstoneOf(reviews: ReviewMap, id: string): ReviewStamp \| null` | — | `tests/reviews.test.ts` |
| `readReviewMap` | function | 323 | `export function readReviewMap(value: unknown):` | `entries/plugin-data.ts`<br>`settings.ts` | — |

#### `src/core/value.ts`

The one shape guard for values that arrive as `unknown`.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `isPlainObject` | function | 12 | `export function isPlainObject(value: unknown): value is Record<string, unknown>` | `core/contexts.ts`<br>`core/portals.ts`<br>`core/reviews.ts`<br>`entries/capture-store.ts`<br>`entries/local-state.ts`<br>`entries/plugin-data.ts`<br>`settings.ts` | — |

#### `src/core/whisper.ts`

The whisper: the model's reading of one entry, written as `~` rows above its

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `WhisperType` | type | 23 | `export type WhisperType = "name" \| "learn" \| "next" \| "ask" \| "thread"` | — | — |
| `WhisperItem` | interface | 26 | `export interface WhisperItem` | `core/entries.ts`<br>`core/insert.ts`<br>`entries/engine.ts`<br>`model/whisper-runner.ts` | `tests/whisper-act.test.ts`<br>`tests/whisper-runner.test.ts` |
| `WhisperInput` | interface | 32 | `export interface WhisperInput` | `entries/engine.ts`<br>`model/whisper-runner.ts` | `tests/whisper-runner.test.ts`<br>`tests/whisper.test.ts` |
| `WHISPER_GLYPH` | const | 42 | `export const WHISPER_GLYPH = "~"` | — | — |
| `WHISPER_LINE` | const | 53 | `export const WHISPER_LINE = /^[ \t]*~[ ](?:(learn\|next\|ask\|thread):[ ])?((?!(?:learn\|next\|ask\|thread):)\S.*)$/` | — | — |
| `WHISPER_MAX_LINES` | const | 56 | `export const WHISPER_MAX_LINES = 3` | `core/insert.ts` | — |
| `WHISPER_WORD_LIMITS` | const | 65 | `export const WHISPER_WORD_LIMITS: Readonly<Record<WhisperType, number>> =` | — | — |
| `WHISPER_MAX_WORDS` | const | 74 | `export const WHISPER_MAX_WORDS = 14` | — | — |
| `WHISPER_NEGATION` | const | 85 | `export const WHISPER_NEGATION = /(,\s*not\b\|\bnot just\b[^.]*\bbut\b\|\brather than\b\|\binstead of\b)/i` | — | — |
| `WHISPER_PROMPT_VERSION` | const | 89 | `export const WHISPER_PROMPT_VERSION = 5` | — | — |
| `parseWhisperLine` | function | 103 | `export function parseWhisperLine(line: string): WhisperItem \| null` | `core/entries.ts`<br>`reading/entry-processor.ts` | `tests/whisper.test.ts` |
| `formatWhisperLine` | function | 114 | `export function formatWhisperLine(item: WhisperItem): string` | `core/insert.ts` | `tests/whisper.test.ts` |
| `whisperKey` | function | 133 | `export function whisperKey(input: WhisperInput): string` | `entries/engine.ts`<br>`model/whisper-runner.ts` | `tests/whisper-act.test.ts`<br>`tests/whisper-runner.test.ts`<br>`tests/whisper.test.ts` |
| `validateWhisper` | function | 155 | `export function validateWhisper( items: readonly unknown[] \| null, input: WhisperInput ):` | `entries/engine.ts`<br>`model/whisper-runner.ts` | `tests/whisper.test.ts` |
| `WhisperDayEntry` | interface | 249 | `export interface WhisperDayEntry` | `entries/engine.ts` | — |
| `whisperThreadPrompt` | function | 286 | `export function whisperThreadPrompt( day: readonly WhisperDayEntry[], own: WhisperDayEntry ):` | `entries/engine.ts` | — |
| `validateThread` | function | 310 | `export function validateThread( items: readonly unknown[] \| null, day: readonly WhisperDayEntry[], own: WhisperDayEntry ):` | `entries/engine.ts` | — |
| `whisperPrompt` | function | 351 | `export function whisperPrompt(input: WhisperInput):` | `entries/engine.ts`<br>`model/whisper-runner.ts` | `tests/whisper.test.ts` |
| `parseWhisperResponse` | function | 379 | `export function parseWhisperResponse(text: string): unknown[] \| null` | `entries/engine.ts`<br>`model/whisper-runner.ts` | `tests/whisper.test.ts` |

#### `src/editor/close-decorations.ts`

The `✓` line, banded where it is written.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `closeDecorations` | function | 42 | `export function closeDecorations(state: EditorState): DecorationSet` | — | `tests/close-decorations.test.ts` |
| `closeDecorationsExtension` | function | 67 | `export function closeDecorationsExtension(): Extension` | `main.ts` | — |

#### `src/editor/duration-ticker.ts`

The digit writer shared by every drawn clock.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `writeClockText` | function | 12 | `export function writeClockText(digits: readonly HTMLElement[], clock: string): void` | `editor/stopwatch-widget.ts`<br>`reading/entry-processor.ts` | — |
| `writeDigits` | function | 20 | `export function writeDigits(digits: readonly HTMLElement[], ms: number): void` | `editor/stopwatch-widget.ts` | — |

#### `src/editor/editor-path.ts`

The file a live editor view is showing, or null when it is not a note.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `editorPathOf` | function | 7 | `export function editorPathOf(view: EditorView): string \| null` | `editor/entry-keys.ts`<br>`entries/engine.ts`<br>`main.ts` | — |

#### `src/editor/entry-decorations.ts`

The entry, drawn.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `entryDecorationSet` | function | 125 | `export function entryDecorationSet( state: EditorState, session: EntrySession, path: string, clock: EntryClock, contexts: readonly WeavingContext[], openDayLink?: OpenDayLink ):...` | — | `tests/entry-decorations.test.ts` |
| `entryDecorationsExtension` | function | 280 | `export function entryDecorationsExtension( getSession: () => EntrySession, getPath: () => string, getClock: () => EntryClock, getContexts: () => readonly WeavingContext[], openD...` | `main.ts` | `tests/stopped-clock-render.test.ts` |

#### `src/editor/entry-field.ts`

The entry index as editor state: one parse per document change, shared by the

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `refreshEntriesEffect` | const | 11 | `export const refreshEntriesEffect = StateEffect.define<void>()` | `editor/close-decorations.ts`<br>`editor/entry-decorations.ts`<br>`entries/engine.ts`<br>`main.ts` | `tests/entry-field.test.ts` |
| `programmaticWrite` | const | 22 | `export const programmaticWrite = Annotation.define<boolean>()` | `editor/entry-keys.ts`<br>`entries/engine.ts`<br>`entries/writer.ts`<br>`main.ts` | — |
| `InputObservation` | interface | 33 | `export interface InputObservation` | `editor/entry-keys.ts`<br>`entries/engine.ts` | — |
| `capturedInput` | const | 44 | `export const capturedInput = Annotation.define<InputObservation>()` | `editor/entry-keys.ts` | `tests/entry-keys.test.ts` |
| `entryIndexField` | const | 47 | `export const entryIndexField = StateField.define<EntryIndex>(` | `editor/close-decorations.ts`<br>`editor/entry-decorations.ts`<br>`editor/entry-frame.ts`<br>`editor/entry-keys.ts`<br>`entries/engine.ts` | `tests/close-decorations.test.ts`<br>`tests/entry-decorations.test.ts`<br>`tests/entry-field.test.ts`<br>`tests/entry-keys.test.ts`<br>`tests/plugin.test.ts`<br>`tests/start-entry.test.ts`<br>`tests/stopped-clock-render.test.ts` |
| `entryIndexExtension` | function | 59 | `export function entryIndexExtension(): Extension` | `main.ts` | — |

#### `src/editor/entry-frame.ts`

The frame around every entry, drawn.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `FrameHost` | interface | 50 | `export interface FrameHost` | — | — |
| `remeasureFrames` | function | 158 | `export function remeasureFrames(view: EditorView): void` | — | — |
| `entryFrameExtension` | function | 402 | `export function entryFrameExtension(host: FrameHost): Extension` | `main.ts` | — |

#### `src/editor/entry-keys.ts`

The two keys an entry owns, and the two edit events that keep the stopwatch

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `ENTRY_KEYS` | const | 50 | `export const ENTRY_KEYS = ["Mod-Shift-Enter", "Enter"] as const` | — | `tests/entry-keys.test.ts` |
| `EntryKeyHost` | interface | 53 | `export interface EntryKeyHost` | — | `tests/entry-keys.test.ts` |
| `EntryEditHost` | interface | 73 | `export interface EntryEditHost extends EntryKeyHost` | — | `tests/entry-keys.test.ts` |
| `enterableEntry` | function | 96 | `export function enterableEntry(view: EditorView, _host: EntryKeyHost): Entry \| null` | — | `tests/entry-keys.test.ts` |
| `handleEnterKey` | function | 104 | `export function handleEnterKey(view: EditorView, host: EntryKeyHost): boolean` | — | `tests/entry-keys.test.ts` |
| `handleStartKey` | function | 120 | `export function handleStartKey(view: EditorView, host: EntryKeyHost): boolean` | — | `tests/entry-keys.test.ts` |
| `shouldPinStopwatch` | function | 130 | `export function shouldPinStopwatch(input:` | — | `tests/entry-keys.test.ts` |
| `maybePinStopwatch` | function | 140 | `export function maybePinStopwatch(view: EditorView, host: EntryEditHost, phone = isPhone()): boolean` | — | — |
| `entryKeysExtension` | function | 174 | `export function entryKeysExtension(host: EntryKeyHost): Extension` | `main.ts` | — |
| `inputObservation` | function | 197 | `export function inputObservation( transactions: readonly Transaction[], context:` | — | `tests/entry-keys.test.ts` |
| `compositionCommit` | function | 242 | `export function compositionCommit(host: Pick<EntryEditHost, "entries">):` | — | `tests/entry-keys.test.ts` |
| `replacedDocument` | function | 320 | `export function replacedDocument(transactions: readonly Transaction[]): boolean` | — | `tests/entry-keys.test.ts` |
| `PendingInput` | interface | 338 | `export interface PendingInput` | — | — |
| `InputLedger` | class | 353 | `export class InputLedger` | — | `tests/entry-keys.test.ts` |
| `entryEditExtension` | function | 377 | `export function entryEditExtension(host: EntryEditHost): Extension` | `main.ts` | `tests/entry-keys.test.ts` |

#### `src/editor/frame-effects.ts`

What a drawn frame can be doing, and which single effect shows it.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `FrameActivity` | interface | 14 | `export interface FrameActivity` | — | — |
| `FrameEffect` | interface | 26 | `export interface FrameEffect` | — | — |
| `FRAME_EFFECTS` | const | 52 | `export const FRAME_EFFECTS: readonly FrameEffect[] = [` | `editor/entry-frame.ts` | `tests/frame-effects.test.ts` |
| `frameEffect` | function | 76 | `export function frameEffect(activity: FrameActivity): FrameEffect \| null` | `editor/entry-frame.ts` | `tests/frame-effects.test.ts` |

#### `src/editor/stopwatch-widget.ts`

The rendered clock row.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `DurationMode` | type | 52 | `export type DurationMode = "fixed" \| "session"` | — | — |
| `MomentMode` | type | 55 | `export type MomentMode = "absent" \| "fixed" \| "wall"` | — | — |
| `DurationWidgetInput` | interface | 58 | `export interface DurationWidgetInput` | — | `tests/stopwatch-widget.test.ts` |
| `DurationWidget` | class | 87 | `export class DurationWidget extends WidgetType` | `editor/entry-decorations.ts` | `tests/entry-decorations.test.ts`<br>`tests/stopped-clock-render.test.ts`<br>`tests/stopwatch-widget.test.ts` |

#### `src/editor/view-registry.ts`

The live editor views, in one place.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `registerEditorView` | function | 15 | `export function registerEditorView(view: EditorView): void` | — | `tests/entry-keys.test.ts`<br>`tests/start-entry.test.ts`<br>`tests/stopped-clock-render.test.ts`<br>`tests/whisper-act.test.ts`<br>`tests/writer.test.ts` |
| `unregisterEditorView` | function | 20 | `export function unregisterEditorView(view: EditorView): void` | — | `tests/entry-keys.test.ts`<br>`tests/start-entry.test.ts`<br>`tests/stopped-clock-render.test.ts`<br>`tests/whisper-act.test.ts`<br>`tests/writer.test.ts` |
| `viewRegistryExtension` | const | 25 | `export const viewRegistryExtension = ViewPlugin.fromClass( class` | `main.ts` | — |
| `registeredEditorViews` | function | 38 | `export function registeredEditorViews(): readonly EditorView[]` | `editor/entry-keys.ts`<br>`entries/engine.ts`<br>`main.ts` | — |
| `findEditorViewForFile` | function | 43 | `export function findEditorViewForFile(file: TFile): EditorView \| null` | `entries/engine.ts`<br>`entries/writer.ts` | — |
| `findActiveEditorView` | function | 60 | `export function findActiveEditorView(app: App): EditorView \| null` | `entries/engine.ts` | — |

#### `src/entries/capture-model-controller.ts`

The model-backed capture controller: the lower half as one tagged state, driven

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `CaptureStorePort` | interface | 56 | `export interface CaptureStorePort` | — | `tests/capture-model-controller.test.ts` |
| `CaptureModelHost` | interface | 62 | `export interface CaptureModelHost` | `main.ts` | `tests/capture-model-controller.test.ts` |
| `captureRequestOf` | function | 112 | `export function captureRequestOf(intent: Extract<WriteIntent,` | — | — |
| `CaptureView` | interface | 137 | `export interface CaptureView` | `ui/loom.ts` | — |
| `CaptureModelController` | class | 155 | `export class CaptureModelController implements LoomCaptureOwner` | `main.ts` | `tests/capture-model-controller.test.ts` |

#### `src/entries/capture-store.ts`

The durable capture record, version 2: the tagged work and its one write.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `CAPTURE_V2_STORAGE_KEY` | const | 41 | `export const CAPTURE_V2_STORAGE_KEY = "weaver:capture:v2"` | — | `tests/capture-store.test.ts` |
| `CaptureEnvelopeV2` | interface | 44 | `export interface CaptureEnvelopeV2` | `entries/capture-model-controller.ts` | `tests/capture-model-controller.test.ts` |
| `CaptureConflict` | class | 52 | `export class CaptureConflict extends Error` | — | `tests/capture-store.test.ts` |
| `readCaptureEnvelope` | function | 332 | `export function readCaptureEnvelope(value: unknown): CaptureEnvelopeV2` | — | `tests/capture-store.test.ts` |
| `migrateCaptureV1` | function | 345 | `export function migrateCaptureV1(record: CaptureRecord): CaptureEnvelopeV2` | — | `tests/capture-store.test.ts` |
| `CaptureStoreV2` | class | 423 | `export class CaptureStoreV2` | `main.ts` | `tests/capture-store.test.ts` |

#### `src/entries/capture.ts`

The one floating draft, and everything that may happen to it.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `CaptureRecord` | interface | 62 | `export interface CaptureRecord` | `entries/capture-store.ts`<br>`entries/local-state.ts` | `tests/capture-store.test.ts`<br>`tests/capture.test.ts`<br>`tests/loom.test.ts` |
| `CaptureStore` | interface | 76 | `export interface CaptureStore` | `entries/local-state.ts` | `tests/capture.test.ts`<br>`tests/loom.test.ts` |
| `CaptureHost` | interface | 86 | `export interface CaptureHost` | — | `tests/capture.test.ts`<br>`tests/loom.test.ts` |
| `CAPTURE_BUSY` | const | 127 | `export const CAPTURE_BUSY = "A draft is already open; it was kept."` | — | — |
| `CaptureController` | class | 144 | `export class CaptureController` | `core/loom.ts` | `tests/capture.test.ts`<br>`tests/loom.test.ts` |

#### `src/entries/clock.ts`

The one clock a running stopwatch is read through.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `ClockSnapshot` | interface | 27 | `export interface ClockSnapshot` | — | — |
| `ClockListener` | type | 35 | `export type ClockListener = (now: number, durationMs: number) => void` | — | — |
| `EntryClock` | class | 41 | `export class EntryClock` | `editor/duration-ticker.ts`<br>`editor/entry-decorations.ts`<br>`editor/stopwatch-widget.ts`<br>`main.ts`<br>`reading/entry-processor.ts`<br>`ui/loom.ts` | `tests/entry-clock.test.ts`<br>`tests/entry-decorations.test.ts`<br>`tests/entry-processor.test.ts`<br>`tests/loom.test.ts`<br>`tests/stopwatch-widget.test.ts` |

#### `src/entries/context-workspaces.ts`

Destination travel: going to a workspace, and coming back to it as you left it.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `LayoutApi` | interface | 37 | `export interface LayoutApi` | `main.ts` | `tests/context-workspaces.test.ts` |
| `WorkspaceHost` | interface | 45 | `export interface WorkspaceHost` | — | `tests/context-workspaces.test.ts` |
| `layoutKey` | function | 71 | `export function layoutKey(contextId: string, phone = isPhone(), tablet = isTablet()): string` | — | `tests/context-workspaces.test.ts` |
| `ContextWorkspaces` | class | 83 | `export class ContextWorkspaces` | `main.ts` | `tests/context-workspaces.test.ts` |

#### `src/entries/day-note.ts`

The day plane, resolved against the vault: which file a destination's note for

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `dayNoteOptions` | function | 72 | `export function dayNoteOptions(app: App, settings: WeaverSettings): DayNoteOptions` | `settings-tab.ts` | — |
| `contextList` | function | 87 | `export function contextList( app: App, settings: WeaverSettings ):` | `main.ts` | `tests/contexts.test.ts`<br>`tests/thought-index.test.ts` |
| `ResolvedContextDay` | type | 97 | `export type ResolvedContextDay = \|` | — | — |
| `resolveContextDay` | function | 109 | `export function resolveContextDay( app: App, settings: WeaverSettings, contextId: string, day: string ): ResolvedContextDay` | `entries/engine.ts`<br>`main.ts` | `tests/day-note.test.ts` |
| `ensureDayNote` | function | 138 | `export async function ensureDayNote(app: App, path: string, day: string): Promise<TFile>` | `entries/engine.ts`<br>`main.ts` | `tests/day-note.test.ts` |

#### `src/entries/engine.ts`

The editor path that changes an entry.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `RetryGuard` | interface | 113 | `export interface RetryGuard` | — | — |
| `WriteOutcome` | type | 123 | `export type WriteOutcome = \|` | — | — |
| `EntryEngine` | class | 136 | `export class EntryEngine` | `entries/capture.ts`<br>`main.ts` | — |

#### `src/entries/local-state.ts`

What this device remembers about Weaver, and nothing that syncs.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `WORKSPACE_STORAGE_KEY` | const | 29 | `export const WORKSPACE_STORAGE_KEY = "weaver:local-state:v1"` | — | `tests/local-state.test.ts` |
| `CAPTURE_STORAGE_KEY` | const | 32 | `export const CAPTURE_STORAGE_KEY = "weaver:capture:v1"` | `entries/capture-store.ts` | `tests/capture-store.test.ts` |
| `DEVICE_STORAGE_KEY` | const | 35 | `export const DEVICE_STORAGE_KEY = "weaver:device:v1"` | — | — |
| `LocalStorageIo` | interface | 38 | `export interface LocalStorageIo` | `entries/capture-store.ts` | `tests/capture-store.test.ts`<br>`tests/local-state.test.ts` |
| `PanePosition` | interface | 46 | `export interface PanePosition` | `entries/context-workspaces.ts` | — |
| `WorkspaceSnapshot` | interface | 63 | `export interface WorkspaceSnapshot` | `entries/context-workspaces.ts`<br>`main.ts` | — |
| `WorkspaceRecord` | interface | 75 | `export interface WorkspaceRecord` | — | — |
| `ScheduleRuntime` | interface | 85 | `export interface ScheduleRuntime` | `entries/portals.ts` | — |
| `LocalStateRecord` | interface | 97 | `export interface LocalStateRecord` | `entries/context-workspaces.ts`<br>`entries/portals.ts` | `tests/context-workspaces.test.ts`<br>`tests/local-state.test.ts`<br>`tests/portal-controller.test.ts` |
| `UnreadableState` | class | 103 | `export class UnreadableState extends Error` | `entries/capture-store.ts` | `tests/capture-store.test.ts` |
| `readCaptureRecord` | function | 316 | `export function readCaptureRecord(value: unknown): CaptureRecord \| null` | — | `tests/capture.test.ts` |
| `readWorkspaceRecord` | function | 362 | `export function readWorkspaceRecord(value: unknown): LocalStateRecord` | — | `tests/context-workspaces.test.ts` |
| `LocalState` | class | 412 | `export class LocalState implements CaptureStore` | `main.ts` | `tests/capture.test.ts`<br>`tests/local-state.test.ts` |

#### `src/entries/loom.ts`

The Loom's coordinator: one place that knows the shell, the draft and the

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `LoomCaptureOwner` | interface | 28 | `export interface LoomCaptureOwner` | `entries/capture-model-controller.ts` | `tests/loom-controller.test.ts` |
| `LoomReferenceOwner` | interface | 37 | `export interface LoomReferenceOwner` | — | `tests/loom-controller.test.ts` |
| `LoomUiStore` | interface | 45 | `export interface LoomUiStore` | — | — |
| `LoomPorts` | interface | 51 | `export interface LoomPorts` | — | `tests/loom-controller.test.ts` |
| `LoomCommand` | type | 65 | `export type LoomCommand = \| LoomAction \|` | — | — |
| `LoomState` | interface | 71 | `export interface LoomState` | — | — |
| `LoomListener` | type | 78 | `export type LoomListener = (state: LoomState, focus: FocusIntent \| null) => void` | — | — |
| `LoomController` | class | 90 | `export class LoomController` | — | `tests/loom-controller.test.ts` |

#### `src/entries/plugin-data.ts`

The one owner of `data.json`: settings, shared Reviews and the serialized

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `ReviewAcceptance` | type | 36 | `export type ReviewAcceptance = \|` | — | — |
| `StagedRebind` | interface | 45 | `export interface StagedRebind` | — | — |
| `PluginDataPorts` | interface | 52 | `export interface PluginDataPorts` | — | `tests/plugin-data.test.ts` |
| `PluginDataStore` | class | 108 | `export class PluginDataStore` | `main.ts` | `tests/plugin-data.test.ts` |

#### `src/entries/portals.ts`

The invitation lifecycle: which schedule is offering what, right now.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `PortalHost` | interface | 52 | `export interface PortalHost` | — | `tests/portal-controller.test.ts` |
| `OfferedInvitation` | interface | 80 | `export interface OfferedInvitation` | — | — |
| `PortalController` | class | 93 | `export class PortalController` | `main.ts` | `tests/portal-controller.test.ts` |

#### `src/entries/reference.ts`

The upper half's one owner: the current query, the frozen sequence it produced,

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `ReferenceHost` | interface | 33 | `export interface ReferenceHost` | — | `tests/reference-controller.test.ts` |
| `ReviewSession` | interface | 43 | `export interface ReviewSession` | — | `tests/reference-controller.test.ts` |
| `ActiveReview` | interface | 52 | `export interface ActiveReview` | — | — |
| `ReferenceReadiness` | type | 62 | `export type ReferenceReadiness = \|` | — | — |
| `ReferencePlace` | type | 75 | `export type ReferencePlace = \|` | — | — |
| `ReferenceBody` | type | 83 | `export type ReferenceBody = \|` | — | — |
| `PreSearch` | interface | 95 | `export interface PreSearch` | — | — |
| `ReferenceSearch` | type | 102 | `export type ReferenceSearch = \|` | — | — |
| `ReferenceModel` | interface | 108 | `export interface ReferenceModel` | `entries/loom.ts`<br>`ui/loom.ts` | `tests/loom-controller.test.ts` |
| `ReviewChange` | interface | 120 | `export interface ReviewChange` | — | — |
| `ReferenceAction` | type | 126 | `export type ReferenceAction = \|` | `entries/loom.ts` | `tests/loom-controller.test.ts` |
| `ReferenceController` | class | 161 | `export class ReferenceController` | `core/loom.ts`<br>`main.ts`<br>`ui/loom.ts` | `tests/reference-controller.test.ts` |
| `sequenceErrors` | function | 542 | `export function sequenceErrors(sequence: ReferenceSequence \| null): readonly ReferenceReadError[]` | — | — |

#### `src/entries/session.ts`

The live stopwatch: at most one entry is being written at a time.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `ActiveEntry` | interface | 16 | `export interface ActiveEntry` | — | — |
| `NativeSessionState` | type | 35 | `export type NativeSessionState = \|` | — | — |
| `NativeStopResult` | type | 47 | `export type NativeStopResult = \|` | `editor/entry-keys.ts`<br>`entries/engine.ts` | — |
| `EntrySession` | class | 63 | `export class EntrySession` | `editor/entry-decorations.ts`<br>`editor/entry-frame.ts`<br>`editor/entry-keys.ts`<br>`entries/clock.ts`<br>`entries/engine.ts`<br>`main.ts` | `tests/entry-clock.test.ts`<br>`tests/entry-decorations.test.ts`<br>`tests/entry-keys.test.ts`<br>`tests/entry-processor.test.ts`<br>`tests/loom.test.ts`<br>`tests/session.test.ts`<br>`tests/stopwatch-widget.test.ts` |

#### `src/entries/thought-index.ts`

The reading index: recognised notes parsed once and queried by scope, order and

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `ThoughtIndexPorts` | interface | 49 | `export interface ThoughtIndexPorts` | — | `tests/thought-index.test.ts` |
| `ThoughtIndex` | class | 70 | `export class ThoughtIndex` | `entries/reference.ts`<br>`main.ts` | `tests/loom.test.ts`<br>`tests/reference-controller.test.ts`<br>`tests/thought-index.test.ts` |

#### `src/entries/writer.ts`

The one writer of a day note.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `dispatchDraftChange` | function | 36 | `export function dispatchDraftChange(view: EditorView, transaction: TransactionSpec): void` | `ui/markdown-pane.ts` | — |
| `RewriteResult` | interface | 41 | `export interface RewriteResult` | `entries/engine.ts` | — |
| `Rewrite` | type | 49 | `export type Rewrite = (source: string) => RewriteResult \| null` | `settings.ts` | — |
| `RewriteRefused` | class | 58 | `export class RewriteRefused extends Error` | `entries/engine.ts` | — |
| `RewriteOptions` | interface | 61 | `export interface RewriteOptions` | — | — |
| `rewriteDay` | function | 83 | `export async function rewriteDay( app: App, file: TFile, rewrite: Rewrite, undoable: boolean, options: RewriteOptions =` | `entries/engine.ts`<br>`main.ts` | `tests/writer.test.ts` |
| `planRewrite` | function | 155 | `export function planRewrite(build: (source: string) => InsertPlan \| null): Rewrite` | `entries/engine.ts` | `tests/writer.test.ts` |
| `minimalChange` | function | 168 | `export function minimalChange(before: string, after: string): TextChange[]` | `core/insert.ts`<br>`main.ts` | `tests/writer.test.ts` |
| `confirmExistingWrite` | function | 191 | `export async function confirmExistingWrite( app: App, file: TFile, expected: string ): Promise<boolean>` | `main.ts` | — |
| `registerWrite` | function | 237 | `export function registerWrite(operationId: string, promise: Promise<unknown>): () => void` | `entries/engine.ts` | `tests/writer.test.ts` |
| `waitForWrite` | function | 246 | `export async function waitForWrite(_app: App, operationId: string): Promise<void>` | `entries/engine.ts` | `tests/writer.test.ts` |

#### `src/main.ts`

Weaver: a day note is a linear list of entries, and a thought may be written

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `WeaverPlugin` | class | 91 | `export default class WeaverPlugin extends Plugin` | `entries/engine.ts`<br>`settings-tab.ts` | `tests/capture-end-to-end.test.ts`<br>`tests/platform-classes.test.ts`<br>`tests/plugin.test.ts`<br>`tests/settings-tab.test.ts`<br>`tests/start-entry.test.ts`<br>`tests/stopped-clock-render.test.ts`<br>`tests/whisper-act.test.ts` |

#### `src/model/whisper-model.ts`

The model a whisper comes from.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `WhisperRequest` | interface | 17 | `export interface WhisperRequest` | — | `tests/whisper-act.test.ts`<br>`tests/whisper-runner.test.ts` |
| `WhisperFailure` | type | 29 | `export type WhisperFailure = \|` | `entries/engine.ts`<br>`notices.ts` | `tests/whisper-act.test.ts`<br>`tests/whisper-runner.test.ts` |
| `WhisperReply` | type | 35 | `export type WhisperReply = \|` | — | `tests/whisper-act.test.ts`<br>`tests/whisper-runner.test.ts` |
| `WhisperModel` | interface | 40 | `export interface WhisperModel` | `main.ts`<br>`model/whisper-runner.ts` | `tests/whisper-act.test.ts`<br>`tests/whisper-runner.test.ts` |
| `NoModel` | const | 53 | `export const NoModel: WhisperModel =` | `entries/engine.ts`<br>`main.ts`<br>`model/whisper-runner.ts` | `tests/whisper-act.test.ts`<br>`tests/whisper-runner.test.ts` |
| `OmLxModel` | class | 130 | `export class OmLxModel implements WhisperModel` | `main.ts` | `tests/whisper-model.test.ts` |

#### `src/model/whisper-runner.ts`

The runner: when a whisper is asked for, and what becomes of the answer.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `WHISPER_IDLE_MS` | const | 30 | `export const WHISPER_IDLE_MS = 800` | — | `tests/whisper-runner.test.ts` |
| `WHISPER_READING_DELAY_MS` | const | 39 | `export const WHISPER_READING_DELAY_MS = 200` | — | `tests/whisper-runner.test.ts` |
| `WHISPER_FAILURE_LIMIT` | const | 45 | `export const WHISPER_FAILURE_LIMIT = 2` | `entries/engine.ts` | — |
| `WhisperRunnerOptions` | interface | 48 | `export interface WhisperRunnerOptions` | — | — |
| `WhisperRunner` | class | 59 | `export class WhisperRunner` | `main.ts` | `tests/whisper-act.test.ts`<br>`tests/whisper-runner.test.ts` |

#### `src/notices.ts`

Every user-facing string Weaver shows, so wording stays consistent.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `NOTICE_REFUSAL_MS` | const | 9 | `export const NOTICE_REFUSAL_MS = 6000` | `entries/engine.ts`<br>`main.ts` | — |
| `NOTICE_NOOP_MS` | const | 11 | `export const NOTICE_NOOP_MS = 3000` | `main.ts` | — |
| `NOTICE_PARTIAL_MS` | const | 13 | `export const NOTICE_PARTIAL_MS = 8000` | `entries/engine.ts` | — |
| `NOTICE_NOTHING_WRITTEN` | const | 16 | `export const NOTICE_NOTHING_WRITTEN = "Nothing was written."` | — | — |
| `NOTICE_NEEDS_EDITING` | const | 19 | `export const NOTICE_NEEDS_EDITING = `Weaver: this needs an editable note. $` | `entries/engine.ts` | `tests/start-entry.test.ts` |
| `NOTICE_NEEDS_ENTRY` | const | 21 | `export const NOTICE_NEEDS_ENTRY = `Weaver: put the caret in an entry. $` | `entries/engine.ts` | `tests/start-entry.test.ts` |
| `NOTICE_DAY_CLOSED` | const | 23 | `export const NOTICE_DAY_CLOSED = (time: string): string => `Weaver: day closed at $` | `main.ts` | — |
| `NOTICE_DAY_ALREADY_CLOSED` | const | 25 | `export const NOTICE_DAY_ALREADY_CLOSED = `Weaver: this day is already closed. $` | `main.ts` | — |
| `NOTICE_NO_DAY_NOTE` | const | 27 | `export const NOTICE_NO_DAY_NOTE = `Weaver: today's day note could not be found. $` | `entries/engine.ts`<br>`main.ts` | — |
| `noticePortal` | function | 36 | `export function noticePortal(name: string, time: string, remainingSeconds: number): string` | `main.ts` | `tests/notices.test.ts` |
| `noticePortalRefused` | function | 50 | `export function noticePortalRefused(reason: string): string` | — | — |
| `NOTICE_PORTAL_UNAVAILABLE` | const | 55 | `export const NOTICE_PORTAL_UNAVAILABLE = `Weaver: that portal is no longer open. $` | — | — |
| `NOTICE_STOP_FAILED` | const | 61 | `export const NOTICE_STOP_FAILED = "Weaver: the stopped time could not be saved; the clock is held where it stopped. Check the vault is writable, then stop again."` | `entries/engine.ts` | `tests/start-entry.test.ts` |
| `NOTICE_WHISPERING` | const | 65 | `export const NOTICE_WHISPERING = "Whispering the day…"` | `entries/engine.ts` | `tests/whisper-act.test.ts` |
| `NOTICE_WHISPER_UNREACHABLE` | const | 68 | `export const NOTICE_WHISPER_UNREACHABLE = "No whisper endpoint is reachable from this device."` | `entries/engine.ts` | `tests/whisper-act.test.ts` |
| `WhisperPass` | interface | 71 | `export interface WhisperPass` | — | — |
| `whisperFailurePhrase` | function | 94 | `export function whisperFailurePhrase(failure: WhisperFailure): string` | `entries/engine.ts`<br>`model/whisper-runner.ts` | — |
| `noticeWhispered` | function | 125 | `export function noticeWhispered(pass: WhisperPass): string` | `entries/engine.ts` | `tests/whisper-act.test.ts` |
| `NAVIGATOR_HINT_KEYS` | const | 148 | `export const NAVIGATOR_HINT_KEYS = "j k move · ⏎ open · ⇧⏎ branch · t new Thread · c continue · delete twice removes · ⌘[ ⌘] back forward · esc close"` | — | — |
| `NAVIGATOR_HINT_TOUCH` | const | 152 | `export const NAVIGATOR_HINT_TOUCH = "tap a row to select · its buttons to act · delete twice removes"` | — | — |
| `noticeCloseFrontmatter` | function | 156 | `export function noticeCloseFrontmatter(action: string): string` | `entries/engine.ts` | — |
| `noticeCloseCodeBlock` | function | 161 | `export function noticeCloseCodeBlock(action: string): string` | `entries/engine.ts` | — |
| `noticeLegacyFormat` | function | 166 | `export function noticeLegacyFormat(action: string): string` | `entries/engine.ts`<br>`main.ts` | `tests/start-entry.test.ts` |

#### `src/reading/close-processor.ts`

Reading view: the close mark, muted and labelled.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `createCloseProcessor` | function | 23 | `export function createCloseProcessor(): MarkdownPostProcessor` | `main.ts` | `tests/entry-processor.test.ts` |

#### `src/reading/entry-processor.ts`

Reading view: the same entry the editor draws, in the same frame.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `createEntryProcessor` | function | 132 | `export function createEntryProcessor( contexts: () => readonly WeavingContext[], openDayLink?: OpenDayLink, clock?: EntryClock ): MarkdownPostProcessor` | `main.ts` | `tests/entry-processor.test.ts` |

#### `src/settings-tab.ts`

The settings surface: six groups, every control applied live.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `WeaverSettingTab` | class | 35 | `export class WeaverSettingTab extends PluginSettingTab` | `main.ts` | `tests/settings-tab.test.ts` |

#### `src/settings.ts`

Weaver settings model.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `WeaverSettings` | interface | 19 | `export interface WeaverSettings` | `editor/entry-frame.ts`<br>`entries/day-note.ts`<br>`entries/plugin-data.ts`<br>`main.ts`<br>`ui/css.ts` | `tests/day-note.test.ts` |
| `WeaverData` | interface | 115 | `export interface WeaverData` | `entries/plugin-data.ts`<br>`main.ts` | `tests/plugin-data.test.ts` |
| `DEFAULT_SETTINGS` | const | 123 | `export const DEFAULT_SETTINGS: WeaverSettings =` | `settings-tab.ts` | `tests/contexts.test.ts`<br>`tests/day-note.test.ts`<br>`tests/plugin-data.test.ts`<br>`tests/settings.test.ts`<br>`tests/start-entry.test.ts`<br>`tests/thought-index.test.ts` |
| `isValidEntrySize` | function | 158 | `export function isValidEntrySize(value: string): boolean` | `settings-tab.ts`<br>`ui/css.ts` | — |
| `isValidWhisperEndpoint` | function | 165 | `export function isValidWhisperEndpoint(value: string): boolean` | — | `tests/settings.test.ts` |
| `whisperReachable` | function | 180 | `export function whisperReachable(endpoint: string, mobile: boolean): boolean` | `main.ts` | `tests/settings.test.ts` |
| `normalizeSettings` | function | 248 | `export function normalizeSettings(data: unknown): WeaverSettings` | — | `tests/settings.test.ts` |
| `normalizeData` | function | 308 | `export function normalizeData(data: unknown): WeaverData` | `entries/plugin-data.ts`<br>`main.ts` | `tests/settings.test.ts` |

#### `src/ui/css.ts`

The generated stylesheet: the five numbers a note is drawn with, the two

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `STYLE_ID` | const | 18 | `export const STYLE_ID = "weaver-style"` | — | — |
| `buildCss` | function | 27 | `export function buildCss(settings: WeaverSettings): string` | — | — |
| `applyCss` | function | 72 | `export function applyCss(settings: WeaverSettings): void` | `main.ts` | — |
| `removeCss` | function | 85 | `export function removeCss(): void` | `main.ts` | — |

#### `src/ui/day-link.ts`

The entry-day link at the top right of a frame: `[[YYYY.MM.DD]]`.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `OpenDayLink` | type | 17 | `export type OpenDayLink = (target: string, sourcePath: string) => void` | `editor/entry-decorations.ts`<br>`reading/entry-processor.ts` | — |
| `dayLinkElement` | function | 26 | `export function dayLinkElement( target: string, sourcePath: string, open: OpenDayLink ): HTMLElement` | `editor/entry-decorations.ts`<br>`reading/entry-processor.ts` | `tests/day-link.test.ts` |

#### `src/ui/dcn.ts`

The digit-and-ink grammar: `B.D.N`, the clock row and the date label all split

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `NUM_CLASS` | const | 16 | `export const NUM_CLASS = "weaver-dcn-num"` | `editor/entry-decorations.ts` | — |
| `INK_CLASS` | const | 18 | `export const INK_CLASS = "weaver-dcn-ink"` | `editor/entry-decorations.ts` | — |
| `Slice` | interface | 21 | `export interface Slice` | — | — |
| `addressSlices` | function | 31 | `export function addressSlices(text: string): Slice[]` | `editor/entry-decorations.ts` | — |
| `appendDigitRuns` | function | 39 | `export function appendDigitRuns(parent: HTMLElement, text: string): void` | `reading/entry-processor.ts`<br>`ui/loom.ts` | — |
| `appendClockRuns` | function | 54 | `export function appendClockRuns(parent: HTMLElement, clock: string): HTMLElement[]` | `editor/stopwatch-widget.ts`<br>`reading/entry-processor.ts` | — |

#### `src/ui/invitation.ts`

How an invitation is named, in the words a writer reads.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `InvitationView` | interface | 14 | `export interface InvitationView` | — | — |
| `openingTime` | function | 20 | `export function openingTime(occurrence: PortalOccurrence): string` | — | — |
| `countdownLabel` | function | 28 | `export function countdownLabel(occurrence: PortalOccurrence, now: number): string` | — | — |
| `arrivalLabel` | function | 35 | `export function arrivalLabel(occurrence: PortalOccurrence, contextName?: string): string` | — | — |
| `invitationName` | function | 41 | `export function invitationName(occurrence: PortalOccurrence): string` | — | — |

#### `src/ui/loom.ts`

The Loom: the one compact surface a thought is written in, from anywhere.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `CaptureSurface` | interface | 38 | `export interface CaptureSurface` | — | — |
| `LoomHost` | interface | 59 | `export interface LoomHost` | — | — |
| `LoomInvitation` | interface | 84 | `export interface LoomInvitation` | — | `tests/loom.test.ts` |
| `Loom` | class | 170 | `export class Loom` | `core/capture-state.ts`<br>`core/frame.ts`<br>`core/loom.ts`<br>`core/reference.ts`<br>`entries/context-workspaces.ts`<br>`entries/loom.ts`<br>`entries/portals.ts`<br>`entries/writer.ts`<br>`main.ts` | `tests/frame.test.ts`<br>`tests/loom.test.ts` |

#### `src/ui/markdown-pane.ts`

One persistent Markdown surface, rich while editing and natively rendered while

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `PaneSelection` | interface | 57 | `export interface PaneSelection` | `ui/loom.ts` | — |
| `MarkdownPaneOptions` | interface | 65 | `export interface MarkdownPaneOptions` | — | — |
| `MarkdownPane` | class | 437 | `export class MarkdownPane` | `ui/loom.ts` | — |

#### `src/ui/platform.ts`

Which platform this is, as one answer.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `isPhone` | function | 14 | `export function isPhone(): boolean` | `editor/entry-keys.ts`<br>`entries/context-workspaces.ts`<br>`main.ts` | `tests/platform-classes.test.ts` |
| `isMobile` | function | 21 | `export function isMobile(): boolean` | `main.ts`<br>`ui/loom.ts` | `tests/platform-classes.test.ts` |
| `isTablet` | function | 28 | `export function isTablet(): boolean` | `entries/context-workspaces.ts`<br>`main.ts` | `tests/platform-classes.test.ts` |
| `canHover` | function | 35 | `export function canHover(): boolean` | — | — |


<!-- design:end -->
