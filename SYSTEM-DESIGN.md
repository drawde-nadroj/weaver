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

An entry is a marker line, its prose, and at most one clock row. A day note is a
list of them plus the day's frontmatter. Everything else in the plugin exists to
draw that list, move a caret through it, or write one of its fields.

The clock row is the frame's bottom edge: the duration and the moment sit at its
two ends, so the row you write is the row the frame is labelled with. Both halves
are digit and punctuation runs — white digits around dimension-coloured colons —
the same grammar the marker is drawn in. The duration comes first because it is
the half that moves: settling rewrites its characters and leaves the moment's
alone.

| Field | Written by | Read by | Shape |
| --- | --- | --- | --- |
| Marker | `formatMarker` | `parseMarkerPrefix`, `parseEntries` | `{ B.D.N }`, matched as a prefix |
| Prose | the writer's own typing | `parseEntries` | every line between the marker and the clock row that is not a whisper row, trimmed at both ends |
| Whisper | the model, at settle or after it | `parseWhisperLine` | `~ <text>` (a name), `~ learn: <text>`, `~ next: <text>`, or `~ ask: <text?>` — one to three rows (the prompt asks for two or three); a `thread:` row may be appended later |
| Moment | `planEntryBeginning`, `planPortalEntry` | `parseClockRow` | `YYYY-MM-DD HH:MM:SS` captured on first committed text; an undated historical moment inherits the filename day |
| Duration | `formatDurationLine` | `parseClockRow` | `[+-=] HH:MM:SS` at the head of the clock row; `-` open, `=` paused, `+` settled |
| Close | `closeLine` | `parseClose` | `✓ HH:MM:SS`, at most one, never an entry |
| Frontmatter | `dayFrontmatter`, `applyDayStats`, `mergeAlignment` | `scanFrontmatter`, `recountDay`, `readAlignments` | `date`, `travels`, `depth`, `duration`, and structured `weaver-alignments` |

<!-- claim: src/core/entries.ts#formatMarker @c9eab6a8cb -->
<!-- claim: src/core/entries.ts#parseEntries @9a8f2bc1c5 -->
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
<!-- claim: src/core/entries.ts#repairBranches @a57d8d7a30 -->

The parser is a prefix match, so `{ 1.2.3 } a title` is one entry whose first
prose line is `a title`; the marker inside frontmatter or a fenced block is text
(`src/core/document.ts#scanFrontmatter`, `src/core/document.ts#scanFences`). The
clock row is the entry's last line, and either half may be absent: a row with
only a moment, or only a duration, is still a clock row. A marker that still
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

<!-- claim: src/entries/writer.ts#rewriteDay @759cc35cb2 -->
<!-- claim: src/entries/writer.ts#planRewrite @b52e9a19bf -->
<!-- claim: src/editor/entry-field.ts#programmaticWrite @e59e28301b -->

Callers of `rewriteDay`, exhaustively —
`src/entries/engine.ts#publish` (the ambient pause),
`src/entries/engine.ts#startEntry`, `src/main.ts#closeDay`,
`src/main.ts#refreshDayStats`, and the two whisper writes,
`src/entries/engine.ts#landWhisper` (one answer arriving after its entry settled)
and `src/entries/engine.ts#whisperDay` (a whole-day pass merged into one
transaction). The editor path is
`src/entries/engine.ts#EntryEngine` itself: settle, descend, deleteEntry and
first-input capture dispatch plans from `core/insert.ts` there, and §3 lists
those plans. Nothing else writes a day note. The gate fails if
`vault.process`, `vault.modify` or `vault.append` appears outside
`src/entries/writer.ts`; if `vault.create` or `vault.createFolder` appears
outside `src/entries/day-note.ts`; if `editor.replaceRange` appears anywhere; or
if a `dispatch` that carries `changes` appears outside `src/entries/engine.ts`
and `src/entries/writer.ts`.

<!-- claim: src/entries/engine.ts#EntryEngine @92cea8c527 -->

## 3. The plans

A plan is a list of changes plus the selection to leave behind. One plan is one
transaction, so one undo reverses all of it.

| Plan | Intent | Changes | Renumbers |
| --- | --- | --- | --- |
| `planStartEntry` | append a root at the tip | marker, blank line, `- 00:00:00` | no — new `N`, next branch |
| `planChildEntry` | open a child under a settled entry, above older siblings | marker, blank line, `- 00:00:00` | no — inherits `B` |
| `planEntryBeginning` | stamp a draft's beginning on first input | the clock row's day and moment, duration bytes untouched | no |
| `planPortalEntry` | capture an opening on first input | root marker, first prose, full clock row and history together | no — new `N`, next branch |
| `planDeleteEntry` | remove a subtree | the block, its blank separator, and nulling deleted history associations | yes — surviving `B` values |
| `planDuration` | write the clock | the duration half of the clock row, moment untouched | no |
| `planWhisper` | name an entry | whisper rows above the first prose line | no |
| `planThread` | place an entry in its day | one `thread:` row below the last whisper row | no |
| `planAppendLine` | the shared append primitive | one insertion at the tip | no |
| `planCloseDay` | close the day | `✓ HH:MM:SS` | no |

<!-- claim: src/core/insert.ts#planStartEntry @2820f13712 -->
<!-- claim: src/core/insert.ts#planChildEntry @5f9ac6508b -->
<!-- claim: src/core/insert.ts#planEntryBeginning @3e58476127 -->
<!-- claim: src/core/insert.ts#planDeleteEntry @9e6538e477 -->
<!-- claim: src/core/insert.ts#planDuration @546c356091 -->
<!-- claim: src/core/insert.ts#planWhisper @a9fb1e4a70 -->
<!-- claim: src/core/insert.ts#planThread @a8069bde30 -->
<!-- claim: src/core/close.ts#planCloseDay @e36f434d57 -->

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
path, the entry's `N`, the baseline milliseconds, the resume instant, and the last
painted whole-second duration. `src/entries/clock.ts#EntryClock` samples elapsed
time, synchronously paints subscribers, then commits that snapshot. Pause and
settle read the snapshot without advancing it. A failed stop retains the frozen
snapshot until a successful retry or fresh input.

<!-- claim: src/entries/session.ts#EntrySession @cf0c428ded -->

The transitions, and where each lives:

| Transition | Trigger | Code | Write |
| --- | --- | --- | --- |
| Start | the writer's own input in a draft | `src/entries/engine.ts#afterEdit` | none |
| Capture beginning | first committed text in an awaiting draft or portal | `src/entries/engine.ts#captureInput`, `src/entries/engine.ts#captureComposition`, `src/entries/engine.ts#capturePortal` | date and moment, and for a portal its root and history, in the input's undo group |
| Pause | a caret move, blur, wheel, touch, leaf change, hidden app, navigator open, the live entry deleted | `src/entries/engine.ts#pause` | `= HH:MM:SS`, not undoable |
| Settle | `⏎` on an open entry | `src/entries/engine.ts#settle` | `+ HH:MM:SS`, undoable — and, when the idle pause already answered, the whisper rows in the same transaction |
| Drop | the entry being written is deleted | `src/entries/engine.ts#deleteEntry` | none |

<!-- claim: src/entries/engine.ts#EntryEngine @92cea8c527 -->

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
adoption read the current snapshot without advancing it; awaiting rows paint wall
time, running rows paint duration with the recorded moment, and fixed rows paint
only recorded fields. No tick costs a transaction or an undo entry.

<!-- claim: src/editor/stopwatch-widget.ts#DurationWidget @96fea98494 -->

Portal openings have no entry identity before writing.
`src/core/portals.ts#portalInstants` enumerates actual epoch minutes and tests
their local hour and minute, preserving daylight-saving gaps and repeated hours.
`src/core/portals.ts#portalPhase` keeps a prepared opening after its minute without
unlocking it early; `src/core/portals.ts#portalAlignments` recognizes every
coincident boundary, hour echo and minute echo from the actual input second.

`src/core/insert.ts#planPortalEntry` appends an actual root beginning and merges its
event through `src/core/alignments.ts#mergeAlignment` in one plan over the original
source coordinates. `src/core/alignments.ts#readAlignments` refuses unreadable
owned metadata rather than inventing empty history. The owned property is
`weaver-alignments`: a YAML sequence of JSON flow mappings recording the UTC
opening, its original local offset timestamp, the actual first-input timestamp,
and the associated entry sequence. Other frontmatter and body bytes remain
untouched. `src/core/alignments.ts#detachAlignments` nulls deleted subtree
associations in the deletion plan without erasing event facts.

