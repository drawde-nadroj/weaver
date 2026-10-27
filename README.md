# Weaver

Weaver is an Obsidian plugin for time-stamped, depth-aware dimensions. A spark
opens a thread, a deeper dimension records a thought inside it, and a `✦` line
records what caused it — so the thought can be returned to. Every level is
first-class structure, coloured across a red→purple palette, and the four surfaces
that read it back — the strip, the Tapestry tab, the shuttle and the weave row —
never invent state of their own.

Weaver writes only through explicit commands, and everything it produces arrives
in one undoable edit. Viewing, filtering and browsing write nothing at all.

The system these surfaces serve — its vocabulary, its loops and its record
formats — is in [`docs/vision.md`](docs/vision.md), the controls in
[`docs/surfaces.md`](docs/surfaces.md) and the flows in
[`docs/user-flows.md`](docs/user-flows.md).

## Status

`0.3.0` — the spark → deepen → return loop is implemented end to end and covered
by `npm test`. Mobile is implemented and shares the same renderer as the desktop
surfaces, but it is **untested on a device**; the visual checks (colours, sizes,
sticky behaviour) have not been verified by eye yet.

## Features

- **Spark** — one command writes a new 1D dimension at the Spark target (today's
  day note, or the note you are in), plus its `✦` source line. Sparking from a
  selection ids the selection's last line and links straight to it.
- **One authoring row** — *Insert dimension* writes at the caret's own site and
  puts the caret in its title, so you type the dimension in the note. *Weave rows*
  opens one row per dimension instead: `⌘⏎` weaves them all in a single edit, and
  `Esc` leaves the file byte-identical.
- **Legible marks** — a `✦` source line carries a band in Live Preview as well as a
  chip in Reading view, so a recorded spark is visible where it is written. The
  glyph and any `[[link]]` stay editable and clickable.
- **Close the day** — one command appends `✓ HH:mm` and recomputes the day's
  counters. A day closes once; a second close is refused rather than duplicated.
- **Day counters** — `sparks`, `dimensions` and `sources` live in the day note's
  frontmatter, recalculated from the note and written only when a value changes.
- **Tapestry** — one read-only view for threads, census, drafts, the calendar and
  the past horizon, at Note, Day, Month and All scopes. Month and All read
  counters from the metadata cache and never open a file.
- **Shuttle** — a device-local tray of grabbed sources (a note, a dimension, a
  passage), woven in at the caret without leaving the note. Weaving keeps the
  row and counts the use; only an unload removes it.
- **Return** — `⌘⇧↵` jumps from a spark to its `✦` source and a second press
  comes back to where you were writing.
- **Marks** — `✦` source lines render as chips in Reading view and as banded lines
  while writing; `✓` close lines are muted text. Neither is a heading and neither
  enters the census.
- **In-page drafts** — a draft is real Markdown with a visible marker, a badge
  that names it and counts how long it has been open, and Weave/Discard buttons.
  Drafts never become dimensions until you weave them.
- **Depth-aware structure** — levels 1–12 (configurable to 24) are parsed,
  coloured and indented; 7D and deeper render as dimensions in Live Preview and
  Reading view while the file text stays plain Markdown.
- **Adjustable sizes** — one default size for every dimension, or a size per
  level when equalizing is off.
- **Travel mode** — editor-only keyboard navigation that filters by level and
  moves between parents, children and siblings without editing anything.
- **One palette** — the six anchor colours are restretched across the vault's
  real maximum depth, with a fixed-rainbow fallback.

## Language

