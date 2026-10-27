// util.inspect, console.log and util.format's %s and %O print a WeakMap or
// WeakSet as Node's formatWeakCollection does: the entries are not
// listed, so the body is "<items unknown>", and past the depth limit the
// value prints as [WeakMap] / [WeakSet]. Nested positions follow the
// usual line breaking.
import { format, inspect } from "node:util";

const cache = new WeakMap<object, number>();
const seen = new WeakSet<object>();
const key = {};
cache.set(key, 1);
seen.add(key);

console.log(cache, seen);
console.log(inspect(cache), inspect(new WeakSet<object>()));
console.log({ cache, seen });
console.log([cache, [seen, [cache]]]);
console.log(inspect({ a: { b: { c: cache } } }), inspect({ a: { b: { c: { d: seen } } } }));
console.log(inspect({ cache }, { depth: 0 }), inspect([seen], { depth: 0 }));
console.log(inspect({ cache }, { depth: null }));
console.log(new Map<string, WeakMap<object, number>>([["k", cache]]));
console.log(new Set<WeakSet<object>>([seen]));
console.log(format("%s|%O", cache, seen), inspect(cache).length);
console.log(cache.has(key), seen.has(key), cache.get(key));
