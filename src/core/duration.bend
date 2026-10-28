import Base

# The duration algebra: seconds in, an `HH:MM:SS` clock out, and the inverse that
# reads a clock string back.
#
# Units are explicit and the arithmetic is pure div/mod, so rounding stays in
# `src/core/duration.ts`, where milliseconds are still in view. Every def is a
# single word because `-o duration.mjs` exports each name verbatim, and every def
# appears above the defs that call it: Bend binds only what is already defined.
#
# One format for both directions: an entry's clock reads against the marker's
# clock, so a duration and a time of day are the same shape and can be compared
# by eye.
#
# Two shapes the checker refuses, and how each is avoided here:
# - `match` may not scrutinize a computed value: every `match` below inspects a
#   parameter, so a computed condition is always passed to a def of its own.
# - a destructuring bind of a computed pair counts as scrutinizing it: `field`
#   hands its two halves to `field_value` as separate parameters instead.

# ── Reading a clock string ───────────────────────────────────────────────

# A finished field as `n + 1`, or `0n` when a non-digit was seen, so that a zero
# means "no duration" and no constructor has to cross the JS boundary.
def field_value(+ok: Bool, +v: U32) -> Nat:
  match ok:
    case True{}:
      Nat.add(U32.to_nat(v), 1n)
    case False{}:
      0n

# One field's digits, left to right, as `n + 1`; `0n` when any of them is not a
# digit, which keeps `field` total over every string the writer can type.
def field(cs: List<&2, Char>, +acc: U32, +ok: Bool) -> Nat:
  match cs:
    case Nil{}:
      field_value(ok, acc)
    case +c <> t:
      field(
        t,
        U32.add(U32.mul(acc, 10), U32.sub(Char.to_u32(c), 48)),
        Bool.and(ok, Char.is_digit(c)))

def all3(+a: Bool, +b: Bool, +c: Bool) -> Bool:
  Bool.and(Bool.and(a, b), c)

# `match` inspects its own parameter: a computed condition arrives here as one.
# Field values arrive as `n + 1`, so each contributes `n` to the clock.
def verdict(+okay: Bool, +hn: Nat, +mn: Nat, +sn: Nat) -> Nat:
  match okay:
    case True{}:
      Nat.add(
        Nat.add(
          Nat.add(Nat.mul(Nat.sub(hn, 1n), 3600n), Nat.mul(Nat.sub(mn, 1n), 60n)),
          Nat.sub(sn, 1n)),
        1n)
    case False{}:
      0n

# The claim that the text really is `HH:MM:SS`: three fields of digits, hours at
# least two digits, minutes and seconds under sixty.
def encode(+h: String, +m: String, +s: String) -> Nat:
  +hn = field(String.to_list(h), 0, True{})
  +mn = field(String.to_list(m), 0, True{})
  +sn = field(String.to_list(s), 0, True{})
  verdict(
    Bool.and(
      all3(Nat.is_ge(hn, 1n), Nat.is_ge(mn, 1n), Nat.is_ge(sn, 1n)),
      Bool.and(
        Nat.is_ge(String.length(h), 2n),
        Bool.and(Nat.is_lt(Nat.sub(mn, 1n), 60n), Nat.is_lt(Nat.sub(sn, 1n), 60n)))),
    hn,
    mn,
    sn)

# A fourth field means the text is not a duration line.
def after_third(h: String, m: String, s: String, rest: List<&2, String>) -> Nat:
  match rest:
    case Nil{}:
      encode(h, m, s)
    case x <> t:
      0n

def after_second(h: String, m: String, rest: List<&2, String>) -> Nat:
  match rest:
    case Nil{}:
      0n
    case s <> rest2:
      after_third(h, m, s, rest2)

def after_first(h: String, rest: List<&2, String>) -> Nat:
  match rest:
    case Nil{}:
      0n
    case m <> rest2:
      after_second(h, m, rest2)

# One cons per match, so no nested list pattern has to be accepted.
def three(parts: List<&2, String>) -> Nat:
  match parts:
    case Nil{}:
      0n
    case h <> rest:
      after_first(h, rest)

# "HH:MM:SS" -> 0n when it is not exactly that shape, seconds + 1n when it is.
def parseClock(s: String) -> Nat:
  three(String.split(s, ':'))

# ── Writing a clock string ───────────────────────────────────────────────

def pad_if(+lt: Bool, +n: U32) -> String:
  match lt:
    case True{}:
      String.append("0", U32.show(n))
    case False{}:
      U32.show(n)

def pad2(+n: U32) -> String:
  pad_if(U32.is_lt(n, 10), n)

# Seconds -> "HH:MM:SS", hours unbounded. Sequential on purpose: the three
# readings are dependent div/mods of one word, where a fork costs more than the
# arithmetic it would split.
def clock(+t: U32) -> String:
  h = U32.div(t, 3600)
  m = U32.div(U32.mod(t, 3600), 60)
  s = U32.mod(t, 60)
  a = String.append(pad2(h), ":")
  b = String.append(a, pad2(m))
  d = String.append(b, ":")
  String.append(d, pad2(s))
