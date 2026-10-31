// Slices stored in record fields: records built from a literal or a factory
// whose fields are only read for their length, comparisons and keyword
// searches, next to records that are kept after the iteration that built
// them (pushed into an array, held in an outer binding, captured by a
// closure, read into a kept array, returned from a helper, captured by a
// closure the factory stores beside it). Slices of non-ASCII text and slices
// longer than a short token are included.
interface Token {
  kind: string;
  text: string;
  pos: number;
}

const KEYWORDS = ["let", "const", "if", "else", "return"];

function token(kind: string, text: string, pos: number): Token {
  return { kind, text, pos };
}

interface LazyToken {
  text: string;
  upper: () => string;
}

function lazyToken(text: string): LazyToken {
  return { text, upper: () => text.toUpperCase() };
}

function classify(text: string): string {
  return KEYWORDS.includes(text) ? "keyword" : "ident";
}

function weight(t: Token): number {
  return t.kind === "keyword" ? t.text.length * 3 : t.text.length + (t.pos & 7);
}

function isReturn(t: Token): boolean {
  return t.text === "return";
}

function textOf(t: Token): string {
  return t.text;
}

/** Calls `visit` with the start and end of every run of word characters. */
function words(source: string, visit: (start: number, end: number) => void): void {
  let start = -1;
  for (let i = 0; i <= source.length; i++) {
    const c = i < source.length ? source.charCodeAt(i) : 32;
    const word = c > 32 && c !== 44 && c !== 59;
    if (word) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      visit(start, i);
      start = -1;
    }
  }
}

function lentTokens(source: string): string {
  let sum = 0;
  let returns = 0;
  let longest = 0;
  for (let i = 0, start = -1; i <= source.length; i++) {
    const c = i < source.length ? source.charCodeAt(i) : 32;
    if (c > 32 && c !== 44 && c !== 59) {
      if (start < 0) start = i;
      continue;
    }
    if (start < 0) continue;
    const text = source.slice(start, i);
    const t = token(classify(text), text, start);
    sum += weight(t);
    if (isReturn(t)) returns++;
    const literal = { text, pos: start };
    if (literal.text.length > longest) longest = literal.text.length;
    start = -1;
  }
  return `lent ${sum} ${returns} ${longest}`;
}

function keptTokens(source: string): string {
  const kept: Token[] = [];
  const texts: string[] = [];
  const later: (() => string)[] = [];
  const returned: string[] = [];
  const uppers: (() => string)[] = [];
  let lazyLength = 0;
  let last: Token | null = null;
  for (let i = 0, start = -1; i <= source.length; i++) {
    const c = i < source.length ? source.charCodeAt(i) : 32;
    if (c > 32 && c !== 44 && c !== 59) {
      if (start < 0) start = i;
      continue;
    }
    if (start < 0) continue;
    const text = source.slice(start, i);
    const pushed = token(classify(text), text, start);
    kept.push(pushed);
    const held = { kind: "held", text, pos: start };
    last = held;
    const read = token("read", source.slice(start, i), start);
    texts.push(read.text);
    const captured = { kind: "captured", text: source.slice(start, i), pos: start };
    later.push(() => captured.text);
    const viaHelper = token("helper", source.slice(start, i), start);
    returned.push(textOf(viaHelper));
    const lazyText = source.slice(start, i);
    const lazy = lazyToken(lazyText);
    lazyLength += lazy.text.length;
    uppers.push(lazy.upper);
    start = -1;
  }
  return [
    `kept ${kept.map((t) => `${t.kind}:${t.text}`).join(" ")}`,
    `last ${last === null ? "none" : last.text}`,
    `texts ${texts.join("|")}`,
    `later ${later.map((f) => f()).join("|")}`,
    `returned ${returned.join("|")}`,
    `upper ${lazyLength} ${uppers.map((f) => f()).join("|")}`,
  ].join("\n");
}

const ascii = "let total = count; if (total) return total; else return 0;";
const mixed = "lét naïve = café; return 東京, x";
const long = `const ${"identifier".repeat(12)} = ${"v".repeat(150)};`;

for (const source of [ascii, mixed, long]) {
  console.log(lentTokens(source));
  console.log(keptTokens(source));
}

let count = 0;
words(ascii, (start, end) => {
  const text = ascii.slice(start, end);
  const t = token(classify(text), text, start);
  count += weight(t);
});
console.log("callback", count);
