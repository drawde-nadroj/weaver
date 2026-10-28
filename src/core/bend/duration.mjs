function word_to_u32(w) {
  let x = 0;
  for (let i = 0; w.$ === "WCon"; i++) {
    x |= Number(w.head) << i;
    w = w.tail;
  }
  return x >>> 0;
}

function u32_to_word(x) {
  let w = {$: "WNil"};
  for (let i = 31; i >= 0; i--) {
    w = {$: "WCon", head: ((x >>> i) & 1) === 1, tail: w};
  }
  return w;
}

function cmp_new(a, b) {
  return {$: a < b ? "LT" : a === b ? "EQ" : "GT"};
}

function nat_divmod(a, b) {
  return b === 0 ? {$: "Tuple", fst: 0, snd: a}
    : {$: "Tuple", fst: Math.trunc(a / b), snd: a % b};
}

function nat_chk(n) {
  if (n > 281474976710655) {
    throw "bend: a Nat past the largest immediate 2^48-1";
  }
  return n;
}

function nat_in(n) {
  if (!Number.isInteger(n) || n < 0 || n > 2 ** 53) {
    throw "bend: expected a Nat host number: an integer from 0 to 2^53";
  }
  return n;
}

function f32_show(x) {
  let s = "nan";
  for (let p = 1; x === x && p <= 9 && f32_round(s) !== x; p += 1) {
    s = String(Number(x.toExponential(p - 1)));
  }
  return (Object.is(x, -0) ? "-0" : s).replace("Infinity", "inf");
}

function f32_bits(x) {
  return new Uint32Array(new Float32Array([x]).buffer)[0];
}

function f32_from_bits(u) {
  return new Float32Array(new Uint32Array([u]).buffer)[0];
}

function f32_read(s) {
  const re = /^[\t\n\v\f\r ]*[+-]?((\d+(?:\.\d*)?|\.\d+)(e[+-]?\d+)?|inf(inity)?|nan)$/i;
  const v = f32_round(s.replace(/inf\w*/i, "Infinity"));
  return re.test(s) ? {$: "Some", value: v} : {$: "None"};
}

const f32_round = function f32_round(s) {
  const d = Number(s);
  const a = Math.abs(d);
  const f = Math.fround(a);
  const g = 2 * a - Math.min(f, 2 ** 128);
  if (g === f || Math.fround(g) !== g || g === Infinity) {
    return Math.sign(d) * f;
  }
  let k = 0;
  while (a * 2 ** k % 1 !== 0) {
    k += 1;
  }
  const [, i, r, e] = /(\d*)\.?(\d*)(?:e([+-]?\d+))?$/i.exec(s);
  const n = Number(e ?? 0) - r.length;
  const x = BigInt(i + r) * 2n ** BigInt(k) * 10n ** BigInt(Math.max(n, 0));
  const y = BigInt(a * 2 ** k) * 10n ** BigInt(Math.max(-n, 0));
  return Math.sign(d) * (x === y || x > y !== g > f ? f : g);
};

const char_new = function char_new(c) {
  return c < 55296 || c >= 57344 && c <= 1114111 ? String.fromCodePoint(c) : String.fromCharCode(56320, c >>> 22, c >>> 11 & 2047, c & 2047);
};

function char_len(s, at = 0) {
  return s[at] === "\uDC00" ? 4 : s.codePointAt(at) > 0xFFFF ? 2 : 1;
}

function char_code(s) {
  return s.length < 4 ? s.codePointAt(0)
    : (s.charCodeAt(1) << 22 | s.charCodeAt(2) << 11 | s.charCodeAt(3)) >>> 0;
}

function string_contains(s, p) {
  // A match must start at a Char boundary, not inside a packed U32 code.
  for (let at = 0; at <= s.length; at += char_len(s, at)) {
    if (s.startsWith(p, at)) {
      return true;
    }
  }
  return false;
}

function str_out(s) {
  return s.replace(/\uDC00[^]{3}/gu, "\uFFFD");
}

function str_in(s) {
  return s.replace(/\p{Cs}/gu, "\uFFFD");
}

// Array
// =====

function array_new(d, v) {
  if (d > 31) {
    throw "bend: an array past the deepest block class 31";
  }
  return Array(2 ** d).fill(v);
}

