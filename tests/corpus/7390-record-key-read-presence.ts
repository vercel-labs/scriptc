// Keyed reads of string-indexed records whose values are numbers or
// booleans, consumed by `??`, `!`, comparisons with undefined and typeof:
// declared fields, an optional declared field, index-signature entries and
// missing keys. A stored NaN is a value, so `??` keeps it; -0 survives the
// read; a missing key is undefined.
interface Scores {
  base: number;
  bonus?: number;
  [name: string]: number | undefined;
}

const scores: Scores = { base: 10 };
scores["alice"] = 3;
scores["nan"] = NaN;
scores["negzero"] = -0;

const keys = ["base", "bonus", "alice", "nan", "negzero", "missing"];
for (const key of keys) {
  const read = scores[key];
  console.log(
    key,
    scores[key] ?? "default",
    scores[key] === undefined,
    typeof scores[key],
    Object.is(scores[key] ?? 1, -0),
    (scores[key] ?? 0) + 1,
    read,
  );
}
scores.bonus = 5;
console.log("bonus", scores["bonus"] ?? "default", scores["bonus"]! * 2);

const counts: Record<string, number> = {};
for (const word of "a b a c b a d".split(" ")) counts[word] = (counts[word] ?? 0) + 1;
let total = 0;
for (const word in counts) total += counts[word]!;
console.log(JSON.stringify(counts), total, counts["zzz"] ?? -1);

const flags: Record<string, boolean> = { on: true, off: false };
for (const key of ["on", "off", "unset"]) {
  console.log(key, flags[key] ?? "unset", flags[key] === undefined, typeof flags[key]);
}
let seen = 0;
for (let i = 0; i < 1000; i++) {
  const key = "k" + (i % 7);
  flags[key] = !(flags[key] ?? false);
  if (flags[key]!) seen++;
}
console.log(seen, Object.keys(flags).length);
