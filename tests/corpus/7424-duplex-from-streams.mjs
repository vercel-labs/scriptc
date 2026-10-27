// Duplex.from over a lone Readable, a lone Writable and a { readable,
// writable } pair, as duplexify.js's _duplexify wraps them: the Duplex
// reads through the Readable and writes through the Writable, takes each
// side's object mode from the stream behind it, and closes once both ends
// finish; destroying it without an error destroys the streams behind it.
import { Duplex, PassThrough, Readable, Writable } from "node:stream";
const log = [];
const r = Readable.from(["a", "b"]);
const dr = Duplex.from(r);
log.push(`dr ${dr.readable} ${dr.writable} ${dr.readableObjectMode} ${dr.writableObjectMode}`);
dr.on("end", () => log.push("dr end"));
dr.on("close", () => log.push("dr close"));
for await (const c of dr) log.push(`dr ${c}`);
const got = [];
const w = new Writable({ write(c, e, cb) { got.push(String(c)); log.push(`w write ${c}`); cb(); } });
const dw = Duplex.from(w);
log.push(`dw ${dw.readable} ${dw.writable} ${dw.writableObjectMode}`);
dw.on("finish", () => log.push("dw finish"));
dw.on("close", () => log.push("dw close"));
dw.write("x", () => log.push("dw cb x"));
dw.end("y", () => log.push("dw end cb"));
await new Promise((res) => dw.on("close", res));
const inner = new PassThrough({ objectMode: true });
const out = new PassThrough({ objectMode: true });
const pair = Duplex.from({ readable: out, writable: inner });
log.push(`pair ${pair.readable} ${pair.writable} ${pair.readableObjectMode} ${pair.writableObjectMode}`);
inner.on("data", (v) => { log.push(`inner ${JSON.stringify(v)}`); out.write({ echo: v }); });
inner.on("finish", () => { log.push("inner finish"); out.end(); });
pair.on("data", (v) => log.push(`pair data ${JSON.stringify(v)}`));
pair.write({ n: 1 });
pair.end({ n: 2 });
await new Promise((res) => pair.on("close", res));
log.push("pair closed");
const killed = Duplex.from(new PassThrough());
killed.on("error", (e) => log.push(`killed error ${e.name}`));
killed.on("close", () => log.push(`killed close ${killed.destroyed}`));
killed.destroy();
await new Promise((res) => setTimeout(res, 5));
// The pair's members are evaluated in source order; a pair still open at
// exit is left as it is.
const order = [];
const open = Duplex.from({
  writable: (order.push("writable"), new Writable({ write(c, e, cb) { cb(); } })),
  readable: (order.push("readable"), Readable.from(["x"])),
});
log.push(`pair order ${order.join(",")} ${open.readable} ${open.writable}`);
console.log(log.join("\n"));
