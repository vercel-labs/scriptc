// TypeScript's `readonly` is not a runtime guarantee: structural casts,
// mapped types that strip the modifier, `any`, Reflect, mutable record
// aliases, and subclass methods can all rewrite a "readonly" field after
// construction, and each write below closes a reference cycle. The
// compiler's acyclicity proof has to see every one of these writes; the
// sanitized lane's RC audit fails if any dropped cycle leaks.
const ROUNDS = 200;

class Node {
  readonly next: Node | null;
  readonly label: string;
  constructor(label: string, next: Node | null) {
    this.label = label;
    this.next = next;
  }
}

// 1. A structural view without the modifier.
function viaView(): boolean {
  const n = new Node("view", null);
  (n as unknown as { next: Node | null }).next = n;
  return n.next === n;
}

// 2. A mapped type that strips readonly.
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
class Leaf {
  readonly up: Leaf | null;
  constructor(up: Leaf | null) {
    this.up = up;
  }
}
function viaMapped(): boolean {
  const a = new Leaf(null);
  const b = new Leaf(a);
  (a as Mutable<Leaf>).up = b;
  return a.up === b && b.up === a;
}

// 3. `any`.
class Loose {
  readonly other: Loose | null;
  constructor() {
    this.other = null;
  }
}
function viaAny(): boolean {
  const l = new Loose();
  (l as any).other = l;
  return l.other === l;
}

// 4. Reflect.set.
class Reflected {
  readonly ref: Reflected | null;
  constructor() {
    this.ref = null;
  }
}
function viaReflect(): boolean {
  const r = new Reflected();
  Reflect.set(r, "ref", r);
  return r.ref === r;
}

// 5. A record declared readonly, written through a mutable alias of the
// same runtime shape.
interface FrozenLink {
  readonly id: number;
  readonly link: FrozenLink | null;
}
function viaAlias(): boolean {
  const frozen: FrozenLink = { id: 1, link: null };
  const open = frozen as { id: number; link: FrozenLink | null };
  open.link = frozen;
  return frozen.link === frozen;
}

// 6. A subclass method rewriting the inherited field through a view.
class Base {
  readonly parent: Base | null;
  constructor(parent: Base | null) {
    this.parent = parent;
  }
}
class Rewire extends Base {
  constructor() {
    super(null);
  }
  loop(): void {
    (this as { parent: Base | null }).parent = this;
  }
}
function viaSubclass(): boolean {
  const w = new Rewire();
  w.loop();
  return w.parent === w;
}

// 7. A readonly array field: the binding is fixed, the contents are not.
class Bag {
  readonly items: Bag[];
  constructor(items: Bag[]) {
    this.items = items;
  }
}
function viaArray(): boolean {
  const bag = new Bag([]);
  bag.items.push(bag);
  return bag.items[0] === bag;
}

// 8. A readonly field holding a mutable holder that is later pointed back.
class Holder {
  owner: Owner | null = null;
}
class Owner {
  readonly holder: Holder;
  constructor(holder: Holder) {
    this.holder = holder;
  }
}
function viaHolder(): boolean {
  const h = new Holder();
  const o = new Owner(h);
  h.owner = o;
  return o.holder.owner === o;
}

const cases: [string, () => boolean][] = [
  ["view", viaView],
  ["mapped", viaMapped],
  ["any", viaAny],
  ["reflect", viaReflect],
  ["alias", viaAlias],
  ["subclass", viaSubclass],
  ["array", viaArray],
  ["holder", viaHolder],
];
for (const [name, run] of cases) {
  let ok = 0;
  for (let i = 0; i < ROUNDS; i++) if (run()) ok++;
  console.log(name, ok);
}