`src/entries/portals.ts#PortalController` derives current candidates and their
phase from actual time at every wakeup, not from elapsed timer counts. Preparation
holds at most one opening in its selected note across midnight; release after
expiry removes it. Consumption is remembered in this instance and checked against
the containing note's readable history after reload. Announced identities survive
backward clock changes and settings toggles. Initialization and delayed wakeups
invite only the nearest current opening through `src/notices.ts#noticePortal`;
hidden documents speak nothing. The controller owns no writer or navigation.

## 5. Geometry

Nothing reflows. The text decides where the box is, never the reverse.

- `frameBox` is pure: column, the text's left edge, the label inset → the box's
  `left`/`width`, or `drawn: false`.
- `src/core/frame.ts#frameColumn` supplies the same pane-clamped column to entry
  boxes and the pending root tray. `src/core/frame.ts#trayFrame` converts that
  box into the tray's content-relative margin and width, including an empty
  document. `src/editor/entry-frame.ts#remeasureFrames` gives a newly mounted
  tray one measurement without making clock ticks measure or dispatch.
  Editor content padding is excluded from that shared column, so a padded theme
  cannot give the entry and portal different right rails.
- `frameSpan` is pure: this entry's two rails and the next entry's top rail →
  `top`/`bottom`, or `drawn: false` when they leave no interior.
- `src/editor/entry-frame.ts` is the only measuring code. It finds each entry's
  rows by their own `data-weaver-n` stamp
  (`src/editor/entry-frame.ts#renderedRows`), measures the ink of the row
  (`src/editor/entry-frame.ts#inkRect`), and schedules one
  `requestAnimationFrame` per batch (`src/editor/entry-frame.ts#schedule`). A row
  that has scrolled out of the render range falls back to its line block, whose
  centre is still the label's centre.
  It also sizes the in-flow pending tray from that root geometry. Reading
  portals inherit the static frame's two outer gutters, and their footer's
  labels straddle the bottom rail rather than floating inside it.
- The constants that turn "a box" into this box — `MIN_AIR`, `NO_CLOCK_PAD`,
  `INLINE_TITLE_PAD` — stay in the measuring layer. The shared side clearance is
  `src/core/frame.ts#frameLabelInset`: `16 px + 0.45em`, using the rendered marker's
  font size, exactly the inset Reading view uses. The labels' background halos
  therefore leave both rounded corners visible without moving the text.
  Nothing renders into that air. The labels cannot overhang the
  row, because Obsidian's `contain: paint` clips a block widget at its padding box;
  a label that needs the corner is drawn inside the text column instead, and the
  gutter is the margin that keeps the rail off the ink.
- Where a frame starts is a setting with two answers. On (`frameFollowsIndent`, the
  default) the marker, the prose and the clock row all take the indent, and because
  the frame's left edge is pinned a fixed air left of the marker, the boxes step right
  with the nesting. Off, only the prose is indented: the marker and the clock row stay
  in the left margin, the frame's edge follows them, and every box starts in the same
  column — which puts the markers and the times in one column each down the note. The
  body class is `weaver-frame-fixed`; both modes are four CSS declarations.
- `src/core/insert.ts#planStartEntry` and `src/core/insert.ts#planChildEntry`
  write a duration-only row, `- 00:00:00`: the block exists, but it has not begun.
  `src/core/insert.ts#planEntryBeginning` stamps the actual local day and moment
  from the first input's one timestamp, even inside an older note, and copies the
  duration bytes unchanged — so an entry made before midnight but typed after it
  records the real day without moving the note. Existing days and moments are
  never replaced. `src/core/duration.ts#parseClockRow` exposes the day
  and time; undated historical moments use the filename day without a rewrite.
  `src/core/day.ts#entryDayLinkTarget` returns a link only when the recorded day
  differs from the filename day, formatted in the filename's style. Same-day
  and historical undated entries carry no date label or hidden tab stop, and an
  awaiting draft carries none either: it has not recorded a day for the link to
  name.
  `src/editor/entry-decorations.ts#DayLinkWidget` and
  `src/reading/entry-processor.ts#createEntryProcessor` render that link
  persistently at the top-right, independent of caret, hover or focus. Legacy
  inline prose in Live Preview uses `.weaver-entry-inline` to put its date above
  the row, beside the raised rail. Its background halo extends only sideways,
  rather than adding vertical clearance over adjacent rows.

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
The marker's soft break is removed with its text, not carried into the first
prose line as a blank row; later prose breaks and inline markup are retained.

## 6. Surfaces

One row per surface that can be touched. "Writes" is the complete list of
document bytes it can cause; "empty" is what it shows with nothing to show.

| Surface | Code | Writes | One undo | Empty |
| --- | --- | --- | --- | --- |
| Entry decoration | `src/editor/entry-decorations.ts#entryDecorationSet` | nothing | — | draws nothing (it renders the marker's runs, the frame label, and a different-day entry's creation-day link) |
| Clock row | `src/editor/stopwatch-widget.ts#DurationWidget` | nothing (ticks its own DOM) | — | — |
| Frame layer | `src/editor/entry-frame.ts#entryFrameExtension` | nothing | — | draws nothing |
| Entry keys | `src/editor/entry-keys.ts#handleEnterKey` | settle `+`, or a child | the plan | not handled outside an entry |
| Start command | `src/main.ts#WeaverPlugin` | the root entry | the plan | `today's day note could not be found. Nothing was written.` |
| Navigator | `src/ui/navigator.ts#Navigator` | the child, the root, the deletion, the pause | the plan | `no entries yet — ＋ starts the first` |
| Reading view | `src/reading/entry-processor.ts#createEntryProcessor` | nothing | — | leaves the paragraph alone (it frames the entry and adds a creation-day link only when the day differs from the note) |
| Pending portal | `src/editor/portal-widget.ts#portalExtension` | first committed text creates marker, prose, clock and history through the engine; otherwise nothing | the entire beginning | appears even after an empty document; no fake entry identity |
| Reading portal tray | `src/reading/portals.ts#PortalReadingTray` | nothing; explicit preparation switches the same leaf to Live Preview | — | one whole-view tray, even without entries |
| Close mark | `src/reading/close-processor.ts#createCloseProcessor` | nothing | — | leaves the paragraph alone |
| Whisper the day | `src/entries/engine.ts#whisperDay` | one whisper per settled entry that has none | the whole pass | `Nothing to whisper: every settled entry already has one, or a name.` |
| Descend command | `src/main.ts#WeaverPlugin` | settle `+`, or a child | the plan, once per transaction | `this needs an editable note.` or `put the caret in an entry.` — nothing written |
| Close day | `src/main.ts#WeaverPlugin` | `✓` plus the counters | the plan | `this day is already closed. Nothing was written.` |
| Settings tab | `src/settings-tab.ts#WeaverSettingTab` | `data.json` only | — | — |

<!-- claim: src/editor/entry-keys.ts#handleEnterKey @05f01a81d6 -->
<!-- claim: src/ui/navigator.ts#Navigator @facec75295 -->
<!-- claim: src/reading/entry-processor.ts#createEntryProcessor @4a073f0ce2 -->

A command's target is the day plane, and *Whisper the day* aims at the day note on
screen — `src/entries/engine.ts#dayToWhisper` — falling back to today's note only
when the open file's filename carries no day. A past day is a day: the note has the
same shape and its entries are the same entries, so the pass follows the reader
rather than the clock. Nothing else writes into a note it was not pointed at.

The navigator is the only navigation: it never takes a `Scope`, never writes
prose, and re-reads the document on every action
(`src/ui/navigator.ts#buildItems`). The phone pinning is one pure decision,
`shouldPinStopwatch`, true only when all four of phone, live session, caret on
the last prose line, and a clock row exist.

`src/core/portal-history.ts#portalHistoryRows` combines recorded beginnings with
the reconstructed local schedule inside the navigator's collapsed Portals
section. Captured alignments use their stored original offsets, while schedule
rows are explicitly in the current timezone. `src/core/portal-history.ts#linkedPortalEntry`
checks sequence, day and moment before a historical jump; deletion or a mismatch
leaves an informational unavailable row. Navigator refreshes preserve selection
identity and scroll, and schedule/history rows cannot descend or delete.

<!-- claim: src/editor/entry-keys.ts#shouldPinStopwatch @eefa36e514 -->

## 7. Settings, colour, and the look

Colour is a pure function of `D` — for the marker and the prose.
`dimensionColor(7)` is the same value in every vault and at every moment, and
`dimensionColorVars` packages the two custom properties a line carries. A whisper
row is the one row that takes the note's own text colour, because the glyph alone
does not survive being read next to prose. Nothing is generated per level; the stylesheet is one
`calc()` over `--weaver-d`, and the runtime variables are written by `buildCss`
into one `<style id="weaver-style">` element.

