// A call through a variadic record field hands back the very object the
// field returned, as JavaScript does: identity and mutation sharing
// survive. The field's lifted signature hides one trailing dynamic array
// (the argument list); passing it natively keeps the answer, where a boxed
// call would copy a record or array result into a fresh object.
interface Handlers {
  make: (...args: any[]) => { x: number };
  list: (...args: any[]) => number[];
  fresh: (...args: any[]) => { n: number };
  count: (start: number, ...rest: any[]) => number;
}

const shared = { x: 1 };
const items = [1, 2];
const h: Handlers = {
  make: () => shared,
  list: () => items,
  fresh: (...args) => ({ n: args.length }),
  count: (start, ...rest) => start + rest.length,
};

// A record answer is the same object, and writing through it is seen
// through the original.
const r = h.make(1, 2, 3);
console.log("record identity", r === shared, r.x);
r.x = 5;
console.log("record shares writes", shared.x, r.x, Object.keys(r).join(","));

// An array answer is the same array, and growing it grows the original.
const a = h.list("a");
console.log("array identity", a === items, a.length);
a.push(3);
console.log("array shares writes", items.length, items.join(","));

// A freshly built answer is not some other object's.
console.log("fresh", h.fresh(1, 2).n, h.fresh() === h.fresh());

// Declared parameters and the surplus tail keep their own positions.
console.log("count", h.count(10), h.count(10, "x", "y"));

// The same field reached through a nested record answers the same object.
const nested = { inner: h };
console.log("nested identity", nested.inner.make() === shared);

// A generic member's erased instance keeps its rest parameter inside the
// hidden array; the answer through the field is still the shared record.
const rows = { id: 7 };
const util = {
  add<T>(name: string, ...args: T[]): { id: number } {
    console.log("add", name, args.length);
    return rows;
  },
};
const holder = { add: util.add };
const row = holder.add("k", 1, 2);
console.log("erased identity", row === rows, row.id);
