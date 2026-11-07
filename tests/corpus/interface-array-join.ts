// Coercions and array joins over values of an interface.
interface Named { label(): string; rank: number }
class One implements Named { rank = 1; label(): string { return "one"; } }
class Two implements Named { rank = 2; label(): string { return "two"; } }
function mk(i: number): Named { return i === 0 ? new One() : new Two(); }
const x = mk(0), y = mk(1);
console.log("" + x, "v=" + y, [x, y].join("|"), x < y, x.rank + y.rank);
const sorted = [y, x].sort((p, q) => p.rank - q.rank);
console.log(sorted[0] === x, [x, y].map((n) => n.label()).join(","), Array.from(new Set([x, x, y])).length);
const m = new Map<string, Named>([["a", x]]);
const got = m.get("a");
if (got) console.log(got.label(), got === x);
const w = new WeakMap<Named, number>([[x, 1]]);
console.log(w.get(x), w.has(y));
