// A block tokenizer in the shape Markdown parsers have: a list of rules
// anchored at the start, tried in order on the rest of the document, and
// the matched token cut off the front. The documents have plain ASCII
// text, text with dashes and accented letters, and text with emoji.
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

let seed = 7;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
}

function pick(words: string[]): string {
  return words[Math.floor(random() * words.length)]!;
}

function sentence(words: string[], count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(pick(words));
  return out.join(" ");
}

function makeDocument(words: string[], blocks: number): string {
  const parts: string[] = [];
  for (let i = 0; i < blocks; i++) {
    const kind = Math.floor(random() * 10);
    if (kind === 0) parts.push(`## ${sentence(words, 4)}\n`);
    else if (kind === 1) parts.push(`- ${sentence(words, 6)}\n- ${sentence(words, 5)}\n`);
    else if (kind === 2) parts.push(`> ${sentence(words, 8)}\n`);
    else if (kind === 3) parts.push("```ts\nconst " + pick(words) + " = 1;\n```\n");
    else if (kind === 4) parts.push(`    ${sentence(words, 3)}\n`);
    else if (kind === 5) parts.push("---\n");
    else if (kind === 6) parts.push(`| ${pick(words)} | ${pick(words)} |\n|---|---|\n`);
    else parts.push(`${sentence(words, 12)}\n${sentence(words, 9)}\n`);
    parts.push("\n");
  }
  return parts.join("");
}

function tokenize(source: string, counts: Map<string, number>): number {
  let rest = source;
  let tokens = 0;
  let captured = 0;
  while (rest.length > 0) {
    let cut = 0;
    for (const [name, rule] of rules) {
      const m = rule.exec(rest);
      if (m === null) continue;
      cut = m[0].length;
      if (m[1] !== undefined) captured += m[1].length;
      counts.set(name, (counts.get(name) ?? 0) + 1);
      break;
    }
    if (cut === 0) break;
    tokens++;
    rest = rest.slice(cut);
  }
  return tokens * 31 + captured;
}

const plain = ["alpha", "beta", "gamma", "delta", "release", "notes", "fix", "the", "of", "a"];
const accented = [...plain, "café", "naïve", "—", "“quoted”", "über"];
const emoji = [...plain, "\u{1F600}", "—", "\u{1F680}", "日本語"];

const scale = Number(process.argv[2] ?? "1");
const blocks = Math.floor(900 * scale);
const counts = new Map<string, number>();
let checksum = 0;
let characters = 0;
for (const words of [plain, accented, emoji]) {
  const text = makeDocument(words, blocks);
  characters += text.length;
  checksum = (Math.imul(checksum, 33) + tokenize(text, counts)) | 0;
}
const names = [...counts.keys()].sort();
for (const name of names) console.log(name, counts.get(name));
console.log("characters", characters, "checksum", checksum);