function array_node(a, b) {
  if (a.length !== b.length) {
    throw "bend: runtime fail-stop";
  }
  return a.concat(b);
}

function array_rmw(a, i, f) {
  const at = i % a.length;
  const old = a[at];
  a[at] = f(old);
  return {$: "Tuple", fst: a, snd: old};
}

// Run
// ===

function run_tail(f, x) {
  return {$: "$JMP", f: f.j?.f === f ? f.j : f, x};
}

function run_clo(j) {
  const f = (x) => run_loop(j(x));
  f.j = j;
  j.f = f;
  return f;
}

function run_loop(r) {
  while (r !== null && typeof r === "object" && r.$ === "$JMP") {
    r = r.f(r.x);
  }
  return r;
}

function run_lib(f, n) {
  return (...a) => a.length < n ? run_lib((...b) => f(...a, ...b), n - a.length)
    : run_loop(f(...a));
}

// Effect
// ======

const $0eff = Object.create(null);

function io_eff(k, run) {
  if (arguments.length > 2) {
    throw new Error("bend: " + k + " takes no need: an effect that waits parks itself");
  }
  if (k in $0eff) {
    throw new Error("bend: two effects register " + k);
  }
  $0eff[k] = run;
}
// Program
// =======

function $field_value(_ok_0, _v_0) {
  if (_ok_0) {
    return nat_chk(_v_0 + 1);
  } else {
    return 0;
  }
}

function $field($0, $1, $2) {
  for (;;) {
    {
      const _cs_0 = $0;
      const _acc_0 = $1;
      const _ok_0 = $2;
      if (_cs_0.$ === "Nil") {
        return $field_value(_ok_0, _acc_0);
      } else {
        const _c_0 = _cs_0["head"];
        const _t_0 = _cs_0["tail"];
        const _x_0 = ($Char_to_u32(_c_0));
        const _x_1 = (Math.imul(_acc_0, 10) >>> 0);
        const _x_2 = ((_x_0 - 48) >>> 0);
        $0 = _t_0;
        $1 = ((_x_1 + _x_2) >>> 0);
        $2 = ($Bool_and(_ok_0, ($Char_is_digit(_c_0))));
        continue;
      }
    }
  }
}

function $all3(_a_0, _b_0, _c_0) {
  return $Bool_and(($Bool_and(_a_0, _b_0)), _c_0);
}

function $verdict(_okay_0, _hn_0, _mn_0, _sn_0) {
  if (_okay_0) {
    const _x_0 = (_hn_0 < 1 ? 0 : _hn_0 - 1);
    const _x_1 = (_mn_0 < 1 ? 0 : _mn_0 - 1);
    const _x_2 = nat_chk(_x_0 * 3600);
    const _x_3 = nat_chk(_x_1 * 60);
    const _x_4 = nat_chk(_x_2 + _x_3);
    const _x_5 = (_sn_0 < 1 ? 0 : _sn_0 - 1);
    const _x_6 = nat_chk(_x_4 + _x_5);
    return nat_chk(_x_6 + 1);
  } else {
    return 0;
  }
}

function $encode(_h_0, _m_0, _s_0) {
  const _hn_0 = ($field(($String_to_list(_h_0)), 0, true));
  const _mn_0 = ($field(($String_to_list(_m_0)), 0, true));
  const _sn_0 = ($field(($String_to_list(_s_0)), 0, true));
  const _x_0 = (_mn_0 < 1 ? 0 : _mn_0 - 1);
  const _x_1 = (_sn_0 < 1 ? 0 : _sn_0 - 1);
  return $verdict(($Bool_and(($all3(($Nat_is_ge(_hn_0, 1)), ($Nat_is_ge(_mn_0, 1)), ($Nat_is_ge(_sn_0, 1)))), ($Bool_and(($Nat_is_ge([...str_out(_h_0)].length, 2)), ($Bool_and((_x_0 < 60), (_x_1 < 60))))))), _hn_0, _mn_0, _sn_0);
}

function $after_third(_h_0, _m_0, _s_0, _rest_0) {
  if (_rest_0.$ === "Nil") {
    return $encode(_h_0, _m_0, _s_0);
  } else {
    return 0;
  }
}

