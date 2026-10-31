# Glosses — plan

A working record of a design conversation, revised against the vault as evidence.
It names symbols that do not exist yet, which is why it lives at the repository
root and not in `docs/`: the gate holds that every backticked name resolves in
`src/`, and it is right to — a plan is about the future, a claim is about the
present.

Status: **proposed**. Nothing here is implemented.

---

## What the vault says

Two corpora, read rather than assumed.

**`Chronomancer/` — the writing.** 102 entries in October: median 35 words, mean
54, longest 308. Dictated, unpunctuated, stream-of-consciousness, asides carrying
the real thought. 20% contain a question mark.

**`Autonomic Ingest/Entries/2026.10/` — the naming.** 106 transcripts, 147,670
words, 974 generated section headings of the form `HH:MM - <phrase>`. That is the
only large corpus of names this system already produces, so it is the style
evidence:

| Fact | Value |
| --- | --- |
| Headings | 974 |
| Median length | 6 words (mean 6, max 10) |
| ≤ 8 words | 925 / 974 (95%) |
| Joined by " and " | 790 (81%) |
| Comma lists | 300 (31%) |
| Gerund-led | 277 (28%) |
| **Questions** | **1** |

And the voice, sampled: *"Fear, pacing, and the mindset needed to act"* ·
*"Slowing down and valuing the quality of output"* · *"Buddhism, recurring loops,
and ways to change the experience"* · *"Durability, shared vocabulary, and
publishing thoughts"*.

Three conclusions:

1. **The form is not the authority.** The headings are one view of naming, and a
   view that can change; a compressed phrase is not the goal. What the corpus is
   good for is length discipline — median 6 words, 95% ≤ 8 — and that ceiling
   survives into the head (≤ 8 words per line).
2. **The question form is still wrong.** One heading in 974 is a question, but more
   importantly a question restates: `what is the review process?` told you nothing.
   A name closes a thought; a `next:` opens one.
3. **Richness beats compression.** The ask is an account of the entry, not a label
   for it: what it holds, what it connects to, what it would teach, what it would do
   next. That is a head of lines, not one phrase — and multiplicity is expressed by
   *different types*, not by joining words with "and".

---

## What changed since the first draft

| First draft | Now | Why |
| --- | --- | --- |
| Proposal shown in the frame's **top-right corner** | **deleted** | the frame is where the plugin speaks without writing; a gloss is writing |
| Two tiers: proposal + adopted | **one tier**: real lines, written at settle | an editable ghost line cannot exist — a text column has no spare vertical space |
| 3 items ≤ 2 words, ≤ 24 chars | **2–3 items joined by "and", ≤ 8 words** | 974 headings say 6 words, 95% ≤ 8 — length discipline kept |
| A question is allowed | **no questions** | 1 in 974 |
| One compressed phrase | **a typed head**: 1–3 lines, `name` bare, plus `thread:` / `learn:` / `next:` | the point is a rich reading, not a short one; prefixes make the note queryable without an index |
| `next` needs an accept key | **published like the rest** | a half-published head is incoherent, and a typed block reads as apparatus rather than as your prose |
| Persistent cache, LRU, denial memory | **deleted** — in-memory only | nothing re-proposes, so nothing can nag |
| Width degradation 3/2/1/0 | **deleted** | a line takes the column's width |
| Three verbs: confirm, deny, rewrite | **edit or undo** | confirm and rewrite are the same operation |
| No debounce needed | **idle speculation added** (computes, never writes) | typing is not a pause trigger |
| "commit" | **"publish"** | `docs/vision.md` already names this boundary |
| Mobile unaddressed | **mobile is capture only** | *"all i really care about on mobile is quick capture"* — `1.10.19` |

What survived untouched: publish-at-settle, the hash precondition, the branch
chain, the model port, the falsification test.

---

## The end goal

Every settled entry begins with a small **head** — one to three short lines that
say what it holds, what it connects to, what it would have you learn, and what it
would have you do next. The head reads as a rich account of the entry, not a
compressed label; the day reads as a sequence of thoughts, and a branch reads as a
chain. It is written once, when writing stops, and only if the text it describes is
still there.

One sentence: **the agent computes continuously and publishes once, on settle,
only if the text it read is still the text that is there.**

---

## Vocabulary

| Word | Means | Is not |
| --- | --- | --- |
| **Gloss** | One line of a head: a bare `name`, or `thread:` / `learn:` / `next:`. | A title (`entry.title` is taken: the first prose line), a heading, a question. |
| **Head** | 1–3 gloss lines written above an entry's prose. | A summary, a block, frontmatter. |
| **Type** | `name` (bare), `thread`, `learn`, `next` — a closed set of four. | A tag, a category, a score. |
| **Item** | One element of a gloss: `fear`, `pacing`, `the mindset needed to act`. | A tag, a keyword, a folder name. |
| **Chain** | A branch's glosses read in order, each naming what it adds over its ancestors. | A summary of the branch. |
| **Speculate** | Compute a gloss for the current text and cache it. Writes nothing. | A proposal, a draft, a queued job. |
| **Publish** | Write the gloss, at settle, if the hash still matches. | Save, sync, approve. |

