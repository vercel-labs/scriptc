#!/usr/bin/env node
// Root-locale collation elements for String.prototype.localeCompare over the
// Latin repertoire (ASCII, Latin-1 Supplement, Latin Extended-A and the
// combining diacritical marks), derived from the pinned Node release's ICU
// (`localeCompare` with no locales/options) and verified against it.
//
//   node scripts/gen-collation-table.mjs          regenerate the table
//   node scripts/gen-collation-table.mjs --check  verify only
//
// Model: every covered code point maps to a short list of collation
// elements (primary, secondary, tertiary). Precomposed letters are their
// base letter's element followed by one secondary-only element for the
// diacritic; letters with a stroke or other built-in variant (ø, ł, đ, ...)
// carry the same extra secondary; ligatures expand (æ → a, e). Strings
// compare level by level over the concatenated elements — primaries
// (zero primaries skipped), then secondaries, then tertiaries — which is the
// multi-level comparison ICU applies at its default (tertiary) strength.
// The output is written only after a randomized differential check against
// Node's own localeCompare passes.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "packages/runtime/src/scr_collation_data.h");
const checkOnly = process.argv.includes("--check");

const base = new Intl.Collator(undefined, { sensitivity: "base" });
const accent = new Intl.Collator(undefined, { sensitivity: "accent" });
const variant = new Intl.Collator(undefined, { sensitivity: "variant" });

export const RANGES = [
  [0x09, 0x0d],
  [0x20, 0x7e],
  [0xa0, 0x17f],
  [0x300, 0x36f],
];
const ch = (c) => String.fromCodePoint(c);
// Combining marks are covered when they are pure diacritics (no primary
// weight); the combining Latin letters (U+0363–U+036F) are not.
const isMark = (c) => c >= 0x300 && c <= 0x36f;
// The vulgar fractions expand through U+2044 FRACTION SLASH, which is
// outside the table, so they stay uncovered.
const UNCOVERED = new Set([0xbc, 0xbd, 0xbe]);
const covered = [];
for (const [lo, hi] of RANGES)
  for (let c = lo; c <= hi; c++)
    if (!UNCOVERED.has(c) && (!isMark(c) || base.compare("a" + ch(c), "a") === 0)) covered.push(c);
const coveredSet = new Set(covered);

// 1. Combining marks: secondary weights by their order on a base letter.
const marks = covered.filter(isMark);
const markOrder = [...marks].sort((a, b) => accent.compare("a" + ch(a), "a" + ch(b)) || a - b);
const markWeight = new Map();
{
  let w = 1;
  for (let i = 0; i < markOrder.length; i++) {
    if (i > 0 && accent.compare("a" + ch(markOrder[i - 1]), "a" + ch(markOrder[i])) !== 0) w++;
    markWeight.set(markOrder[i], w);
  }
}

// Canonical combining classes, as ranks: ICU normalizes (NFD, with marks
// reordered by class) before collating. Derived from the canonical
// reordering Node's normalize() applies to mark pairs.
const reorders = (a, b) => ("x" + ch(a) + ch(b)).normalize("NFD") !== "x" + ch(a) + ch(b);
const atomicMarks = marks.filter((m) => ch(m).normalize("NFD") === ch(m));
const movable = atomicMarks.filter((m) =>
  atomicMarks.some((n) => reorders(m, n) || reorders(n, m)),
);
const cccOrder = [...movable].sort(
  (a, b) => (reorders(a, b) ? 1 : reorders(b, a) ? -1 : 0) || a - b,
);
const cccRank = new Map();
{
  let r = 1;
  for (let i = 0; i < cccOrder.length; i++) {
    const prev = cccOrder[i - 1];
    if (i > 0 && (reorders(prev, cccOrder[i]) || reorders(cccOrder[i], prev))) r++;
    cccRank.set(cccOrder[i], r);
  }
}

// 2. Ignorable code points (no weight at any level).
const ignorable = new Set(
  covered.filter(
    (c) => variant.compare(ch(c) + "a", "a") === 0 && variant.compare("a" + ch(c), "a") === 0,
  ),
);

