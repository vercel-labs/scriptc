// Object literals with get/set accessors held as `any` or `unknown` keep
// their accessors, as in Node: a read calls the getter, a write calls the
// setter, Object.keys, Object.entries and JSON.stringify list the accessor
// in declaration order and call the getter, and the property descriptor
// has a get and set function. Writes to data properties reach the
// original object.

function dyn(value: unknown): any {
  return value;
}

let count = 0;
const lit = {
  a: 1,
  get g(): number { count++; return 42; },
  set g(v: number) { console.log("set", v); },
  b: 2,
  get only(): string { return "read-only"; },
};
const d = dyn(lit);
console.log("read", d.g, d.only, count);
console.log("keys", Object.keys(d).join(","), JSON.stringify(d), count);
console.log("entries", Object.entries(d).map((e) => e.join("=")).join(";"));
console.log("in", "g" in d, Object.hasOwn(d, "g"));
d.g = 7;
d.a = 5;
console.log("write", lit.a, d.a);
const desc = Object.getOwnPropertyDescriptor(d, "g")!;
console.log("descriptor", typeof desc.get, typeof desc.set, desc.enumerable, desc.configurable);
const u: unknown = lit;
console.log("unknown", (u as any).g, JSON.stringify(u));
