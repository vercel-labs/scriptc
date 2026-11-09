// A checked conversion of an untyped value into a class accepts the class and
// every class below it, into a union every arm, and into a record type the
// record; a symbol compared with an untyped value compares identities. The
// conversions here all succeed, so Node and the native binary print the same.

const TAG_BASE: symbol = Symbol.for('cast-keys.base');
const TAG_SIDE: symbol = Symbol.for('cast-keys.side');
const TAG_LOCAL: symbol = Symbol('cast-keys.local');
const TAG_TWIN: symbol = Symbol('cast-keys.local');

class Base {
  readonly tag: symbol;
  readonly id: number;
  constructor(id: number) {
    this.tag = TAG_BASE;
    this.id = id;
  }
  describe(): string {
    return 'base#' + this.id;
  }
}

class Mid extends Base {
  readonly depth: number;
  constructor(id: number) {
    super(id);
    this.depth = 1;
  }
  describe(): string {
    return 'mid#' + this.id;
  }
}

class Leaf extends Mid {
  readonly leaf: string;
  constructor(id: number) {
    super(id);
    this.leaf = 'leaf';
  }
  describe(): string {
    return 'leaf#' + this.id + ':' + this.leaf;
  }
}

class Side extends Base {
  readonly side: symbol;
  constructor(id: number) {
    super(id);
    this.side = TAG_SIDE;
  }
  describe(): string {
    return 'side#' + this.id;
  }
}

class Other {
  readonly tag: symbol;
  readonly name: string;
  constructor(name: string) {
    this.tag = TAG_LOCAL;
    this.name = name;
  }
}

type Rec = {tag: symbol; label: string; count: number};
type Pair = {left: number; right: number};

function takeBase(b: Base): string {
  return b.describe();
}

function takeMid(m: Mid): number {
  return m.depth + m.id;
}

function takeEither(x: Base | Other): string {
  return x instanceof Other ? 'other:' + x.name : 'base:' + x.describe();
}

function takeRec(r: Rec): string {
  return r.label + '=' + r.count;
}

function takeRecOrBase(x: Rec | Base): string {
  return x instanceof Base ? x.describe() : takeRec(x);
}

const rec: Rec = {tag: TAG_SIDE, label: 'rec', count: 3};
const pair: Pair = {left: 1, right: 2};

const kinds: string[] = ['base', 'mid', 'leaf', 'side', 'other', 'rec', 'pair', 'parsed', 'number', 'text', 'null', 'undefined', 'symbol', 'twin'];
const values: unknown[] = [
  new Base(1),
  new Mid(2),
  new Leaf(3),
  new Side(4),
  new Other('o'),
  rec,
  pair,
  JSON.parse('{"tag":"cast-keys.base","label":"parsed","count":7}'),
  42,
  'cast-keys.base',
  null,
  undefined,
  TAG_LOCAL,
  TAG_TWIN,
];

// Conversions into a class: the class itself and every class below it.
for (let round = 0; round < 3; round++) {
  const lines: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const kind = kinds[i]!;
    const v = values[i];
    if (kind === 'base' || kind === 'mid' || kind === 'leaf' || kind === 'side') {
      const b = v as Base;
      lines.push(kind + ' as Base ' + b.describe() + ' ' + takeBase(v as any));
      lines.push(kind + ' either ' + takeEither(v as any) + ' ' + takeRecOrBase(v as any));
    }
    if (kind === 'mid' || kind === 'leaf') {
      const m = v as Mid;
      lines.push(kind + ' as Mid ' + m.depth + ' ' + takeMid(v as any));
    }
    if (kind === 'leaf') {
      const l = v as Leaf;
      lines.push(kind + ' as Leaf ' + l.leaf);
    }
    if (kind === 'side') {
      const s = v as Side;
      lines.push(kind + ' as Side ' + String(s.side === TAG_SIDE));
    }
    if (kind === 'other') {
      const o = v as Other;
      lines.push(kind + ' as Other ' + o.name + ' ' + takeEither(v as any));
    }
    if (kind === 'rec') {
      const r = v as Rec;
      lines.push(kind + ' as Rec ' + r.label + ' ' + takeRec(v as any) + ' ' + takeRecOrBase(v as any));
    }
    if (kind === 'pair') {
      const p = v as Pair;
      lines.push(kind + ' as Pair ' + (p.left + p.right));
    }
  }
  if (round === 0) console.log(lines.join('\n'));
  else console.log('round ' + round + ': ' + lines.length + ' conversions');
}

// A symbol compared with an untyped value, both operand orders and both
// operators, for every kind of value.
function compare(kind: string, v: unknown): string {
  const a = v as any;
  const out: string[] = [];
  out.push(String(v === TAG_LOCAL));
  out.push(String(TAG_LOCAL === v));
  out.push(String(v !== TAG_LOCAL));
  out.push(String(TAG_TWIN !== v));
  out.push(String(v === Symbol.iterator));
  if (v !== null && v !== undefined) {
    out.push(String(a.tag === TAG_BASE));
    out.push(String(TAG_BASE === a.tag));
    out.push(String(a.tag !== TAG_BASE));
    out.push(String(TAG_LOCAL === a.tag));
    out.push(String(a.tag === TAG_SIDE));
    out.push(String(a.side === TAG_SIDE));
    out.push(String(TAG_SIDE !== a.side));
  }
  return kind + ': ' + out.join(' ');
}

for (let i = 0; i < values.length; i++) {
  console.log(compare(kinds[i]!, values[i]));
}

// A symbol that is held by an untyped value, compared with symbols of the
// same description, the registry and the well-known set.
const held: unknown[] = [TAG_BASE, TAG_LOCAL, TAG_TWIN, Symbol.iterator, Symbol.for('cast-keys.base'), Symbol('cast-keys.local')];
const wanted: symbol[] = [TAG_BASE, TAG_LOCAL, TAG_TWIN, Symbol.iterator];
for (let i = 0; i < held.length; i++) {
  let row = '';
  for (let j = 0; j < wanted.length; j++) {
    row += held[i] === wanted[j]! ? '=' : '.';
    row += wanted[j]! !== held[i] ? '.' : '=';
  }
  console.log('held ' + i + ' ' + row);
}

let hits = 0;
for (let round = 0; round < 2000; round++) {
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === TAG_LOCAL) hits += 1;
    if (TAG_TWIN === v) hits += 2;
    if (v !== null && v !== undefined && (v as any).tag === TAG_BASE) hits += 3;
  }
}
console.log('hits ' + hits);