// 3. Expansions: a code point equal at the base level to two ASCII letters.
const letters = "abcdefghijklmnopqrstuvwxyz";
const expansion = new Map();
for (const c of covered) {
  if (c < 0x80 || isMark(c) || ignorable.has(c) || ch(c).normalize("NFD") !== ch(c)) continue;
  if (covered.some((d) => d < 0x80 && base.compare(ch(c), ch(d)) === 0)) continue;
  for (const x of letters)
    for (const y of letters)
      if (base.compare(ch(c), x + y) === 0 && !expansion.has(c)) expansion.set(c, x + y);
}

// 4. Primary classes over single code points (base level), in order.
const singles = covered.filter((c) => !isMark(c) && !ignorable.has(c) && !expansion.has(c));
const decomposedBase = (c) => {
  const nfd = ch(c).normalize("NFD");
  return nfd.length > 1 && isMark(nfd.codePointAt(1)) ? nfd.codePointAt(0) : null;
};
const primaryReps = singles.filter((c) => decomposedBase(c) === null);
primaryReps.sort((a, b) => base.compare(ch(a), ch(b)) || a - b);
const primaryOf = new Map();
{
  let p = 1;
  for (let i = 0; i < primaryReps.length; i++) {
    if (i > 0 && base.compare(ch(primaryReps[i - 1]), ch(primaryReps[i])) !== 0) p++;
    primaryOf.set(primaryReps[i], p);
  }
}
// The class representative: the ASCII member when there is one.
const repOf = (c) => {
  const p = primaryOf.get(c);
  const ascii = primaryReps.find((d) => primaryOf.get(d) === p && d < 0x80);
  return ascii ?? primaryReps.find((d) => primaryOf.get(d) === p);
};

// 5. Extra secondary of a non-decomposable variant letter (ø against o):
//    the mark whose sequence it equals at the accent level, or a weight
//    placed among the marks by comparison.
const extraSecondary = new Map();
const variantMark = new Map();
let nextUnique = markOrder.length + 10;
const syntheticAt = [];
for (const c of primaryReps) {
  const r = repOf(c);
  if (r === c || accent.compare(ch(c), ch(r)) === 0) continue;
  const same = markOrder.find((m) => accent.compare(ch(c), ch(r) + ch(m)) === 0);
  if (same !== undefined) {
    variantMark.set(c, same);
    continue;
  }
  // Insert between mark weights: below the first mark it sorts before.
  let below = markOrder.findIndex((m) => accent.compare(ch(c), ch(r) + ch(m)) < 0);
  if (below < 0) below = markOrder.length;
  syntheticAt.push({ c, below });
}
// Ligatures differ from their spelled-out pair by a secondary between the
// halves (æ against a, e): a mark's weight or a synthetic one.
const expansionSecondary = new Map();
const expansionMark = new Map();
for (const [c, pair] of expansion) {
  if (accent.compare(ch(c), pair) === 0) continue;
  const same = markOrder.find((m) => accent.compare(ch(c), pair[0] + ch(m) + pair[1]) === 0);
  if (same !== undefined) {
    expansionMark.set(c, same);
    continue;
  }
  let below = markOrder.findIndex((m) => accent.compare(ch(c), pair[0] + ch(m) + pair[1]) < 0);
  if (below < 0) below = markOrder.length;
  syntheticAt.push({ c, below, expansion: true });
}
// Synthetic weights are fractional slots; renumber all secondaries densely.
{
  const entries = [];
  for (const [m, w] of markWeight) entries.push({ key: `m${m}`, w: w * 2 });
  // Case pairs (Æ/æ, Ð/ð) share their synthetic secondary: they differ at
  // the tertiary level only.
  const uniqueByFold = new Map();
  for (const { c, below, expansion: isExpansion } of syntheticAt) {
    const fold = ch(c).toLowerCase();
    if (below >= markOrder.length && !uniqueByFold.has(fold)) uniqueByFold.set(fold, nextUnique++);
    const w =
      below < markOrder.length
        ? markWeight.get(markOrder[below]) * 2 - 1
        : uniqueByFold.get(fold) * 2;
    entries.push({ key: `${isExpansion ? "x" : "c"}${c}`, w });
  }
  const distinct = [...new Set(entries.map((e) => e.w))].sort((a, b) => a - b);
  const dense = new Map(distinct.map((w, i) => [w, i + 2])); // 1 is "common"
  for (const e of entries) {
    const w = dense.get(e.w);
    if (e.key.startsWith("m")) markWeight.set(Number(e.key.slice(1)), w);
    else if (e.key.startsWith("x")) expansionSecondary.set(Number(e.key.slice(1)), w);
    else extraSecondary.set(Number(e.key.slice(1)), w);
  }
}

