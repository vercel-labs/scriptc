// Exceptions that cross many frames: throws from helpers below a recursion,
// caught 2, 5 and 20 recursive calls up (direct calls, then calls through a
// callback), with each frame holding an array across its call, and a
// backtracking parser that uses exceptions for control flow.
class ParseError extends Error {
  readonly at: number;
  constructor(at: number, message: string) {
    super(message);
    this.at = at;
  }
}

/** A thrown value that is not an Error (no stack to capture). */
class Stop {
  readonly code: number;
  constructor(code: number) {
    this.code = code;
  }
}

const held: number[][] = [];
function fail(n: number, plain: boolean): number {
  if (plain) throw new Stop(n);
  throw new RangeError("chain " + n);
}
function check(n: number, plain: boolean): number {
  return (n & 3) === 0 ? fail(n, plain) : n;
}
function validate(n: number, plain: boolean): number {
  return check(n, plain) + (n & 1);
}
function bottom(n: number, plain: boolean): number {
  const box = [n, -1];
  const r = validate(n, plain);
  held[0] = box;
  return r + box.length;
}
function walk(n: number, depth: number, plain: boolean): number {
  const box = [n, depth];
  const r = depth === 0 ? bottom(n, plain) : walk(n, depth - 1, plain);
  held[depth] = box;
  return r + box.length;
}

function chains(rounds: number): string {
  const out: string[] = [];
  for (const depth of [2, 5, 20])
    for (const plain of [false, true]) {
      let caught = 0;
      let sum = 0;
      for (let i = 0; i < rounds; i++) {
        try {
          sum += walk(i, depth - 2, plain);
        } catch (error) {
          caught++;
          sum += error instanceof Stop ? error.code & 7 : 1;
        }
      }
      out.push(`depth ${depth} ${plain ? "object" : "error"}: caught ${caught} sum ${sum}`);
    }
  return out.join("\n");
}

// The same chains through a callback: each level visits the next with a
// closure, as tree visitors do.
function visit(n: number, depth: number, each: (n: number, depth: number) => number): number {
  const box = [n, depth];
  const r = depth === 0 ? bottom(n, false) : each(n, depth - 1);
  held[depth] = box;
  return r + box.length;
}
function visits(rounds: number): string {
  const out: string[] = [];
  const each = (n: number, depth: number): number => visit(n, depth, each);
  for (const depth of [2, 5, 20]) {
    let caught = 0;
    let sum = 0;
    for (let i = 0; i < rounds; i++) {
      try {
        sum += visit(i, depth - 2, each);
      } catch (error) {
        caught++;
        sum += error instanceof RangeError ? 1 : 0;
      }
    }
    out.push(`visit depth ${depth}: caught ${caught} sum ${sum}`);
  }
  return out.join("\n");
}

// expr := term (("+" | "-") term)*; term := atom ("*" atom)*;
// atom := number | "(" expr ")" | name "(" expr ("," expr)* ")" | name.
// A call and a name start alike: the parser tries the call first and
// backtracks when it fails.
let text = "";
let pos = 0;
function peek(): string {
  return pos < text.length ? text[pos]! : "";
}
function expect(c: string): void {
  if (peek() !== c) throw new ParseError(pos, `expected ${c}`);
  pos++;
}
function name(): string {
  const start = pos;
  while (pos < text.length && text.charCodeAt(pos) >= 97 && text.charCodeAt(pos) <= 122) pos++;
  if (pos === start) throw new ParseError(pos, "expected a name");
  return text.slice(start, pos);
}
function call(): number {
  const callee = name();
  expect("(");
  let value = expr() + callee.length;
  while (peek() === ",") {
    pos++;
    value += expr();
  }
  expect(")");
  return value;
}
function atom(): number {
  const c = peek();
  if (c >= "0" && c <= "9") {
    let value = 0;
    while (peek() >= "0" && peek() <= "9") value = value * 10 + (text.charCodeAt(pos++) - 48);
    return value;
  }
  if (c === "(") {
    pos++;
    const value = expr();
    expect(")");
    return value;
  }
  const start = pos;
  try {
    return call();
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    pos = start;
    return name().length;
  }
}
function term(): number {
  let value = atom();
  while (peek() === "*") {
    pos++;
    value = (value * atom()) % 1000003;
  }
  return value;
}
function expr(): number {
  let value = term();
  while (peek() === "+" || peek() === "-") {
    const op = text[pos++];
    value = op === "+" ? value + term() : value - term();
  }
  return value;
}

let seed = 4242;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
}
function source(depth: number): string {
  const r = random();
  if (depth > 6 || r < 0.25) return String(Math.floor(random() * 100));
  if (r < 0.45) return "abcdefgh".slice(0, 1 + Math.floor(random() * 8));
  if (r < 0.6) return `(${source(depth + 1)})`;
  if (r < 0.8) return `${source(depth + 1)}${random() < 0.5 ? "+" : "*"}${source(depth + 1)}`;
  return `f${"xyz".slice(0, Math.floor(random() * 3))}(${source(depth + 1)},${source(depth + 1)})`;
}

function parse(count: number): string {
  let total = 0;
  let failed = 0;
  for (let i = 0; i < count; i++) {
    // Every tenth input lacks its last character, which fails deep inside it.
    const full = source(0);
    text = i % 10 === 0 ? full.slice(0, -1) : full;
    pos = 0;
    try {
      total = (total + expr()) % 1000003;
      if (pos !== text.length) throw new ParseError(pos, "trailing input");
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      failed++;
    }
  }
  return `parsed ${count}: total ${total} failed ${failed}`;
}

const scale = Number(process.argv[2] ?? "1");
console.log(chains(Math.floor(60000 * scale)));
console.log(visits(Math.floor(60000 * scale)));
console.log(parse(Math.floor(40000 * scale)));
