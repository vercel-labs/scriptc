// Records whose fields hold strings, arrays, other records and class
// instances, and that only flow into field reads, release exactly the
// references they hold: on normal scope exit, per loop iteration, on
// break/continue/return, and when a field expression or a producer
// throws while the record is half built. Records that are stored,
// returned, captured, compared by identity or printed stay observable
// exactly as in Node.
interface Token {
  kind: string;
  text: string;
  pos: number;
}
interface Span {
  label: string;
  parts: string[];
  token: Token;
}
class Counter {
  hits = 0;
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}
interface Owned {
  owner: Counter;
  tag: string | undefined;
  note?: string;
}

const words = ["alpha", "beta", "gamma", "delta"];
function word(i: number): string {
  return words[i % words.length]! + i;
}
function makeToken(kind: string, text: string, pos: number): Token {
  return { kind, text, pos };
}
function pick(flag: boolean, a: string, b: string): Token {
  return flag ? { kind: "a", text: a, pos: 1 } : makeToken("b", b, 2);
}
function width(t: Token): number {
  return t.text.length + t.kind.length;
}
function spanWidth(s: Span): number {
  return s.label.length + s.parts.length + width(s.token);
}
function failing(text: string, n: number): string {
  if (n % 4 === 3) throw new Error(`bad ${text}`);
  return text.toUpperCase();
}
function strict(kind: string, n: number): Token {
  return { kind, text: failing(kind + n, n), pos: n };
}
const kept: Token[] = [];
function keep(t: Token): number {
  kept.push(t);
  return t.pos;
}

let total = 0;
let log = "";
for (let i = 0; i < 12; i++) {
  const w = word(i);
  const t = { kind: "id", text: w, pos: i };
  total += t.pos + t.text.length;
  const u = makeToken("num", w + "!", i);
  if (u.kind === "num") total += width(u);
  total += width({ kind: w, text: w + w, pos: 0 });
  const s: Span = { label: "s" + i, parts: [w, t.text, u.text], token: makeToken("x", w, i) };
  total += spanWidth(s) + s.parts.join("").length;
  const p = pick(i % 2 === 0, w, t.kind);
  log += p.text[0];
  if (i % 5 === 4) total += keep(t);
  try {
    const bad = { kind: "k", text: failing(w, i), pos: i };
    log += bad.text.length;
  } catch (e) {
    log += "!";
  }
  try {
    const half = strict(w, i);
    log += half.text.length;
  } catch (e) {
    log += "?";
  }
  if (i === 6) continue;
  const late = { kind: w, text: String(i), pos: -i };
  if (late.text === "9") break;
  total += late.kind.length;
}
console.log(total, log, kept.map((t) => t.text).join(","));

function find(names: string[], target: string): number {
  for (let i = 0; i < names.length; i++) {
    const entry = { name: names[i]!, index: i, upper: names[i]!.toUpperCase() };
    if (entry.name === target) return entry.index * 10 + entry.upper.length;
  }
  return -1;
}
console.log(find(words, "gamma"), find(words, "omega"));

function owners(n: number): string {
  const counters = [new Counter("a"), new Counter("b")];
  let out = "";
  for (let i = 0; i < n; i++) {
    const o: Owned = { owner: counters[i % 2]!, tag: i % 3 === 0 ? undefined : "t" + i };
    o.owner.hits++;
    out += o.tag ?? "-";
    const optional: Owned = { owner: counters[0]!, tag: "x", note: i % 2 ? "odd" : undefined };
    out += optional.note === undefined ? "." : optional.note[0];
  }
  return `${out} ${counters[0]!.hits} ${counters[1]!.hits}`;
}
console.log(owners(7));

function tally(lines: string[]): string {
  let out = "";
  for (const line of lines) {
    const parsed = { head: line.slice(0, 1), rest: line.slice(1), size: line.length };
    switch (parsed.head) {
      case "a": {
        const scoped = { head: parsed.rest, rest: parsed.head, size: 1 };
        out += scoped.head;
        break;
      }
      case "b":
        out += parsed.rest.toUpperCase();
        break;
      default:
        out += parsed.size;
    }
  }
  return out;
}
console.log(tally(["abc", "bcd", "cde", "a"]));

function guarded(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    try {
      const r = { name: word(i), list: [i, i + 1] };
      if (i % 2 === 0) throw new Error(r.name);
      out += r.list.length;
    } catch (e) {
      out += (e as Error).message.length;
    } finally {
      const f = { name: "f" + i, list: [i] };
      out += f.name.length;
    }
  }
  return out;
}
console.log(guarded(5));

// Identity, storage, capture and printing keep heap records.
const a = { kind: "same", text: "x", pos: 1 };
const b = { kind: "same", text: "x", pos: 1 };
const readers: (() => string)[] = [];
for (let i = 0; i < 3; i++) {
  const r = { kind: "r", text: word(i), pos: i };
  readers.push(() => r.text);
}
console.log(a === b, readers.map((read) => read()).join(" "));
console.log({ kind: "shown", text: word(2), pos: 3 }, JSON.stringify(makeToken("j", "s", 1)));
