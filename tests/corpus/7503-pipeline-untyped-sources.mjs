// pipeline() over untyped iterable sources: arrays, strings, Sets, generator
// objects, async generator objects, class iterables and object values,
// into Writables, a Transform chain, a function stage and the promise form.
// Each source is pumped as Node pumps an iterable, on the same ticks.
import { pipeline, Writable, Transform } from "node:stream";
import { pipeline as pipelineP } from "node:stream/promises";

const log = [];
function show(chunk) {
  return typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : JSON.stringify(chunk);
}
function objectSink(label) {
  return new Writable({
    objectMode: true,
    write(chunk, _enc, cb) {
      log.push(`${label} write ${show(chunk)}`);
      cb();
    },
    final(cb) { log.push(`${label} final`); cb(); },
  });
}
function sink(label, objectMode = false) {
  if (objectMode) return objectSink(label);
  return new Writable({
    write(chunk, _enc, cb) {
      log.push(`${label} write ${typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : JSON.stringify(chunk)}`);
      cb();
    },
    final(cb) { log.push(`${label} final`); cb(); },
  });
}
function* gen() {
  log.push("gen start");
  yield "g1";
  log.push("gen mid");
  yield "g2";
  log.push("gen end");
}
async function* agen() {
  yield "a1";
  await null;
  yield "a2";
}
const sources = {
  array: () => ["x", "y"],
  string: () => "hey",
  set: () => new Set(["s1", "s2"]),
  gen: () => gen(),
  agen: () => agen(),
  iterable: () => ({ *[Symbol.iterator]() { yield "i1"; yield "i2"; } }),
  objects: () => [{ n: 1 }, { n: 2 }],
};
const names = Object.keys(sources);
async function run(name) {
  const src = sources[name]();
  const objectMode = name === "objects";
  await new Promise((resolve) => {
    queueMicrotask(() => log.push(`${name} microtask`));
    pipeline(src, sink(name, objectMode), (err) => {
      log.push(`${name} done ${err ? err.code ?? err.message : err}`);
      resolve(undefined);
    });
    log.push(`${name} after call`);
  });
}
for (const n of names) await run(n);

// a transform chain and a function stage after an untyped source
const src2 = ["p", "q"];
await new Promise((resolve) =>
  pipeline(
    src2,
    new Transform({ transform(c, _e, cb) { cb(null, c.toString().toUpperCase()); } }),
    sink("transform"),
    (err) => { log.push(`transform done ${err}`); resolve(undefined); },
  ),
);
const src3 = new Set(["f1", "f2"]);
await new Promise((resolve) =>
  pipeline(
    src3,
    async function* (source) { for await (const c of source) yield c + "!"; },
    sink("fnstage"),
    (err) => { log.push(`fnstage done ${err}`); resolve(undefined); },
  ),
);
// promises form
const src4 = ["m", "n"];
await pipelineP(src4, sink("promises"));
log.push("promises resolved");
// an error thrown by the source
function* bad() { yield "ok"; throw new Error("source failed"); }
const src5 = bad();
await new Promise((resolve) =>
  pipeline(src5, sink("bad"), (err) => { log.push(`bad done ${err && err.message}`); resolve(undefined); }),
);
// a source of non-string values into a byte-mode writable
const src6 = [1, 2];
await new Promise((resolve) =>
  pipeline(src6, sink("numbers"), (err) => { log.push(`numbers done ${err && err.code}`); resolve(undefined); }),
);
console.log(log.join("\n"));
