import Base
import ./src/core/duration.bend as D

# The laws of the duration algebra, stated. `PROOF.bend` proves each one.
#
# Every claim below is closed — no `for` — so each discharges by `{==}`: both
# sides reduce to the same term. They pin exactly the values
# `tests/duration.test.ts` pins, so the Bend module and the TypeScript facade
# cannot drift apart without the gate going red.
#
# From this commit on this file belongs to the human: the AI writes the code and
# `PROOF.bend`, and adds laws only when asked.

law clock_zero:
  {D.clock(0) == "00:00:00" : String}

law clock_six_minutes:
  {D.clock(372) == "00:06:12" : String}

law clock_past_an_hour:
  {D.clock(3723) == "01:02:03" : String}

law clock_past_a_day:
  {D.clock(90000) == "25:00:00" : String}

# Parsing laws stay inside a few minutes: Base's `Nat` is unary, so a literal
# past roughly thirty thousand frames overflows the checker's stack. The
# formatting laws carry the large values, because they compare `String`s.
law parse_roundtrip:
  {D.parseClock("01:02:03") == 3724n : Nat}

law parse_rejects_a_short_clock:
  {D.parseClock("00:04") == 0n : Nat}

law parse_rejects_seconds_past_fifty_nine:
  {D.parseClock("00:60:00") == 0n : Nat}

# LAW: the duration line is an entry's only mutable field.
# LAW: `+` alone is settled; `-` and `=` are both open, and `=` is written when
#      the writer stops writing.