for (const [c, m] of variantMark) extraSecondary.set(c, markWeight.get(m));
for (const [c, m] of expansionMark) expansionSecondary.set(c, markWeight.get(m));

// 6. Elements per code point (tertiary assigned below).
const COMMON = 1;
const elements = new Map();
for (const c of covered) {
  if (ignorable.has(c)) elements.set(c, []);
  else if (isMark(c) && ch(c).normalize("NFD") === ch(c) && markWeight.has(c))
    elements.set(c, [[0, markWeight.get(c), COMMON, cccRank.get(c) ?? 0]]);
}
for (const c of primaryReps) {
  const ces = [[primaryOf.get(c), COMMON, 0, 0]];
  if (extraSecondary.has(c)) ces.push([0, extraSecondary.get(c), COMMON, 0]);
  elements.set(c, ces);
}
for (const c of covered) {
  if (elements.has(c) || expansion.has(c)) continue;
  // Canonically decomposable: the elements of its NFD atoms.
  const nfd = [...ch(c).normalize("NFD")].map((x) => x.codePointAt(0));
  if (nfd.length === 1 && nfd[0] === c) throw new Error(`no elements for U+${c.toString(16)}`);
  elements.set(
    c,
    nfd.flatMap((x) => {
      const es = elements.get(x);
      if (es === undefined) throw new Error(`U+${c.toString(16)} decomposes outside the table`);
      return es.map((e) => [...e]);
    }),
  );
}
for (const [c, pair] of expansion) {
  const first = elements.get(pair.codePointAt(0)).map((e) => [...e]);
  const second = elements.get(pair.codePointAt(1)).map((e) => [...e]);
  // A ligature differs from its spelled-out pair at the secondary level:
  // find the mark-equivalent secondary between the two halves, if any.
  const middle = expansionSecondary.has(c) ? [[0, expansionSecondary.get(c), COMMON, 0]] : [];
  elements.set(c, [...first, ...middle, ...second]);
}

// 7. Tertiary: rank code points whose primary+secondary elements agree.
const psKey = (c) =>
  elements
    .get(c)
    .map((e) => `${e[0]}.${e[1]}`)
    .join(" ");
const groups = new Map();
for (const c of covered) {
  if (ignorable.has(c) || isMark(c)) continue;
  const k = psKey(c);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(c);
}
const tertiaryOf = new Map();
for (const members of groups.values()) {
  members.sort((a, b) => variant.compare(ch(a), ch(b)) || a - b);
  let t = 1;
  for (let i = 0; i < members.length; i++) {
    if (i > 0 && variant.compare(ch(members[i - 1]), ch(members[i])) !== 0) t++;
    tertiaryOf.set(members[i], t);
  }
}
for (const c of covered) {
  if (ignorable.has(c) || isMark(c)) continue;
  for (const e of elements.get(c)) if (e[0] !== 0) e[2] = tertiaryOf.get(c);
}

// The model's comparison (mirrored by scr_str_locale_compare in C).
export function modelCompare(a, b) {
  const ces = (s) => {
    const es = [...s].flatMap((x) => elements.get(x.codePointAt(0)));
    // Canonical reordering: stable sort each run of movable marks by class.
    for (let i = 1; i < es.length; i++) {
      const e = es[i];
      if (e[3] === 0) continue;
      let j = i;
      while (j > 0 && es[j - 1][3] > e[3]) {
        es[j] = es[j - 1];
        j--;
      }
      es[j] = e;
    }
    return es;
  };
  const ea = ces(a);
  const eb = ces(b);
  for (const level of [0, 1, 2]) {
    // Zero primaries (diacritics) are skipped at the primary level only.
    const wa = ea.filter((e) => level !== 0 || e[0] !== 0).map((e) => e[level]);
    const wb = eb.filter((e) => level !== 0 || e[0] !== 0).map((e) => e[level]);
    const n = Math.min(wa.length, wb.length);
    for (let i = 0; i < n; i++) if (wa[i] !== wb[i]) return wa[i] < wb[i] ? -1 : 1;
    if (wa.length !== wb.length) return wa.length < wb.length ? -1 : 1;
  }
  return 0;
}