---

## The mechanism

```
while writing   idle ~800 ms → compute gloss(hash) → in-memory cache   (no write)
on settle        hash matches?  → one plan: gloss line + `+`           (write)
                 hash changed?  → `+` only, entry stays untitled      (no write)
```

The hash is a fingerprint of the entry's prose plus its ancestors' first lines —
both are inputs, so both must match later. Not the marker, and not the clock row:
`-` becoming `=` must not invalidate a gloss. This is a compare-and-swap, which is
why no invalidation logic exists — a stale gloss fails its precondition and is
dropped. The same device the repository already uses for claim hashes.

### Three rules that follow

1. **A write is either part of the act that caused it, or it does not happen.** No
   deferred arrival. A line appearing above prose mid-sentence moves the text and
   the rails under your eyes — the one reflow this design cannot allow.
2. **Settle never waits on the network.** It is the most-used key in the app. Cold
   means untitled, immediately.
3. **The act is atomic.** The head and the duration half go into one
   `Rewrite` (`src/entries/writer.ts`), one transaction, one undo. The honest cost:
   undoing a gloss also reopens the entry, because both are one act.

### Speculation is invisible

An idle timer (~800 ms) computes and caches. It writes nothing, so it needs no undo
entry, no transaction, no surface. Typing is not a pause trigger, so without this
the cache is cold exactly when settling is most likely.

The cache is in-memory and bounded. If the app restarts mid-entry the entry is
still open and the settle is simply cold — no persistence, no LRU file, no
negatives.

---

## Decisions

### 1. The head is the artifact

There is no editable ghost line, because a text column has no negative space: every
visible row inside an entry is text. A rendered line would have to insert vertical
space (reflow, rails move) or be real blank lines (a schema change). So anything
editable above the prose **is** prose.

The frame keeps its three labels — marker, moment, duration. No fourth corner.

### 2. The form is a typed head

A head of **1–3 lines**, each ≤ 8 words, drawn from a closed set of four types:

| Type | Answers | Example (real entries) |
| --- | --- | --- |
| bare `name` | what it holds | `naming enforced, one proposal at a time` |
| `thread:` | what it connects to | `the spark, one unit of connection` |
| `learn:` | what it names but hasn't pinned | `durable execution` |
| `next:` | what it would do next | `port pi durable to go` |

A bare name is the default and carries no prefix; the three prefixes are the
exception, and they are what makes the note queryable: `next:` lines are a to-do
list, `learn:` lines are a study queue, `thread:` lines are a connection graph —
all of it plain text, no index, no second store.

The model returns only what is genuinely present. Most entries will carry one or two
lines; three is the ceiling, not the target. If the mean ever climbs past ~2, the
prompt is over-filling and the head stops being a reading.

No questions in a gloss. A question restates what the entry already asks
(`what is the review process?` told you nothing); the transaction is that a name
*closes* a thought and a `next:` *opens* one.

### 3. Novelty, not brevity

Any line whose content words are already in the entry is worthless. So:

> **A gloss line must contain content words the entry does not.**

Mechanically: reject a line when its content-word set overlaps the entry's by more
than a threshold. That single test catches restatement, first-five-words names, and
the question form that started this.

Plus: ≤ 8 words per line, ≤ 3 lines, at most one of each type, no line equal to an
ancestor's line, no question mark.

### 4. A gloss is a delta, and the branch is a chain

Every gloss is generated with its ancestors' first lines in view, under one rule:
name what this entry **adds**; never repeat a line an ancestor already has. So a
branch accumulates — `name` → `thread` → `next` — and a day reads as a diff rather
than twenty paraphrases of its root.

### 5. No provenance

An adopted line is ordinary text. No flag, no style, no marker saying a model
drafted it. The voice consistency with the ingest does the work: text in that voice
is already understood by you as generated.

### 6. Triggers

| Edge | What it does |
| --- | --- |
| **Idle** ~800 ms | speculate: compute and cache, never write |
| **Pause** (`=`) | refreshes speculation |
| **Settle** (`+`) | publish: one plan, or nothing |
| **Open** | nothing. Viewing writes nothing |
| **Command: gloss this day** | the only retroactive path; explicit, one plan per entry |

### 7. Names do not have to be enforced

