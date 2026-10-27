// Duplex.from over a promise: a Duplex that is not writable and reads the
// promise's value once it settles (nothing for null), then ends; a
// rejection destroys it with the reason. The events interleave with
// microtasks and nextTick callbacks as in Node.
import { Duplex } from "node:stream";
const log = [];
const tick = (n) => { if (n < 5) { log.push(`tick ${n}`); process.nextTick(() => tick(n + 1)); } };
const later = (v, ms) => new Promise((res) => setTimeout(() => res(v), ms));
const a = Duplex.from(Promise.resolve({ answer: 42 }));
log.push(`a ${a.readable} ${a.writable} ${a.readableObjectMode}`);
a.on("data", (v) => log.push(`a data ${JSON.stringify(v)}`));
a.on("end", () => log.push("a end"));
a.on("close", () => log.push("a close"));
Promise.resolve().then(() => log.push("microtask 1")).then(() => log.push("microtask 2"));
tick(0);
await new Promise((res) => a.on("close", res));
const b = Duplex.from(later(null, 1));
b.on("data", () => log.push("b data"));
b.on("end", () => log.push("b end"));
await new Promise((res) => b.on("close", res));
const c = Duplex.from(Promise.reject(new Error("nope")));
c.on("error", (e) => log.push(`c error ${e.message}`));
c.on("close", () => log.push(`c close ${c.destroyed}`));
await new Promise((res) => c.on("close", res));
const d = Duplex.from(later("text", 1));
for await (const v of d) log.push(`d ${v}`);
console.log(log.join("\n"));
