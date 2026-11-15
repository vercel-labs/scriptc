// A Set and a Map that hold a unit key beside ordinary strings, printed by
// console.log and util.inspect: alone, inside an object, inside an array.
import { inspect } from "node:util";

const s = new Set<string | null>(["a", null, "b"]);
const m = new Map<string | null, number>([
  ["a", 1],
  [null, 2],
]);
const u = new Set<string | undefined>();
u.add(undefined);
u.add("x");
const t = new Map<string | null | undefined, string>();
t.set(null, "n");
t.set(undefined, "u");
t.set("k", "v");

console.log(s);
console.log(m);
console.log(u);
console.log(t);
console.log(inspect(s));
console.log(inspect(m));
console.log(inspect(u));
console.log(inspect(t));
console.log({ s, m });
console.log([u, t]);
console.log("set:", s, "map:", m);
console.log(s.size, m.size, u.size, t.size);
