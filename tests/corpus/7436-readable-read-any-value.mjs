// readable.read() answers any value on an object-mode stream, and a
// Buffer or a string (with an encoding) in byte mode.
import { Readable, PassThrough } from "node:stream";
const r = new Readable({ objectMode: true, read() {} });
r.push({ a: 1 }); r.push(2); r.push("three"); r.push([4]); r.push(null);
r.once("readable", () => { let v; while ((v = r.read()) !== null) console.log("read", JSON.stringify(v)); });
const p = new PassThrough({ objectMode: true });
p.write([1, 2]);
p.end();
p.once("readable", () => console.log("pt", JSON.stringify(p.read()), p.read()));
const b = new PassThrough();
b.end("bytes!");
b.once("readable", () => { const c = b.read(3); console.log("bytes", Buffer.isBuffer(c), String(c), String(b.read())); });
const e = new PassThrough();
e.setEncoding("utf8");
e.end("text");
e.once("readable", () => { const t = e.read(); console.log("encoded", typeof t, t); });
