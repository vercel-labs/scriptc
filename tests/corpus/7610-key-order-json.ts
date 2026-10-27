// JSON.stringify of object literals that write the same keys in different
// orders: each value serializes in the order its literal wrote, as in Node.
type Point = { x: number; y: number; label?: string };

const a = { id: 1, name: "a", ok: true };
const b = { name: "b", ok: false, id: 2 };
const c = { ok: true, id: 3, name: "c" };
for (const value of [a, b, c]) console.log(JSON.stringify(value));
console.log(JSON.stringify([a, b, c]));
console.log(JSON.stringify({ first: b, rest: [c, a] }, null, 2));

// Optional keys the literal leaves out, and writes to keys it has.
const p: Point = { y: 2, x: 1 };
const q: Point = { label: "q", x: 3, y: 4 };
const r: Point = { x: 5, y: 6, label: "r" };
q.x = 30;
r.label = "r2";
for (const point of [p, q, r]) console.log(JSON.stringify(point));

// A function typed by one literal's shape receiving the others.
function describe(value: { id: number; name: string; ok: boolean }): string {
  return JSON.stringify(value);
}
console.log(describe(c), describe(a));

// JSON.parse into the same record type keeps each text's own key order.
type Entry = { id: number; name: string; ok: boolean };
for (const text of ['{"ok":true,"name":"p","id":7}', '{"id":8,"name":"q","ok":false}']) {
  const parsed = JSON.parse(text) as Entry;
  console.log(JSON.stringify(parsed), Object.keys(parsed).join(","), describe(parsed));
}
