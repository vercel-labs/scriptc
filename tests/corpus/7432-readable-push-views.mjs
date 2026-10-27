// readable.push() in byte mode turns a Uint8Array or another typed array
// into a Buffer over the same bytes (Stream._uint8ArrayToBuffer); the
// pushed array itself is left as it was.
import { Readable } from "node:stream";
const u = new Uint8Array([100, 101]);
const r = new Readable({ read() {} });
r.push(u); r.push(new Uint16Array([0x6766])); r.push(null);
for await (const b of r) console.log(Buffer.isBuffer(b), b.toString(), b.length);
console.log("source still", Buffer.isBuffer(u));
const r1 = new Readable({ read() {} });
r1.push(new Uint8Array([97, 98]));
r1.push(null);
for await (const b of r1) console.log(Buffer.isBuffer(b), b.toString());
const r2 = new Readable({ read() {} });
r2.on("data", (b) => console.log("data", Buffer.isBuffer(b), b.toString()));
r2.push(new Uint8Array([99])); r2.push(null);
