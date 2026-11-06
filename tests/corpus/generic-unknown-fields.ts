// @transform-types
// Generic classes whose fields are typed by a type parameter, instantiated
// with `unknown` or `object`: the instantiation keeps those fields in the
// checked-dynamic storage a field declared `unknown` uses. Values of every
// kind go in and come back with their identity, `typeof` and narrowing
// intact, `T | null` and `T[]` fields and parameter properties follow the
// same rule, a subclass inherits the slot, a generic factory reaches it
// through its own type parameter, accessors read and replace it, another
// argument that lowers to a dynamic value (a WeakMap) shares the
// instantiation, and a number instantiation keeps its own typed layout.

class Item {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
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
  set(v: T): boolean {
    if (v === this.value) return false;
    this.value = v;
    return true;
  }
}

class Slot<T> {
  current: T | null = null;
  history: T[] = [];
  constructor(public readonly first: T) {
    this.put(first);
  }
  put(v: T): number {
    this.current = v;
    return this.history.push(v);
  }
}

class Named<T> extends Box<T> {
  constructor(
    readonly label: string,
    v: T,
  ) {
    super(v);
  }
  describe(): string {
    return this.label + ": " + kind(this.get());
  }
}

class Cell<T> {
  _value: T;
  _writes = 0;
  constructor(value: T) {
    this._value = value;
  }
  get value(): T {
    return this._value;
  }
  set value(next: T) {
    if (this._value === next) return;
    this._value = next;
    this._writes++;
  }
  peek(): T {
    return this._value;
  }
}

function cell<T>(initial: T): Cell<T> {
  return new Cell(initial);
}

function kind(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "number") return "number " + (v + 1);
  if (typeof v === "string") return "string " + v.toUpperCase();
  if (typeof v === "boolean") return "boolean " + (v ? "yes" : "no");
  if (typeof v === "function") return "function " + v.name;
  if (v instanceof Item) return v.greet();
  if (Array.isArray(v)) return "array of " + v.length;
  if (typeof v === "object") return "object " + JSON.stringify(v);
  return typeof v;
}

const shout = (s: string): string => s.toUpperCase() + "!";
const item = new Item("pen");
const list = [1, 2, 3];
const record = { a: 1, nested: { b: "two" } };
const values: unknown[] = [7, "seven", true, null, undefined, shout, item, list, record];

for (const v of values) {
  const box = new Box(v);
  const back = box.get();
  console.log(kind(back), back === v, typeof back === typeof v);
}

const shared = new Box<unknown>(record);
console.log(shared.get() === record, shared.set(record), shared.set(item), shared.get() === item);
const held = shared.get();
if (held instanceof Item) console.log("narrowed", held.greet());
shared.value = shout;
const fn = shared.get();
if (typeof fn === "function") console.log("called", fn("hey"));
shared.value = list;
const arr = shared.get();
if (Array.isArray(arr)) console.log("array", arr.length, arr === list);

const objects = new Box<object>(record);
console.log(objects.get() === record, kind(objects.get()));
objects.value = item;
console.log(objects.get() === item, objects.set(list), objects.get() === list);

const slot = new Slot<unknown>("start");
console.log(kind(slot.first), kind(slot.current), slot.history.length);
for (const v of values) slot.put(v);
console.log(slot.history.length, slot.history[7] === item, slot.history[6] === shout, kind(slot.current));
console.log(slot.history.map(kind).join(" | "));

const named = new Named<unknown>("thing", item);
console.log(named.describe(), named instanceof Box, named.get() === item);
named.set(42);
console.log(named.describe(), named.label);

const c = cell(values[1]);
console.log(kind(c.value), c._writes);
c.value = "seven";
c.value = item;
c.value = item;
console.log(c.peek() === item, c._writes, kind(c.value));
const fromNull = cell<unknown>(null);
fromNull.value = record;
console.log(kind(fromNull.peek()), fromNull.peek() === record, fromNull._writes);

const numbers = new Box(1);
numbers.set(numbers.get() + 41);
console.log(numbers.get(), typeof numbers.get());
const counter = cell(0);
counter.value = counter.value + 5;
console.log(counter.value, counter._writes);

const weakKey = {};
const weak = new WeakMap<object, number>([[weakKey, 9]]);
const weakBox = new Box(weak);
console.log(weakBox.get() === weak, weakBox.get().get(weakKey), weakBox.get().has({}));

const churn = new Box<unknown>(null);
for (let i = 0; i < 2000; i++) churn.value = { i, tag: "row" + i, items: [i, i + 1] };
console.log(kind(churn.get()));
