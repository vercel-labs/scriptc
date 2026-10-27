import { publish } from "@scriptc/threads";
import type { ProgramLifetime } from "@scriptc/types";

// ProgramLifetime classes whose fields mix widths: booleans, small integers,
// numbers, strings, references and optional values, declared in an order
// that leaves alignment holes, with subclasses that add fields of each width.
// Field reads and writes, virtual dispatch, instanceof, boxing into unknown,
// thrown instances and publication behave the same before and after the
// objects are published.

abstract class Node implements ProgramLifetime {
  readonly kind: number;
  flagged = false;
  readonly pos: number;
  end: number;
  parent: Node | undefined = undefined;
  constructor(kind: number, pos: number, end: number) {
    this.kind = kind;
    this.pos = pos;
    this.end = end;
  }
  abstract label(): string;
  width(): number {
    return this.end - this.pos;
  }
}

class Ident extends Node {
  readonly text: string;
  id = 0;
  escaped = false;
  constructor(pos: number, text: string) {
    super(1, pos, pos + text.length);
    this.text = text;
  }
  label(): string {
    return `Ident(${this.text}#${this.id}${this.escaped ? "!" : ""})`;
  }
}

class Literal extends Node {
  readonly value: number;
  negative: boolean;
  radix = 10;
  constructor(pos: number, value: number) {
    super(2, pos, pos + String(value).length);
    this.value = value;
    this.negative = value < 0;
  }
  label(): string {
    return `Literal(${this.value.toString(this.radix)}${this.negative ? "-" : ""})`;
  }
}

class Binary extends Node {
  readonly left: Node;
  readonly right: Node;
  operator: string;
  precedence = 0;
  parenthesized = false;
  constructor(left: Node, operator: string, right: Node) {
    super(3, left.pos, right.end);
    this.left = left;
    this.right = right;
    this.operator = operator;
    left.parent = this;
    right.parent = this;
  }
  label(): string {
    const inner = `${this.left.label()} ${this.operator} ${this.right.label()}`;
    return this.parenthesized ? `(${inner})` : inner;
  }
}

class Tagged extends Ident {
  tag: string | undefined = undefined;
  weight = 0.5;
  marked = false;
  label(): string {
    return `Tagged(${super.label()}, ${this.tag ?? "-"}, ${this.weight}, ${this.marked})`;
  }
}

class Flow implements ProgramLifetime {
  flags: number;
  node: Node | undefined;
  antecedent: Flow | undefined;
  reachable = true;
  constructor(flags: number, node: Node | undefined, antecedent: Flow | undefined) {
    this.flags = flags;
    this.node = node;
    this.antecedent = antecedent;
  }
}

function describe(n: Node): string {
  const parent = n.parent === undefined ? "-" : String(n.parent.kind);
  return `${n.label()} k${n.kind} ${n.pos}-${n.end} w${n.width()} ${n.flagged ? "F" : "f"} up ${parent}`;
}

function classify(value: unknown): string {
  if (value instanceof Tagged) return `tagged ${value.tag ?? "-"}`;
  if (value instanceof Ident) return `ident ${value.text}`;
  if (value instanceof Literal) return `literal ${value.value}`;
  if (value instanceof Binary) return `binary ${value.operator}`;
  if (value instanceof Flow) return `flow ${value.flags}`;
  return typeof value;
}

function isNode(value: unknown): boolean {
  return value instanceof Node;
}

function isLiteral(value: unknown): boolean {
  return value instanceof Literal;
}

function walk(n: Node, out: string[]): void {
  out.push(describe(n));
  if (n instanceof Binary) {
    walk(n.left, out);
    walk(n.right, out);
  }
}

function build(prefix: string): { root: Binary; flows: Flow[]; idents: Ident[] } {
  const a = new Ident(0, `${prefix}a`);
  a.id = 7;
  const b = new Tagged(4, `${prefix}b`);
  b.tag = "t";
  b.weight = 1.25;
  b.marked = true;
  b.escaped = true;
  const lit = new Literal(8, -255);
  lit.radix = 16;
  const sum = new Binary(a, "+", b);
  sum.precedence = 12;
  sum.parenthesized = true;
  const root = new Binary(sum, "*", lit);
  root.precedence = 13;
  root.flagged = true;
  const flows: Flow[] = [];
  let prev: Flow | undefined = undefined;
  for (const n of [a, b, lit, sum, root]) {
    prev = new Flow(flows.length * 3 + 1, n, prev);
    flows.push(prev);
  }
  flows[2]!.reachable = false;
  return { root, flows, idents: [a, b] };
}

