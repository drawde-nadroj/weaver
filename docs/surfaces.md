# Weaver — surfaces

Every control Weaver ships, the job it does, and the form it took: **11 commands,
4 settings groups and 4 surfaces** — the strip, the Tapestry tab, the shuttle and
the weave row — plus travel and the marks themselves.

## One verb per intent

| id | Name | Chord | What it does |
| --- | --- | --- | --- |
| `spark` | Spark | `Mod+Shift+K` | A 1D dimension plus `✦` at the tip of the target note; the caret lands in the title and the note is revealed. |
| `insert-heading` | Insert dimension | `Mod+Shift+J` | Writes at the caret's site, one level under its parent; the caret lands in the title. |
| `open-composer` | Weave rows | `Mod+Shift+L` | The inline row; `⌘⏎` weaves N rows in one edit. |
| `new-draft` | Start a draft at the cursor | `Mod+Shift+D` | Opens a `⟪draft …⟫` block at the cursor. |
| `weave-draft` | Weave the draft at the cursor | — | Draft → dimension, in one undo. |
| `load-shuttle` | Shuttle | `Mod+Shift+G` | Loads the caret's context, then opens the palette. |
| `return` | Return to source | `Mod+Shift+Enter` | Jumps to the `✦` source of the spark above the caret, and back. |
| `close-day` | Close the day | — | `✓ HH:mm`, recomputed counters, a toast naming the time. |
| `tapestry` | Open Tapestry | `Mod+Shift+T` | The tab, at a scope. |
| `open-draft-search` | Search open drafts | — | Cross-note draft search. |
| `travel` | Travel through dimensions | `Mod+Shift+P` | Keyboard walk of the note's own dimensions. |

Travel is kept deliberately: it is the only keyboard walk of the note's own
dimensions and the established navigation vocabulary (previous/next,
shallower/deeper). Everything else that duplicated a surface is gone — the
sibling-above insert, the second shuttle verb, the ribbon icons, the breadcrumb
bar, the gutter lane, the mobile floating button and the palette-recalculation
command whose button now lives in Settings.

## The audit

Every control from `0.2.0`, with its shipped state.

| Control | Intended job | Shipped state |
| --- | --- | --- |
| `weaver:insert-heading` | Add a timestamped dimension under the cursor's section. | **Becomes an immediate insert.** Named *Insert dimension*; it writes the dimension where the caret is and leaves the caret in the title, so the note is the only authoring surface. |
| `weaver:append-h1` | Start a thread at the end of this note. | **Retired**, folded into `weaver:spark` with the *This note* target. Nothing claims its chord. |
| `weaver:insert-sibling-above` | Add an empty dimension above the current one. | **Deleted.** It was a second way to write the same line, and the only command whose result did not put the caret where you type. |
| `weaver:open-composer` | Compose several dimensions and land them in one edit. | **Kept, narrowed.** Named *Weave rows*: one row shape (level + title), `⌘⏎` commits, the footer reads `type a title to weave` until there is something to commit. |
| `weaver:new-draft` | Start an unfinished dimension at the cursor. | **Unchanged.** The id stays, because Obsidian stores user hotkeys against it. |
| `weaver:weave-draft` | Turn the draft at the cursor into a dimension. | **Unchanged**, and it now says `Weaver: no draft at the cursor.` instead of returning silently. |
| `weaver:open-draft-search` | Find a draft in another note. | **Unchanged.** |
| `weaver:travel` | Walk the note's dimensions and drafts from the keyboard. | **Unchanged.** Its two settings moved to Advanced. |
| `weaver:open-panel` | Show the control panel. | **Becomes `weaver:tapestry`**, a tab of its own at four scopes; the phone gets the sheet. |
| `weaver:load-shuttle` + `weaver:shuttle` | Load a source, then show what is loaded. | **One verb.** Loading is not a separate stop on the way to the palette. |
| `weaver:recalculate-palette` | Re-measure the vault's deepest dimension. | **Becomes a button** in Settings → Advanced, next to the depth it measures. |
| `weaver:toggle-gutter-rail` / `weaver:toggle-breadcrumbs` | Show or hide an orientation lane / context bar. | **Deleted with their surfaces.** The strip names the chain, so a second reading of it had no job left. |
| Ribbon icons | Discover the gutter rail and the panel. | **Deleted.** The command palette and the strip are the entry points. |
| Mobile floating button | Reach six commands from the corner of a phone. | **Deleted** with its three settings: the same commands are on the mobile toolbar and in the sheet. |
| Settings tab | Configure the surfaces. | **Four groups, 23 settings** (below). |

## Surface specs

### Strip

**Purpose.** Answer "where am I, and what is unfinished" in one line, without a
click and without a panel.

