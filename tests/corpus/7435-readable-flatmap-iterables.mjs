// flatMap over what the callback returns: async and sync generators, a
// Set, a Map, a Readable, and a value that is not iterable (V8's
// TypeError); the generator's steps interleave with process.nextTick as
// in Node, breaking out of the loop runs the inner generator's finally,
// and an inner throw rejects toArray().
import { Readable } from "node:stream";
const log = [];
log.push(JSON.stringify(await Readable.from(["x"]).flatMap(async function* (s) { yield s; yield s + s; }).toArray()));
log.push(JSON.stringify(await Readable.from([2]).flatMap(function* (n) { yield n; yield -n; }).toArray()));
log.push(JSON.stringify(await Readable.from([1, 2]).flatMap((n) => new Set([n, n])).toArray()));
log.push(JSON.stringify(await Readable.from(["p"]).flatMap((s) => Readable.from([s, s.toUpperCase()])).toArray()));
log.push(JSON.stringify(await Readable.from([3]).flatMap((n) => new Map([[n, "v"]])).toArray()));
log.push(JSON.stringify(await Readable.from([{ k: 1 }]).flatMap((o) => [o, { k: o.k + 1 }]).toArray()));
try { await Readable.from([1]).flatMap(() => 5).toArray(); } catch (e) { log.push(`${e.name} ${e.message}`); }
try { await Readable.from([1]).flatMap(() => null).toArray(); } catch (e) { log.push(`${e.name} ${e.message}`); }
const order = [];
let n = 0;
const tick = () => { order.push(`t${n}`); if (++n < 5) process.nextTick(tick); };
process.nextTick(tick);
for await (const v of Readable.from([1]).flatMap(async function* (k) { order.push("gen start"); yield k; order.push("gen mid"); yield k + 1; })) order.push(`v${v}`);
log.push(order.join(" "));
const closed = [];
const early = Readable.from([1, 2]).flatMap(async function* (k) { try { yield k; yield k * 10; } finally { closed.push(`finally ${k}`); } });
for await (const v of early) { closed.push(`got ${v}`); break; }
log.push(closed.join(" "));
const thrown = [];
try { await Readable.from([1]).flatMap(async function* () { yield 1; throw new Error("inner boom"); }).toArray(); } catch (e) { thrown.push(e.message); }
log.push(thrown.join(" "));
console.log(log.join("\n"));
