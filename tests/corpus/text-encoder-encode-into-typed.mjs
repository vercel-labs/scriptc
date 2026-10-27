// TextEncoder.encodeInto with a typed string and view, a view that may be
// null, partial writes and subarray destinations.
const enc = new TextEncoder();
const view = new Uint8Array(8);
const r = enc.encodeInto("héllo wörld", view);
console.log(r.read, r.written, Array.from(view).join(","));
let maybe = Math.random() > 2 ? view : null;
try { enc.encodeInto("x", maybe); } catch (e) { console.log(e.constructor.name, e.code); }
maybe = new Uint8Array(3);
const r2 = enc.encodeInto("😀ab", maybe);
console.log(r2.read, r2.written, Array.from(maybe).join(","));
const sub = view.subarray(2);
const r3 = enc.encodeInto("zz", sub);
console.log(r3.read, r3.written, Array.from(view).join(","), JSON.stringify(r3));
