// Number-keyed Maps and Sets with two to four small integer keys use the
// direct index. Results must match Node through overwrites, deletes and
// re-adds, a fractional, negative or large key that moves the map to
// hashing, clear, and mutation during a for-of or forEach walk.

const hist = new Map<number, number>();
const codes = [0, 3, 1, 3, 2, 0, 3, 3, 1];
for (const c of codes) hist.set(c, (hist.get(c) ?? 0) + 1);
console.log([...hist].map(([k, v]) => `${k}:${v}`).join(" "), hist.size, hist.has(4), hist.get(-0));

// Delete and re-add: the re-added key moves to the end.
hist.delete(3);
hist.set(3, 9);
hist.delete(0);
console.log([...hist.keys()].join(","), hist.get(3), hist.has(0));

// A key the direct index cannot hold moves the map to hashing.
for (const odd of [0.5, -1, 2 ** 40]) {
  const m = new Map<number, string>([
    [1, "a"],
    [2, "b"],
  ]);
  m.set(odd, "c");
  m.set(1, "A");
  console.log([...m].map(([k, v]) => `${k}=${v}`).join(" "), m.get(2), m.get(odd), m.size);
}

// Two keys, then clear, then reuse.
const pair = new Map<number, number>();
pair.set(5, 50);
pair.set(7, 70);
pair.clear();
pair.set(7, 1);
pair.set(1, 2);
console.log([...pair].map(([k, v]) => `${k}=${v}`).join(" "), pair.size);

// A walk that deletes ahead and adds keys.
const walk = new Map<number, number>([
  [0, 0],
  [1, 10],
  [2, 20],
]);
const seen: number[] = [];
for (const [k, v] of walk) {
  seen.push(v);
  if (k === 0) {
    walk.delete(2);
    walk.set(3, 30);
  }
  if (k === 3) walk.set(0, -1);
}
console.log(seen.join(","), [...walk].map(([k, v]) => `${k}=${v}`).join(" "));

// Sets of small integers, forEach with deletion and addition.
const set = new Set<number>([2, 0]);
set.add(1);
set.add(2);
const order: number[] = [];
set.forEach((v) => {
  order.push(v);
  if (v === 2) {
    set.delete(1);
    set.add(3);
  }
});
console.log(order.join(","), [...set].join(","), set.has(1), set.size);

// Many small maps, each with a few keys.
let total = 0;
for (let i = 0; i < 1000; i++) {
  const m = new Map<number, number>();
  m.set(i % 3, i);
  m.set((i + 1) % 3, 1);
  if (i % 5 === 0) m.delete(i % 3);
  total += (m.get(i % 3) ?? 100) + (m.get((i + 1) % 3) ?? 0) + m.size;
}
console.log(total);
