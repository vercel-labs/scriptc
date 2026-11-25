// structuredClone of a Set and a Map that hold a unit key, alone and
// inside an object; the clone is read through its type and printed.
const s = new Set<string | null>(["a", null, "b"]);
const m = new Map<string | null | undefined, number>();
m.set(null, 1);
m.set(undefined, 2);
m.set("k", 3);

const sc = structuredClone(s);
console.log(sc !== s, sc.size, sc.has(null), sc.has("a"), sc.has("c"));
for (const v of sc) console.log(v === null ? "<null>" : v);
console.log(sc);

const mc = structuredClone(m);
console.log(mc !== m, mc.size, mc.get(null), mc.get(undefined), mc.get("k"));
for (const [k, v] of mc) console.log(k === null ? "<null>" : k === undefined ? "<undefined>" : k, v);
console.log(mc);

const boxed = structuredClone({ keys: s, table: m });
console.log(boxed.keys.has(null), boxed.table.get(undefined));
console.log(boxed);

const dyn: unknown = structuredClone(s as unknown);
console.log(dyn);
if (dyn instanceof Set) console.log(dyn.has(null), dyn.size);