function $after_second(_h_0, _m_0, _rest_0) {
  if (_rest_0.$ === "Nil") {
    return 0;
  } else {
    const _s_0 = _rest_0["head"];
    const _rest2_0 = _rest_0["tail"];
    return $after_third(_h_0, _m_0, _s_0, _rest2_0);
  }
}

function $after_first(_h_0, _rest_0) {
  if (_rest_0.$ === "Nil") {
    return 0;
  } else {
    const _m_0 = _rest_0["head"];
    const _rest2_0 = _rest_0["tail"];
    return $after_second(_h_0, _m_0, _rest2_0);
  }
}

function $three(_parts_0) {
  if (_parts_0.$ === "Nil") {
    return 0;
  } else {
    const _h_0 = _parts_0["head"];
    const _rest_0 = _parts_0["tail"];
    return $after_first(_h_0, _rest_0);
  }
}

function $parseClock(_s_0) {
  return $three(($String_split(_s_0, ":")));
}

function $pad_if(_lt_0, _n_0) {
  if (_lt_0) {
    const _x_0 = ($U32_show(_n_0));
    return ("0" + _x_0);
  } else {
    return $U32_show(_n_0);
  }
}

function $pad2(_n_0) {
  return $pad_if((_n_0 < 10), _n_0);
}

function $clock(_t_0) {
  const _h_0 = (3600 === 0 ? 0 : (_t_0 / 3600) >>> 0);
  const _x_0 = (3600 === 0 ? _t_0 : _t_0 % 3600);
  const _m_0 = (60 === 0 ? 0 : (_x_0 / 60) >>> 0);
  const _s_0 = (60 === 0 ? _t_0 : _t_0 % 60);
  const _x_1 = ($pad2(_h_0));
  const _a_0 = (_x_1 + ":");
  const _x_2 = ($pad2(_m_0));
  const _b_0 = (_a_0 + _x_2);
  const _d_0 = (_b_0 + ":");
  const _x_3 = ($pad2(_s_0));
  return (_d_0 + _x_3);
}

function $Char_to_u32(_c_0) {
  return char_code(_c_0);
}

function $Bool_and(_a_0, _b_0) {
  if (!_a_0) {
    return false;
  } else {
    return _b_0;
  }
}

function $Char_is_digit(_c_0) {
  const _x_0 = char_code(_c_0);
  const _x_1 = char_code(_c_0);
  return $Bool_and((_x_0 >= 48), (_x_1 <= 57));
}

function $String_to_list(_s_0) {
  if (_s_0 === "") {
    return {$: "Nil"};
  } else {
    const _h_0 = _s_0.slice(0, char_len(_s_0));
    const _t_0 = _s_0.slice(char_len(_s_0));
    return {$: "Con", "head": _h_0, "tail": ($String_to_list(_t_0))};
  }
}

function $Nat_is_ge(_a_0, _b_0) {
  return $Cmp_is_ge(cmp_new(_a_0, _b_0));
}

function $String_split(_s_0, _sep_0) {
  if (_s_0 === "") {
    return {$: "Con", "head": "", "tail": {$: "Nil"}};
  } else {
    const _h_0 = _s_0.slice(0, char_len(_s_0));
    const _t_0 = _s_0.slice(char_len(_s_0));
    return $String_split_fin(_h_0, ($String_split(_t_0, _sep_0)), ($Char_is_eq(_h_0, _sep_0)));
  }
}

function $U32_show(_a_0) {
  const _b_0 = _a_0;
  return $U32_show_if(_b_0, (_b_0 === 0));
}

function $Cmp_is_ge(_c_0) {
  if (_c_0.$ === "LT") {
    return false;
  } else {
    return true;
  }
}

function $String_split_fin(_c_0, _r_0, _cut_0) {
  if (!_cut_0) {
    return $String_split_push(_c_0, _r_0);
  } else {
    return {$: "Con", "head": "", "tail": _r_0};
  }
}

function $Char_is_eq(_a_0, _b_0) {
  const _x_0 = char_code(_a_0);
  const _x_1 = char_code(_b_0);
  return (_x_0 === _x_1);
}