function report(side: string, g: { root: Binary; flows: Flow[]; idents: Ident[] }): void {
  const out: string[] = [];
  walk(g.root, out);
  for (const line of out) console.log(side, line);
  for (const f of g.flows) {
    const node = f.node === undefined ? "-" : classify(f.node);
    const before = f.antecedent === undefined ? "-" : String(f.antecedent.flags);
    console.log(side, "flow", f.flags, f.reachable, node, before);
  }
  const boxed: unknown[] = [g.root, g.root.left, g.idents[1], g.flows[0], 3, "s"];
  console.log(side, boxed.map(classify).join(", "));
}

function attempt(what: string, write: () => void): void {
  try {
    write();
    console.log(what, "wrote");
  } catch (e) {
    console.log(what, (e as Error).name, (e as Error).message);
  }
}

const g = build("x");
report("before", g);

// Writes to fields that share an 8-byte word with their neighbours.
g.idents[0]!.id = 9;
g.idents[0]!.escaped = true;
const tagged = g.idents[1] as Tagged;
tagged.marked = false;
tagged.weight = -2;
g.root.flagged = false;
g.flows[1]!.flags = 40;
report("written", g);

// A thrown instance keeps its class.
try {
  throw g.idents[1];
} catch (e) {
  console.log("caught", classify(e), isNode(e), isLiteral(e));
}

// Instances as map keys and set members.
const seen = new Map<Node, number>();
const visited = new Set<Flow>();
for (const f of g.flows) {
  if (f.node !== undefined) seen.set(f.node, (seen.get(f.node) ?? 0) + f.flags);
  visited.add(f);
}
console.log("keys", [...seen.entries()].map(([n, v]) => `${n.kind}:${v}`).join(" "), visited.size);

const published = publish(g);
console.log("same", published === g, publish(g.root) === g.root);
report("published", published);
attempt("ident id", () => {
  published.idents[0]!.id = 1;
});
attempt("tagged flag", () => {
  (published.idents[1] as Tagged).marked = true;
});
attempt("root flag", () => {
  published.root.flagged = true;
});
attempt("flow reachable", () => {
  published.flows[2]!.reachable = true;
});
report("after writes", published);

// New instances next to published ones stay writable.
const fresh = new Binary(new Ident(16, "y"), "-", new Literal(20, 3));
fresh.precedence = 11;
fresh.right.flagged = true;
console.log("fresh", describe(fresh), describe(fresh.right), classify(fresh.left), classify(published.root));

// Instances in recycled blocks: freed 8- and 16-byte objects leave their
// blocks on the allocator's free lists, and the next instances of the same
// sizes reuse them. Marker has no fields (a 4-byte instance); Toggle's
// field and Pair's first field sit right after the header.
class Scrap {
  readonly n: number;
  constructor(n: number) {
    this.n = n;
  }
}

class Blank {}

class Marker implements ProgramLifetime {}

class Toggle implements ProgramLifetime {
  on: boolean;
  constructor(on: boolean) {
    this.on = on;
  }
}

class Pair implements ProgramLifetime {
  readonly low: number;
  readonly high: Node | undefined;
  constructor(low: number, high: Node | undefined) {
    this.low = low | 0;
    this.high = high;
  }
}

const blanks: Blank[] = [];
const scraps: Scrap[] = [];
const markers: Marker[] = [];
const toggles: Toggle[] = [];
const pairs: Pair[] = [];
for (let round = 0; round < 3; round++) {
  for (let i = 0; i < 200; i++) {
    blanks.push(new Blank());
    scraps.push(new Scrap(i * 1.5));
  }
  let sum = 0;
  for (const s of scraps) sum += s.n;
  blanks.length = 0;
  scraps.length = 0;
  for (let i = 0; i < 200; i++) {
    markers.push(new Marker());
    toggles.push(new Toggle(i % 3 === 0));
    pairs.push(new Pair(i - 100, i % 2 === 0 ? undefined : published.root));
  }
  let on = 0;
  let low = 0;
  let high = 0;
  for (const t of toggles) if (t.on) on++;
  for (const p of pairs) {
    low += p.low;
    if (p.high !== undefined) high++;
  }
  console.log("recycled", round, sum, markers.length, on, low, high);
}
