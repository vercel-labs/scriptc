// The checked-dynamic stream lane: constructor-function streams
// (Readable.call(this, opts) + util.inherits) whose methods dispatch
// through the runtime's dynamic member table. Every method argument is an
// untyped value, so setEncoding's names and errors, unshift's forms and
// answers, write's argument shifting, setDefaultEncoding and end's forms
// all resolve at run time, and readableEncoding is read back.
const { Readable, Writable, Duplex } = require("stream");
const util = require("util");

function report(fn) {
  try {
    return fn();
  } catch (e) {
    return "THROW " + e.code + " | " + e.message;
  }
}

// ── setEncoding on a constructor-function readable ───────────────────────
function Source(opts) {
  Readable.call(this, opts || {});
}
util.inherits(Source, Readable);
Source.prototype._read = function () {};

for (const v of [null, undefined, "", "UTF8", "hex", "HEX"]) {
  const r = new Source();
  const ret = r.setEncoding(v);
  console.log("se", String(v), ret === r, JSON.stringify(r.readableEncoding));
  r.push(Buffer.from("hi there"));
  console.log("se-read", String(v), JSON.stringify(r.read()));
}
for (const v of ["nope", 5, true, Buffer.alloc(0)]) {
  const r = new Source();
  console.log("se-bad", String(v), report(() => r.setEncoding(v) === r));
}
{
  const r = new Source();
  console.log("se-obj", report(() => r.setEncoding({})));
  const r2 = new Source();
  console.log("se-arr", report(() => r2.setEncoding([1])));
}

// ── unshift forms ────────────────────────────────────────────────────────
{
  const r = new Source();
  console.log("u1", r.unshift("ab"), String(r.read()));
  console.log("u2", r.unshift(Buffer.from("cd")), String(r.read()));
  console.log("u3", r.unshift(undefined), r.readableLength);
  console.log("u4", r.unshift(""), r.readableLength);
  console.log("u5", r.unshift("6162", "hex"), String(r.read()));
  console.log("u6", report(() => r.unshift("zz", "nope")));
  const r2 = new Source({ defaultEncoding: "hex" });
  console.log("u7", String(r2.unshift("6162")), String(r2.read()));
  const r3 = new Source();
  r3.setEncoding("hex");
  console.log("u8", String(r3.unshift("zz")), String(r3.read()));
  const r4 = new Source();
  r4.push("abc");
  console.log("u9", r4.unshift(null), r4.readableLength, String(r4.read()));
  const o = new Source({ objectMode: true });
  console.log("u10", o.unshift(5), JSON.stringify(o.read()));
  const o2 = new Source({ objectMode: true });
  o2.push(1);
  console.log("u11", o2.unshift(null), o2.readableLength);
  const r5 = new Source();
  r5.on("error", (e) => console.log("u12-error", e.code));
  r5.push("x");
  r5.push(null);
  console.log("u12", r5.unshift("late"));
  const r6 = new Source();
  console.log("u13", r6.unshift("x", 5), String(r6.read()));
}

// ── write and end forms ──────────────────────────────────────────────────
function Sink(opts) {
  Writable.call(this, opts || {});
}
util.inherits(Sink, Writable);
Sink.prototype._write = function (chunk, enc, cb) {
  console.log("write", typeof chunk, String(chunk), enc);
  cb();
};

setTimeout(() => {
  const w = new Sink();
  w.on("finish", () => console.log("finish"));
  console.log("w1", w.write("hi"));
  console.log("w2", w.write("6869", "hex", (err) => console.log("w-cb", err)));
  console.log("w3", w.write("yo", (err) => console.log("w-cb2", err)));
  console.log("sde", w.setDefaultEncoding("HEX") === w);
  const w2 = new Sink();
  w2.on("error", (e) => console.log("w-err", e.code));
  w2.on("close", () => console.log("w-close"));
  w2.destroy(new Error("boom"));
  console.log("w4", w2.write("x", (e) => console.log("w-after-destroy-cb", e && e.code)));
}, 5);

setTimeout(() => {
  const forms = [
    ["none", (w) => w.end()],
    ["chunk", (w) => w.end("a")],
    ["chunk-enc", (w) => w.end("61", "hex")],
    ["cb", (w) => w.end(() => console.log("e-cb"))],
    ["chunk-cb", (w) => w.end("b", () => console.log("e-chunk-cb"))],
    ["chunk-enc-cb", (w) => w.end("62", "hex", () => console.log("e-chunk-enc-cb"))],
  ];
  for (const [name, fn] of forms) {
    const w = new Sink();
    w.on("finish", () => console.log("e-finish", name));
    fn(w);
  }
  const w2 = new Sink({ objectMode: true });
  w2.on("finish", () => console.log("e-object-finish"));
  w2.end({ a: 1 });
  const bad = new Sink();
  bad.on("error", (e) => console.log("e-bad", e.code));
  console.log("e-bad-ret", report(() => bad.end("x", "nope")));
}, 20);

function Pipe(opts) {
  Duplex.call(this, opts || {});
}
util.inherits(Pipe, Duplex);
Pipe.prototype._read = function () {};
Pipe.prototype._write = function (chunk, enc, cb) {
  console.log("d-write", String(chunk));
  cb();
};
setTimeout(() => {
  const d = new Pipe();
  d.on("finish", () => console.log("d-finish"));
  d.end("tail");
}, 40);
