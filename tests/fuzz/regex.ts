// Compiling a pattern from data and matching with it: exec, test, replace, split, match, search, matchAll.
// Case fields: pattern source, flags, input.
import { type Case, field, mutate, note, noteStr, pick, ri, rnd, seedField } from "./fz.ts";

const DICT: string[] = [
  "(", ")", "(?:", "(?=", "(?!", "(?<=", "(?<!", "(?<n>", "\\k<n>", "\\1", "\\9", "[", "]", "[^", "-", "{", "}",
  "{2}", "{1,}", "{0,3}", "*", "+", "?", "|", "^", "$", ".", "\\d", "\\w", "\\s", "\\b", "\\B", "\\p{L}",
  "\\p{Script=Greek}", "\\u{10FFFF}", "\\ud83d", "\\x", "\\c", "\\", "a", "é", "\u{1F600}", "&&", "--", "\\q{",
];
const FLAGS: string[] = ["", "g", "i", "m", "s", "u", "y", "v", "gi", "gu", "iu", "gimsuy", "dv", "d", "uv", "x", "gg"];
const INPUTS: string[] = [
  "user@example.com", "2024-01-02", "abcd", "foo bar_baz-9", "ée\u{1F600}Ωx", "", "aaaaaaaaaaaaaaaa", "/* c */ x",
  "\n\r  a\tb", "cde ce",
];

export function generate(seeds: Case[]): Case {
  const source = mutate(seedField(seeds, 2), DICT, ri(5) + 1).slice(0, 200);
  const flags = pick(FLAGS);
  const input = ri(3) === 0 ? mutate(pick(INPUTS), DICT, ri(3)).slice(0, 24) : pick(INPUTS);
  return [String(ri(6)), String(rnd()), source, flags, input];
}

export function execute(c: Case): void {
  const mode = Number(field(c, 0));
  const input = field(c, 4);
  try {
    const re = new RegExp(field(c, 2), field(c, 3));
    noteStr(re.source);
    noteStr(re.flags);
    if (mode === 0) {
      const m = re.exec(input);
      note(m === null ? -1 : m.index);
      if (m !== null) {
        note(m.length);
        noteStr(m[0] ?? "u");
      }
      note(re.lastIndex);
    } else if (mode === 1) note(re.test(input) ? 1 : 0);
    else if (mode === 2) noteStr(input.replace(re, "[$1|$&|$<n>|$`]"));
    else if (mode === 3) {
      const parts = input.split(re, 50);
      note(parts.length);
      for (const p of parts) noteStr(p ?? "u");
    } else if (mode === 4) {
      const m = input.match(re);
      note(m === null ? -1 : m.length);
      note(input.search(re));
    } else if (re.global) {
      let n = 0;
      for (const m of input.matchAll(re)) {
        note(m.index ?? -1);
        if (++n > 50) break;
      }
    } else noteStr(input.replace(re, (s: string): string => s.toUpperCase()));
    note(1);
  } catch (e) {
    note(2);
  }
}