function $U32_show_if(_a_0, _z_0) {
  if (_z_0) {
    return "0";
  } else {
    return $U32_show_go(10, _a_0, "");
  }
}

function $String_split_push(_c_0, _ps_0) {
  if (_ps_0.$ === "Nil") {
    return {$: "Con", "head": (_c_0 + ""), "tail": {$: "Nil"}};
  } else {
    const _h_0 = _ps_0["head"];
    const _t_0 = _ps_0["tail"];
    return {$: "Con", "head": (_c_0 + _h_0), "tail": _t_0};
  }
}

function $U32_show_go($0, $1, $2, $3) {
  let $pc = 0;
  for (;;) switch ($pc) {
    case 0: {
      const _f_0 = $0;
      const _n_0 = $1;
      const _acc_0 = $2;
      if (_f_0 === 0) {
        return _acc_0;
      } else {
        const _g_0 = (_f_0 - 1);
        $0 = _g_0;
        $1 = _acc_0;
        $2 = _n_0;
        $3 = (_n_0 === 0);
        $pc = 1; continue;
      }
    }
    case 1: {
      const _g_0 = $0;
      const _acc_0 = $1;
      const _n_0 = $2;
      const _z_0 = $3;
      if (_z_0) {
        return _acc_0;
      } else {
        const _x_0 = (10 === 0 ? _n_0 : _n_0 % 10);
        $0 = _g_0;
        $1 = (10 === 0 ? 0 : (_n_0 / 10) >>> 0);
        $2 = (char_new(((48 + _x_0) >>> 0)) + _acc_0);
        $pc = 0; continue;
      }
    }
  }
}

function $U32_show_fin($0, $1, $2, $3) {
  let $pc = 1;
  for (;;) switch ($pc) {
    case 0: {
      const _f_0 = $0;
      const _n_0 = $1;
      const _acc_0 = $2;
      if (_f_0 === 0) {
        return _acc_0;
      } else {
        const _g_0 = (_f_0 - 1);
        $0 = _g_0;
        $1 = _acc_0;
        $2 = _n_0;
        $3 = (_n_0 === 0);
        $pc = 1; continue;
      }
    }
    case 1: {
      const _g_0 = $0;
      const _acc_0 = $1;
      const _n_0 = $2;
      const _z_0 = $3;
      if (_z_0) {
        return _acc_0;
      } else {
        const _x_0 = (10 === 0 ? _n_0 : _n_0 % 10);
        $0 = _g_0;
        $1 = (10 === 0 ? 0 : (_n_0 / 10) >>> 0);
        $2 = (char_new(((48 + _x_0) >>> 0)) + _acc_0);
        $pc = 0; continue;
      }
    }
  }
}
export default {
  "field_value": run_lib((a0,a1) => run_loop($field_value(a0,a1)), 2),
  "field": run_lib((a0,a1,a2) => run_loop($field(a0,a1,a2)), 3),
  "all3": run_lib((a0,a1,a2) => run_loop($all3(a0,a1,a2)), 3),
  "verdict": run_lib((a0,a1,a2,a3) => run_loop($verdict(a0,nat_in(a1),nat_in(a2),nat_in(a3))), 4),
  "encode": run_lib((a0,a1,a2) => run_loop($encode(str_in(a0),str_in(a1),str_in(a2))), 3),
  "after_third": run_lib((a0,a1,a2,a3) => run_loop($after_third(str_in(a0),str_in(a1),str_in(a2),a3)), 4),
  "after_second": run_lib((a0,a1,a2) => run_loop($after_second(str_in(a0),str_in(a1),a2)), 3),
  "after_first": run_lib((a0,a1) => run_loop($after_first(str_in(a0),a1)), 2),
  "three": run_lib((a0) => run_loop($three(a0)), 1),
  "parseClock": run_lib((a0) => run_loop($parseClock(str_in(a0))), 1),
  "pad_if": run_lib((a0,a1) => str_out(run_loop($pad_if(a0,a1))), 2),
  "pad2": run_lib((a0) => str_out(run_loop($pad2(a0))), 1),
  "clock": run_lib((a0) => str_out(run_loop($clock(a0))), 1),
};
