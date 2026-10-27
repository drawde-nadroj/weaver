# Weaver — vision

## Epigraph and promise

> sparks create a new reality, it's only fitting that they be first dimension so
> that i can return back to things
>
> — `Chronomancer/2026.10.26.md:52`

The sentence names the whole system. A thought that sparked something else is not
decoration around a note; it is the first dimension of a new thread, and it is
worth being the first because returning is the point. Anything that cannot be
returned to is a thought the note will lose.

The loop is one sentence: **grab → spark → deepen → return → review → grow**. A day
note is the tip of reality; a spark opens a thread; depth is dimension; evidence
stays in Markdown; only the working state you have not yet written down is private
to the plugin.

The promise is two commands: *spark it now, deepen it where you are*. Nothing in
this system asks you to leave the note you are writing in order to record what you
are writing. A capture surface that opens a dialog over the note it captures from
has already failed the promise, because the dialog is a second place to be.

## Vocabulary

| Term | Means | Is not |
| --- | --- | --- |
| **Dimension** | A level of thought inside a thread. `1D` is the top of a day, `2D` a thought inside it, and so on, one level per nesting step. | A Markdown feature, a global coordinate, a rank. |
| **Spark** | A 1D dimension: the seed of a thread, usually caused by something you were reading, hearing or thinking. | Any deeper dimension, a draft, a unit of score. |
| **Thread** | One spark and everything under it, across every dimension it opened. | A file, a tag, a session. |
| **Sparked by** | The recorded source of a spark, written as one `✦` line directly under the spark's dimension line. | A backlink, a parent, a property. |
| **Draft** | An unfinished dimension, written in place in the note and woven when it is ready. | A spark, session state, a separate note. |
| **Weave** | Turning a draft, or a column of composer rows, into dimensions in one edit. | An automatic rewrite, a sync operation. |
| **Tip** | The live edge: the end of today's day note, where new thought is appended. | The active file, a cursor, a stored coordinate. |
| **Day plane** | Today's day note, `Chronomancer/YYYY.MM.DD.md` — the file the core Daily Notes plugin opens, which in this vault uses format `YYYY.MM.DD` in folder `Chronomancer`. | The ingest day note under `Autonomic Ingest/`, which is a machine-written ledger. |
| **Return** (`↩`) | Going back to the source a spark came from, and then back again to the place you were writing. | Navigation to an unrelated note, evidence of attention. |
| **Mark** | A glyph on its own line that records an event rather than a thought: `✦` for a source, `✓` for a close. | A heading, a dimension, frontmatter. |
| **Census** | Counts by dimension, scoped to the thing you are looking at. | A score, a streak, a quality signal. |
| **Tapestry** | The view that shows threads, marks, census, calendar and past horizon at four scopes. | Another editor, a second prose store. |
| **Shuttle** | The tray of sources you have loaded and not yet woven in. | Evidence, a note, a permanent archive. |

**Rule.** Product copy says *dimension*; the word *heading* names only the Markdown syntax, and code identifiers keep their names. The hash-plus-number notation (`H1`…`Hn`) is syntax and never appears in product copy — use `1D`…`nD`.

## The loops

| Loop | Trigger | What moves | Lives in |
| --- | --- | --- | --- |
| Grab | Select text, a dimension or a note, then *Shuttle*. | A pointer to the source joins the shuttle; no prose is written. | Session |
| Spark | *Spark* at the tip, or at the cursor of this note. | A new 1D dimension, its `✦` source line, and the day's counters. | Evidence |
| Deepen | *Insert dimension*, *Start a draft*, or *Weave rows*, at the caret. | New 2D…nD dimensions below the current one. | Evidence |
| Return | `↩ *Return to source*` on a spark. | The place you were reading moves to the `✦` source, and back again. | Session |
| Review | Open the Tapestry's Day scope, or tomorrow's day note. | Nothing is written; the day is read back to you. | Derived |
| Grow | Month scope, All scope, and the calendar. | Nothing is written; longer patterns become visible. | Derived |

## Evidence versus session

The boundary rule is one test: **if the plugin vanished, the notes must still mean
something.**

Evidence is what a reader of the vault would find and understand without the
plugin: day notes, dimension lines, `✦` source lines and `✓` close lines, drafts,
and the frontmatter counters. Evidence is written by an explicit command and by
nothing else.

