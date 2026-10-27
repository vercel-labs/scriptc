// `new` through stored builtin constructors in JavaScript.
const table = [Date, Map, Set, Object, WeakMap, WeakSet];
for (const C of table) {
  const value = new C();
  console.log(C.name, typeof value, Object.prototype.toString.call(value), value.constructor === C);
}
const Ctor = table[0];
console.log(new Ctor(86400000).toISOString(), new Ctor(2024, 0, 31).getDate());
const MapCtor = table[1];
const map = new MapCtor(Object.entries({ a: 1, b: 2 }));
map.set("c", 3);
console.log(map.size, map.get("a"), [...map.entries()].length);
const SetCtor = table[2];
console.log(new SetCtor([...map.keys()]).size, new SetCtor([NaN, NaN, 0, -0]).size);
const named = { Date, Map, Set };
console.log(named.Date === Date, named.Map === table[1], named.Set === table[2]);
