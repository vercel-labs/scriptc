// A pattern that can only match at position 0 (every path meets a `^`
// without the m flag before it consumes anything) is searched with one
// attempt. Patterns that are anchored, patterns that only look anchored (the
// m flag, an alternative without the anchor, an anchor inside a lookaround,
// a group that can be skipped before the anchor, a back reference before
// it) and sticky patterns, each as a literal and as the same pattern
// constructed at run time, through every operation, on ASCII and non-ASCII
// subjects, short and long.
export {};

const patterns: RegExp[] = [
  // Anchored.
  /^abc/,
  /^abc/g,
  /^abc/i,
  /^abc/u,
  /^abc/s,
  /^ABC/giu,
  /^/,
  /^/g,
  /^$/,
  /$^/,
  /^a|^b/,
  /^a|^b/g,
  /(^a)(b)?/,
  /((^a)|(^b))c?/,
  /(?:^a|^b)c/,
  /\b^a/,
  /\B^-/,
  /(?=a)^ab/,
  /(?!b)^a/,
  /(?<!b)^a/,
  /^(?=a)ab?/,
  /^(?!\s)abc/,
  /(?:^a)+/,
  /(?:^ab){1,2}/,
  /(?:)^a/,
  /^(a)\1/,
  /^[^\n]*\n/,
  /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/,
  // Not anchored: each of these can match somewhere else, or is a shape
  // the search must keep trying.
  /^abc/m,
  /^abc/gm,
  /^a|b/,
  /^a|b/g,
  /a|^b/,
  /(?:^a|b)c/,
  /((^a)|(b))c?/g,
  /(?=^)a/,
  /(?!^)a/,
  /(?!^)a/g,
  /(?<=^)a/,
  /(?<!^)a/g,
  /(?:^a)?b/,
  /(?:^a)*b/g,
  /(?:^a){0,2}b/,
  /a?^b/,
  /a^/,
  /(a)?\1^b/,
  /[^a]bc/,
  /\^a/,
  // Sticky: one attempt at lastIndex, with or without the anchor.
  /abc/y,
  /^abc/y,
  /^abc/gy,
  /^abc/my,
  /b/gy,
];

const dashes = "-".repeat(300);
const wideDashes = "—".repeat(100);
const subjects: string[] = [
  "abc",
  "ABCabc",
  "xabc",
  "b",
  "ab",
  "",
  "-a",
  "a\nabc",
  "\nb",
  "aabc",
  "abc\u2014",
  "\u2014abc",
  "\u2014\nabc",
  "b\u2014b",
  "a\u{1F600}abc",
  "\u{1F600}abc",
  "$$ x \u2014 $$\nrest",
  "abc" + dashes,
  dashes + "\nabc",
  "b" + dashes + "b",
  "abc" + wideDashes + "abc",
  wideDashes + "\nabc\n" + wideDashes,
  "b" + wideDashes + "b",
];

function shown(text: string): string {
  return text.length > 40 ? `${text.slice(0, 12)}..${text.slice(-12)}(${text.length})` : text;
}

function matchShown(m: RegExpMatchArray | null): string {
  if (m === null) return "null";
  const parts: string[] = [];
  for (let i = 0; i < m.length; i++) parts.push(m[i] === undefined ? "-" : shown(m[i]!));
  return `${m.index}:${JSON.stringify(parts)}`;
}

function describe(re: RegExp, s: string): string {
  const out: string[] = [];
  re.lastIndex = 0;
  out.push(`test=${re.test(s)}@${re.lastIndex}`);
  re.lastIndex = 0;
  out.push(`exec=${matchShown(re.exec(s))}@${re.lastIndex}`);
  re.lastIndex = 0;
  out.push(`search=${s.search(re)}`);
  const matched = s.match(re);
  if (re.global) out.push(`match=${matched === null ? "null" : JSON.stringify(shown(matched.join("|")))}`);
  else out.push(`match=${matchShown(matched)}`);
  out.push(`replace=${JSON.stringify(shown(s.replace(re, "[$&|$1]")))}`);
  out.push(`split=${JSON.stringify(shown(s.split(re, 4).join("|")))}`);
  if (re.global) {
    const all: string[] = [];
    for (const m of s.matchAll(re)) all.push(`${m.index}:${shown(m[0])}`);
    out.push(`matchAll=${JSON.stringify(all)}`);
    out.push(`replaceAll=${JSON.stringify(shown(s.replaceAll(re, "<$&>")))}`);
  }
  if (re.global || re.sticky) {
    const steps: string[] = [];
    for (const from of [1, 2, 3, s.length, s.length + 1]) {
      re.lastIndex = from;
      const m = re.exec(s);
      steps.push(`${from}>${m === null ? "null" : m.index}@${re.lastIndex}`);
      re.lastIndex = from;
      steps.push(`${re.test(s)}@${re.lastIndex}`);
    }
    out.push(`from=${steps.join(",")}`);
    re.lastIndex = 0;
  }
  return out.join(" ");
}

let rows = 0;
let different = 0;
for (const literal of patterns) {
  const constructed = new RegExp(literal.source, literal.flags);
  console.log(`${literal} ${constructed}`);
  for (const subject of subjects) {
    const a = describe(literal, subject);
    const b = describe(constructed, subject);
    rows++;
    console.log(`  ${JSON.stringify(shown(subject))} ${a}`);
    if (a !== b) {
      different++;
      console.log(`  constructed differs: ${b}`);
    }
  }
}
console.log(`${rows} rows, ${different} where the literal and the constructed pattern differ`);