// 8. Differential verification against Node.
let seed = 0x5eed;
const rnd = (n) => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed % n;
};
const pool = covered.filter((c) => !isMark(c));
const heavy = [..."aAbBeEoOsSzZ ,.-_'1 2éÉèäÄöøØßæÆœłŁđ"].map((x) => x.codePointAt(0));
const word = () => {
  const n = 1 + rnd(5);
  let s = "";
  for (let i = 0; i < n; i++) {
    const r = rnd(10);
    s += ch(
      r < 6 ? heavy[rnd(heavy.length)] : r < 9 ? pool[rnd(pool.length)] : marks[rnd(marks.length)],
    );
  }
  return s;
};
let mismatches = 0;
const samples = [];
const check = (a, b) => {
  const want = a.localeCompare(b);
  const got = modelCompare(a, b);
  if (Math.sign(want) !== got) {
    mismatches++;
    if (samples.length < 20)
      samples.push(`${JSON.stringify(a)} vs ${JSON.stringify(b)}: node ${want}, model ${got}`);
  }
};
for (const x of pool) for (const y of pool) check(ch(x), ch(y));
for (let i = 0; i < 300000; i++) check(word(), word());
if (mismatches > 0) {
  console.error(`collation model disagrees with Node in ${mismatches} cases:`);
  for (const s of samples) console.error(`  ${s}`);
  process.exit(1);
}
console.log(`collation model matches Node over ${pool.length ** 2 + 300000} comparisons`);
if (checkOnly) process.exit(0);

// 9. Emit the C table.
const lines = [];
lines.push("/* Generated by scripts/gen-collation-table.mjs from the pinned Node");
lines.push(" * release's root-locale collation (ICU, localeCompare without locales or");
lines.push(" * options). Do not edit by hand. Each covered code point maps to up to");
lines.push(" * three collation elements {primary, secondary, tertiary, combining class");
lines.push(" * rank}; zero primaries are skipped at the primary level, and runs of");
lines.push(" * marks with a nonzero class rank are put in canonical order before");
lines.push(" * comparing. n == 255 marks an uncovered code point. */");
lines.push("#ifndef SCR_COLLATION_DATA_H");
lines.push("#define SCR_COLLATION_DATA_H");
lines.push("#include <stdint.h>");
lines.push("typedef struct { uint16_t p; uint8_t s; uint8_t t; uint8_t ccc; } ScrCollElem;");
lines.push("typedef struct { uint8_t n; ScrCollElem e[3]; } ScrCollEntry;");
const maxP = Math.max(...[...elements.values()].flat().map((e) => e[0]));
const maxS = Math.max(...[...elements.values()].flat().map((e) => e[1]));
const maxT = Math.max(...[...elements.values()].flat().map((e) => e[2]));
if (maxP > 0xffff || maxS > 0xff || maxT > 0xff)
  throw new Error("weights overflow the table types");
for (const [lo, hi] of RANGES) {
  const name = `scr_coll_${lo.toString(16).padStart(4, "0")}`;
  lines.push(`static const ScrCollEntry ${name}[${hi - lo + 1}] = {`);
  for (let c = lo; c <= hi; c++) {
    if (!coveredSet.has(c)) {
      lines.push(
        `    {255, {{0, 0, 0, 0}}}, /* U+${c.toString(16).toUpperCase().padStart(4, "0")} not covered */`,
      );
      continue;
    }
    const es = elements.get(c);
    if (es.length > 3) throw new Error(`U+${c.toString(16)} needs ${es.length} elements`);
    const body = es.map((e) => `{${e[0]}, ${e[1]}, ${e[2]}, ${e[3]}}`).join(", ");
    lines.push(
      `    {${es.length}, {${body}}}, /* U+${c.toString(16).toUpperCase().padStart(4, "0")} */`,
    );
  }
  lines.push("};");
}
lines.push("static const ScrCollEntry *scr_coll_lookup(uint32_t c) {");
for (const [lo, hi] of RANGES) {
  const name = `scr_coll_${lo.toString(16).padStart(4, "0")}`;
  lines.push(
    `  if (c >= 0x${lo.toString(16)} && c <= 0x${hi.toString(16)}) return &${name}[c - 0x${lo.toString(16)}];`,
  );
}
lines.push("  return 0;");
lines.push("}");
lines.push("#endif");
await writeFile(out, lines.join("\n") + "\n");
console.log(`wrote ${out}`);
