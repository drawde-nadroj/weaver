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

The clock row is the frame's bottom edge: the moment and the duration sit at its
two ends, so the row you write is the row the frame is labelled with.

| Field | Written by | Read by | Shape |
| --- | --- | --- | --- |
| Marker | `formatMarker` | `parseMarkerPrefix`, `parseEntries` | `{ D.C.N }`, matched as a prefix |
| Prose | the writer's own typing | `parseEntries` | every line between the marker and the clock row, trimmed at both ends |
| Moment | the entry's first write | `parseClockRow` | `HH:MM:SS` at the head of the clock row |
| Duration | `formatDurationLine` | `parseClockRow` | `[+-=] HH:MM:SS`; `-` open, `=` paused, `+` settled |
| Close | `closeLine` | `parseClose` | `✓ HH:MM:SS`, at most one, never an entry |
| Frontmatter | `dayFrontmatter`, `applyDayStats` | `scanFrontmatter`, `recountDay` | `date`, `travels`, `depth`, `duration` |

<!-- claim: src/core/entries.ts#formatMarker @26f8d1081a -->
<!-- claim: src/core/entries.ts#parseEntries @d348ea9601 -->
<!-- claim: src/core/duration.ts#parseClockRow @a1ee9d6751 -->
<!-- claim: src/core/close.ts#parseClose @1690b1d5c0 -->
<!-- claim: src/core/day-stats.ts#recountDay @89a9e7f928 -->

