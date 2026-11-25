// @transform-types
// Class fields typed by a type parameter, in instantiations that bind the
// parameter to `unknown` or `object`: `T`, `T | null`, `T | undefined` and
// `T[]` fields, parameter properties, a generic subclass, a generic factory
// and a defaulted type parameter store their values as a field declared
// `unknown` does, next to a `number` instantiation of the same class.

class Item {
  constructor(readonly name: string) {}
  greet(): string {
    return "item " + this.name;
  }
}

class Box<T> {
  value: T;
  constructor(v: T) {
    this.value = v;
  }
  get(): T {
    return this.value;
  }
  replace(v: T): T {
    const old = this.value;
    this.value = v;
    return old;
  }
  get current(): T {
    return this.value;
  }
  set current(v: T) {
    this.value = v;
  }
}

class Slot<T> {
  last: T | null = null;
  pending?: T;
  history: T[] = [];
  constructor(public readonly first: T) {}
  put(v: T): void {
    if (this.last !== null) this.history.push(this.last);
    this.last = v;
    this.pending = undefined;
  }
}

class Named<T> extends Box<T> {
  constructor(
    readonly name: string,
    v: T,
  ) {
    super(v);
  }
  describe(): string {
    return `${this.name}: ${typeof this.value}`;
  }
}

class Holder<T = unknown> {
  items: T[] = [];
  add(item: T): number {
    return this.items.push(item);
  }
}

function boxOf<T>(v: T): Box<T> {
  return new Box(v);
}

function kind(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(${v.length})`;
  if (v instanceof Item) return v.greet();
  if (typeof v === "object") return "object " + JSON.stringify(v);
  return typeof v + " " + String(v);
}

// The issue's program.
const box = new Box<unknown>("x");
console.log(box.get());

// Values of every kind go in and come back unchanged.
const item = new Item("a");
const record = { n: 1 };
const list = [1, "two"];
const values: unknown[] = [1, "s", true, null, undefined, 10n, record, list, item];
for (const v of values) {
  box.value = v;
  console.log(kind(box.get()), box.get() === v);
}

// Narrowing a value read from the field.
box.current = item;
const read = box.current;
if (read instanceof Item) console.log("instanceof", read.name);
console.log("replace", kind(box.replace(42)), kind(box.value));

// An `object` instantiation keeps identity.
const objectBox = new Box<object>(record);
console.log(objectBox.get() === record, JSON.stringify(objectBox));
objectBox.value = list;
console.log(Array.isArray(objectBox.value));

// `T | null`, optional `T` and `T[]` fields, and a parameter property.
const slot = new Slot<unknown>(0);
slot.put("a");
slot.put([1, 2]);
slot.put({ k: "v" });
slot.put(null);
console.log(slot.first, slot.last, slot.pending, slot.history);
console.log(slot.history.map(kind).join(" | "));
slot.pending = item;
console.log(kind(slot.pending));

// A generic subclass inherits the base's field.
const named = new Named<unknown>("k", { x: 1 });
console.log(named.describe(), named.value);
named.value = "text";
console.log(named.describe(), named.get());
const narrowed: unknown = new Named<unknown>("m", { x: 7 }).value;
if (typeof narrowed === "object" && narrowed !== null && "x" in narrowed)
  console.log("x =", (narrowed as { x: number }).x);

// A defaulted type parameter and a generic factory.
const holder = new Holder();
holder.add(1);
holder.add("b");
console.log(holder.add(item), holder.items.map(kind).join(" | "));
const made = boxOf<unknown>([3, 4]);
console.log(kind(made.get()));

// Another argument that lowers to a checked-dynamic value.
const weak = new WeakMap<object, number>([[record, 5]]);
const weakBox = new Box<WeakMap<object, number>>(weak);
console.log(weakBox.get().get(record), weakBox.get() === weak);

// A number instantiation of the same class keeps its own layout.
const numbers = new Box<number>(2);
numbers.value *= 21;
console.log(numbers.get() + 0.5, typeof numbers.value);

// Repeated writes over the same field.
const counter = new Box<unknown>(0);
for (let i = 0; i < 1000; i++) counter.value = i % 2 === 0 ? i : String(i);
console.log(kind(counter.value));

// Inspection and JSON keep the declared field order.
const inspected = new Slot<unknown>({ a: [1] });
inspected.history.push(2);
console.log(new Box<unknown>("x"), new Box<number>(1));
console.log(inspected, JSON.stringify(inspected), Object.keys(inspected));
