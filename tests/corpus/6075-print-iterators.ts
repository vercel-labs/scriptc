// util.inspect and Object.prototype.toString of iterator objects: generators,
// array, typed array and string iterators and iterator helpers print as
// Object [<tag>] {}, and Map and Set iterators print the entries they have
// left.
import { inspect } from "node:util";
function* g(): Generator<number> { yield 1; }
const s = new Set([1, 2, 3]);
const m = new Map<string, number>([["a", 1], ["b", 2]]);
const si = s.values(); si.next();
console.log(g(), [1, 2].values(), "ab"[Symbol.iterator](), new Uint8Array([1]).values());
console.log(s.values(), s.entries(), m.keys(), m.values(), m.entries(), si);
console.log([1].values().map((x) => x), Iterator.from([1]), g().filter(() => true));
console.log(inspect({ a: { b: { c: s.values(), d: g() } } }));
console.log(Object.prototype.toString.call(g()), Object.prototype.toString.call([1].values().map((x) => x)), Object.prototype.toString.call(m.keys()));
const done = s.values(); Array.from(done);
console.log(done, new Map<string, number>().entries(), g());
const keyed = new Map<{ x: number }, number[]>([[{ x: 1 }, [1, 2]]]);
console.log(keyed.entries(), keyed.keys());
console.log(new Set(Array.from({ length: 120 }, (_, i) => i)).values());