Product copy says **dimension**; the word **heading** names only the Markdown
syntax, and no hash-plus-number notation appears in copy — levels read `1D`…`nD`.
The full naming rule, and the vocabulary it protects, is in
[`docs/vision.md`](docs/vision.md#naming-rule-for-future-docs).

## Keys

### The weave row

`⏎` adds a row, `⌘⏎` (or `⌥⏎`) weaves every non-empty row in one edit, `⇥` moves
to the level stepper, `◂`/`▸` step the level, and `Esc` cancels with the document
untouched. With nothing typed the Weave button is disabled and the footer reads
`type a title to weave`: the empty state is prevention, not a toast.

### Shuttle

`↑`/`↓` or `j`/`k` move, `↵` weaves in at the caret, `⌘↵` sparks from the source,
`⌥↵` opens it, `⌫` unloads, `/` filters, `Esc` closes.

### Tapestry

Focus a list and the arrows or `j`/`k` walk its rows, `Home`/`End` reach the ends,
`Enter` opens, and a typed letter starts that list's filter. `/` puts the caret in
the filter field, `↑`/`↓` there move the cursor, and `Esc` clears the query. In
Note scope `Tab` moves between the drafts and dimension lists; in Day scope there
is one cursor, so `Tab` leaves the panel.

### Travel

`1`–`9` filter by level, `0`/`a` show all, `↑`/`k` and `↓`/`j` move, `←`/`h` and
`→`/`l` walk to the parent or first child, `g`/`Home` and `G`/`End` jump to the
first or last target, `Tab` switches between dimensions and drafts, and
`Enter`/`Esc`/`q` leave travel at the current target.

## Drafts

A draft is a real block of Markdown in the note — nothing is hidden in plugin
storage, so git carries it, other tools read it, and an abandoned thought is
never lost. The only new syntax is the marker pair:

```markdown
⟪draft 3.2 2026-10-26 16:37:04⟫
Half-formed thought
body of the thought
⟪/draft 3.2⟫
```

- The first line after the open marker is the title; the lines up to the close
  marker are the body.
- The id is `<level>.<ordinal>`, so `draft 3.2` is a 3D draft.
- The datetime is always local `YYYY-MM-DD HH:mm:ss`, and the badge shows how
  long ago it was opened.
- Weaving replaces both markers with a normal timestamped dimension; discarding
  removes the block. Either way it is one undoable edit.
- Drafts never appear in the outline, the palette, travel-by-dimension, the
  Tapestry's census or deep-dimension rendering until they are woven. A marker with no
  matching close line is left as plain text, and Source mode always shows the raw
  markers so the block stays editable as text.

**Instruction for agents reading a note:** open drafts are the
`⟪draft <id> <date> <time>⟫ … ⟪/draft <id>⟫` blocks below. The most recent draft
has the greatest datetime, and the text inside a block is the user's current
thinking — not settled note content. Prefer the newest draft when the user says
"where I am now" or refers to a draft by id such as "draft 3.2".

## Install from source

```sh
npm install
npm run build
npm run deploy
```

`npm run deploy` copies `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/weaver` and never touches `data.json`. Set
`WEAVER_VAULT` to deploy somewhere other than `/Users/jordan/Knowledge`:

```sh
WEAVER_VAULT="/path/to/vault" npm run deploy
```

Then open **Settings → Community plugins**, reload the installed plugins, and
enable **Weaver**.

### Upgrading from the `rainbow-headings` snippet

Weaver injects `--h1-color` … `--h6-color` and colours the editor's own heading
spans, so it outranks a single-class snippet: you can leave `rainbow-headings`
enabled. Weaver ports the anchors plus the `em`/`strong` colours; it does not
edit the snippet or `appearance.json`.

## Development

```sh
npm run dev     # esbuild watch, writes main.js
npm run check   # typecheck + vitest + production build
```

`npm run dev` does not deploy. Run `npm run deploy` after a successful build, or
toggle the plugin off and on in Obsidian to reload.

## Commands

Every command carries an Obsidian icon, so it renders on the mobile toolbar.

| Command ID | Name | Default hotkey | Icon |
| --- | --- | --- | --- |
| `weaver:spark` | Spark | `Mod+Shift+K` | `sparkles` |
| `weaver:insert-heading` | Insert dimension | `Mod+Shift+J` | `heading` |
| `weaver:open-composer` | Weave rows | `Mod+Shift+L` | `pencil` |
| `weaver:new-draft` | Start a draft at the cursor | `Mod+Shift+D` | `file-plus` |
| `weaver:weave-draft` | Weave the draft at the cursor | — | `check` |
| `weaver:load-shuttle` | Shuttle | `Mod+Shift+G` | `inbox` |
| `weaver:return` | Return to source | `Mod+Shift+Enter` | `corner-up-left` |
| `weaver:close-day` | Close the day | — | `check-circle` |
| `weaver:tapestry` | Open Tapestry | `Mod+Shift+T` | `waypoints` |
| `weaver:open-draft-search` | Search open drafts | — | `search` |
| `weaver:travel` | Travel through dimensions | `Mod+Shift+P` | `compass` |

`weaver:append-h1`, `weaver:open-panel`, `weaver:insert-sibling-above`,
`weaver:shuttle`, `weaver:toggle-gutter-rail`, `weaver:toggle-breadcrumbs` and
`weaver:recalculate-palette` are gone: Spark took the first, the Tapestry tab the
second, and the rest duplicated a surface that no longer exists. *Shuttle* now
loads the caret's context **and** opens the palette in one step, so there is
nothing to bind a second key to. A hotkey you bound to a retired id needs
rebinding; the vault-depth rescan is a button in Settings.


## Settings

| Group | Setting | Default | Effect |
| --- | --- | --- | --- |
| Writing | Timestamp format | `HH:mm:ss` | The note's clock convention, for dimensions and the closing mark. |
| Writing | Separator | `" - "` | Text between the time and the title. |
| Writing | Maximum dimension depth | 12 | Highest level parsed, coloured and inserted (6–24). |
| Day | Spark target | Today | Where a spark lands: today's day note, or the note being edited. |
| Day | Write day counters | on | Keep `sparks`, `dimensions` and `sources` in the day note's frontmatter. |
| Day | Day note folder | `Chronomancer` | Used only when the core Daily Notes plugin cannot be read. |
| Day | Day note format | `YYYY.MM.DD` | Same fallback, for the filename. |
| Look | Equalize dimension sizes | on | Render every dimension at the default size; the inline title is untouched. |
| Look | Dimension size | `1em` | Default size, applied when sizes are equalized. |
| Look | Level sizes | blank | One field per level (1D…nD), used when sizes are **not** equalized. Blank keeps the theme size; accepts `em`, `rem` or `px`. |
| Look | Dimension weight | 600 | Font weight for all dimensions. |
| Look | Indent step (desktop) | 18px | Left padding added per level. |
| Look | Indent step (mobile) | 12px | Same, on phones. |
| Look | Indent maximum level | 8 | Levels beyond this stop indenting. |
| Look | Colour mode | Vault stretch | Six anchors spread across the vault's maximum depth, or a fixed rainbow with an extension. |
| Look | Current palette | — | The emitted swatches, with a recalculate button. |
| Look | Transition | 200 ms | Colour transition when the palette changes. |
| Look | Deep dimensions in Live Preview | on | Render 7D and deeper as dimensions and hide the hash run when the cursor is away. |
| Look | Deep dimensions in Reading view | on | Transform 7D and deeper paragraphs into dimension elements. |
| Look | Port `em`/`strong` colours | on | Orange `em`, red `strong`. |
| Look | Render drafts in the note | on | Show draft markers as a card with the badge. Off leaves the markers as plain text; drafts stay weavable either way. |
| Advanced | Vault depth | — | The measured depth and the palette span, with a rescan button. |
| Advanced | Travel default level | All | Level filter travel starts with. |
| Advanced | Travel wraps around | off | Whether travel wraps at the first and last dimension. |
| Advanced | Debug logging | off | Verbose console output. |

Twenty-three settings in four groups: **Writing** is the note's own convention,
**Day** is where a spark lands, **Look** is how the note is drawn, and **Advanced**
holds the rescan, travel and logging controls.

## Mobile

Weaver is `isDesktopOnly: false` and shares its renderer between desktop and
phone, so every surface is designed twice in the same vocabulary:

- **Strip** — one line pinned at the top of the note pane; a tap opens the
  Tapestry sheet at the matching scope.
- **Tapestry sheet** — the same four scope chips and the same sections as the tab,
  stacked, with 44px rows and no cursors.
- **Shuttle sheet** — a bottom sheet above the keyboard with the same four verbs;
  `⌫` becomes a visible `×` on the row.
- **Weave row** — kept above the keyboard, with the level stepper as tap targets.
- **Travel bar** — a Headings/Drafts toggle, level chips, up/down/Done and
  parent/child buttons that are disabled while drafts are the target.

## Known limits

- Dimensions deeper than 6D are invisible to Obsidian's outline core plugin and
  to `[[#heading]]` links, because the file text remains a standard ATX heading.
  Weaver's own dimension list and travel mode do list them.
- Month and All scopes read the frontmatter counters only. Per-level counts and
  the closing mark need the file, so those scopes report `1D` and the total, and
  never claim to know whether a day was closed.
- A words reference needs a block id. Loading a passage without one writes the
  id at load time — a pointer, not prose — because a passage link without an id
  addresses nothing.
- Draft marker datetimes are local and carry no timezone. A vault edited across
  timezones shows the authoring clock, and a draft opened in the future reports
  `stale` rather than a wrong timer.
- The draft search scans at most 5000 Markdown files and skips files above 2 MB,
  the same caps as the palette scan.
- The mobile toolbar is core Obsidian UI; Weaver cannot place its own buttons
  there. Add the command IDs manually.
- Mobile Vim mode and external hardware keyboards are unverified.
- Setext (`===` / `---` underlined) headings are not indexed.
- The vault palette scan skips files above 2 MB and caps the scan at 5000
  Markdown files, falling back to the last known depth.
