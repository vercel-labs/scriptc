// Option values known only at run time in JavaScript: decodeStrings and
// defaultEncoding read from an object, a write callback whose chunk is
// then a string, decodeStrings: 0 (only false turns decoding off), a
// defaultEncoding that is not a string, and a _construct assigned after
// construction, which Node's constructor never reads.
import { Writable, Readable } from "node:stream";
const opts = { decode: false, enc: "base64" };
const w = new Writable({
  decodeStrings: opts.decode,
  defaultEncoding: opts.enc,
  write(c, e, cb) { console.log("js", typeof c, e, String(c)); cb(); },
});
w.write("aGk=");
try { new Writable({ defaultEncoding: 5 }); } catch (e) { console.log("bad", e.code, e.message); }
const zero = new Writable({ decodeStrings: 0, write(c, e, cb) { console.log("zero", Buffer.isBuffer(c), e); cb(); } });
zero.write("z");
const late = new Writable({ write(chunk, enc, cb) { console.log("write", chunk.toString()); cb(); } });
let ran = false;
late._construct = (cb) => { ran = true; cb(); };
late.write("a");
late.end(() => console.log("ended, construct ran:", ran));
const r = new Readable({ read() {} });
const order = [];
(order.push("receiver"), r)._construct = (order.push("value"), function (cb) { console.log("never"); cb(); });
console.log(order.join(","));
r.push("x");
r.push(null);
r.on("data", (d) => console.log("data", d.toString()));
