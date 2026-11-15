// Loops over patterns anchored at position 0: a tokenizer that tries a list
// of anchored rules on the rest of a text and cuts the match off, the same
// tokens through sticky rules and lastIndex, exec loops with the g flag,
// and the empty-match loops of replace, replaceAll, matchAll and split. On
// ASCII text and on text with characters of every UTF-16 width.
export {};

// ── a tokenizer over the rest of the text ──────────────────────────────
const rules: [string, RegExp][] = [
  ["newline", /^(?:[ \t]*(?:\n|$))+/],
  ["code", /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/],
  ["fences", /^ {0,3}(`{3,}|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/],
  ["heading", /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/],
  ["hr", /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/],
  ["blockquote", /^( {0,3}> ?([^\n]*)(?:\n|$))+/],
  ["list", /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]+?)?(?:\n|$)/],
  ["html", /^ {0,3}<(?!script)([a-z]+)[^>]*>[^\n]*(?:\n|$)/i],
  ["def", /^ {0,3}\[([^\]]+)\]: *([^\s]+)(?: +"([^"]*)")? *(?:\n+|$)/],
  ["math", /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/],
  ["table", /^ *\|(.+)\n *\|?( *[-:]+[-| :]*)(?:\n|$)/],
  ["text", /^[^\n]+(?:\n|$)/],
];

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let rest = source;
  while (rest.length > 0) {
    let cut = 0;
    for (const [name, rule] of rules) {
      const m = rule.exec(rest);
      if (m === null) continue;
      cut = m[0].length;
      tokens.push(`${name}:${cut}:${m[1] === undefined ? "-" : m[1].length}`);
      break;
    }
    if (cut === 0) {
      tokens.push("stuck");
      break;
    }
    rest = rest.slice(cut);
  }
  return tokens;
}

// The same rules as sticky patterns over the whole text.
const stickyRules: [string, RegExp][] = rules.map(([name, rule]): [string, RegExp] => [
  name,
  new RegExp(rule.source.slice(1), rule.flags + "y"),
]);

function tokenizeSticky(source: string): string[] {
  const tokens: string[] = [];
  let at = 0;
  while (at < source.length) {
    let cut = 0;
    for (const [name, rule] of stickyRules) {
      rule.lastIndex = at;
      const m = rule.exec(source);
      if (m === null) continue;
      cut = m[0].length;
      tokens.push(`${name}:${cut}:${m[1] === undefined ? "-" : m[1].length}`);
      break;
    }
    if (cut === 0) {
      tokens.push("stuck");
      break;
    }
    at += cut;
  }
  return tokens;
}

function document(dash: string, face: string, repeats: number): string {
  const block = [
    `# Release notes ${dash} part one`,
    "",
    `Some text with a dash ${dash} and a face ${face} in it.`,
    "More text on the next line.",
    "",
    "- first item",
    `- second item ${dash} with a dash`,
    "1. numbered",
    "",
    "> a quote",
    `> that goes on ${face}`,
    "",
    "```ts",
    `const x = "${dash}";`,
    "```",
    "",
    "    indented code",
    "",
    "---",
    "",
    "$$",
    `a ${dash} b`,
    "$$",
    "",
    "| a | b |",
    "|---|---|",
    "",
    '[ref]: https://example.com "Title"',
    "",
    "<div>html</div>",
    "",
  ].join("\n");
  return block.repeat(repeats);
}

function summary(tokens: string[]): string {
  const counts = new Map<string, number>();
  let hash = 0;
  for (const token of tokens) {
    const name = token.slice(0, token.indexOf(":"));
    counts.set(name, (counts.get(name) ?? 0) + 1);
    for (let i = 0; i < token.length; i++) hash = (Math.imul(hash, 31) + token.charCodeAt(i)) | 0;
  }
  const names = [...counts.keys()].sort();
  return `${tokens.length} tokens, hash ${hash}, ${names.map((n) => `${n}=${counts.get(n)}`).join(" ")}`;
}

for (const [label, dash, face] of [
  ["ascii", "--", ":)"],
  ["bmp", "—", "☺"],
  ["astral", "—", "\u{1F600}"],
]) {
  const text = document(dash!, face!, 40);
  const cutTokens = tokenize(text);
  const stickyTokens = tokenizeSticky(text);
  console.log(`${label}: ${text.length} characters: ${summary(cutTokens)}`);
  console.log(`${label}: sticky rules give ${cutTokens.join(",") === stickyTokens.join(",") ? "the same tokens" : summary(stickyTokens)}`);
  console.log(`${label}: first tokens ${cutTokens.slice(0, 14).join(" ")}`);
}

// ── exec loops ─────────────────────────────────────────────────────────
function execLoop(re: RegExp, s: string): string {
  const seen: string[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(s)) !== null && guard++ < 20) {
    seen.push(`${m.index}:${JSON.stringify(m[0])}@${re.lastIndex}`);
    if (m[0] === "") re.lastIndex = re.lastIndex + 1;
  }
  return `${seen.join(" ")} | end@${re.lastIndex}`;
}

const loopSubjects = ["abcabc", "a\nabc\nab", "—a\na\u{1F600}\nabc", "\u{1F600}\u{1F600}", ""];
const loopPatterns: RegExp[] = [/^a/g, /^a/gm, /^/g, /^/gm, /^|b/g, /^\s*/g, /^a|^—/g, /^./gsu, /^./gs, /^(?=a)/g];
for (const re of loopPatterns) {
  const twin = new RegExp(re.source, re.flags);
  for (const s of loopSubjects) {
    const a = execLoop(re, s);
    const b = execLoop(twin, s);
    console.log(`${re} on ${JSON.stringify(s)}: ${a}${a === b ? "" : ` | constructed: ${b}`}`);
  }
}

// ── the empty-match loops of replace, replaceAll, matchAll and split ────
for (const re of loopPatterns) {
  const twin = new RegExp(re.source, re.flags);
  for (const s of loopSubjects) {
    const out: string[] = [];
    for (const r of [re, twin]) {
      const parts: string[] = [];
      parts.push(JSON.stringify(s.replace(r, "<$&>")));
      parts.push(JSON.stringify(s.replaceAll(r, "[$`|$&|$']")));
      parts.push(JSON.stringify(s.replace(r, (whole: string, offset: number) => `{${whole}@${offset}}`)));
      const all: string[] = [];
      for (const m of s.matchAll(r)) all.push(`${m.index}:${m[0].length}`);
      parts.push(all.join(","));
      parts.push(JSON.stringify(s.split(r)));
      parts.push(JSON.stringify(s.split(r, 2)));
      parts.push(String(r.lastIndex));
      out.push(parts.join(" "));
    }
    console.log(`${re} on ${JSON.stringify(s)}: ${out[0]}${out[0] === out[1] ? "" : ` | constructed: ${out[1]}`}`);
  }
}

// A sticky anchored pattern after lastIndex has moved, and lastIndex kept
// by a failed test.
const stepped = /^ab/gy;
for (const s of ["abab", "ab—ab"]) {
  stepped.lastIndex = 0;
  const first = stepped.test(s);
  const afterFirst = stepped.lastIndex;
  const second = stepped.test(s);
  console.log(`${stepped} on ${JSON.stringify(s)}: ${first}@${afterFirst} then ${second}@${stepped.lastIndex}`);
}