`D` is depth, `C` is the branch's thread id, `N` is the day sequence. `N` is
identity and only ever appended (`src/core/entries.ts#nextSeq`); `C` is address,
inherited by an insert (`planChildEntry` copies the parent's `C`) and repaired
only when a root is deleted (`planDeleteEntry` → `repairThreads`). `D` is
structural: a child is its parent's `D` plus one, and a depth-1 entry starts a
new thread (`nextThread`).

<!-- claim: src/core/entries.ts#nextThread @c576a5b869 -->
<!-- claim: src/core/entries.ts#repairThreads @7919580f20 -->

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

Callers, exhaustively — `src/entries/engine.ts#writeDuration` (pause and settle),
`src/entries/engine.ts#appendEntry`, `src/main.ts#closeDay`,
`src/main.ts#refreshDayStats`. Nothing else writes a day note. The gate fails if
`vault.process`, `vault.modify` or `vault.append` appears outside
`src/entries/writer.ts`; if `vault.create` or `vault.createFolder` appears
outside `src/entries/day-note.ts`; if `editor.replaceRange` appears anywhere; or
if a `dispatch` that carries `changes` appears outside `src/entries/engine.ts`
and `src/entries/writer.ts`.

<!-- claim: src/entries/engine.ts#EntryEngine @cc6654df91 -->

## 3. The plans

A plan is a list of changes plus the selection to leave behind. One plan is one
transaction, so one undo reverses all of it.

| Plan | Intent | Changes | Renumbers |
| --- | --- | --- | --- |
| `planStartEntry` | append a root at the tip | marker, blank line, `HH:MM:SS - 00:00:00` | no — new `N`, next thread |
| `planChildEntry` | open a child under a settled entry | marker, blank line, `HH:MM:SS - 00:00:00` | no — inherits `C` |
| `planDeleteEntry` | remove a subtree | the block and the blank separator below it | yes — surviving `C` values |
| `planDuration` | write the clock | the duration half of the clock row, moment untouched | no |
| `planAppendLine` | the shared append primitive | one insertion at the tip | no |
| `planCloseDay` | close the day | `✓ HH:MM:SS` | no |

<!-- claim: src/core/insert.ts#planStartEntry @43f3c82770 -->
<!-- claim: src/core/insert.ts#planChildEntry @8d4231c9b9 -->
<!-- claim: src/core/insert.ts#planDeleteEntry @86569127e3 -->
<!-- claim: src/core/insert.ts#planDuration @543224e52c -->
<!-- claim: src/core/close.ts#planCloseDay @e36f434d57 -->

Two invariants hold across every plan, and both are tested against
`applyPlanToSource`, the pure oracle: **a settled `+` half is never rewritten**
(`planDuration` returns null for a settled entry), and **an insert never
renumbers anything** (`planChildEntry` carries the parent's `C`). `cmChanges`
converts a plan to CodeMirror's shape; the editor gets two dispatches, the change
and then the caret, because Obsidian maps a spec's selection through its own
changes and a caret past the old end cannot be expressed in one.

<!-- claim: src/core/insert.ts#applyPlanToSource @c5b022f97b -->
<!-- claim: src/core/insert.ts#cmChanges @7f311f1a35 -->

## 4. Session versus evidence

The note is the record. Session state is what this installation is doing right
now, and it is device-local: it is never synced, never written, and becomes
evidence only when the engine writes it.

`EntrySession` holds at most one `src/entries/session.ts#ActiveEntry` — the file
path, the entry's `N`, the baseline milliseconds already in its clock row, and
the wall clock the session started at. `elapsed` is baseline plus now minus
start; nothing else reads a clock.

<!-- claim: src/entries/session.ts#EntrySession @850ab8bcca -->

The transitions, and where each lives:

| Transition | Trigger | Code | Write |
| --- | --- | --- | --- |
| Start | the writer's own input in a draft | `src/entries/engine.ts#afterEdit` | none |
| Pause | a caret move, blur, wheel, touch, leaf change, hidden app, navigator open, the live entry deleted | `src/entries/engine.ts#pause` | `= HH:MM:SS`, not undoable |
| Settle | `⏎` on an open entry | `src/entries/engine.ts#settle` | `+ HH:MM:SS`, undoable |
| Drop | the entry being written is deleted | `src/entries/engine.ts#deleteEntry` | none |

<!-- claim: src/entries/engine.ts#EntryEngine @cc6654df91 -->

`afterEdit` is the only place a clock starts, and it starts on `typed` only —
the annotation CodeMirror puts on real input. A vault reload, a decoration
refresh, a jump, an append or a settle all dispatch without it, so none of them
starts a clock. The ticking widget writes no document: it mutates three digit
spans every second (`startTicking`), which is why a running clock costs no
transaction, no undo entry, and no re-render.

<!-- claim: src/editor/duration-ticker.ts#startTicking @6da859596b -->
<!-- claim: src/editor/stopwatch-widget.ts#DurationWidget @ec7c01f8fc -->

## 5. Geometry

Nothing reflows. The text decides where the box is, never the reverse.

- `frameBox` is pure: column, the text's left edge, the label inset → the box's
  `left`/`width`, or `drawn: false`.
- `frameSpan` is pure: this entry's two rails and the next entry's top rail →
  `top`/`bottom`, or `drawn: false` when they leave no interior.
- `src/editor/entry-frame.ts` is the only measuring code. It finds each entry's
  rows by their own `data-weaver-n` stamp
  (`src/editor/entry-frame.ts#renderedRows`), measures the ink of the row
  (`src/editor/entry-frame.ts#inkRect`), and schedules one
  `requestAnimationFrame` per batch (`src/editor/entry-frame.ts#schedule`). A row
  that has scrolled out of the render range falls back to its line block, whose
  centre is still the label's centre.
- The constants that turn "a box" into this box — `LEFT_GUTTER`, `RIGHT_GUTTER`,
  `MIN_AIR`, `NO_CLOCK_PAD`, `INLINE_TITLE_PAD` — are in that file, not in CSS,
  because they are measurements, not styling.

<!-- claim: src/core/frame.ts#frameBox @cbb958de1d -->
<!-- claim: src/core/frame.ts#frameSpan @324739146a -->
<!-- claim: src/editor/entry-frame.ts#entryFrameExtension @049f956468 -->

Frames are Live Preview only: `src/editor/entry-frame.ts#measure` returns early
unless `editorLivePreviewField` is true. Source mode is the file's own text. In
Reading view the same shape is a real element made by the post processor, so no
measurement is involved at all.

## 6. Surfaces

One row per surface that can be touched. "Writes" is the complete list of
document bytes it can cause; "empty" is what it shows with nothing to show.

| Surface | Code | Writes | One undo | Empty |
| --- | --- | --- | --- | --- |
| Entry decoration | `src/editor/entry-decorations.ts#entryDecorationSet` | nothing | — | draws nothing |
| Clock row | `src/editor/stopwatch-widget.ts#DurationWidget` | nothing (ticks its own DOM) | — | — |
| Frame layer | `src/editor/entry-frame.ts#entryFrameExtension` | nothing | — | draws nothing |
| Entry keys | `src/editor/entry-keys.ts#handleEnterKey` | settle `+`, or a child | the plan | not handled outside an entry |
| Start command | `src/main.ts#WeaverPlugin` | the root entry | the plan | `today's day note could not be found. Nothing was written.` |
| Navigator | `src/ui/navigator.ts#Navigator` | the child, the root, the deletion, the pause | the plan | `no entries yet — ＋ appends the first` |
| Reading view | `src/reading/entry-processor.ts#createEntryProcessor` | nothing | — | leaves the paragraph alone |
| Close mark | `src/reading/close-processor.ts#createCloseProcessor` | nothing | — | leaves the paragraph alone |
| Close day | `src/main.ts#WeaverPlugin` | `✓` plus the counters | the plan | `this day is already closed. Nothing was written.` |
| Settings tab | `src/settings-tab.ts#WeaverSettingTab` | `data.json` only | — | — |

<!-- claim: src/editor/entry-keys.ts#handleEnterKey @05f01a81d6 -->
<!-- claim: src/ui/navigator.ts#Navigator @ef46c8c66b -->
<!-- claim: src/reading/entry-processor.ts#createEntryProcessor @85ced77e71 -->

The navigator is the only navigation: it never takes a `Scope`, never writes
prose, and re-reads the document on every action
(`src/ui/navigator.ts#buildItems`). The phone pinning is one pure decision,
`shouldPinStopwatch`, true only when all four of phone, live session, caret on
the last prose line, and a clock row exist.

<!-- claim: src/editor/entry-keys.ts#shouldPinStopwatch @eefa36e514 -->

## 7. Settings, colour, and the look

Colour is a pure function of `D`: `dimensionColor(7)` is the same value in every
vault and at every moment, and `dimensionColorVars` packages the two custom
properties a line carries. Nothing is generated per level; the stylesheet is one
`calc()` over `--weaver-d`, and the runtime variables are written by `buildCss`
into one `<style id="weaver-style">` element.

<!-- claim: src/core/color.ts#dimensionColor @bbd0b078df -->
<!-- claim: src/ui/css.ts#buildCss @627d9d6ac0 -->

Settings land in one of the places listed here, never in a surface of their own:
values that change the drawing go through `buildCss` (variables), values that
change state go through `src/main.ts#syncBodyClasses` (body classes), and
everything else is read where it is needed (the generated table lists every
field's readers). The settings model is the only place a persisted name exists;
`normalizeSettings` clamps and defaults, and `LEGACY_SETTING_KEYS` is the single
place the v2 `heading*` spellings are read.

<!-- claim: src/settings.ts#normalizeSettings @8ca468439f -->
<!-- claim: src/settings.ts#DEFAULT_SETTINGS @78e60ea700 -->

**Vocabulary is a coupling, not a preference.** The unit is an *entry*, its depth
a *dimension*, its state *open* or *settled*. `heading` names Markdown syntax and
nothing else, which is why the settings fields are `entrySize`, `entryWeight` and
`equalizeEntrySizes` and why the v2 names appear once, in the migration.

## 8. Every sentence the user sees

`src/notices.ts` owns the text: the notice durations and every refusal and
confirmation. A surface imports the string; it never retypes one. That is what
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
| an export | its doc comment — the gate requires one — and the sentence here that names it |

If a change makes a sentence in this file false, the gate will say which one.
That is the point: the document is not maintained by memory, it is maintained by
`npm run docs:check` and repaired where it points.

<!-- design:begin — generated by scripts/design-md.mjs; do not edit by hand -->

### Modules

34 files, 153 exported symbols, 25 test files.

| file | layer | lines | exports | imports `obsidian` |
| --- | --- | --- | --- | --- |
| `src/core/clock.ts` | core | 16 | 2 | no |
| `src/core/close.ts` | core | 61 | 5 | no |
| `src/core/color.ts` | core | 123 | 7 | no |
| `src/core/day-stats.ts` | core | 90 | 4 | no |
| `src/core/day.ts` | core | 58 | 5 | no |
| `src/core/document.ts` | core | 92 | 6 | no |
| `src/core/duration.ts` | core | 110 | 6 | no |
| `src/core/entries.ts` | core | 392 | 15 | no |
| `src/core/frame.ts` | core | 96 | 7 | no |
| `src/core/insert.ts` | core | 241 | 10 | no |
| `src/core/navigator-stack.ts` | core | 40 | 4 | no |
| `src/editor/close-decorations.ts` | editor | 82 | 2 | yes |
| `src/editor/duration-ticker.ts` | editor | 55 | 5 | no |
| `src/editor/editor-path.ts` | editor | 11 | 1 | yes |
| `src/editor/entry-decorations.ts` | editor | 271 | 2 | yes |
| `src/editor/entry-field.ts` | editor | 40 | 4 | no |
| `src/editor/entry-frame.ts` | editor | 351 | 2 | yes |
| `src/editor/entry-keys.ts` | editor | 222 | 10 | no |
| `src/editor/stopwatch-widget.ts` | editor | 182 | 2 | no |
| `src/editor/view-registry.ts` | editor | 65 | 6 | yes |
| `src/entries/day-note.ts` | entries | 96 | 3 | yes |
| `src/entries/engine.ts` | entries | 461 | 1 | yes |
| `src/entries/session.ts` | entries | 47 | 2 | no |
| `src/entries/writer.ts` | entries | 100 | 5 | yes |
| `src/main.ts` | root | 306 | 1 | yes |
| `src/notices.ts` | root | 46 | 13 | no |
| `src/reading/close-processor.ts` | reading | 39 | 1 | yes |
| `src/reading/entry-processor.ts` | reading | 190 | 1 | yes |
| `src/settings-tab.ts` | root | 221 | 1 | yes |
| `src/settings.ts` | root | 186 | 6 | no |
| `src/ui/css.ts` | ui | 73 | 4 | no |
| `src/ui/dcn.ts` | ui | 46 | 5 | no |
| `src/ui/navigator.ts` | ui | 451 | 1 | no |
| `src/ui/platform.ts` | ui | 38 | 4 | yes |

### Commands

| id | name | icon | hotkey |
| --- | --- | --- | --- |
| `weaver:append-entry` | Append an entry | `plus` | `Mod,Shift+E` |
| `weaver:navigate` | Today's entries | `list` | `Mod,Shift+P` |
| `weaver:line-break` | Insert a line break | `corner-down-left` | — |
| `weaver:close-day` | Close the day | `check-circle` | — |

### Settings

| field | default | read in |
| --- | --- | --- |
| `writeDayCounters` | `true` | `main.ts`<br>`settings-tab.ts` |
| `dayNoteFolder` | `"Chronomancer"` | `entries/day-note.ts`<br>`settings-tab.ts` |
| `dayNoteFormat` | `"YYYY.MM.DD"` | `entries/day-note.ts`<br>`settings-tab.ts` |
| `equalizeEntrySizes` | `true` | `main.ts`<br>`settings-tab.ts` |
| `entrySize` | `"1em"` | `settings-tab.ts`<br>`ui/css.ts` |
| `entryWeight` | `600` | `settings-tab.ts`<br>`ui/css.ts` |
| `indentStep` | `18` | `settings-tab.ts`<br>`ui/css.ts` |
| `mobileIndentStep` | `12` | `settings-tab.ts`<br>`ui/css.ts` |
| `indentMaxLevel` | `8` | `settings-tab.ts`<br>`ui/css.ts` |
| `portEmphasisColors` | `true` | `main.ts`<br>`settings-tab.ts` |
| `entryFrames` | `true` | `editor/entry-frame.ts`<br>`settings-tab.ts` |
| `entryDayLink` | `true` | `editor/entry-decorations.ts`<br>`reading/entry-processor.ts`<br>`settings-tab.ts` |
| `debug` | `false` | `main.ts`<br>`settings-tab.ts` |

The names on disk are these names: `settings.ts#LEGACY_SETTING_KEYS` maps the three v2 spellings and nothing else reads them.

### DOM names

A name is a contract: a user's snippet may hang off any of them, so a rename is a breaking change and a `hook` is deliberate rather than dead. `styled` means a rule exists in `styles.css` or is generated by `src/ui/css.ts`; `body state` means `main.ts` toggles it on `<body>`; `hook` means Weaver writes it and nothing styles it — the tests or a user's CSS do.

| name | state | written in |
| --- | --- | --- |
| `weaver-close-mark` | styled | `reading/close-processor.ts` |
| `weaver-close-mark-line` | styled | `editor/close-decorations.ts` |
| `weaver-dcn-ink` | styled | `ui/dcn.ts` |
| `weaver-dcn-num` | styled | `ui/dcn.ts` |
| `weaver-duration` | styled | `editor/entry-frame.ts`<br>`editor/stopwatch-widget.ts`<br>`reading/entry-processor.ts` |
| `weaver-duration-clock` | styled | `editor/stopwatch-widget.ts`<br>`reading/entry-processor.ts` |
| `weaver-duration-ink` | styled | `editor/stopwatch-widget.ts`<br>`reading/entry-processor.ts` |
| `weaver-duration-moment` | styled | `editor/stopwatch-widget.ts`<br>`reading/entry-processor.ts` |
| `weaver-duration-num` | styled | `editor/stopwatch-widget.ts`<br>`reading/entry-processor.ts` |
| `weaver-duration-raw` | styled | `editor/entry-decorations.ts`<br>`editor/entry-frame.ts` |
| `weaver-duration-sigil` | styled | `editor/stopwatch-widget.ts`<br>`reading/entry-processor.ts` |
| `weaver-entry-daylink` | styled | `editor/entry-decorations.ts`<br>`editor/stopwatch-widget.ts`<br>`reading/entry-processor.ts` |
| `weaver-entry-head` | styled | `editor/entry-decorations.ts`<br>`editor/entry-frame.ts`<br>`reading/entry-processor.ts`<br>`ui/css.ts` |
| `weaver-entry-prose` | styled | `editor/entry-decorations.ts`<br>`reading/entry-processor.ts`<br>`ui/css.ts` |
| `weaver-frame` | styled | `editor/entry-frame.ts`<br>`reading/entry-processor.ts` |
| `weaver-frame-label` | styled | `editor/entry-decorations.ts`<br>`editor/stopwatch-widget.ts`<br>`reading/entry-processor.ts` |
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
| `weaver-navigator-row` | styled | `ui/navigator.ts` |
| `weaver-navigator-stop` | hook | `ui/navigator.ts` |
| `weaver-navigator-time` | styled | `ui/navigator.ts` |
| `weaver-navigator-title` | styled | `ui/navigator.ts` |
| `weaver-no-emphasis` | styled | `main.ts`<br>`ui/css.ts` |
| `weaver-phone` | styled | `main.ts` |
| `weaver-platform-mobile` | body state | `main.ts` |
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
16:10:00 + 00:04:12

{ 2.1.2 }
the thought this one opened, one dimension deeper
16:14:12 + 00:01:30

{ 2.1.3 }
and the one beside it, still open
16:15:42 = 00:03:23

✓ 17:02:00
```

### Coverage, as it actually is

Derived, not asserted: a module whose exports no test names is listed here until a test names one. It is a report, not a gate — but it cannot go missing.

| module | exports named by a test | exports |
| --- | --- | --- |
| `src/core/document.ts` | 0 | 6 |
| `src/editor/duration-ticker.ts` | 0 | 5 |
| `src/editor/editor-path.ts` | 0 | 1 |
| `src/editor/entry-frame.ts` | 0 | 2 |
| `src/entries/engine.ts` | 0 | 1 |
| `src/ui/css.ts` | 0 | 4 |
| `src/ui/dcn.ts` | 0 | 5 |

Modules with no symbol named by any test: 7.

### Symbols

One table per module. `used by` is a textual reference from another file — a caller, a type annotation, a test — not a resolved call graph; this repository has no compiler API to resolve one, and the document must not claim what it cannot show.

#### `src/core/clock.ts`

Pads a clock component to two digits.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `pad2` | function | 2 | `export function pad2(value: number): string` | `core/day.ts` | `tests/clock.test.ts` |
| `formatClock` | function | 11 | `export function formatClock(date: Date): string` | `core/close.ts`<br>`core/day-stats.ts`<br>`core/duration.ts`<br>`core/insert.ts`<br>`editor/duration-ticker.ts`<br>`editor/stopwatch-widget.ts`<br>`main.ts`<br>`reading/entry-processor.ts` | `tests/clock.test.ts`<br>`tests/duration.test.ts` |

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
| `DayNoteOptions` | interface | 16 | `export interface DayNoteOptions` | `entries/day-note.ts` | — |
| `dayKey` | function | 22 | `export function dayKey(now: Date): string` | `editor/entry-decorations.ts`<br>`entries/day-note.ts`<br>`main.ts`<br>`reading/entry-processor.ts` | `tests/day-note.test.ts` |
| `dayNotePath` | function | 27 | `export function dayNotePath(now: Date, options: DayNoteOptions): string` | `entries/day-note.ts` | `tests/append-entry.test.ts`<br>`tests/day-note.test.ts` |
| `dayKeyFromName` | function | 40 | `export function dayKeyFromName(basename: string): string \| null` | `editor/entry-decorations.ts`<br>`reading/entry-processor.ts` | `tests/day-note.test.ts` |
| `dayFrontmatter` | function | 47 | `export function dayFrontmatter(day: string): string` | `entries/day-note.ts` | `tests/day-note.test.ts` |

#### `src/core/document.ts`

The line-level facts every parser in Weaver shares: where each line starts,

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `CodeFence` | interface | 9 | `export interface CodeFence` | `core/entries.ts` | — |
| `FenceScan` | interface | 18 | `export interface FenceScan` | — | — |
| `lineStartsOf` | function | 30 | `export function lineStartsOf(source: string): number[]` | `core/entries.ts`<br>`core/insert.ts` | — |
| `FrontmatterScan` | interface | 42 | `export interface FrontmatterScan` | — | — |
| `scanFrontmatter` | function | 48 | `export function scanFrontmatter(lines: readonly string[]): FrontmatterScan` | `core/close.ts`<br>`core/day-stats.ts`<br>`core/entries.ts` | — |
| `scanFences` | function | 61 | `export function scanFences(lines: readonly string[]): FenceScan` | `core/close.ts`<br>`core/entries.ts` | — |

#### `src/core/duration.ts`

The clock row of an entry, and the clocks it is written with.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `DurationSigil` | type | 23 | `export type DurationSigil = "+" \| "-" \| "="` | `core/entries.ts`<br>`core/insert.ts`<br>`editor/stopwatch-widget.ts`<br>`entries/engine.ts` | — |
| `formatClock` | function | 26 | `export function formatClock(ms: number): string` | `core/clock.ts`<br>`core/close.ts`<br>`core/day-stats.ts`<br>`core/insert.ts`<br>`editor/duration-ticker.ts`<br>`editor/stopwatch-widget.ts`<br>`main.ts`<br>`reading/entry-processor.ts` | `tests/clock.test.ts`<br>`tests/duration.test.ts` |
| `formatDurationLine` | function | 31 | `export function formatDurationLine(sigil: DurationSigil, ms: number): string` | `core/insert.ts` | — |
| `ClockRow` | interface | 42 | `export interface ClockRow` | `reading/entry-processor.ts` | — |
| `parseClockRow` | function | 71 | `export function parseClockRow(text: string): ClockRow \| null` | `core/entries.ts`<br>`core/insert.ts`<br>`reading/entry-processor.ts` | `tests/duration.test.ts` |
| `formatClockRow` | function | 105 | `export function formatClockRow(time: string \| null, sigil: DurationSigil, ms: number): string` | `core/insert.ts` | `tests/duration.test.ts` |

#### `src/core/entries.ts`

The entry: the unit a day note is made of.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `Entry` | interface | 27 | `export interface Entry` | `core/insert.ts`<br>`editor/entry-keys.ts`<br>`entries/engine.ts`<br>`settings-tab.ts`<br>`ui/navigator.ts` | `tests/settings-tab.test.ts` |
| `EntryIndex` | interface | 66 | `export interface EntryIndex` | `core/day-stats.ts`<br>`core/insert.ts`<br>`editor/entry-field.ts`<br>`entries/engine.ts`<br>`ui/navigator.ts` | — |
| `MarkerPrefix` | interface | 94 | `export interface MarkerPrefix` | — | — |
| `parseMarkerPrefix` | function | 109 | `export function parseMarkerPrefix(text: string): MarkerPrefix \| null` | `reading/entry-processor.ts` | — |
| `parseEntries` | function | 147 | `export function parseEntries(source: string): EntryIndex` | `core/close.ts`<br>`core/day-stats.ts`<br>`core/insert.ts`<br>`editor/entry-field.ts`<br>`entries/engine.ts`<br>`main.ts`<br>`ui/navigator.ts` | `tests/append-entry.test.ts`<br>`tests/color.test.ts`<br>`tests/day-stats.test.ts`<br>`tests/entries.test.ts`<br>`tests/entry-plans.test.ts`<br>`tests/record-format.test.ts`<br>`tests/writer.test.ts` |
| `findEntryAtLine` | function | 310 | `export function findEntryAtLine(index: EntryIndex, line: number): Entry \| null` | — | `tests/entries.test.ts` |
| `findEntryAtOffset` | function | 319 | `export function findEntryAtOffset(index: EntryIndex, offset: number): Entry \| null` | `editor/entry-keys.ts`<br>`entries/engine.ts` | `tests/entries.test.ts` |
| `findCurrentEntry` | function | 327 | `export function findCurrentEntry(index: EntryIndex, line: number): Entry \| null` | `ui/navigator.ts` | `tests/entries.test.ts` |
| `entryBySeq` | function | 337 | `export function entryBySeq(index: EntryIndex, n: number): Entry \| null` | `entries/engine.ts`<br>`ui/navigator.ts` | `tests/entries.test.ts` |
| `childrenOf` | function | 345 | `export function childrenOf(index: EntryIndex, entry: Entry \| null): Entry[]` | `ui/navigator.ts` | `tests/entries.test.ts` |
| `endOfSubtree` | function | 351 | `export function endOfSubtree(index: EntryIndex, entry: Entry): number` | `core/insert.ts` | — |
| `nextSeq` | function | 356 | `export function nextSeq(index: EntryIndex): number` | `core/insert.ts` | `tests/entries.test.ts` |
| `nextThread` | function | 361 | `export function nextThread(index: EntryIndex): number` | `core/insert.ts` | `tests/entries.test.ts` |
| `formatMarker` | function | 366 | `export function formatMarker(d: number, c: number, n: number): string` | `core/insert.ts` | `tests/entries.test.ts` |
| `repairThreads` | function | 377 | `export function repairThreads(index: EntryIndex): TextChange[]` | `core/insert.ts` | `tests/entries.test.ts` |

#### `src/core/frame.ts`

The frame around one entry: a box, and nothing else.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `FrameColumn` | interface | 22 | `export interface FrameColumn` | `editor/entry-frame.ts` | `tests/frame.test.ts` |
| `FrameBoxInput` | interface | 28 | `export interface FrameBoxInput` | — | — |
| `FrameBox` | interface | 37 | `export interface FrameBox` | — | — |
| `frameBox` | function | 50 | `export function frameBox(input: FrameBoxInput): FrameBox` | `editor/entry-frame.ts` | `tests/frame.test.ts` |
| `FrameSpanInput` | interface | 57 | `export interface FrameSpanInput` | — | — |
| `FrameSpan` | interface | 69 | `export interface FrameSpan` | — | `tests/frame.test.ts` |
| `frameSpan` | function | 90 | `export function frameSpan(input: FrameSpanInput): FrameSpan` | `editor/entry-frame.ts` | `tests/frame.test.ts` |

#### `src/core/insert.ts`

The three plans that write entry text, and the arithmetic every plan shares.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `TextChange` | interface | 25 | `export interface TextChange` | `core/entries.ts`<br>`entries/writer.ts` | — |
| `InsertPlan` | interface | 32 | `export interface InsertPlan` | `core/close.ts`<br>`entries/engine.ts`<br>`entries/writer.ts` | `tests/entry-plans.test.ts` |
| `planAppendLine` | function | 56 | `export function planAppendLine(source: string, text: string, caret: number = text.length): InsertPlan` | `core/close.ts` | — |
| `planStartEntry` | function | 86 | `export function planStartEntry(source: string, index: EntryIndex, now: Date): InsertPlan \| null` | `entries/engine.ts` | `tests/entry-plans.test.ts`<br>`tests/writer.test.ts` |
| `planChildEntry` | function | 102 | `export function planChildEntry( _source: string, index: EntryIndex, parent: Entry, now: Date ): InsertPlan \| null` | `entries/engine.ts` | `tests/entry-plans.test.ts` |
| `planDeleteEntry` | function | 135 | `export function planDeleteEntry( source: string, index: EntryIndex, entry: Entry ): InsertPlan \| null` | `entries/engine.ts` | `tests/entry-plans.test.ts` |
| `planDuration` | function | 184 | `export function planDuration( _source: string, index: EntryIndex, entry: Entry, sigil: DurationSigil, ms: number ): InsertPlan \| null` | `entries/engine.ts` | `tests/entry-plans.test.ts`<br>`tests/writer.test.ts` |
| `offsetToLineCh` | function | 211 | `export function offsetToLineCh(source: string, offset: number):` | `entries/engine.ts` | — |
| `cmChanges` | function | 224 | `export function cmChanges( changes: readonly TextChange[] ):` | `entries/engine.ts`<br>`entries/writer.ts` | `tests/entry-plans.test.ts` |
| `applyPlanToSource` | function | 231 | `export function applyPlanToSource(source: string, plan: InsertPlan):` | `entries/writer.ts`<br>`main.ts` | `tests/close.test.ts`<br>`tests/entry-plans.test.ts` |

#### `src/core/navigator-stack.ts`

The return stack: where a jump came from.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `Stop` | interface | 11 | `export interface Stop` | `entries/engine.ts`<br>`main.ts`<br>`ui/navigator.ts` | `tests/navigator-stack.test.ts`<br>`tests/navigator.test.ts` |
| `STACK_LIMIT` | const | 19 | `export const STACK_LIMIT = 8` | — | `tests/navigator-stack.test.ts` |
| `pushStop` | function | 27 | `export function pushStop(stops: readonly Stop[], stop: Stop, limit = STACK_LIMIT): Stop[]` | `entries/engine.ts` | `tests/navigator-stack.test.ts` |
| `popStop` | function | 36 | `export function popStop(stops: readonly Stop[]):` | `ui/navigator.ts` | `tests/navigator-stack.test.ts` |

#### `src/editor/close-decorations.ts`

The `✓` line, banded where it is written.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `closeDecorations` | function | 42 | `export function closeDecorations(state: EditorState): DecorationSet` | — | `tests/close-decorations.test.ts` |
| `closeDecorationsExtension` | function | 67 | `export function closeDecorationsExtension(): Extension` | `main.ts` | — |

#### `src/editor/duration-ticker.ts`

The one writer of a ticking clock.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `TICK_MS` | const | 15 | `export const TICK_MS = 1000` | — | — |
| `Ticker` | interface | 18 | `export interface Ticker` | — | — |
| `writeDigits` | function | 27 | `export function writeDigits(digits: readonly HTMLElement[], ms: number): void` | `editor/stopwatch-widget.ts` | — |
| `stopTicking` | function | 37 | `export function stopTicking(dom: HTMLElement \| null): void` | `editor/stopwatch-widget.ts` | — |
| `startTicking` | function | 45 | `export function startTicking(dom: HTMLElement, digits: HTMLElement[], ms: number): void` | `editor/stopwatch-widget.ts` | — |

#### `src/editor/editor-path.ts`

The file a live editor view is showing, or null when it is not a note.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `editorPathOf` | function | 7 | `export function editorPathOf(view: EditorView): string \| null` | `editor/entry-keys.ts`<br>`entries/engine.ts` | — |

#### `src/editor/entry-decorations.ts`

The entry, drawn.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `entryDecorationSet` | function | 116 | `export function entryDecorationSet( state: EditorState, settings: WeaverSettings, session: EntrySession, path: string, now: number, openDayLink?: (target: string, sourcePath: st...` | — | `tests/entry-decorations.test.ts` |
| `entryDecorationsExtension` | function | 241 | `export function entryDecorationsExtension( getSettings: () => WeaverSettings, getSession: () => EntrySession, getPath: () => string, openDayLink?: (target: string, sourcePath: s...` | `main.ts` | — |

#### `src/editor/entry-field.ts`

The entry index as editor state: one parse per document change, shared by the

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `refreshEntriesEffect` | const | 11 | `export const refreshEntriesEffect = StateEffect.define<void>()` | `editor/close-decorations.ts`<br>`editor/entry-decorations.ts`<br>`entries/engine.ts`<br>`main.ts` | `tests/entry-field.test.ts` |
| `programmaticWrite` | const | 22 | `export const programmaticWrite = Annotation.define<boolean>()` | `editor/entry-keys.ts`<br>`entries/engine.ts`<br>`entries/writer.ts`<br>`ui/navigator.ts` | — |
| `entryIndexField` | const | 25 | `export const entryIndexField = StateField.define<EntryIndex>(` | `editor/close-decorations.ts`<br>`editor/entry-decorations.ts`<br>`editor/entry-frame.ts`<br>`editor/entry-keys.ts`<br>`entries/engine.ts` | `tests/append-entry.test.ts`<br>`tests/close-decorations.test.ts`<br>`tests/entry-decorations.test.ts`<br>`tests/entry-field.test.ts`<br>`tests/entry-keys.test.ts`<br>`tests/plugin.test.ts` |
| `entryIndexExtension` | function | 37 | `export function entryIndexExtension(): Extension` | `main.ts` | — |

#### `src/editor/entry-frame.ts`

The frame around every entry, drawn.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `FrameHost` | interface | 50 | `export interface FrameHost` | — | — |
| `entryFrameExtension` | function | 342 | `export function entryFrameExtension(host: FrameHost): Extension` | `main.ts` | — |

#### `src/editor/entry-keys.ts`

The two keys an entry owns, and the two edit events that keep the stopwatch

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `ENTRY_KEYS` | const | 37 | `export const ENTRY_KEYS = ["Mod-Shift-E", "Enter"] as const` | `main.ts` | `tests/entry-keys.test.ts` |
| `EntryKeyHost` | interface | 40 | `export interface EntryKeyHost` | — | `tests/entry-keys.test.ts` |
| `EntryEditHost` | interface | 52 | `export interface EntryEditHost extends EntryKeyHost` | — | — |
| `enterableEntry` | function | 66 | `export function enterableEntry(view: EditorView, _host: EntryKeyHost): Entry \| null` | — | `tests/entry-keys.test.ts` |
| `handleEnterKey` | function | 74 | `export function handleEnterKey(view: EditorView, host: EntryKeyHost): boolean` | — | `tests/entry-keys.test.ts` |
| `handleStartKey` | function | 89 | `export function handleStartKey(_view: EditorView, host: EntryKeyHost): boolean` | — | `tests/entry-keys.test.ts` |
| `shouldPinStopwatch` | function | 99 | `export function shouldPinStopwatch(input:` | — | `tests/entry-keys.test.ts` |
| `maybePinStopwatch` | function | 109 | `export function maybePinStopwatch(view: EditorView, host: EntryEditHost, phone = isPhone()): boolean` | — | — |
| `entryKeysExtension` | function | 143 | `export function entryKeysExtension(host: EntryKeyHost): Extension` | `main.ts` | — |
| `entryEditExtension` | function | 155 | `export function entryEditExtension(host: EntryEditHost): Extension` | `main.ts` | — |

#### `src/editor/stopwatch-widget.ts`

The rendered clock row.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `DurationWidgetInput` | interface | 36 | `export interface DurationWidgetInput` | — | `tests/stopwatch-widget.test.ts` |
| `DurationWidget` | class | 56 | `export class DurationWidget extends WidgetType` | `editor/entry-decorations.ts` | `tests/entry-decorations.test.ts`<br>`tests/stopwatch-widget.test.ts` |

#### `src/editor/view-registry.ts`

The live editor views, in one place.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `registerEditorView` | function | 15 | `export function registerEditorView(view: EditorView): void` | — | `tests/append-entry.test.ts`<br>`tests/writer.test.ts` |
| `unregisterEditorView` | function | 20 | `export function unregisterEditorView(view: EditorView): void` | — | `tests/append-entry.test.ts`<br>`tests/writer.test.ts` |
| `viewRegistryExtension` | const | 25 | `export const viewRegistryExtension = ViewPlugin.fromClass( class` | `main.ts` | — |
| `registeredEditorViews` | function | 38 | `export function registeredEditorViews(): readonly EditorView[]` | `editor/entry-keys.ts`<br>`entries/engine.ts`<br>`main.ts` | — |
| `findEditorViewForFile` | function | 43 | `export function findEditorViewForFile(file: TFile): EditorView \| null` | `entries/engine.ts`<br>`entries/writer.ts` | — |
| `findActiveEditorView` | function | 57 | `export function findActiveEditorView(app: App): EditorView \| null` | — | — |

#### `src/entries/day-note.ts`

The day plane, resolved against the vault: which file today's note is, and how

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `dayNoteOptions` | function | 60 | `export function dayNoteOptions(app: App, settings: WeaverSettings): DayNoteOptions` | — | — |
| `resolveDayNote` | function | 67 | `export function resolveDayNote( app: App, settings: WeaverSettings, now: Date ):` | `entries/engine.ts`<br>`main.ts` | `tests/day-note.test.ts` |
| `ensureDayNote` | function | 82 | `export async function ensureDayNote(app: App, path: string, now: Date): Promise<TFile>` | `entries/engine.ts` | `tests/day-note.test.ts` |

#### `src/entries/engine.ts`

The only writer of entry text.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `EntryEngine` | class | 53 | `export class EntryEngine` | `main.ts` | — |

#### `src/entries/session.ts`

The live stopwatch: at most one entry is being written at a time.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `ActiveEntry` | interface | 10 | `export interface ActiveEntry` | — | — |
| `EntrySession` | class | 19 | `export class EntrySession` | `editor/entry-decorations.ts`<br>`editor/entry-frame.ts`<br>`editor/entry-keys.ts`<br>`entries/engine.ts`<br>`main.ts` | `tests/entry-decorations.test.ts`<br>`tests/entry-keys.test.ts`<br>`tests/navigator.test.ts`<br>`tests/session.test.ts` |

#### `src/entries/writer.ts`

The one writer of a day note.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `RewriteResult` | interface | 28 | `export interface RewriteResult` | — | — |
| `Rewrite` | type | 36 | `export type Rewrite = (source: string) => RewriteResult \| null` | `settings.ts` | — |
| `rewriteDay` | function | 45 | `export async function rewriteDay( app: App, file: TFile, rewrite: Rewrite, undoable: boolean ): Promise<RewriteResult \| null>` | `entries/engine.ts`<br>`main.ts` | `tests/writer.test.ts` |
| `planRewrite` | function | 73 | `export function planRewrite(build: (source: string) => InsertPlan \| null): Rewrite` | `entries/engine.ts` | `tests/writer.test.ts` |
| `minimalChange` | function | 86 | `export function minimalChange(before: string, after: string): TextChange[]` | `main.ts` | `tests/writer.test.ts` |

#### `src/main.ts`

Weaver: a day note is a linear list of entries.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `WeaverPlugin` | class | 56 | `export default class WeaverPlugin extends Plugin` | `entries/engine.ts`<br>`reading/entry-processor.ts`<br>`settings-tab.ts`<br>`ui/navigator.ts` | `tests/append-entry.test.ts`<br>`tests/entry-processor.test.ts`<br>`tests/navigator.test.ts`<br>`tests/platform-classes.test.ts`<br>`tests/plugin.test.ts`<br>`tests/settings-tab.test.ts` |

#### `src/notices.ts`

Every user-facing string Weaver shows, so wording stays consistent.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `NOTICE_REFUSAL_MS` | const | 7 | `export const NOTICE_REFUSAL_MS = 6000` | `entries/engine.ts`<br>`main.ts` | — |
| `NOTICE_NOOP_MS` | const | 9 | `export const NOTICE_NOOP_MS = 3000` | `main.ts` | — |
| `NOTICE_PARTIAL_MS` | const | 11 | `export const NOTICE_PARTIAL_MS = 8000` | — | — |
| `NOTICE_NOTHING_WRITTEN` | const | 14 | `export const NOTICE_NOTHING_WRITTEN = "Nothing was written."` | — | — |
| `NOTICE_NEEDS_EDITING` | const | 17 | `export const NOTICE_NEEDS_EDITING = `Weaver: this needs an editable note. $` | — | — |
| `NOTICE_DAY_CLOSED` | const | 19 | `export const NOTICE_DAY_CLOSED = (time: string): string => `Weaver: day closed at $` | `main.ts` | — |
| `NOTICE_DAY_ALREADY_CLOSED` | const | 21 | `export const NOTICE_DAY_ALREADY_CLOSED = `Weaver: this day is already closed. $` | `main.ts` | — |
| `NOTICE_NO_DAY_NOTE` | const | 23 | `export const NOTICE_NO_DAY_NOTE = `Weaver: today's day note could not be found. $` | `entries/engine.ts`<br>`main.ts` | — |
| `NAVIGATOR_HINT_KEYS` | const | 26 | `export const NAVIGATOR_HINT_KEYS = "↑↓ move · ⏎ jump · ⇧⏎ descend · n append · x delete · ⌘[ back · esc close"` | `ui/navigator.ts` | — |
| `NAVIGATOR_HINT_TOUCH` | const | 30 | `export const NAVIGATOR_HINT_TOUCH = "tap to jump · tap the caret row to descend · ✕ twice deletes"` | `ui/navigator.ts` | — |
| `noticeCloseFrontmatter` | function | 33 | `export function noticeCloseFrontmatter(action: string): string` | `entries/engine.ts` | — |
| `noticeCloseCodeBlock` | function | 38 | `export function noticeCloseCodeBlock(action: string): string` | `entries/engine.ts` | — |
| `noticeLegacyFormat` | function | 43 | `export function noticeLegacyFormat(action: string): string` | `entries/engine.ts`<br>`main.ts` | `tests/append-entry.test.ts` |

#### `src/reading/close-processor.ts`

Reading view: the close mark, muted and labelled.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `createCloseProcessor` | function | 23 | `export function createCloseProcessor(): MarkdownPostProcessor` | `main.ts` | `tests/entry-processor.test.ts` |

#### `src/reading/entry-processor.ts`

Reading view: the same entry the editor draws, in the same frame.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `createEntryProcessor` | function | 86 | `export function createEntryProcessor(plugin: WeaverPlugin): MarkdownPostProcessor` | `main.ts` | `tests/entry-processor.test.ts` |

#### `src/settings-tab.ts`

The settings surface: four groups, every control applied live.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `WeaverSettingTab` | class | 22 | `export class WeaverSettingTab extends PluginSettingTab` | `main.ts` | `tests/settings-tab.test.ts` |

#### `src/settings.ts`

Weaver settings model.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `WeaverSettings` | interface | 15 | `export interface WeaverSettings` | `editor/entry-decorations.ts`<br>`editor/entry-frame.ts`<br>`entries/day-note.ts`<br>`main.ts`<br>`ui/css.ts` | `tests/entry-decorations.test.ts` |
| `WeaverData` | interface | 44 | `export interface WeaverData` | `main.ts` | — |
| `DEFAULT_SETTINGS` | const | 50 | `export const DEFAULT_SETTINGS: WeaverSettings =` | `settings-tab.ts` | `tests/append-entry.test.ts`<br>`tests/day-note.test.ts`<br>`tests/entry-decorations.test.ts`<br>`tests/entry-processor.test.ts`<br>`tests/settings.test.ts` |
| `isValidEntrySize` | function | 73 | `export function isValidEntrySize(value: string): boolean` | `settings-tab.ts`<br>`ui/css.ts` | — |
| `normalizeSettings` | function | 131 | `export function normalizeSettings(data: unknown): WeaverSettings` | — | `tests/settings.test.ts` |
| `normalizeData` | function | 171 | `export function normalizeData(data: unknown): WeaverData` | `main.ts` | `tests/settings.test.ts` |

#### `src/ui/css.ts`

The generated stylesheet: the six numbers a note is drawn with, and the two

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `STYLE_ID` | const | 11 | `export const STYLE_ID = "weaver-style"` | — | — |
| `buildCss` | function | 14 | `export function buildCss(settings: WeaverSettings): string` | — | — |
| `applyCss` | function | 57 | `export function applyCss(settings: WeaverSettings): void` | `main.ts` | — |
| `removeCss` | function | 70 | `export function removeCss(): void` | `main.ts` | — |

#### `src/ui/dcn.ts`

`D.C.N` as digits and punctuation: the digits stay white and the separators

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `NUM_CLASS` | const | 15 | `export const NUM_CLASS = "weaver-dcn-num"` | `editor/entry-decorations.ts` | — |
| `INK_CLASS` | const | 17 | `export const INK_CLASS = "weaver-dcn-ink"` | `editor/entry-decorations.ts` | — |
| `Slice` | interface | 20 | `export interface Slice` | — | — |
| `markerSlices` | function | 30 | `export function markerSlices(text: string): Slice[]` | `editor/entry-decorations.ts` | — |
| `appendDigitRuns` | function | 38 | `export function appendDigitRuns(parent: HTMLElement, text: string): void` | `reading/entry-processor.ts`<br>`ui/navigator.ts` | — |

#### `src/ui/navigator.ts`

The navigator: today's entries, the return stack, and the three gestures.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `Navigator` | class | 42 | `export class Navigator` | `main.ts` | `tests/navigator.test.ts` |

#### `src/ui/platform.ts`

Which platform this is, as one answer.

| symbol | kind | line | signature | used by | tested by |
| --- | --- | --- | --- | --- | --- |
| `isPhone` | function | 14 | `export function isPhone(): boolean` | `editor/entry-keys.ts`<br>`main.ts` | `tests/platform-classes.test.ts` |
| `isMobile` | function | 21 | `export function isMobile(): boolean` | `main.ts` | `tests/platform-classes.test.ts` |
| `isTablet` | function | 28 | `export function isTablet(): boolean` | `main.ts` | `tests/platform-classes.test.ts` |
| `canHover` | function | 35 | `export function canHover(): boolean` | — | — |


<!-- design:end -->
