// TypeScript class fields declared `unknown`, `unknown[]`,
// `readonly unknown[]`, `object` and `object | undefined`: they keep their
// values in the checked-dynamic storage JavaScript fields already use. Values of every kind go in and come
// back out with their identity, `typeof` and narrowing intact, arrays of
// them grow and iterate, initializers run at construction, subclasses add
// and overwrite them, and overwriting releases what a field held.

class Item {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  greet(): string {
    return "item " + this.name;
  }
}

class Slot {
  value: unknown;
  label: string;
  constructor(label: string) {
    this.label = label;
    this.value = null;
  }
  set(v: unknown): boolean {
    if (v === this.value) return false;
    this.value = v;
    return true;
  }
  describe(): string {
    const v = this.value;
    if (v === null) return this.label + ": null";
    if (v === undefined) return this.label + ": undefined";
    if (typeof v === "number") return this.label + ": number " + (v + 1);
    if (typeof v === "string") return this.label + ": string " + v.toUpperCase();
    if (typeof v === "boolean") return this.label + ": boolean " + (v ? "yes" : "no");
    if (v instanceof Item) return this.label + ": " + v.greet();
    if (Array.isArray(v)) return this.label + ": array of " + v.length;
    if (typeof v === "object") return this.label + ": object " + JSON.stringify(v);
    return this.label + ": " + typeof v;
  }
}

const slot = new Slot("s");
console.log(slot.describe());
const item = new Item("a");
for (const v of [3, "hi", true, item, [1, 2, 3], { k: "v" }, undefined, null]) {
  slot.set(v);
  console.log(slot.describe());
}
console.log("same value again changes nothing:", slot.set(null));
slot.set(item);
console.log("identity kept:", slot.value === item, slot.set(item));
const back = slot.value;
if (back instanceof Item) console.log("narrowed:", back.name);
console.log("nullish:", new Slot("t").value ?? "fallback");

class Bag {
  readonly fixed: readonly unknown[];
  items: unknown[];
  data: unknown = JSON.parse('{"a":1,"b":[2,3]}');
  constructor(fixed: readonly unknown[]) {
    this.fixed = fixed;
    this.items = [];
  }
  add(v: unknown): number {
    this.items.push(v);
    return this.items.length;
  }
  kinds(): string {
    let out = "";
    for (const v of this.items) out += (v === null ? "null" : typeof v) + " ";
    return out.trim();
  }
}

const bag = new Bag([1, "two", null]);
bag.add(1);
bag.add("x");
bag.add(null);
bag.add(item);
bag.add([4]);
console.log("items:", bag.items.length, bag.kinds());
console.log("fixed:", bag.fixed.length, String(bag.fixed[1]), bag.fixed[2] === null);
console.log("index read:", bag.items[3] === item, typeof bag.items[1]);
console.log("data:", JSON.stringify(bag.data));
bag.items = bag.items.filter((v) => typeof v !== "string");
console.log("filtered:", bag.items.length, bag.kinds());

class NamedSlot extends Slot {
  extra: unknown;
  constructor(label: string, extra: unknown) {
    super(label);
    this.extra = extra;
    this.value = "from the subclass";
  }
}

const named = new NamedSlot("n", 42);
console.log(named.describe(), typeof named.extra, String(named.extra));
const asBase: Slot = named;
asBase.set(7);
console.log(asBase.describe(), named.value === 7);

const passThrough = (s: Slot): unknown => s.value;
console.log("returned:", passThrough(named) === 7);
const record = { label: named.label, value: named.value, extra: named.extra };
console.log("record:", JSON.stringify(record));

let total = 0;
const slots: Slot[] = [];
for (let i = 0; i < 200; i++) slots.push(new Slot("x" + i));
for (let round = 0; round < 50; round++)
  for (let i = 0; i < slots.length; i++) {
    slots[i].set({ round, i, tag: "r" + round });
    const v = slots[i].value;
    if (typeof v === "object" && v !== null) total += 1;
  }
for (const s of slots) s.set(null);
console.log("stress:", total, slots.every((s) => s.value === null));

class Binding {
  owner: object | undefined;
  meta: object;
  extras: (object | null)[];
  constructor(owner: object | undefined) {
    this.owner = owner;
    this.meta = { kind: "binding" };
    this.extras = [];
  }
  call(fn: (this: unknown, n: number) => number, n: number): number {
    return fn.call(this.owner, n);
  }
}

const ownerItem = new Item("owner");
const bound = new Binding(ownerItem);
console.log("owner identity:", bound.owner === ownerItem, bound.owner instanceof Item);
console.log(
  "this through call:",
  bound.call(function (this: unknown, n: number): number {
    return this instanceof Item ? n * 2 : -1;
  }, 21),
);
bound.owner = undefined;
console.log("owner cleared:", bound.owner === undefined, new Binding(undefined).owner === undefined);
bound.extras.push({ a: 1 }, null, ownerItem);
console.log("extras:", bound.extras.length, bound.extras[1] === null, bound.extras[2] === ownerItem);
bound.meta = [1, 2];
console.log("meta:", Array.isArray(bound.meta), JSON.stringify(bound.meta));
