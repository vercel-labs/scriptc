// comptime values are Node's values. The evaluator computes Math's
// transcendental members and hypot the way V8 does, so a table baked at
// compile time holds the values the same expressions give when Node
// evaluates them. Every row prints in full precision; the C library's
// versions differ in the last digit for a share of these inputs.
const table = comptime(() => {
  const rows: number[][] = [];
  for (let i = 0; i < 48; i++) {
    const x = i * 0.37 - 4.2;
    rows.push([
      Math.sin(x),
      Math.cos(x),
      Math.tan(x),
      Math.atan(x),
      Math.sinh(x),
      Math.cosh(x),
      Math.tanh(x),
      Math.asinh(x),
      Math.exp(x),
      Math.expm1(x),
      Math.cbrt(x),
      Math.atan2(x, 1.5),
      Math.hypot(x, 1.5, 0.25),
      Math.log(i + 0.5),
      Math.log1p(i / 7),
      Math.log2(i + 0.5),
      Math.log10(i + 0.5),
      Math.acosh(1 + i / 3),
      Math.asin(i / 48),
      Math.acos(i / 48),
      Math.atanh(i / 49),
    ]);
  }
  return rows;
});
for (const row of table) console.log(row.join(" "));

// The same members computed at run time give the same digits.
let same = 0;
for (let i = 0; i < table.length; i++) {
  const x = i * 0.37 - 4.2;
  if (table[i]![0] === Math.sin(x) && table[i]![8] === Math.exp(x) && table[i]![10] === Math.cbrt(x)) same++;
}
console.log("matches at run time", same, "of", table.length);

// Edge cases of hypot, and values far from zero.
const edges = comptime(() => [
  Math.hypot(),
  Math.hypot(-3),
  Math.hypot(3, 4),
  Math.hypot(0, -0),
  Math.hypot(1e300, 1e300),
  Math.hypot(1e-300, 1e-300),
  Math.sin(1e22),
  Math.cos(1e22),
  Math.exp(709.5),
  Math.cbrt(-27),
  Math.atan2(-1, -1),
]);
console.log(edges.join(" "));

// 64-bit wrapping arithmetic on bigints: an FNV-1a hash of each word, baked
// as hexadecimal text. BigInt.asUintN answers a non-negative value whatever
// the sign of its input and whichever bit of the width is set.
const hashes = comptime(() => {
  const fnv1a = (word: string): string => {
    let hash = 0xcbf29ce484222325n;
    for (let i = 0; i < word.length; i++) {
      hash = BigInt.asUintN(64, (hash ^ BigInt(word.charCodeAt(i))) * 0x100000001b3n);
    }
    return hash.toString(16);
  };
  return ["", "a", "comptime", "evaluator", "the quick brown fox"].map(fnv1a);
});
console.log(hashes.join(" "));
const wrapped = comptime(() =>
  [
    BigInt.asUintN(64, -1n),
    BigInt.asUintN(63, -1n),
    BigInt.asUintN(8, -1n),
    BigInt.asUintN(64, 2n ** 64n - 1n),
    BigInt.asUintN(64, -(2n ** 63n)),
    BigInt.asUintN(128, -5n),
    BigInt.asUintN(0, -1n),
    BigInt.asIntN(64, 2n ** 64n - 1n),
    BigInt.asIntN(8, 255n),
  ].map(String),
);
console.log(wrapped.join(" "));
