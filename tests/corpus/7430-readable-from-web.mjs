// Readable.fromWeb: a Readable over a web ReadableStream's reader, in
// byte mode by default (Uint8Array chunks arrive as Buffers), in object
// mode, and with an encoding; an early destroy cancels the stream with
// null, and an error from the stream destroys the Readable. Duplex.from
// and compose() over a lone web ReadableStream read it the same way.
import { Duplex, Readable, compose } from "node:stream";
const log = [];
const tick = (n) => { if (n < 6) { log.push(`tick ${n}`); process.nextTick(() => tick(n + 1)); } };
const web = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("ab")); c.enqueue(new TextEncoder().encode("cd")); c.close(); } });
const r = Readable.fromWeb(web);
log.push(`r ${r.readableObjectMode} ${r.readableHighWaterMark}`);
r.on("data", (b) => log.push(`data ${Buffer.isBuffer(b)} ${b.toString()}`));
r.on("end", () => log.push("end"));
r.on("close", () => log.push("close"));
tick(0);
await new Promise((res) => r.on("close", res));
const words = new ReadableStream({ start(c) { c.enqueue("x"); c.enqueue("y"); c.close(); } });
const o = Readable.fromWeb(words, { objectMode: true, highWaterMark: 1 });
for await (const v of o) log.push(`obj ${v}`);
const text = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("héllo")); c.close(); } });
const t = Readable.fromWeb(text, { encoding: "utf8" });
for await (const v of t) log.push(`text ${typeof v} ${v}`);
let m = 0;
const endless = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array([++m])); }, cancel(reason) { log.push(`cancel ${reason && reason.name}`); } });
const e = Readable.fromWeb(endless);
e.once("data", (b) => { log.push(`endless ${b[0]}`); e.destroy(); });
e.on("close", () => log.push("endless close"));
await new Promise((res) => e.on("close", res));
await new Promise((res) => setTimeout(res, 5));
const failing = new ReadableStream({ start(c) { c.error(new Error("web broke")); } });
const f = Readable.fromWeb(failing);
f.on("error", (err) => log.push(`failing error ${err.message}`));
f.on("close", () => log.push("failing close"));
f.resume();
await new Promise((res) => f.on("close", res));
const d = Duplex.from(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("dx")); c.close(); } }));
log.push(`d ${d.readable} ${d.writable} ${d.readableObjectMode}`);
d.on("data", (b) => log.push(`d data ${b.toString()}`));
await new Promise((res) => d.on("close", res));
const one = compose(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("one")); c.close(); } }));
for await (const b of one) log.push(`one ${b.toString()}`);
console.log(log.join("\n"));
