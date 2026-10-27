// URLSearchParams iterators in a checked-dynamic program: next() results,
// live iteration after append and delete, and the consumers (spread,
// Array.from with and without a mapper, Object.fromEntries, new Map) over
// the params and each projection.
const sp = new URLSearchParams("b=2&a=1&a=3");
const it = sp.keys();
console.log(it.next());
sp.append("c", "4");
console.log(JSON.stringify([...it]), it.next());
console.log(JSON.stringify([...sp.values()]), JSON.stringify(Array.from(sp.entries())));
console.log(JSON.stringify(Array.from(sp.keys(), (k) => k.toUpperCase())));
console.log(JSON.stringify(Object.fromEntries(sp.entries())), JSON.stringify(Object.fromEntries(sp)));
console.log(JSON.stringify([...new Map(sp.entries())]), new Map(sp).size);
const values = sp.values();
const seen = [];
let step = values.next();
while (!step.done) {
  seen.push(step.value);
  if (step.value === "2") sp.delete("a");
  step = values.next();
}
console.log(JSON.stringify(seen), sp.toString());
