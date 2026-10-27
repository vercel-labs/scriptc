// Object-mode streams through dynamic values: options objects held in
// variables, constructor functions with util.inherits (Transform.call
// and Writable.call with objectMode), streams passed around as plain
// values, and Readable.from over values of mixed types.
const stream = require("stream");
const util = require("util");

const show = (v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : `${typeof v}:${String(v)}`);

function Tagger(tag) {
  stream.Transform.call(this, { objectMode: true });
  this.tag = tag;
}
util.inherits(Tagger, stream.Transform);
Tagger.prototype._transform = function (chunk, enc, cb) {
  console.log("tagger enc:", enc);
  if (chunk === 3) return cb();
  cb(null, { tag: this.tag, value: chunk });
};
Tagger.prototype._flush = function (cb) {
  this.push({ tag: this.tag, value: "flushed" });
  cb();
};

function Collector() {
  stream.Writable.call(this, { objectMode: true, highWaterMark: 2 });
  this.items = [];
}
util.inherits(Collector, stream.Writable);
Collector.prototype._write = function (chunk, enc, cb) {
  this.items.push(show(chunk));
  cb();
};

function viaConstructors(next) {
  const t = new Tagger("x");
  const c = new Collector();
  console.log("modes:", t.readableObjectMode, t.writableObjectMode, c.writableObjectMode, c.writableHighWaterMark);
  t.pipe(c);
  c.on("finish", () => {
    console.log("collected:", c.items.join(" "));
    next();
  });
  t.write(1);
  t.write("two", () => console.log("write cb"));
  t.write(3);
  t.end({ four: 4 });
}

function viaOptionObjects(next) {
  const readableOpts = { objectMode: true, read() {} };
  const r = new stream.Readable(readableOpts);
  const transformOpts = {
    objectMode: true,
    transform(chunk, enc, cb) {
      cb(null, Array.isArray(chunk) ? chunk.length : chunk);
    },
  };
  const t = new stream.Transform(transformOpts);
  const seen = [];
  const writableOpts = {
    objectMode: true,
    write(chunk, enc, cb) {
      seen.push(show(chunk) + "/" + enc);
      cb();
    },
  };
  const w = new stream.Writable(writableOpts);
  stream.pipeline(r, t, w, (err) => {
    console.log("option objects:", err === undefined ? "ok" : err, seen.join(" "));
    next();
  });
  r.push([1, 2, 3]);
  r.push(false);
  r.push({ k: "v" });
  r.push(null);
}

async function viaFrom() {
  const values = [0, "s", undefined, [1], { a: { b: 2 } }, 1.5];
  const out = [];
  for await (const v of stream.Readable.from(values)) out.push(show(v));
  console.log("from:", out.join(" "));
  const pt = new stream.PassThrough({ objectMode: true });
  const passAlong = (s, v) => s.write(v);
  passAlong(pt, { through: true });
  passAlong(pt, 7);
  pt.end();
  pt.on("data", (v) => console.log("passed:", show(v)));
  await new Promise((resolve) => pt.on("end", resolve));
}

viaConstructors(() => viaOptionObjects(() => viaFrom()));
