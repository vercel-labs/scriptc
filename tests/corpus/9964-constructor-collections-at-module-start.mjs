// JavaScript: a Set, a list and rows of constructors built by a module's own
// top-level code. Each line is one use of such a collection: membership,
// size, iteration, copies, writes, identity through a helper, and the
// collections handed on as plain values.
const known = new Set([Number, String]);
const order = [Number, String, Boolean];
const rows = [
  { label: "id", cast: Number },
  { label: "name", cast: String },
];

function describe(value) {
  return typeof value === "function" ? value.name + "/" + (value === globalThis[value.name]) : typeof value;
}

console.log(known.has(String), known.has(Boolean), known.size);
console.log([...known].map((f) => f.name).join(","));
const seen = [];
known.forEach((f) => seen.push(f.name));
for (const f of known) seen.push(f.name + ":" + String(f("1")));
console.log(seen.join(" "));
known.add(Boolean);
known.delete(Number);
console.log(known.size, known.has(Boolean), known.has(Number));
console.log(Array.from(known).length, new Set(known).has(String), typeof known, Array.isArray(known));
console.log([...known].map(describe).join(" "));
const holder = new Map();
holder.set(known, "hit");
console.log(holder.get(known), holder.size);

console.log(order.includes(String), order.indexOf(Boolean), order.find((f) => f === String) === String);
console.log(order.map((f) => f.name + ":" + String(f("1"))).join(" "));
console.log(["7"].map(order[1]).join(","), order.length, order[0] === Number);
const copy = [...order].reverse();
console.log(copy.length, copy[0] === Boolean, order.slice(1)[0] === String, order.concat([String]).length);
console.log(JSON.stringify({ c: order[1], n: 1 }), JSON.stringify([order[1], 1]), JSON.stringify(order));
console.log(order[1]?.("42"), "name" in order[1], Object.keys(order[1]).length);

console.log(rows.map((r) => r.label + ":" + r.cast.name + ":" + String(r.cast("1"))).join(" "));
console.log(rows.find((r) => r.cast === String)?.label, JSON.stringify(rows[1]), JSON.stringify({ c: rows[1].cast, n: 1 }));
console.log(rows.map((r) => describe(r.cast)).join(" "));
