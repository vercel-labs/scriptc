// Class instances that cross into untyped code keep their identity there,
// and untyped writes land in the original native fields. Each write below
// targets a readonly field that the typed program only ever assigns in its
// constructor, and each closes a reference cycle. The compiler must treat
// every type that can cross into untyped code as mutable; the sanitized
// lane's RC audit fails if any dropped cycle leaks.
const ROUNDS = 200;

class Chain {
  readonly next: Chain | null;
  readonly n: number;
  constructor(n: number, next: Chain | null) {
    this.n = n;
    this.next = next;
  }
}

// Untyped parameters: the write goes through the checked-dynamic view.
function poke(target: any, value: any): void {
  target.next = value;
}
function viaAnyParam(): boolean {
  const c = new Chain(1, null);
  poke(c, c);
  return c.next === c;
}

// An unknown value narrowed back with a structural cast.
function relink(target: unknown, value: unknown): void {
  (target as { next: unknown }).next = value;
}
class Ring {
  readonly next: Ring | null;
  constructor() {
    this.next = null;
  }
}
function viaUnknown(): boolean {
  const a = new Ring();
  const b = new Ring();
  relink(a, b);
  relink(b, a);
  return a.next === b && b.next === a;
}

// Reached only through a record field and an array element.
class Inner {
  readonly owner: Inner | null;
  constructor() {
    this.owner = null;
  }
}
interface Envelope {
  items: Inner[];
}
function setOwner(target: any, value: any): void {
  target.owner = value;
}
function viaContainer(): boolean {
  const inner = new Inner();
  const env: Envelope = { items: [inner] };
  const loose: any = env;
  setOwner(loose.items[0], inner);
  return inner.owner === inner;
}

// A callback receiving the instance untyped.
class Cell {
  readonly self: Cell | null;
  constructor() {
    this.self = null;
  }
}
function visit(value: Cell, fn: (v: any) => void): void {
  fn(value);
}
function viaCallback(): boolean {
  const cell = new Cell();
  visit(cell, (v) => {
    v.self = v;
  });
  return cell.self === cell;
}

const cases: [string, () => boolean][] = [
  ["any-param", viaAnyParam],
  ["unknown", viaUnknown],
  ["container", viaContainer],
  ["callback", viaCallback],
];
for (const [name, run] of cases) {
  let ok = 0;
  for (let i = 0; i < ROUNDS; i++) if (run()) ok++;
  console.log(name, ok);
}
