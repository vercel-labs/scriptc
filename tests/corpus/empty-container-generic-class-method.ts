// A fresh empty container passed to a generic METHOD of a generic class,
// where the call has a destination. The method's declaration names the
// class's type parameter too (`extra: T`), which the receiver's
// instantiation binds, so the instance's parameters keep that binding while
// the method's own type parameter takes the destination's.
class Box<T> {
  value: T;
  constructor(value: T) {
    this.value = value;
  }
  wrap<U>(items: U, extra: T): U {
    console.log("extra", extra);
    return items;
  }
  pair<U>(items: U): [U, T] {
    return [items, this.value];
  }
  fresh(): T[] {
    // The same call through `this`, inside the class's own body.
    const out: T[] = this.wrap([], this.value);
    out.push(this.value);
    return out;
  }
}

const box = new Box<string>("a");

// A destination the inferred element type already satisfies.
const loose: unknown[] = box.wrap([], "x");
loose.push(1, "two");
console.log(loose, loose.length, box.value);

// A destination that names the element type.
const names: string[] = box.wrap([], "y");
names.push("ada");
console.log(names);

// Maps and sets.
const ages: Map<string, number> = box.wrap(new Map(), "z");
ages.set("ada", 36);
const seen: Set<number> = box.wrap(new Set(), "w");
seen.add(7);
console.log(ages, seen);

// The class's type parameter in the result.
const store = new Box<number>(4);
const [list, n]: [string[], number] = store.pair([]);
list.push("item");
console.log(list, n);

// A call through `this` under each receiver instantiation.
console.log(box.fresh(), store.fresh());
