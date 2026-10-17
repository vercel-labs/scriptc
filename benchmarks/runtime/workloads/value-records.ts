// Records that hold references: a tokenizer that builds token records with
// string fields and passes them to helpers, an immutable reducer that
// updates its state with object spread, and tuple-returning helpers whose
// results are destructured at once. None of these temporaries outlives
// the statement or loop iteration that builds it.
interface Token {
  kind: string;
  text: string;
  pos: number;
}
const KEYWORDS = ["let", "const", "if", "else", "for", "while", "return", "function"];
function classify(text: string): string {
  return KEYWORDS.includes(text) ? "keyword" : "ident";
}
function token(kind: string, text: string, pos: number): Token {
  return { kind, text, pos };
}
function weight(t: Token): number {
  return t.kind === "keyword" ? t.text.length * 3 : t.text.length + (t.pos & 7);
}
function tokenize(source: string): number {
  let sum = 0;
  let start = -1;
  for (let i = 0; i <= source.length; i++) {
    const c = i < source.length ? source.charCodeAt(i) : 32;
    const word = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95;
    if (word) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      const text = source.slice(start, i);
      const t = token(classify(text), text, start);
      sum += weight(t);
      start = -1;
    }
    if (c !== 32 && c !== 10) {
      const punct = { kind: "punct", text: source[i]!, pos: i };
      sum += weight(punct) + (punct.text === ";" ? 1 : 0);
    }
  }
  return sum;
}

interface State {
  mode: string;
  depth: number;
  count: number;
  last: string;
}
function step(s: State, text: string): State {
  if (text === "{") return { ...s, depth: s.depth + 1, last: text };
  if (text === "}") return { ...s, depth: s.depth - 1, last: text };
  return s.mode === "code" ? { ...s, count: s.count + 1 } : { ...s, mode: "code", last: text };
}
function reduce(texts: string[], rounds: number): number {
  let total = 0;
  for (let r = 0; r < rounds; r++) {
    let state: State = { mode: "start", depth: 0, count: 0, last: "" };
    for (const text of texts) {
      state = step(state, text);
      if (state.depth > 3) state = { ...state, depth: 3 };
    }
    total += state.count + state.depth + state.last.length + state.mode.length;
  }
  return total;
}

function divmod(a: number, b: number): [number, number] {
  return [Math.floor(a / b), a % b];
}
function split(text: string, at: number): [string, string] {
  return [text.slice(0, at), text.slice(at)];
}
function tuples(n: number, texts: string[]): number {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const [q, r] = divmod(i * 31, 17);
    const [head, tail] = split(texts[i % texts.length]!, r % 3);
    sum += q + r + head.length * 2 + tail.length;
  }
  return sum;
}

const scaleArg = Number(process.argv[2] ?? "1");
const line = "function step ( s , text ) { if ( text ) { return s ; } let x = s ; while ( x ) { x = x ; } }\n";
const source = line.repeat(Math.floor(400 * scaleArg));
const texts = source.split(" ").filter((t) => t.length > 0);
let lexed = 0;
for (let i = 0; i < 240; i++) lexed += tokenize(source);
const reduced = reduce(texts, Math.floor(600 * scaleArg));
const pairs = tuples(Math.floor(2_000_000 * scaleArg), texts);
console.log("tokens", lexed, "reduce", reduced, "tuples", pairs);
