// URLSearchParams keys(), values() and entries() outside a for-of head:
// a stored iterator steps with next() ({ value, done }), spreads from its
// current position, and walks the live pair list by index, so pairs
// appended after it was created are visited. Spreads, Array.from, Object.fromEntries and
// new Map over the params or their iterators read the same pairs.
const sp = new URLSearchParams("b=2&a=1&a=3&c=%20x");

const keys = sp.keys();
console.log(JSON.stringify(keys.next()), JSON.stringify(keys.next()));
sp.append("d", "4");
console.log(JSON.stringify([...keys]));
console.log(JSON.stringify(keys.next()));

console.log(JSON.stringify([...sp]));
console.log(JSON.stringify([...sp.keys()]));
console.log(JSON.stringify([...sp.values()]));
console.log(JSON.stringify([...sp.entries()]));
console.log(JSON.stringify(Array.from(sp)));
console.log(JSON.stringify(Array.from(sp.entries())));
console.log(JSON.stringify(Array.from(sp.values())));
console.log(JSON.stringify(Object.fromEntries(sp)));
console.log(JSON.stringify(Object.fromEntries(sp.entries())));
console.log(JSON.stringify([...new Map(sp)]));
console.log(JSON.stringify([...new Map(sp.entries())]));

const values = sp.values();
const seen: string[] = [];
for (const v of values) {
  seen.push(v);
  if (v === "1") sp.delete("b");
}
console.log(JSON.stringify(seen), sp.toString());

const entries = new URL("https://h.example/p?x=1&y=2&x=3").searchParams.entries();
const pairs: string[] = [];
for (const [k, v] of entries) pairs.push(`${k}:${v}`);
console.log(pairs.join(" "));

const empty = new URLSearchParams().entries();
console.log(JSON.stringify(empty.next()), JSON.stringify([...empty]));