**Composition.** One line above the editor: the ancestor chain and the current
dimension, then the flags that are actually set, in order —
`1D Breaking Free ▸ 2D Why now · 1 untitled · 2 drafts · closed 21:29`. A day
with nothing recorded reads `Tue 27 Oct · no marks yet`; a day that has marks but
whose caret is above the first dimension reads just its date. It carries no spark
or dimension totals — the Tapestry's census owns those. It never scrolls with the
text and it is never a modal.

**Keys.** Click or tap the strip: it opens the Tapestry at the matching scope —
Day on the day note, Note everywhere else.

**States.** Day, closed day, empty day, other note, and hidden (no Markdown view).

**Touch.** The same line, pinned at the top of the note pane, ellipsized rather
than wrapped; the innermost chain segment survives; a tap opens the sheet.

### Tapestry

**Purpose.** Show what exists and what is unfinished, at four scopes, without
becoming a second place to write prose.

**Composition.** One tab. Scope chips `Note · Day · Month · All` and the Spark
target toggle (`Today` / `This note`, saved on change) in the header, then that
scope's sections in one grid — `repeat(auto-fit, minmax(320px, 1fr))`, so two
columns at width and one in a narrow window, with no measurement code. `Threads`
(each row: numeral, `HH:mm` + title, child count, `✦` when a source is recorded),
`Census`, `Review`, `Drafts`, `Dimensions` (note scope only), `Calendar` (Month and
All), and `Past horizon` (All). Note scope shows Dimensions and Drafts; Day scope
shows Threads, Census, Review and today's Drafts; Month and All show Census, the day
totals and the calendar. Nothing else renders in a scope.

**Review** names what is unfinished, and every pending row is a button that leads
somewhere: `n drafts, unwoven` → Note scope, `n loaded, not yet woven` → the
shuttle, `n sparks untitled` → the first untitled 1D in the day note. With nothing
pending the first row reads `Nothing pending.` `last mark HH:mm` and `closed HH:mm`
are plain rows. Closing the day does not open anything: the strip flips to
`closed HH:mm` and the toast names the time.

**Keys.** `Tab` cycles focus between the two lists in note scope and walks out of
the panel; `↑`/`↓` or `j`/`k` move a list's cursor; `Home`/`End` reach its ends;
`↵` opens the row; `/` focuses that list's filter; a typed letter starts a filter.
In day scope there is exactly one cursor, over Threads.

**States.** One registered view, read-only, writing nothing: browsing every scope
must leave the vault unchanged. An open Tapestry is re-scoped and revealed rather
than duplicated. Month scope shows 12 weeks, All scope 53.

**Touch.** A bottom sheet with the same scope chips, the sections stacked, and 44px
rows; no cursors, no filters, every row a tap target.

### Shuttle

**Purpose.** Keep the sources you grabbed available while you write, without
writing anything into the vault.

**Composition.** A floating palette: header `Shuttle · 3 loaded`, rows showing the
source kind glyph (`✦` dimension, `▸` note, `❝` words), the short label, and the
day it was loaded. A row that has been woven in shows its use count as `·2`.

**Keys.** `↑`/`↓` or `j`/`k` move; `↵` weaves the source in at the caret; `⌥↵`
opens the source; `⌫` unloads; `/` filters; `Esc` closes. Weaving in keeps the row
and bumps its use count; only `⌫` unloads. Empty state: `Nothing loaded. Grab a
source with ⌘⇧G.`

**States.** Loaded, filtered, empty, and woven-in-but-retained. A successful load
says nothing beyond the palette opening with the row at the top; the toast is
reserved for `Weaver: nothing to load.` The shuttle persists across restarts as
plugin data, is device-local, is never synced into the vault, and is never counted
as evidence.

**Touch.** A bottom sheet above the keyboard with the same four verbs; `⌫` becomes
a swipe-left on a row plus a visible `×`.

### The weave row

**Purpose.** Record several dimensions at the caret, in the note you are already
in, without a modal over the text.

**Composition.** At the caret, no overlay: a block widget above the insertion line
holds one row per dimension — `◂ 1D ▸` and a real title field — and a footer with
the Weave button and the hint `⌘⏎ weave · Esc cancel`. Drafts keep their existing
`⟪draft⟫` markers; a draft is edited in place, not through this widget.

**Keys.** `⏎` adds a row, `⌘⏎` (or `⌥⏎`) weaves every non-empty row in one edit,
`⇥` moves to the level stepper, `◂`/`▸` step the level within the configured
depth, `Esc` cancels with the document untouched.

**States.** Empty (Weave disabled, footer `type a title to weave`), typing, and
committed. The widget never writes except as the single commit transaction, so
cancelling leaves the note byte-identical and every commit is one undo.

**Touch.** The same row, kept above the keyboard, with the level stepper as tap
targets.

### Marks

**Purpose.** Show what has happened, without turning events into structure.

**Composition.** A `✦` line renders as a chip in Reading view and as a banded line
in Live Preview (`--background-secondary`, a faint left rule, monospace); the
closing mark `✓ HH:mm` renders as muted text in both.