<!-- claim: src/core/color.ts#dimensionColor @bbd0b078df -->
<!-- claim: src/ui/css.ts#buildCss @3731087775 -->

Settings land in one of the places listed here, never in a surface of their own:
values that change the drawing go through `buildCss` (variables), values that
change state go through `src/main.ts#syncBodyClasses` (body classes), and
everything else is read where it is needed (the generated table lists every
field's readers). The settings model is the only place a persisted name exists;
`normalizeSettings` clamps and defaults, and `LEGACY_SETTING_KEYS` is the single
place an older spelling is read — the v2 `heading*` names. A stored name with no
current name at all (`entryWeight`, dropped with the per-entry weight slider;
`entryDate`, dropped with the per-entry date) is simply dropped.

<!-- claim: src/settings.ts#normalizeSettings @c605a342e5 -->
<!-- claim: src/settings.ts#DEFAULT_SETTINGS @a3ccb180cf -->

**Vocabulary is a coupling, not a preference.** The unit is an *entry*, its depth
a *dimension*, its state *open* or *settled*. `heading` names Markdown syntax and
nothing else, which is why the settings fields are `entrySize` and
`equalizeEntrySizes` and why the v2 names appear once, in the migration. The
frame's labels — marker, the date link on another day, stopwatch and moment — carry
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
| a marker or duration shape | `core/entries.ts`, `core/duration.ts`, `core/duration.bend` + `LAWS.bend`, the fixture, §1 |
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

47 files, 260 exported symbols, 41 test files.

| file | layer | lines | exports | imports `obsidian` |
| --- | --- | --- | --- | --- |
| `src/core/alignments.ts` | core | 484 | 8 | no |
| `src/core/clock.ts` | core | 16 | 2 | no |
| `src/core/close.ts` | core | 61 | 5 | no |
| `src/core/color.ts` | core | 123 | 7 | no |
| `src/core/day-stats.ts` | core | 90 | 4 | no |
| `src/core/day.ts` | core | 73 | 6 | no |
| `src/core/document.ts` | core | 92 | 6 | no |
| `src/core/duration.ts` | core | 157 | 6 | no |
| `src/core/entries.ts` | core | 426 | 15 | no |
| `src/core/frame.ts` | core | 165 | 12 | no |
| `src/core/insert.ts` | core | 636 | 14 | no |
| `src/core/navigator-stack.ts` | core | 40 | 4 | no |
| `src/core/portal-history.ts` | core | 320 | 6 | no |
| `src/core/portals.ts` | core | 48 | 5 | no |
| `src/core/whisper.ts` | core | 407 | 19 | no |
| `src/editor/close-decorations.ts` | editor | 82 | 2 | yes |
| `src/editor/duration-ticker.ts` | editor | 23 | 2 | no |
| `src/editor/editor-path.ts` | editor | 11 | 1 | yes |
| `src/editor/entry-decorations.ts` | editor | 300 | 2 | yes |
| `src/editor/entry-field.ts` | editor | 62 | 6 | no |
| `src/editor/entry-frame.ts` | editor | 483 | 3 | yes |
| `src/editor/entry-keys.ts` | editor | 493 | 15 | no |
| `src/editor/frame-effects.ts` | editor | 86 | 4 | no |
| `src/editor/portal-widget.ts` | editor | 510 | 5 | yes |
| `src/editor/stopwatch-widget.ts` | editor | 273 | 3 | no |
| `src/editor/view-registry.ts` | editor | 65 | 6 | yes |
| `src/entries/clock.ts` | entries | 131 | 3 | no |
| `src/entries/day-note.ts` | entries | 96 | 3 | yes |
| `src/entries/engine.ts` | entries | 1381 | 1 | yes |
| `src/entries/portals.ts` | entries | 308 | 4 | no |
| `src/entries/session.ts` | entries | 105 | 2 | no |
| `src/entries/writer.ts` | entries | 100 | 5 | yes |
| `src/main.ts` | root | 573 | 1 | yes |
| `src/model/whisper-model.ts` | root | 186 | 6 | yes |
| `src/model/whisper-runner.ts` | root | 227 | 5 | no |
| `src/notices.ts` | root | 166 | 23 | no |
| `src/reading/close-processor.ts` | reading | 39 | 1 | yes |
| `src/reading/entry-processor.ts` | reading | 306 | 1 | yes |
| `src/reading/portals.ts` | reading | 302 | 1 | yes |
| `src/settings-tab.ts` | root | 290 | 1 | yes |
| `src/settings.ts` | root | 253 | 8 | no |
| `src/ui/css.ts` | ui | 80 | 4 | no |
| `src/ui/day-link.ts` | ui | 51 | 2 | no |
| `src/ui/dcn.ts` | ui | 74 | 6 | no |
| `src/ui/navigator.ts` | ui | 811 | 1 | no |
| `src/ui/platform.ts` | ui | 38 | 4 | yes |
| `src/ui/portal.ts` | ui | 723 | 10 | no |

### Commands

| id | name | icon | hotkey |
| --- | --- | --- | --- |
| `weaver:start-entry` | Start an entry | `plus` | `Mod,Shift+E` |
| `weaver:descend` | Descend into a child entry | `arrow-down-right` | — |
| `weaver:navigate` | Today's entries | `list` | `Mod,Shift+P` |
| `weaver:whisper-day` | Whisper the day | `sparkles` | — |
| `weaver:close-day` | Close the day | `check-circle` | — |

### Settings

| field | default | read in |
| --- | --- | --- |
| `writeDayCounters` | `true` | `main.ts`<br>`settings-tab.ts` |
| `portalsEnabled` | `true` | `editor/portal-widget.ts`<br>`main.ts`<br>`settings-tab.ts`<br>`ui/navigator.ts` |
| `dayNoteFolder` | `"Chronomancer"` | `entries/day-note.ts`<br>`settings-tab.ts` |
| `dayNoteFormat` | `"YYYY.MM.DD"` | `entries/day-note.ts`<br>`settings-tab.ts` |
| `equalizeEntrySizes` | `true` | `main.ts`<br>`settings-tab.ts` |
| `entrySize` | `"1em"` | `settings-tab.ts`<br>`ui/css.ts` |
| `indentStep` | `18` | `settings-tab.ts`<br>`ui/css.ts` |
| `mobileIndentStep` | `12` | `settings-tab.ts`<br>`ui/css.ts` |
| `indentMaxLevel` | `8` | `settings-tab.ts`<br>`ui/css.ts` |
| `portEmphasisColors` | `true` | `main.ts`<br>`settings-tab.ts` |
| `entryFrames` | `true` | `editor/entry-frame.ts`<br>`editor/portal-widget.ts`<br>`reading/portals.ts`<br>`settings-tab.ts` |
| `frameFollowsIndent` | `true` | `main.ts`<br>`settings-tab.ts` |
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
| `weaver-alignments` | hook | `core/alignments.ts`<br>`core/portal-history.ts`<br>`ui/navigator.ts` |
| `weaver-close-mark` | styled | `reading/close-processor.ts` |
| `weaver-close-mark-line` | styled | `editor/close-decorations.ts` |
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
| `weaver-frame-label` | styled | `editor/entry-decorations.ts`<br>`editor/entry-frame.ts`<br>`editor/stopwatch-widget.ts`<br>`reading/entry-processor.ts`<br>`ui/day-link.ts`<br>`ui/portal.ts` |
| `weaver-frame-layer` | styled | `editor/entry-frame.ts` |
| `weaver-navigator` | styled | `ui/navigator.ts` |
| `weaver-navigator-append` | styled | `ui/navigator.ts` |
| `weaver-navigator-card` | styled | `ui/navigator.ts` |
| `weaver-navigator-count` | styled | `ui/navigator.ts` |
| `weaver-navigator-dcn` | styled | `ui/navigator.ts` |
| `weaver-navigator-delete` | styled | `ui/navigator.ts` |
| `weaver-navigator-entry` | hook | `ui/navigator.ts` |
| `weaver-navigator-hint` | styled | `ui/navigator.ts` |
| `weaver-navigator-hint-keys` | styled | `ui/navigator.ts` |
| `weaver-navigator-hint-touch` | styled | `ui/navigator.ts` |
| `weaver-navigator-label` | styled | `ui/navigator.ts` |
| `weaver-navigator-list` | styled | `ui/navigator.ts` |
| `weaver-navigator-open` | styled | `ui/navigator.ts` |
| `weaver-navigator-portal` | styled | `ui/navigator.ts` |
| `weaver-navigator-portal-label` | styled | `ui/navigator.ts` |
| `weaver-navigator-portal-moment` | styled | `ui/navigator.ts` |
| `weaver-navigator-portal-time` | styled | `ui/navigator.ts` |
| `weaver-navigator-portal-unavailable` | styled | `ui/navigator.ts` |
| `weaver-navigator-portals-all` | styled | `ui/navigator.ts` |
| `weaver-navigator-portals-error` | styled | `ui/navigator.ts` |
| `weaver-navigator-portals-note` | styled | `ui/navigator.ts` |
| `weaver-navigator-portals-toggle` | styled | `ui/navigator.ts` |
| `weaver-navigator-row` | styled | `ui/navigator.ts` |
| `weaver-navigator-stop` | hook | `ui/navigator.ts` |
| `weaver-navigator-time` | styled | `ui/navigator.ts` |
| `weaver-navigator-title` | styled | `ui/navigator.ts` |
| `weaver-no-emphasis` | styled | `main.ts`<br>`ui/css.ts` |
| `weaver-phone` | styled | `main.ts` |
| `weaver-platform-mobile` | body state | `main.ts` |
| `weaver-portal` | styled | `editor/entry-frame.ts`<br>`ui/portal.ts` |
| `weaver-portal-clock` | styled | `ui/portal.ts` |
| `weaver-portal-countdown` | styled | `ui/portal.ts` |
| `weaver-portal-footer` | styled | `ui/portal.ts` |
| `weaver-portal-input` | styled | `ui/portal.ts` |
| `weaver-portal-label` | styled | `ui/portal.ts` |
| `weaver-portal-lock` | styled | `ui/portal.ts` |
| `weaver-portal-prepare` | styled | `ui/portal.ts` |
| `weaver-portal-refusal` | styled | `ui/portal.ts` |
| `weaver-portal-tray` | styled | `ui/portal.ts` |
| `weaver-settings` | styled | `settings-tab.ts` |
| `weaver-style` | hook | `ui/css.ts` |
| `weaver-tablet` | body state | `main.ts` |
| `weaver-unequal` | styled | `main.ts`<br>`ui/css.ts` |

**Dead CSS check.** Every class styled in `styles.css` must be written by the code. Unstyled rules right now: none.

| attribute | written in |
| --- | --- |
| `data-weaver-close-processed` | `reading/close-processor.ts` |
| `data-weaver-d` | `reading/entry-processor.ts` |
| `data-weaver-entry-processed` | `reading/entry-processor.ts` |
| `data-weaver-n` | `editor/entry-decorations.ts`<br>`editor/entry-frame.ts`<br>`editor/stopwatch-widget.ts` |
| `data-weaver-portal` | `ui/portal.ts` |
| `data-weaver-portal-tray` | `editor/entry-frame.ts`<br>`ui/portal.ts` |

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
| `src/editor/duration-ticker.ts` | 0 | 2 |
| `src/editor/editor-path.ts` | 0 | 1 |
| `src/editor/entry-frame.ts` | 0 | 3 |
| `src/entries/engine.ts` | 0 | 1 |
| `src/reading/portals.ts` | 0 | 1 |
| `src/ui/css.ts` | 0 | 4 |
| `src/ui/dcn.ts` | 0 | 6 |

Modules with no symbol named by any test: 8.

### Symbols

One table per module. `used by` is a textual reference from another file — a caller, a type annotation, a test — not a resolved call graph; this repository has no compiler API to resolve one, and the document must not claim what it cannot show.

#### `src/core/alignments.ts`

Portal history: the openings a day note actually entered, and the frontmatter

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `ALIGNMENTS_KEY` | const | 23 | `export const ALIGNMENTS_KEY = "weaver-alignments"` | — | — |
| `AlignmentRecord` | interface | 35 | `export interface AlignmentRecord` | `core/insert.ts`<br>`core/portal-history.ts` | `tests/alignments.test.ts`<br>`tests/navigator.test.ts`<br>`tests/portal-history.test.ts` |
| `AlignmentRead` | type | 43 | `export type AlignmentRead = \|` | — | — |
| `AlignmentWrite` | type | 48 | `export type AlignmentWrite = \|` | — | — |
| `formatLocalTimestamp` | function | 88 | `export function formatLocalTimestamp(date: Date): string` | `core/insert.ts` | `tests/alignments.test.ts`<br>`tests/navigator.test.ts`<br>`tests/portal-controller.test.ts`<br>`tests/reading-portals.test.ts` |
| `readAlignments` | function | 348 | `export function readAlignments(source: string): AlignmentRead` | `core/insert.ts`<br>`core/portal-history.ts`<br>`entries/engine.ts`<br>`entries/portals.ts`<br>`main.ts` | `tests/alignments.test.ts`<br>`tests/entry-plans.test.ts`<br>`tests/writer.test.ts` |
| `mergeAlignment` | function | 442 | `export function mergeAlignment(source: string, record: AlignmentRecord): AlignmentWrite` | `core/insert.ts` | `tests/alignments.test.ts`<br>`tests/portal-controller.test.ts` |
| `detachAlignments` | function | 470 | `export function detachAlignments(source: string, deleted: ReadonlySet<number>): AlignmentWrite` | `core/insert.ts` | `tests/alignments.test.ts` |

#### `src/core/clock.ts`

Pads a clock component to two digits.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `pad2` | function | 2 | `export function pad2(value: number): string` | `core/alignments.ts`<br>`core/day.ts`<br>`core/insert.ts`<br>`core/portal-history.ts`<br>`main.ts`<br>`ui/navigator.ts`<br>`ui/portal.ts` | `tests/clock.test.ts` |
| `formatClock` | function | 11 | `export function formatClock(date: Date): string` | `core/close.ts`<br>`core/day-stats.ts`<br>`core/duration.ts`<br>`core/insert.ts`<br>`editor/duration-ticker.ts`<br>`editor/stopwatch-widget.ts`<br>`main.ts`<br>`reading/entry-processor.ts`<br>`ui/portal.ts` | `tests/clock.test.ts`<br>`tests/duration.test.ts`<br>`tests/entry-plans.test.ts` |

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
| `dimensionColor` | function | 108 | `export function dimensionColor(d: number): string` | `editor/entry-decorations.ts`<br>`editor/entry-frame.ts` | `tests/color.test.ts` |
| `dimensionColorVars` | function | 119 | `export function dimensionColorVars(d: number): string` | `editor/entry-decorations.ts`<br>`reading/entry-processor.ts`<br>`ui/navigator.ts` | `tests/color.test.ts` |

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
| `DayNoteOptions` | interface | 19 | `export interface DayNoteOptions` | `entries/day-note.ts` | — |
| `dayKey` | function | 25 | `export function dayKey(now: Date): string` | `core/insert.ts`<br>`core/portals.ts`<br>`entries/day-note.ts`<br>`main.ts` | `tests/day-note.test.ts`<br>`tests/entry-plans.test.ts`<br>`tests/portal-controller.test.ts` |
| `dayNotePath` | function | 30 | `export function dayNotePath(now: Date, options: DayNoteOptions): string` | `entries/day-note.ts` | `tests/day-note.test.ts`<br>`tests/reading-portals.test.ts`<br>`tests/start-entry.test.ts` |
| `dayKeyFromName` | function | 43 | `export function dayKeyFromName(basename: string): string \| null` | `entries/engine.ts` | `tests/day-note.test.ts` |
| `entryDayLinkTarget` | function | 55 | `export function entryDayLinkTarget(day: string \| null, basename: string): string \| null` | `editor/entry-decorations.ts`<br>`reading/entry-processor.ts` | `tests/day-note.test.ts` |
| `dayFrontmatter` | function | 62 | `export function dayFrontmatter(day: string): string` | `entries/day-note.ts` | `tests/day-note.test.ts` |

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
| `formatClock` | function | 36 | `export function formatClock(ms: number): string` | `core/clock.ts`<br>`core/close.ts`<br>`core/day-stats.ts`<br>`core/insert.ts`<br>`editor/duration-ticker.ts`<br>`editor/stopwatch-widget.ts`<br>`main.ts`<br>`reading/entry-processor.ts`<br>`ui/portal.ts` | `tests/clock.test.ts`<br>`tests/duration.test.ts`<br>`tests/entry-plans.test.ts` |
| `formatDurationLine` | function | 41 | `export function formatDurationLine(sigil: DurationSigil, ms: number): string` | `core/insert.ts` | — |
| `ClockRow` | interface | 56 | `export interface ClockRow` | `reading/entry-processor.ts` | — |
| `parseClockRow` | function | 98 | `export function parseClockRow(text: string): ClockRow \| null` | `core/entries.ts`<br>`core/insert.ts`<br>`reading/entry-processor.ts` | `tests/duration.test.ts` |
| `formatClockRow` | function | 146 | `export function formatClockRow( time: string \| null, sigil: DurationSigil, ms: number, day: string \| null ): string` | `core/insert.ts` | `tests/duration.test.ts` |

#### `src/core/entries.ts`

The entry: the unit a day note is made of.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `Entry` | interface | 36 | `export interface Entry` | `core/insert.ts`<br>`core/portal-history.ts`<br>`editor/entry-decorations.ts`<br>`editor/entry-keys.ts`<br>`entries/engine.ts`<br>`settings-tab.ts`<br>`ui/navigator.ts` | `tests/navigator.test.ts`<br>`tests/settings-tab.test.ts` |
| `EntryIndex` | interface | 85 | `export interface EntryIndex` | `core/day-stats.ts`<br>`core/insert.ts`<br>`core/portal-history.ts`<br>`editor/entry-field.ts`<br>`editor/entry-keys.ts`<br>`entries/engine.ts`<br>`ui/navigator.ts` | — |
| `MarkerPrefix` | interface | 113 | `export interface MarkerPrefix` | — | — |
| `parseMarkerPrefix` | function | 128 | `export function parseMarkerPrefix(text: string): MarkerPrefix \| null` | `reading/entry-processor.ts` | — |
| `parseEntries` | function | 166 | `export function parseEntries(source: string): EntryIndex` | `core/close.ts`<br>`core/day-stats.ts`<br>`core/insert.ts`<br>`core/portal-history.ts`<br>`editor/entry-field.ts`<br>`editor/entry-keys.ts`<br>`entries/engine.ts`<br>`main.ts`<br>`reading/entry-processor.ts`<br>`ui/navigator.ts` | `tests/color.test.ts`<br>`tests/day-stats.test.ts`<br>`tests/entries.test.ts`<br>`tests/entry-keys.test.ts`<br>`tests/entry-plans.test.ts`<br>`tests/portal-history.test.ts`<br>`tests/record-format.test.ts`<br>`tests/start-entry.test.ts`<br>`tests/stopped-clock-render.test.ts`<br>`tests/whisper-act.test.ts`<br>`tests/whisper.test.ts`<br>`tests/writer.test.ts` |
| `findEntryAtLine` | function | 344 | `export function findEntryAtLine(index: EntryIndex, line: number): Entry \| null` | — | `tests/entries.test.ts` |
| `findEntryAtOffset` | function | 353 | `export function findEntryAtOffset(index: EntryIndex, offset: number): Entry \| null` | `editor/entry-keys.ts`<br>`entries/engine.ts` | `tests/entries.test.ts` |
| `findCurrentEntry` | function | 361 | `export function findCurrentEntry(index: EntryIndex, line: number): Entry \| null` | `ui/navigator.ts` | `tests/entries.test.ts` |
| `entryBySeq` | function | 371 | `export function entryBySeq(index: EntryIndex, n: number): Entry \| null` | `core/portal-history.ts`<br>`editor/entry-keys.ts`<br>`entries/engine.ts`<br>`main.ts`<br>`ui/navigator.ts` | `tests/entries.test.ts` |
| `childrenOf` | function | 379 | `export function childrenOf(index: EntryIndex, entry: Entry \| null): Entry[]` | `core/insert.ts`<br>`ui/navigator.ts` | `tests/entries.test.ts` |
| `endOfSubtree` | function | 385 | `export function endOfSubtree(index: EntryIndex, entry: Entry): number` | `core/insert.ts` | — |
| `nextSeq` | function | 390 | `export function nextSeq(index: EntryIndex): number` | `core/insert.ts`<br>`entries/engine.ts` | `tests/entries.test.ts` |
| `nextBranch` | function | 395 | `export function nextBranch(index: EntryIndex): number` | `core/insert.ts` | `tests/entries.test.ts` |
| `formatMarker` | function | 400 | `export function formatMarker(b: number, d: number, n: number): string` | `core/insert.ts`<br>`entries/engine.ts` | `tests/entries.test.ts` |
| `repairBranches` | function | 411 | `export function repairBranches(index: EntryIndex): TextChange[]` | `core/insert.ts` | `tests/entries.test.ts` |

#### `src/core/frame.ts`

The frame around one entry: a box, and nothing else.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `frameLabelInset` | function | 25 | `export function frameLabelInset(fontSize: number): number` | `editor/entry-frame.ts` | — |
| `FrameColumn` | interface | 30 | `export interface FrameColumn` | `editor/entry-frame.ts` | `tests/frame.test.ts` |
| `FrameColumnInput` | interface | 36 | `export interface FrameColumnInput` | — | — |
| `frameColumn` | function | 55 | `export function frameColumn(input: FrameColumnInput): FrameColumn` | `editor/entry-frame.ts` | `tests/frame.test.ts` |
| `FrameBoxInput` | interface | 63 | `export interface FrameBoxInput` | — | — |
| `FrameBox` | interface | 72 | `export interface FrameBox` | — | — |
| `frameBox` | function | 85 | `export function frameBox(input: FrameBoxInput): FrameBox` | `editor/entry-frame.ts` | `tests/frame.test.ts` |
| `TrayFrame` | interface | 98 | `export interface TrayFrame` | — | — |
| `trayFrame` | function | 110 | `export function trayFrame(input:` | `editor/entry-frame.ts` | `tests/frame.test.ts` |
| `FrameSpanInput` | interface | 126 | `export interface FrameSpanInput` | — | — |
| `FrameSpan` | interface | 138 | `export interface FrameSpan` | — | `tests/frame.test.ts` |
| `frameSpan` | function | 159 | `export function frameSpan(input: FrameSpanInput): FrameSpan` | `editor/entry-frame.ts` | `tests/frame.test.ts` |

#### `src/core/insert.ts`

The plans that write entry text, and the arithmetic every plan shares.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `TextChange` | interface | 40 | `export interface TextChange` | `core/entries.ts`<br>`entries/engine.ts`<br>`entries/writer.ts` | — |
| `InsertPlan` | interface | 47 | `export interface InsertPlan` | `core/close.ts`<br>`entries/engine.ts`<br>`entries/writer.ts` | `tests/entry-plans.test.ts` |
| `planAppendLine` | function | 71 | `export function planAppendLine(source: string, text: string, caret: number = text.length): InsertPlan` | `core/close.ts` | — |
| `planStartEntry` | function | 106 | `export function planStartEntry(source: string, index: EntryIndex): InsertPlan \| null` | `entries/engine.ts` | `tests/entry-plans.test.ts`<br>`tests/writer.test.ts` |
| `planChildEntry` | function | 131 | `export function planChildEntry( _source: string, index: EntryIndex, parent: Entry ): InsertPlan \| null` | `entries/engine.ts` | `tests/entry-plans.test.ts` |
| `planEntryBeginning` | function | 190 | `export function planEntryBeginning( _source: string, index: EntryIndex, entry: Entry, beganAt: Date ): InsertPlan \| null` | `entries/engine.ts` | `tests/entry-plans.test.ts` |
| `planPortalEntry` | function | 262 | `export function planPortalEntry( source: string, index: EntryIndex, portal: PortalInstant, beganAt: Date, text: string ): InsertPlan \| null` | `entries/engine.ts` | `tests/entry-plans.test.ts`<br>`tests/portal-history.test.ts`<br>`tests/writer.test.ts` |
| `planDeleteEntry` | function | 347 | `export function planDeleteEntry( source: string, index: EntryIndex, entry: Entry ): InsertPlan \| null` | `entries/engine.ts` | `tests/entry-plans.test.ts` |
| `planDuration` | function | 410 | `export function planDuration( _source: string, index: EntryIndex, entry: Entry, sigil: DurationSigil, ms: number ): InsertPlan \| null` | `entries/engine.ts` | `tests/entry-plans.test.ts`<br>`tests/writer.test.ts` |
| `planWhisper` | function | 455 | `export function planWhisper( _source: string, index: EntryIndex, entry: Entry, whisper: readonly WhisperItem[] ): InsertPlan \| null` | `entries/engine.ts` | `tests/entry-plans.test.ts` |
| `planThread` | function | 484 | `export function planThread( source: string, index: EntryIndex, entry: Entry, item: WhisperItem ): InsertPlan \| null` | `entries/engine.ts` | — |
| `offsetToLineCh` | function | 507 | `export function offsetToLineCh(source: string, offset: number):` | `entries/engine.ts` | — |
| `cmChanges` | function | 520 | `export function cmChanges( changes: readonly TextChange[] ):` | `entries/engine.ts`<br>`entries/writer.ts` | `tests/entry-plans.test.ts` |
| `applyPlanToSource` | function | 527 | `export function applyPlanToSource(source: string, plan: InsertPlan):` | `entries/engine.ts`<br>`entries/writer.ts`<br>`main.ts` | `tests/close.test.ts`<br>`tests/entry-plans.test.ts` |

#### `src/core/navigator-stack.ts`

The return stack: where a jump came from.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `Stop` | interface | 11 | `export interface Stop` | `entries/engine.ts`<br>`main.ts`<br>`ui/navigator.ts` | `tests/navigator-stack.test.ts`<br>`tests/navigator.test.ts` |
| `STACK_LIMIT` | const | 19 | `export const STACK_LIMIT = 8` | — | `tests/navigator-stack.test.ts` |
| `pushStop` | function | 27 | `export function pushStop(stops: readonly Stop[], stop: Stop, limit = STACK_LIMIT): Stop[]` | `entries/engine.ts` | `tests/navigator-stack.test.ts` |
| `popStop` | function | 36 | `export function popStop(stops: readonly Stop[]):` | `ui/navigator.ts` | `tests/navigator-stack.test.ts` |

#### `src/core/portal-history.ts`

The day's portal history, as rows a surface can list.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `RecordedPortalHistoryRow` | interface | 123 | `export interface RecordedPortalHistoryRow` | — | — |
| `OpeningPortalHistoryRow` | interface | 136 | `export interface OpeningPortalHistoryRow` | — | — |
| `PortalHistoryRow` | type | 145 | `export type PortalHistoryRow = RecordedPortalHistoryRow \| OpeningPortalHistoryRow` | `ui/navigator.ts` | `tests/portal-history.test.ts` |
| `PortalHistory` | type | 148 | `export type PortalHistory = \|` | — | — |
| `linkedPortalEntry` | function | 161 | `export function linkedPortalEntry(record: AlignmentRecord, index: EntryIndex): Entry \| null` | `ui/navigator.ts` | `tests/portal-history.test.ts` |
| `portalHistoryRows` | function | 252 | `export function portalHistoryRows( source: string, now: number, showAll: boolean ): PortalHistory` | `ui/navigator.ts` | `tests/portal-history.test.ts` |

#### `src/core/portals.ts`

Local openings are epoch instants, so daylight-saving gaps and repeats stay real.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `PortalInstant` | interface | 5 | `export interface PortalInstant` | `core/insert.ts`<br>`core/portal-history.ts`<br>`editor/portal-widget.ts`<br>`entries/portals.ts`<br>`reading/portals.ts`<br>`ui/portal.ts` | `tests/entry-plans.test.ts`<br>`tests/portal-controller.test.ts`<br>`tests/portal-surface.test.ts` |
| `AlignmentKind` | type | 15 | `export type AlignmentKind = "boundary" \| "hour-echo" \| "minute-echo"` | `core/portal-history.ts` | — |
| `portalInstants` | function | 18 | `export function portalInstants(fromMs: number, toMs: number): PortalInstant[]` | `core/portal-history.ts`<br>`entries/portals.ts` | `tests/entry-plans.test.ts`<br>`tests/portal-controller.test.ts`<br>`tests/portal-history.test.ts`<br>`tests/portals.test.ts`<br>`tests/writer.test.ts` |
| `portalAlignments` | function | 33 | `export function portalAlignments(portal: PortalInstant, beganAt: number): readonly AlignmentKind[]` | `core/portal-history.ts`<br>`entries/engine.ts` | `tests/portals.test.ts` |
| `portalPhase` | function | 43 | `export function portalPhase(portal: PortalInstant, now: number, held: boolean): "approaching" \| "open" \| "held" \| "expired"` | `core/portal-history.ts`<br>`editor/portal-widget.ts`<br>`entries/engine.ts`<br>`entries/portals.ts` | `tests/portals.test.ts` |

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
| `writeClockText` | function | 12 | `export function writeClockText(digits: readonly HTMLElement[], clock: string): void` | `editor/stopwatch-widget.ts`<br>`reading/entry-processor.ts`<br>`ui/portal.ts` | — |
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
| `entryDecorationSet` | function | 129 | `export function entryDecorationSet( state: EditorState, session: EntrySession, path: string, clock: EntryClock, openDayLink?: OpenDayLink ): DecorationSet` | — | `tests/entry-decorations.test.ts` |
| `entryDecorationsExtension` | function | 277 | `export function entryDecorationsExtension( getSession: () => EntrySession, getPath: () => string, getClock: () => EntryClock, openDayLink?: OpenDayLink ): Extension` | `main.ts` | `tests/stopped-clock-render.test.ts` |

#### `src/editor/entry-field.ts`

The entry index as editor state: one parse per document change, shared by the

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `refreshEntriesEffect` | const | 11 | `export const refreshEntriesEffect = StateEffect.define<void>()` | `editor/close-decorations.ts`<br>`editor/entry-decorations.ts`<br>`entries/engine.ts`<br>`main.ts` | `tests/entry-field.test.ts` |
| `programmaticWrite` | const | 22 | `export const programmaticWrite = Annotation.define<boolean>()` | `editor/entry-keys.ts`<br>`entries/engine.ts`<br>`entries/writer.ts`<br>`main.ts`<br>`ui/navigator.ts` | — |
| `InputObservation` | interface | 33 | `export interface InputObservation` | `editor/entry-keys.ts`<br>`entries/engine.ts` | — |
| `capturedInput` | const | 44 | `export const capturedInput = Annotation.define<InputObservation>()` | `editor/entry-keys.ts`<br>`entries/engine.ts` | `tests/entry-keys.test.ts`<br>`tests/start-entry.test.ts` |
| `entryIndexField` | const | 47 | `export const entryIndexField = StateField.define<EntryIndex>(` | `editor/close-decorations.ts`<br>`editor/entry-decorations.ts`<br>`editor/entry-frame.ts`<br>`editor/entry-keys.ts`<br>`entries/engine.ts` | `tests/close-decorations.test.ts`<br>`tests/entry-decorations.test.ts`<br>`tests/entry-field.test.ts`<br>`tests/entry-keys.test.ts`<br>`tests/plugin.test.ts`<br>`tests/start-entry.test.ts`<br>`tests/stopped-clock-render.test.ts` |
| `entryIndexExtension` | function | 59 | `export function entryIndexExtension(): Extension` | `main.ts` | — |

#### `src/editor/entry-frame.ts`

The frame around every entry, drawn.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `FrameHost` | interface | 57 | `export interface FrameHost` | — | — |
| `remeasureFrames` | function | 165 | `export function remeasureFrames(view: EditorView): void` | `editor/portal-widget.ts` | — |
| `entryFrameExtension` | function | 474 | `export function entryFrameExtension(host: FrameHost): Extension` | `main.ts` | — |

#### `src/editor/entry-keys.ts`

The two keys an entry owns, and the two edit events that keep the stopwatch

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `ENTRY_KEYS` | const | 49 | `export const ENTRY_KEYS = ["Mod-Shift-E", "Enter"] as const` | `main.ts` | `tests/entry-keys.test.ts` |
| `EntryKeyHost` | interface | 52 | `export interface EntryKeyHost` | — | `tests/entry-keys.test.ts` |
| `EntryEditHost` | interface | 71 | `export interface EntryEditHost extends EntryKeyHost` | — | `tests/entry-keys.test.ts` |
| `enterableEntry` | function | 94 | `export function enterableEntry(view: EditorView, _host: EntryKeyHost): Entry \| null` | — | `tests/entry-keys.test.ts` |
| `handleEnterKey` | function | 102 | `export function handleEnterKey(view: EditorView, host: EntryKeyHost): boolean` | — | `tests/entry-keys.test.ts` |
| `handleStartKey` | function | 117 | `export function handleStartKey(_view: EditorView, host: EntryKeyHost): boolean` | — | `tests/entry-keys.test.ts` |
| `shouldPinStopwatch` | function | 127 | `export function shouldPinStopwatch(input:` | — | `tests/entry-keys.test.ts` |
| `maybePinStopwatch` | function | 137 | `export function maybePinStopwatch(view: EditorView, host: EntryEditHost, phone = isPhone()): boolean` | — | — |
| `entryKeysExtension` | function | 171 | `export function entryKeysExtension(host: EntryKeyHost): Extension` | `main.ts` | — |
| `inputObservation` | function | 194 | `export function inputObservation( transactions: readonly Transaction[], context:` | — | `tests/entry-keys.test.ts`<br>`tests/start-entry.test.ts` |
| `compositionCommit` | function | 239 | `export function compositionCommit(host: Pick<EntryEditHost, "entries">):` | — | `tests/entry-keys.test.ts` |
| `replacedDocument` | function | 317 | `export function replacedDocument(transactions: readonly Transaction[]): boolean` | — | `tests/entry-keys.test.ts` |
| `PendingInput` | interface | 335 | `export interface PendingInput` | — | — |
| `InputLedger` | class | 350 | `export class InputLedger` | — | `tests/entry-keys.test.ts` |
| `entryEditExtension` | function | 374 | `export function entryEditExtension(host: EntryEditHost): Extension` | `main.ts` | `tests/entry-keys.test.ts` |

#### `src/editor/frame-effects.ts`

What a drawn frame can be doing, and which single effect shows it.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `FrameActivity` | interface | 14 | `export interface FrameActivity` | — | — |
| `FrameEffect` | interface | 26 | `export interface FrameEffect` | — | — |
| `FRAME_EFFECTS` | const | 52 | `export const FRAME_EFFECTS: readonly FrameEffect[] = [` | `editor/entry-frame.ts` | `tests/frame-effects.test.ts` |
| `frameEffect` | function | 76 | `export function frameEffect(activity: FrameActivity): FrameEffect \| null` | `editor/entry-frame.ts` | `tests/frame-effects.test.ts` |

#### `src/editor/portal-widget.ts`

Pending portals in Live Preview: one block tray at the end of today's note.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `PortalWidgetHost` | interface | 54 | `export interface PortalWidgetHost` | — | `tests/portal-widget.test.ts` |
| `PortalTray` | class | 105 | `export class PortalTray` | — | `tests/portal-widget.test.ts` |
| `portalExtension` | function | 447 | `export function portalExtension(host: PortalWidgetHost): Extension` | `main.ts` | — |
| `focusPortal` | function | 487 | `export function focusPortal(view: EditorView, id: string): boolean` | `entries/engine.ts` | `tests/portal-widget.test.ts` |
| `trayDecorations` | function | 497 | `export function trayDecorations(host: PortalWidgetHost, state: EditorState): DecorationSet` | — | `tests/portal-widget.test.ts` |

#### `src/editor/stopwatch-widget.ts`

The rendered clock row.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `ClockMode` | type | 52 | `export type ClockMode = "fixed" \| "awaiting" \| "running"` | `editor/entry-decorations.ts` | — |
| `DurationWidgetInput` | interface | 55 | `export interface DurationWidgetInput` | — | `tests/stopwatch-widget.test.ts` |
| `DurationWidget` | class | 82 | `export class DurationWidget extends WidgetType` | `editor/entry-decorations.ts` | `tests/entry-decorations.test.ts`<br>`tests/stopped-clock-render.test.ts`<br>`tests/stopwatch-widget.test.ts` |

#### `src/editor/view-registry.ts`

The live editor views, in one place.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `registerEditorView` | function | 15 | `export function registerEditorView(view: EditorView): void` | — | `tests/entry-keys.test.ts`<br>`tests/start-entry.test.ts`<br>`tests/stopped-clock-render.test.ts`<br>`tests/whisper-act.test.ts`<br>`tests/writer.test.ts` |
| `unregisterEditorView` | function | 20 | `export function unregisterEditorView(view: EditorView): void` | — | `tests/entry-keys.test.ts`<br>`tests/start-entry.test.ts`<br>`tests/stopped-clock-render.test.ts`<br>`tests/whisper-act.test.ts`<br>`tests/writer.test.ts` |
| `viewRegistryExtension` | const | 25 | `export const viewRegistryExtension = ViewPlugin.fromClass( class` | `main.ts` | — |
| `registeredEditorViews` | function | 38 | `export function registeredEditorViews(): readonly EditorView[]` | `editor/entry-keys.ts`<br>`entries/engine.ts`<br>`main.ts` | — |
| `findEditorViewForFile` | function | 43 | `export function findEditorViewForFile(file: TFile): EditorView \| null` | `entries/engine.ts`<br>`entries/writer.ts` | — |
| `findActiveEditorView` | function | 57 | `export function findActiveEditorView(app: App): EditorView \| null` | `entries/engine.ts` | — |

#### `src/entries/clock.ts`

The one clock a running stopwatch is read through.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `ClockSnapshot` | interface | 27 | `export interface ClockSnapshot` | — | — |
| `ClockListener` | type | 35 | `export type ClockListener = (now: number, durationMs: number) => void` | — | — |
| `EntryClock` | class | 41 | `export class EntryClock` | `editor/duration-ticker.ts`<br>`editor/entry-decorations.ts`<br>`editor/portal-widget.ts`<br>`editor/stopwatch-widget.ts`<br>`main.ts`<br>`reading/entry-processor.ts`<br>`reading/portals.ts` | `tests/entry-clock.test.ts`<br>`tests/entry-decorations.test.ts`<br>`tests/entry-processor.test.ts`<br>`tests/portal-widget.test.ts`<br>`tests/stopwatch-widget.test.ts` |

#### `src/entries/day-note.ts`

The day plane, resolved against the vault: which file today's note is, and how

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `dayNoteOptions` | function | 60 | `export function dayNoteOptions(app: App, settings: WeaverSettings): DayNoteOptions` | — | — |
| `resolveDayNote` | function | 67 | `export function resolveDayNote( app: App, settings: WeaverSettings, now: Date ):` | `entries/engine.ts`<br>`main.ts` | `tests/day-note.test.ts` |
| `ensureDayNote` | function | 82 | `export async function ensureDayNote(app: App, path: string, now: Date): Promise<TFile>` | `entries/engine.ts` | `tests/day-note.test.ts` |

#### `src/entries/engine.ts`

The editor path that changes an entry.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `EntryEngine` | class | 112 | `export class EntryEngine` | `main.ts` | — |

#### `src/entries/portals.ts`

Portal lifecycle: which openings are showing now, which one is prepared, and

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `PortalHost` | interface | 37 | `export interface PortalHost` | — | `tests/portal-controller.test.ts`<br>`tests/portal-widget.test.ts` |
| `PortalStatus` | type | 53 | `export type PortalStatus = "approaching" \| "open" \| "held" \| "expired"` | — | — |
| `PortalHold` | interface | 56 | `export interface PortalHold` | — | — |
| `PortalController` | class | 70 | `export class PortalController` | `editor/portal-widget.ts`<br>`main.ts` | `tests/portal-controller.test.ts`<br>`tests/portal-widget.test.ts` |

#### `src/entries/session.ts`

The live stopwatch: at most one entry is being written at a time.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `ActiveEntry` | interface | 16 | `export interface ActiveEntry` | — | — |
| `EntrySession` | class | 32 | `export class EntrySession` | `editor/entry-decorations.ts`<br>`editor/entry-frame.ts`<br>`editor/entry-keys.ts`<br>`entries/clock.ts`<br>`entries/engine.ts`<br>`main.ts` | `tests/entry-clock.test.ts`<br>`tests/entry-decorations.test.ts`<br>`tests/entry-keys.test.ts`<br>`tests/entry-processor.test.ts`<br>`tests/navigator.test.ts`<br>`tests/portal-widget.test.ts`<br>`tests/session.test.ts`<br>`tests/stopwatch-widget.test.ts` |

#### `src/entries/writer.ts`

The one writer of a day note.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `RewriteResult` | interface | 28 | `export interface RewriteResult` | — | — |
| `Rewrite` | type | 36 | `export type Rewrite = (source: string) => RewriteResult \| null` | `settings.ts` | — |
| `rewriteDay` | function | 45 | `export async function rewriteDay( app: App, file: TFile, rewrite: Rewrite, undoable: boolean ): Promise<RewriteResult \| null>` | `entries/engine.ts`<br>`main.ts` | `tests/writer.test.ts` |
| `planRewrite` | function | 73 | `export function planRewrite(build: (source: string) => InsertPlan \| null): Rewrite` | `entries/engine.ts` | `tests/writer.test.ts` |
| `minimalChange` | function | 86 | `export function minimalChange(before: string, after: string): TextChange[]` | `core/insert.ts`<br>`main.ts` | `tests/writer.test.ts` |

#### `src/main.ts`

Weaver: a day note is a linear list of entries.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `WeaverPlugin` | class | 76 | `export default class WeaverPlugin extends Plugin` | `entries/engine.ts`<br>`reading/portals.ts`<br>`settings-tab.ts`<br>`ui/navigator.ts` | `tests/navigator.test.ts`<br>`tests/platform-classes.test.ts`<br>`tests/plugin.test.ts`<br>`tests/reading-portals.test.ts`<br>`tests/settings-tab.test.ts`<br>`tests/start-entry.test.ts`<br>`tests/stopped-clock-render.test.ts`<br>`tests/whisper-act.test.ts` |

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
| `noticePortal` | function | 34 | `export function noticePortal(time: string, remainingSeconds: number): string` | `main.ts` | `tests/notices.test.ts` |
| `noticePortalRefused` | function | 48 | `export function noticePortalRefused(reason: string): string` | `entries/engine.ts` | — |
| `NOTICE_PORTAL_UNAVAILABLE` | const | 53 | `export const NOTICE_PORTAL_UNAVAILABLE = `Weaver: that portal is no longer open. $` | `entries/engine.ts` | — |
| `NOTICE_STOP_FAILED` | const | 59 | `export const NOTICE_STOP_FAILED = "Weaver: the stopped time could not be saved; the clock is held where it stopped. Check the vault is writable, then stop again."` | `entries/engine.ts` | `tests/start-entry.test.ts` |
| `NOTICE_WHISPERING` | const | 63 | `export const NOTICE_WHISPERING = "Whispering the day…"` | `entries/engine.ts` | `tests/whisper-act.test.ts` |
| `NOTICE_WHISPER_UNREACHABLE` | const | 66 | `export const NOTICE_WHISPER_UNREACHABLE = "No whisper endpoint is reachable from this device."` | `entries/engine.ts` | `tests/whisper-act.test.ts` |
| `WhisperPass` | interface | 69 | `export interface WhisperPass` | — | — |
| `whisperFailurePhrase` | function | 92 | `export function whisperFailurePhrase(failure: WhisperFailure): string` | `entries/engine.ts`<br>`model/whisper-runner.ts` | — |
| `noticeWhispered` | function | 123 | `export function noticeWhispered(pass: WhisperPass): string` | `entries/engine.ts` | `tests/whisper-act.test.ts` |
| `NAVIGATOR_HINT_KEYS` | const | 146 | `export const NAVIGATOR_HINT_KEYS = "↑↓ move · ⏎ jump · ⇧⏎ descend · n start · x delete · ⌘[ back · esc close"` | `ui/navigator.ts` | — |
| `NAVIGATOR_HINT_TOUCH` | const | 150 | `export const NAVIGATOR_HINT_TOUCH = "tap to jump · tap the caret row to descend · ✕ twice deletes"` | `ui/navigator.ts` | — |
| `noticeCloseFrontmatter` | function | 153 | `export function noticeCloseFrontmatter(action: string): string` | `entries/engine.ts` | — |
| `noticeCloseCodeBlock` | function | 158 | `export function noticeCloseCodeBlock(action: string): string` | `entries/engine.ts` | — |
| `noticeLegacyFormat` | function | 163 | `export function noticeLegacyFormat(action: string): string` | `entries/engine.ts`<br>`main.ts` | `tests/start-entry.test.ts` |

#### `src/reading/close-processor.ts`

Reading view: the close mark, muted and labelled.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `createCloseProcessor` | function | 23 | `export function createCloseProcessor(): MarkdownPostProcessor` | `main.ts` | `tests/entry-processor.test.ts` |

#### `src/reading/entry-processor.ts`

Reading view: the same entry the editor draws, in the same frame.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `createEntryProcessor` | function | 132 | `export function createEntryProcessor(openDayLink?: OpenDayLink, clock?: EntryClock): MarkdownPostProcessor` | `main.ts` | `tests/entry-processor.test.ts` |

#### `src/reading/portals.ts`

Portals in Reading view: one tray at the end of each daily note that is open,

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `PortalReadingTray` | class | 61 | `export class PortalReadingTray` | `main.ts` | — |

#### `src/settings-tab.ts`

The settings surface: five groups, every control applied live.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `WeaverSettingTab` | class | 22 | `export class WeaverSettingTab extends PluginSettingTab` | `main.ts` | `tests/settings-tab.test.ts` |

#### `src/settings.ts`

Weaver settings model.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `WeaverSettings` | interface | 15 | `export interface WeaverSettings` | `editor/entry-frame.ts`<br>`editor/portal-widget.ts`<br>`entries/day-note.ts`<br>`main.ts`<br>`ui/css.ts` | — |
| `WeaverData` | interface | 70 | `export interface WeaverData` | `main.ts` | — |
| `DEFAULT_SETTINGS` | const | 76 | `export const DEFAULT_SETTINGS: WeaverSettings =` | `settings-tab.ts` | `tests/day-note.test.ts`<br>`tests/portal-widget.test.ts`<br>`tests/reading-portals.test.ts`<br>`tests/settings.test.ts`<br>`tests/start-entry.test.ts` |
| `isValidEntrySize` | function | 105 | `export function isValidEntrySize(value: string): boolean` | `settings-tab.ts`<br>`ui/css.ts` | — |
| `isValidWhisperEndpoint` | function | 112 | `export function isValidWhisperEndpoint(value: string): boolean` | — | `tests/settings.test.ts` |
| `whisperReachable` | function | 127 | `export function whisperReachable(endpoint: string, mobile: boolean): boolean` | `main.ts` | `tests/settings.test.ts` |
| `normalizeSettings` | function | 192 | `export function normalizeSettings(data: unknown): WeaverSettings` | — | `tests/settings.test.ts` |
| `normalizeData` | function | 238 | `export function normalizeData(data: unknown): WeaverData` | `main.ts` | `tests/settings.test.ts` |

#### `src/ui/css.ts`

The generated stylesheet: the five numbers a note is drawn with, the two

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `STYLE_ID` | const | 18 | `export const STYLE_ID = "weaver-style"` | — | — |
| `buildCss` | function | 21 | `export function buildCss(settings: WeaverSettings): string` | — | — |
| `applyCss` | function | 64 | `export function applyCss(settings: WeaverSettings): void` | `main.ts` | — |
| `removeCss` | function | 77 | `export function removeCss(): void` | `main.ts` | — |

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
| `markerSlices` | function | 31 | `export function markerSlices(text: string): Slice[]` | `editor/entry-decorations.ts` | — |
| `appendDigitRuns` | function | 39 | `export function appendDigitRuns(parent: HTMLElement, text: string): void` | `reading/entry-processor.ts`<br>`ui/navigator.ts` | — |
| `appendClockRuns` | function | 54 | `export function appendClockRuns(parent: HTMLElement, clock: string): HTMLElement[]` | `editor/stopwatch-widget.ts`<br>`reading/entry-processor.ts`<br>`ui/portal.ts` | — |

#### `src/ui/navigator.ts`

The navigator: today's entries, the return stack, today's portal history, and

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `Navigator` | class | 82 | `export class Navigator` | `main.ts` | `tests/navigator.test.ts` |

#### `src/ui/platform.ts`

Which platform this is, as one answer.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `isPhone` | function | 14 | `export function isPhone(): boolean` | `editor/entry-keys.ts`<br>`main.ts` | `tests/platform-classes.test.ts` |
| `isMobile` | function | 21 | `export function isMobile(): boolean` | `main.ts` | `tests/platform-classes.test.ts` |
| `isTablet` | function | 28 | `export function isTablet(): boolean` | `main.ts` | `tests/platform-classes.test.ts` |
| `canHover` | function | 35 | `export function canHover(): boolean` | — | — |

#### `src/ui/portal.ts`

The pending portal, drawn once for every surface that can show one.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `PortalDisplayPhase` | type | 37 | `export type PortalDisplayPhase = "approaching" \| "open" \| "held" \| "expired"` | — | — |
| `PortalSurfaceMode` | type | 40 | `export type PortalSurfaceMode = "write" \| "reading"` | — | — |
| `PortalSurfaceOptions` | interface | 43 | `export interface PortalSurfaceOptions` | — | `tests/portal-surface.test.ts` |
| `PORTAL_REFUSAL` | const | 68 | `export const PORTAL_REFUSAL = "Could not start this entry"` | `editor/portal-widget.ts` | `tests/portal-surface.test.ts` |
| `portalTimeLabel` | function | 81 | `export function portalTimeLabel(portal: PortalInstant): string` | — | `tests/portal-surface.test.ts` |
| `portalCountdownLabel` | function | 91 | `export function portalCountdownLabel(portal: PortalInstant, now: number, prepared = false): string` | — | `tests/portal-surface.test.ts` |
| `PortalSurface` | class | 103 | `export class PortalSurface` | `editor/portal-widget.ts`<br>`reading/portals.ts` | `tests/portal-surface.test.ts` |
| `portalTrayElement` | function | 703 | `export function portalTrayElement(): HTMLElement` | `editor/portal-widget.ts` | — |
| `mountPortalTray` | function | 711 | `export function mountPortalTray(container: HTMLElement): HTMLElement` | `reading/portals.ts` | `tests/portal-surface.test.ts` |
| `mountPortalSurface` | function | 718 | `export function mountPortalSurface(container: HTMLElement, options: PortalSurfaceOptions): PortalSurface` | `editor/portal-widget.ts`<br>`reading/portals.ts` | `tests/portal-surface.test.ts` |


<!-- design:end -->
