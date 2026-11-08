// A method whose signature has no mapping is refused without rejecting its class: the fields,
// the other methods, the accessors, construction, `instanceof`, subclasses, virtual dispatch and
// the class as a type all work. The refused method is never used here.
class Store {
  items: string[] = [];
  count = 0;
  label: string;
  constructor(label: string) {
    this.label = label;
  }
  add(item: string): number {
    this.items.push(item);
    return ++this.count;
  }
  watch(ref: WeakRef<object>): number {
    return ref.deref() === undefined ? 0 : 1;
  }
  get size(): number {
    return this.items.length;
  }
  describe(): string {
    return `${this.label}: ${this.items.join(",")} (${this.count})`;
  }
}
class Tagged extends Store {
  tag = "t";
  describe(): string {
    return `[${this.tag}] ${super.describe()}`;
  }
}
// A subclass that redeclares the refused method with the same signature, and one that only
// overrides a compiled method of the class that holds the refused one.
class Quiet extends Store {
  watch(ref: WeakRef<object>): number {
    return ref.deref() === undefined ? 2 : 3;
  }
  describe(): string {
    return "quiet";
  }
}
interface Counter {
  add(item: string): number;
}
function fill(counter: Counter): number {
  counter.add("p");
  return counter.add("q");
}
const s = new Store("a");
s.add("x");
s.add("y");
console.log(s.describe(), s.size, s instanceof Store, s.label);
const t: Store = new Tagged("b");
t.add("z");
console.log(t.describe(), t instanceof Tagged, t instanceof Store);
const all: Store[] = [s, t, new Quiet("c")];
console.log(all.map((x) => `${x.describe()}/${x.size}`).join(" | "));
console.log(fill(new Store("d")), fill(new Quiet("e")));
console.log(JSON.stringify(s), Object.keys(t).join(","));
const untyped: unknown = s;
console.log(untyped instanceof Store ? untyped.count : -1);