**Keys.** None of their own. In Live Preview only a line class is added, so the
glyph stays typable and a `[[link]]` inside a `✦` line stays clickable.

**States.** Present or absent. None of these are headings and none enter the
census as dimensions: a `✦` line inside frontmatter, inside a fenced code block or
inside a `⟪draft⟫` block is not a mark at all.

**Touch.** The same two states; the band carries the emphasis a hover card used to.

### Travel

**Purpose.** Move through the note's dimensions and drafts from the keyboard
without editing.

**Composition.** The bottom travel bar on phones and the key set elsewhere.

**Keys.** `1`–`9` level filter, `0`/`a` all, `↑`/`↓`/`j`/`k` move,
`←`/`→`/`h`/`l` parent or first child, `g`/`G` or `Home`/`End` first or last,
`Tab` headings or drafts, `Enter`/`Esc`/`q` leave at the current target.

**States.** Inactive, active over dimensions, active over drafts.

**Touch.** The bottom travel bar: Headings/Drafts toggle, level chips,
up/down/Done, parent/child.

## Settings

Four groups, 23 settings. It is the whole configuration surface.

| Group | Settings |
| --- | --- |
| Writing | `timestampFormat`, `timestampSeparator`, `maxDepth` |
| Day | `sparkTarget`, `writeDayCounters`, `dayNoteFolder`, `dayNoteFormat` |
| Look | `equalizeHeadingSizes`, `headingSize`, `headingLevelSizes`, `headingWeight`, `indentStep`, `mobileIndentStep`, `indentMaxLevel`, `colorMode`, `paletteTransitionMs`, `deepHeadingLivePreview`, `deepHeadingReadingView`, `portEmphasisColors`, `inPageDrafts` |
| Advanced | `travelDefaultLevel`, `travelWrap`, `debug`, plus the vault-depth rescan row |

## Mobile matrix

| Surface | Pointer | Touch |
| --- | --- | --- |
| Strip | One line above the editor; click opens the Tapestry at the matching scope. | One line pinned at the top of the note pane; tap opens the Tapestry sheet. |
| Tapestry | A tab with scope chips, filters and two list cursors. | Bottom sheet, same scope chips, sections stacked, 44px rows. |
| Shuttle | Floating palette with filter input and single-key verbs. | Bottom sheet above the keyboard, same four verbs, swipe-left plus a visible `×` to unload. |
| Weave row | Block widget above the caret with a real title field and stepper keys. | Same row, kept above the keyboard, level stepper as tap targets. |
| Marks | Banded `✦` line while writing, chip in Reading view, muted `✓` line. | The same three readings. |
| Travel | Keyboard walking with the travel bar hidden on desktop. | The bottom travel bar with level chips and Done. |

No surface ships phone-less: each one is designed twice, in the same vocabulary.

## Record formats

The contract every surface reads and writes. It is stated once here so that no
screen invents its own shape.

- **Day note frontmatter** written by the plugin: `date: YYYY-MM-DD`, `sparks: <n>`,
  `dimensions: <n>`, `sources: <n>`. Recalculated from the note and written only
  when a value changes. There is no `opened_at`, no `closed_at`: opening a day is
  not an event, and closing is a mark in the note.
- **Spark**: `# <HH:mm> - <Title>` in the day note, then the first body line
  `✦ [[<note>#<HH:mm - Title>|<HH:mm Title>]]`, optionally followed by ` - <why>`.
  A spark without a recorded source is a bare `✦` line and still counts as a spark.
  A spark with no title yet (`# <HH:mm> - `) is a legal record: it counts as
  untitled, is named `Untitled` by the strip and Review, and is never auto-repaired.
- **Words**: `^<id>` appended to the end of the referenced line. Never on its own
  line.
- **Closing**: `✓ <time>` on its own line, never a heading, where `<time>` uses the
  note's timestamp format, so `✓ 23:41` or `✓ 23:41:07`. A day carries at most one
  closing mark; the last one wins on read, and a second close is refused with a
  notice that ends `Nothing was written.`
- **Drafts**: the `⟪draft L.O YYYY-MM-DD HH:mm:ss⟫ … ⟪/draft L.O⟫` pair, unchanged.
- **Counting**: `sparks` = 1D dimensions in the day note; `dimensions` = all
  dimensions in the day note; `sources` = `✦` lines carrying a link. `untitled` is
  derived from the note (1D dimensions with an empty title) and is never written to
  frontmatter. The counters are written after every mutation of the day note —
  spark, dimension, weave, close — and after a two-second-debounced `modify`, and
  only when a value changed.
- **Block ids** are six characters from `a-z0-9`, unique within the file, appended
  as ` ^<id>` to the end of the referenced line, reusing an existing trailing id
  rather than adding a second one.