`2.10.20` says *"that way naming is always enforced"*. Auto-publishing cannot
enforce it without either a deferred write (ruled out) or a placeholder (a lie on
screen). So the honest form of enforcement is invitation: an untitled entry simply
has no gloss, and the command exists for when you want them.

### 8. The model

- oMLX at `http://127.0.0.1:8000/v1` — OpenAI-compatible, SSE, `cors_origins: "*"`.
- Model `Qwen3.5-4B-MLX-4bit`. Per-role setting; `hash + model + promptVersion` is
  the cache key, so switching models invalidates by construction.
- Thinking is a per-model setting in oMLX's admin panel. The client ignores any
  `reasoning_content` delta and treats reasoning-only output as failure.
- Behind a `Model` port with `NoModel`, so `npm test` never needs a server. With
  `NoModel`, settle writes `+` and nothing else: indistinguishable from today.

### 9. Platforms

Desktop runs the model wherever it is; oMLX already advertises
`jordan-mac.tail570e1d.ts.net` in `server_aliases`, so mobile can point the same
port at the Mac. But mobile is **capture only** (`1.10.19`), so no model work is
scheduled for it.

Apple's Foundation Models is unreachable: a Swift-only framework, a WebView with
JavaScript plugins, no native bridge. *"Mobile is not a fork"* makes that a
settled matter rather than an obstacle.

### 10. Not doing

- **No chat surface, no session, no queue, no review surface.**
- **No question-form glosses.**
- **No `next step` per entry as a separate artifact.** `next:` is one line of a
  head; the *branch's* next step is a separate reading (`1.9.18`: *"dissection of a
  branch at a time"*), and a subtree has no line to live in. The per-entry head is
  its substrate.
- **No Go, no sidecar, no index** — until retrieval across days is wanted. That is
  also the stated learning project (`1.5.8`), and it comes after this.

---

## What is missing in the tree

| Need | Where | Cost |
| --- | --- | --- |
| a plan that writes an entry's first line | `src/core/insert.ts` (new, beside the five existing plans) | one pure function, one test, one §6 row, one claim |
| the model port and the oMLX adapter | `src/model/` (new) | two modules, doc comments for the gate |
| prompt assembly, novelty and shape tests, ancestor extraction | `src/model/` pure | the actual design; fully unit-testable |
| idle speculation, hash cache, cancellation | `src/model/` + a hook in `src/entries/engine.ts` | one timer, one map, one abort signal |
| the atomic publish | `src/entries/writer.ts` via `planRewrite` composition | one `Rewrite`, no new writer path |
| settings | `src/settings.ts`, `src/settings-tab.ts` | a §7 row each: on/off, endpoint, key, model |
| the backfill command | `src/main.ts` | one command, one §6 row |

Free payoff: `src/ui/navigator.ts:390` already renders `entry.title`, so a written
gloss becomes the navigator's row label with no new code. Reading view needs
nothing: the line is text there too.

Gate cost: new modules and exports need doc comments; `SYSTEM-DESIGN.md` gains rows;
`npm run design` rewrites the generated half; claims go red until re-stamped by a
person who re-read the sentences. This file sits outside `docs/` so it cannot turn
the gate red while it describes things that do not exist.

---

## Increments

1. **Shaping, pure.** Novelty test, type set, line and length limits, prompt assembly with
   ancestors. No model, no network. Green under `npm test`.
2. **The port.** `Model`, `NoModel`, the oMLX adapter, settings. Off by default;
   with no model, settle behaves exactly as today.
3. **The plan.** A pure function that writes an entry's first line, with tests —
   offsets, the marker-row prose case, a clock row below it.
4. **The publish.** Idle speculation, hash compare-and-swap, the composed
   `Rewrite` at settle. The only increment that can damage a note, so it lands with
   the most tests.
5. **The chain.** Ancestors' first lines into the prompt; no-repeat enforced.
6. **The past.** The "gloss this day" command, and per-role model switching.

---

## Open questions

1. **The branch reading** — `1.9.18` asks for it and it is the goal, not a
   follow-on: the head is its **substrate**. A subtree has no line to live in, so it
   needs a place to speak. Separate surface, same model, later.
2. **The head's size** — the ceiling is 3 lines; the target is 1–2. If the mean
   climbs past ~2 per entry the prompt is over-filling and the head stops reading as
   an account. Worth measuring on the first fifty entries and tuning once.
3. **Should the gloss command exist at all**, or should a settled entry with no
   gloss stay that way forever?
4. **Where the API key lives** — `data.json` in plaintext, or elsewhere.
5. **Ancestors above a published head** — when a parent's first line is itself a
   gloss, the child's chain reads in generated voice twice. Worth checking whether
   that compounds or stays legible.
6. **The falsification test**, recorded so it can be honoured later: *delete the
   feature if the gloss never makes you skip rereading the prose.*
