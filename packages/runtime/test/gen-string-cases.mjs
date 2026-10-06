// Generates string-method test cases with Node as the oracle.
// Each line: <op>\t<input-hex>\t<args>\t<expected-hex>
//
//   node gen-string-cases.mjs > string-cases.txt
//
// All strings are hex-encoded UTF-8 bytes ("-" = empty) so the file is
// unambiguous; numeric args use String(x) (strtod-parseable, including
// "NaN"/"Infinity"/"-Infinity"); numeric/boolean expected values are the
// hex of String(result), which the C side reproduces via scr_f64_to_str
// (itself fuzz-verified against Node) or "true"/"false".
//
// Divergence handling: scriptc stores well-formed UTF-8 and replaces the
// lone surrogates JS produces (charAt on half an astral pair, slice
// boundaries splitting a pair) with U+FFFD. Buffer.from(str, "utf8")
// performs exactly that replacement, so hex-encoding the JS result through
// Buffer *is* the documented post-processing — the divergence cases are in
// this file with the scriptc-expected bytes, not skipped. test_string.c
// additionally asserts a few of them by hand for explicitness.
import { stdout } from "node:process";

const hex = (str) => {
  const b = Buffer.from(str, "utf8");
  return b.length ? b.toString("hex") : "-";
};
const num = (x) => String(x); // NaN / Infinity / -Infinity / -0 -> "0": all fine

const strings = [
  // ASCII
  "",
  "a",
  "Z",
  "abc",
  "abab",
  "ababab",
  "aXbXc",
  "hello world",
  "Hello, World! 123",
  "abc\0def", // embedded NUL (valid UTF-8; len-based, not strlen-based)
  // whitespace / trim material
  " ",
  "  padded  ",
  "\t\r\n x \n\r\t",
  // the full JS WhiteSpace + LineTerminator set around a payload
  "\t\n\v\f\r          　﻿w s　﻿ \t",
  "​", // ZERO WIDTH SPACE is NOT JS whitespace — must survive trim
  " 　\u{1F600}　 ", // astral payload inside whitespace
  // Latin-1 / 2-byte UTF-8
  "é",
  "café",
  "naïve über",
  // 3-byte UTF-8: CJK and BMP edges
  "你好世界",
  "日本語テスト",
  "你好world",
  "�", // pre-existing replacement char (distinct from divergence output!)
  "￿", // private use + max BMP
  "a b c", // line separators mid-string
  // astral (4-byte UTF-8, surrogate pairs in JS)
  "\u{1F600}",
  "a\u{1F600}b",
  "\u{1F600}\u{1F601}\u{1F602}",
  "x\u{1F600}\u{1F600}y",
  "\u{10000}",
  "\u{10FFFF}",
  "a\u{10FFFF}",
  "\u{1F1FA}\u{1F1F8}", // regional indicators (flag)
  // combining marks
  "é",
  "café",
  "à́̂b",
  // mixed everything
  "mixed é中\u{1F600}é end",
  "\u{1F600} café 世界 é!",
];

const lines = new Set();
function emit(op, input, args, expected) {
  lines.add(`${op}\t${hex(input)}\t${args}\t${expected}`);
}

// Pin conversion and early exhaustion separately from the broad method
// oracle: limits can stop between the surrogate halves of an astral unit.
for (const [input, separator] of [
  ["", ","],
  [",a,,b,", ","],
  ["ababa", "aba"],
  ["a\0b\0", "\0"],
  ["a😀b", ""],
]) {
  for (const limit of [0, 1, 2, 3, 7, -1, 1.9, NaN, Infinity, 4294967296, 4294967297]) {
    const pieces = input.split(separator, limit);
    emit(
      "splitLimit",
      input,
      `${hex(separator)},${num(limit)}`,
      hex(`${pieces.length}:${pieces.join("\x01")}`),
    );
  }
}