Session is where this installation is working right now: the shuttle, the
remembered Spark target, the Tapestry's scope, the cursor, the remembered return
place. Session state is device-local. It is never synced, never exported, and never
counted as attention. It becomes evidence only at the moment a command writes it
into a note.

## Progression

The census is a map, not a score. There are no streaks, no quality grades and no
attendance. Nothing in the system rewards opening the app on a day.

Growth is visible in four readings, and only these four:

1. threads per day — how many 1D dimensions a day note holds;
2. dimensions per thread — how far the deepest thread on a day went;
3. sources reused across days — how often the same `✦` source comes back;
4. days with a closing mark — how often a day was ended on purpose.

Closing is a decision, never attendance. An unfinished day is not a failure, and
the Tapestry shows an unfinished day as unfinished rather than as a gap to be
repaired. This restates the rule the earlier design already set: a dimension is a
derived reading, "not a stored field, not a global coordinate and not a rank"
(`~/chronomancer-me/docs/design/ontology.md`, §4; see also §7, where a plane is
explicitly "not a space, a global dimension, a rank").

## Reference forms

| Kind | Rendered form | When |
| --- | --- | --- |
| Note | `[[<note>]]` | The whole entry matters. |
| Dimension | `[[<note>#<HH:mm - Title>\|<HH:mm Title>]]` | A specific thought. **Preferred.** |
| Words | `[[<note>#^<id>\|<short alias>]]` | A passage. The `^id` is generated and appended to the **end of the referenced line**. |

A heading link beats a block id whenever the target is a dimension: it survives
editing above the target, it is readable in source, and it is what a person would
write by hand. Block ids are for prose that has no heading to name. Every dimension
link carries a short alias, because entry filenames are long and this vault is
edited in source (vim) mode, where a forty-character link is noise.

The current vault shows what happens without that rule. `Chronomancer/2026.10.26.md:1`
links `#^9e8a82`, but the id sits alone on a blank line in
`Autonomic Ingest/Entries/2026.10/2026.10.26 - Breaking Free and Building Thoughtware.md`,
so the reference points at an empty line. The same reference written as a dimension
link would name the thought it means, and would keep working when the passage above
it grows.

## Prior art

- **Information scraps.** Small pulled-out items elude filing tools, so capture has
  to be one gesture and schema-free; the filing happens later or never. Bernstein,
  "Information Scraps: How and Why Information Eludes our Personal Information
  Management Tools", TOIS 26(4), 2008 —
  https://people.csail.mit.edu/msbernst/papers/CSW-2007.pdf
- **Incremental formalization.** Informal notes become structured on demand rather
  than up front; demanding structure at capture time loses the thought. Shipman &
  McCall, "Supporting Knowledge-Base Evolution with Incremental Formalization",
  CHI '94 — https://dl.acm.org/doi/10.1145/191666.191768
- **Reference mechanisms and their brittleness.** Block-as-file, purple numbers,
  offset links and text fragments all buy addressability by tying a link to a
  position or an opaque id. Obsidian's `[[file#^id]]` is a purple number, which is
  why a heading link is preferred for dimensions. Brander, "Block reference
  mechanisms", 2022 — https://newsletter.squishy.computer/p/block-reference-mechanisms
- **This project's own prior iteration.** `plane → thought → spark → return →
  census`; the `MARK_GLYPH` table (`✦` spark, `↩` return, `✓` finish) in
  `~/chronomancer-me/apps/obsidian/src/chrono/tapestry-view.ts`; the
  contribution-calendar contract (Monday-start weeks, 0–4 intensity, future days
  marked) asserted in `~/chronomancer-me/apps/obsidian/test/contribution.test.ts`;
  and the cursor-free "viewing writes nothing" rule (`~/chronomancer-me/docs/design/ontology.md`
  §1, §2, §8).

## Naming rule for future docs

- Product word: **dimension**. Syntax word: heading.
- No hash-plus-number notation in copy: `1D`…`nD` only.
- New surfaces take weaving vocabulary — thread, shuttle, weave, return, mark.
- New surfaces do not take filing vocabulary — inbox, queue, folder, archive.
