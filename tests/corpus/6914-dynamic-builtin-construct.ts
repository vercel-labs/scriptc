// `new` through values that hold builtin constructors.
const ctors: Record<string, unknown> = { Date, Map, Set, Object, WeakMap, WeakSet };
function construct(name: string, ...args: unknown[]): unknown {
  const C = ctors[name] as any;
  return new C(...args);
}
function make(C: any, ...args: unknown[]): unknown {
  return new C(...args);
}
const tag = (value: unknown) => Object.prototype.toString.call(value);

const d = construct("Date", 0) as Date;
console.log(tag(d), d.getTime(), d.toISOString());
const d2 = make(Date, 2020, 1, 3, 4, 5, 6, 7) as Date;
console.log(d2.getFullYear(), d2.getMonth(), d2.getDate(), d2.getHours(), d2.getMilliseconds());
const d3 = make(Date, "2001-02-03T04:05:06Z") as Date;
const d4 = make(Date, d3) as Date;
console.log(d3.getTime(), d4.getTime());
console.log(typeof make(Date), Number.isNaN((make(Date, "nope") as Date).getTime()));

const m = construct("Map", [["a", 1], ["b", 2]]) as Map<unknown, unknown>;
console.log(tag(m), m.size, m.get("b"), [...m.keys()].join());
const m2 = make(Map, m) as Map<unknown, unknown>;
m2.set("c", 3);
console.log(m.size, m2.size, (make(Map) as Map<unknown, unknown>).size, (make(Map, null) as Map<unknown, unknown>).size);

const s = construct("Set", [1, 2, 2, 3]) as Set<unknown>;
console.log(tag(s), s.size, s.has(3), (make(Set, "abca") as Set<unknown>).size);

const o = construct("Object") as Record<string, unknown>;
o.x = 1;
const same = { y: 2 };
console.log(tag(o), JSON.stringify(o), make(Object, same) === same, tag(make(Object, null)));

const key = {};
const w = construct("WeakMap", [[key, "v"]]) as WeakMap<object, unknown>;
console.log(tag(w), w.get(key), w.has({}));
const ws = make(WeakSet, [key]) as WeakSet<object>;
console.log(tag(ws), ws.has(key));

try {
  make(Map, [1]);
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}
try {
  make(WeakMap, [[1, 2]]);
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}

const DateSlot: new () => unknown = Date;
const MapSlot: new (entries: [string, number][]) => unknown = Map;
console.log(tag(new DateSlot()), (new MapSlot([["k", 1]]) as Map<unknown, unknown>).get("k"));