for (const s of strings) {
  const L = s.length;
  const idxs = [
    ...new Set([
      NaN,
      -Infinity,
      Infinity,
      -L - 5,
      -L - 1,
      -L,
      -L + 1,
      -3,
      -2,
      -1,
      -0.5,
      0,
      0.5,
      1,
      1.5,
      2,
      3,
      Math.floor(L / 2),
      L - 2,
      L - 1,
      L - 0.5,
      L,
      L + 1,
      L + 5,
    ]),
  ];

  emit("len", s, "-", hex(String(L)));
  emit("trim", s, "-", hex(s.trim()));
  emit("trimStart", s, "-", hex(s.trimStart()));
  emit("trimEnd", s, "-", hex(s.trimEnd()));

  // split(separator): expected is `${count}:${pieces.join("\x01")}` so
  // empty results ([] vs [""]) stay distinguishable; \x01 appears in no
  // corpus string. Lone-surrogate pieces (empty separator over astral
  // chars) hex through Buffer.from as U+FFFD — exactly the divergence.
  for (const sep of new Set([
    "",
    ",",
    "a",
    "X",
    " ",
    "é",
    "世",
    "\u{1F600}",
    s.slice(0, 1),
    s.slice(1, 3),
    s,
  ])) {
    if (!sep.isWellFormed()) continue;
    const pieces = s.split(sep);
    emit("split", s, hex(sep), hex(`${pieces.length}:${pieces.join("\x01")}`));
  }

  // padStart/padEnd: targets around the length, fills of 1..n units
  // including astral fills the truncation can split (JS keeps the lone
  // high surrogate; Buffer.from's hex makes it the U+FFFD we emit).
  for (const target of [NaN, -3, 0, 1, L - 1, L, L + 1, L + 3, L + 7, L + 0.5, 2 * L + 3])
    for (const fill of ["", " ", "0", "ab", "xyz", "é", "\u{1F600}", "a\u{1F600}"]) {
      emit("padStart", s, `${num(target)},${hex(fill)}`, hex(s.padStart(target, fill)));
      emit("padEnd", s, `${num(target)},${hex(fill)}`, hex(s.padEnd(target, fill)));
    }

  for (const i of idxs) {
    emit("charCodeAt", s, num(i), hex(String(s.charCodeAt(i))));
    emit("charAt", s, num(i), hex(s.charAt(i)));
  }

  for (const a of idxs)
    for (const b of idxs) emit("slice", s, `${num(a)},${num(b)}`, hex(s.slice(a, b)));

  // needles: derived substrings (only well-formed ones — a needle with a
  // lone surrogate cannot exist as a scriptc string) plus fixed probes
  const needles = [
    ...new Set(
      [
        "",
        "a",
        "b",
        "X",
        "z!",
        s,
        s + " ",
        s.slice(0, 1),
        s.slice(0, 2),
        s.slice(1, 3),
        s.slice(-1),
        s.slice(-2),
        s.slice(2, -1),
        "\u{1F600}",
        "世",
        "é",
        "é",
        "́",
        " ",
      ].filter((n) => n.isWellFormed()),
    ),
  ];
  const fromIdxs = [
    ...new Set([
      NaN,
      -Infinity,
      Infinity,
      -5,
      -1,
      0,
      1,
      1.5,
      2,
      Math.floor(L / 2),
      L - 1,
      L,
      L + 5,
    ]),
  ];
  for (const n of needles) {
    emit("includes", s, hex(n), hex(String(s.includes(n))));
    emit("startsWith", s, hex(n), hex(String(s.startsWith(n))));
    emit("endsWith", s, hex(n), hex(String(s.endsWith(n))));
    emit("lastIndexOf", s, hex(n), hex(String(s.lastIndexOf(n))));
    for (const f of fromIdxs)
      emit("indexOf", s, `${hex(n)},${num(f)}`, hex(String(s.indexOf(n, f))));
  }

  // valid repeat counts only; count < 0 / Infinity -> RangeError -> abort,
  // covered by the crash test in string.test.ts
  for (const c of [0, 1, 2, 3, 7, 2.9, 0.5, -0.5, NaN]) emit("repeat", s, num(c), hex(s.repeat(c)));
}

// parseInt(s, radix): args = String(radix) (strtod-parseable), expected =
// hex of String(result) — the C side formats through scr_f64_to_str,
// itself fuzz-verified against Node, so correctly-rounded bignum results
// compare exactly. String(-0) is "0" on both sides; the -0 SIGN is pinned
// by the differential corpus instead.
const parseIntInputs = [
  "",
  " ",
  "0",
  "-0",
  "+0",
  "42",
  "  42  ",
  "\t\n-17",
  "+99",
  "3.9",
  "1e3",
  "0x1F",
  "0X1f",
  "-0x20",
  "  +0xAb",
  "0x",
  "0xG",
  "08",
  "079",
  "ff",
  "FF",
  "zz",
  "z!",
  "101",
  "777",
  "12abc",
  "abc12",
  "-",
  "+",
  " - 1",
  "١٢٣",
  "Infinity",
  "NaN",
  "9007199254740993",
  "18446744073709551617",
  "123456789012345678901234567890",
  "9".repeat(40),
  "1" + "0".repeat(308),
  "1" + "0".repeat(309),
  "-1" + "0".repeat(400),
  "0".repeat(50) + "7",
  "deadbeefdeadbeefdeadbeefdeadbeef",
  "7".repeat(30),
  "1".repeat(80),
  "  1 ",
  "　42",
  "42\0",
  "1_000",
];
const radices = [
  undefined,
  0,
  2,
  8,
  10,
  16,
  36,
  1,
  37,
  -1,
  16.9,
  NaN,
  Infinity,
  -Infinity,
  2.5,
  4294967312,
  -4294967280,
  35,
];
for (const s of parseIntInputs)
  for (const r of radices)
    emit("parseInt", s, r === undefined ? "0" : num(r), hex(String(parseInt(s, r))));

stdout.write([...lines].join("\n") + "\n");
