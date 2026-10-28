import Base
import ./LAWS.bend as Laws

# Proofs for `LAWS.bend`. Every law there is closed, so every proof here is
# reflexivity: both sides of the equality reduce to one term.
#
# `bend PROOF.bend` is the gate. `--verdict` rechecks it with the proven kernel
# and needs a Lean toolchain (`elan`, toolchain leanprover/lean4:v4.34.0); see
# `npm run bend:proof`.
#
# Recorded from the step-0 spike, because it shapes how this file is written:
# - `bend x.bend -o x.mjs` emits ONE default export holding every non-IO def, so
#   TypeScript reaches these through `src/core/bend/duration.mjs`.
# - a def must be defined above the defs that call it, and a `match` may not
#   scrutinize a computed value.
# - a Bool crosses to JS as a JS boolean, a U32 and a Nat as a JS number.

def Laws.clock_zero():
  {==}

def Laws.clock_six_minutes():
  {==}

def Laws.clock_past_an_hour():
  {==}

def Laws.clock_past_a_day():
  {==}

def Laws.parse_roundtrip():
  {==}

def Laws.parse_rejects_a_short_clock():
  {==}

def Laws.parse_rejects_seconds_past_fifty_nine():
  {==}

# Worth checking in parallel: the proofs are independent and of like cost. The
# algebra itself stays sequential — three readings are dependent div/mods of one
# word, which a fork would cost more than it splits.
def all() -> Unit:
  a b = Laws.clock_zero() Laws.clock_past_an_hour()
  c d = Laws.clock_past_a_day() Laws.parse_roundtrip()
  e f = Laws.parse_rejects_a_short_clock() Laws.parse_rejects_seconds_past_fifty_nine()
  Unit{}
