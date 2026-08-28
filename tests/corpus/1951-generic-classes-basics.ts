// Generic classes, monomorphized per instantiation: fields, methods,
// accessors, inference and explicit type arguments, instanceof against the
// generic name (one runtime class in Node — the family interval here).
// The early reference pins collection-order independence: its checker type is
// first mapped before Box's family has collected, then must remap to Box%N.
class EarlyHolder {
  readonly box: Box<number>;
  constructor(box: Box<number>) {
    this.box = box;
  }
  read(): number {
    return this.box.get();
  }
}

class Box<T> {
  v: T;
  constructor(v: T) {
    this.v = v;
  }
  get(): T {
    return this.v;
  }
  set(v: T): void {
    this.v = v;
  }
  describe(): string {
    return `box(${this.v})`;
  }
}

const a = new Box(41); // inferred Box<number>
a.set(a.get() + 1);
console.log(a.get(), a.describe());
console.log(new EarlyHolder(a).read());

const b = new Box<string>("hi"); // explicit
console.log(b.get().toUpperCase(), b.describe());

const c: Box<boolean> = new Box(true); // annotation-typed slot
console.log(c.v, c instanceof Box, a instanceof Box);

// Instantiations in containers.
const boxes: Box<number>[] = [new Box(1), new Box(2), new Box(3)];
console.log(boxes.map((x) => x.get()).join("+"));

// Accessors per instantiation.
class Cell<T> {
  private inner: T[];
  constructor(seed: T) {
    this.inner = [seed];
  }
  get first(): T {
    return this.inner[0]!;
  }
  set first(v: T) {
    this.inner[0] = v;
  }
}
const cell = new Cell("x");
cell.first = "y";
console.log(cell.first);
const ncell = new Cell(10);
ncell.first = ncell.first * 2;
console.log(ncell.first);

// Type-parameter defaults: `new Pair("k", 3)` and the default-typed slot.
class Pair<A, B = number> {
  a: A;
  b: B;
  constructor(a: A, b: B) {
    this.a = a;
    this.b = b;
  }
  swapText(): string {
    return `${this.b},${this.a}`;
  }
}
const p = new Pair("k", 3);
console.log(p.a, p.b, p.swapText());

// Multiple type parameters at distinct instantiations.
const q = new Pair(true, "z");
console.log(q.swapText());

// Recursive generic layouts: a self-referential field type.
class Node2<T> {
  value: T;
  next: Node2<T> | null = null;
  constructor(v: T) {
    this.value = v;
  }
}
const n1 = new Node2(1);
const n2 = new Node2(2);
n2.next = n1;
console.log(n2.value, n2.next.value, n1.next === null);

// Generic functions constructing generic classes (cross-demand).
function wrap<T>(v: T): Box<T> {
  return new Box(v);
}
console.log(wrap(5).get() + wrap(6).get());
console.log(wrap("w").describe());
