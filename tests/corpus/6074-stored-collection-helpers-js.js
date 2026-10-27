// The JavaScript form: iterator helper objects over Map and Set iterators
// that are stored and consumed later: the helpers observe the collection live, and abandoned
// or returned helpers leave it usable.
const set = new Set([1, 2, 3]);
const doubled = set.values().map((x) => x * 2);
set.add(4);
set.delete(1);
console.log(doubled.next(), [...doubled]);

const map = new Map                ([
  ["a", 1],
  ["b", 2],
  ["c", 3],
]);
const large = map.entries().filter(([, v]) => v > 1);
map.set("d", 4);
map.delete("b");
console.log([...large].map(([k, v]) => `${k}=${v}`).join(" "));
const keys = map.keys().map((k, i) => k.toUpperCase() + i);
console.log(keys.next(), keys.return(), keys.next());
const rest = map.values().drop(2);
for (const v of rest) console.log("value", v);
const firstTwo = map.keys().take(2);
console.log([...firstTwo], [...firstTwo]);

// A stage on a stage, and Iterator.from over a Set and a Map.
const chained = set.values().filter((x) => x % 2 === 0).map((x) => `n${x}`);
console.log(chained.toArray());
const fromSet = Iterator.from(set).map((x) => x + 0.5);
set.add(9);
console.log([...fromSet]);
console.log(Iterator.from(map).map(([k, v]) => k + v).toArray());

// A helper left mid-walk does not stop later changes or walks.
const abandoned = set.values().map((x) => x);
abandoned.next();
for (let i = 0; i < 100; i++) {
  set.add(100 + i);
  set.delete(100 + i);
}
console.log(set.size, set.values().take(3).toArray(), [...set].length);
const returned = map.values().map((v) => v * 10);
returned.next();
returned.return();
for (let i = 0; i < 50; i++) map.set(`t${i}`, i);
for (let i = 0; i < 50; i++) map.delete(`t${i}`);
console.log(map.size, [...map.keys()].join(","));

// Records and strings as elements.

const rows = new Map             ([
  [1, { id: 1, tag: "x" }],
  [2, { id: 2, tag: "y" }],
]);
const tags = rows.values().map((r) => r.tag.repeat(r.id));
rows.set(3, { id: 3, tag: "z" });
console.log([...tags], rows.entries().find(([, r]) => r.tag === "y")?.[0]);
