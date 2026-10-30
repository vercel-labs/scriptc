// pipeline() over untyped sources in CommonJS: a source that a function
// answers, which may be an array, a generator, a stream, a string, or a
// Buffer, whose bytes are numbers that a byte-mode Writable refuses.
const { pipeline, Readable, Writable } = require("node:stream");

function sink(label) {
  const parts = [];
  return new Writable({
    write(chunk, _enc, cb) {
      parts.push(String(chunk));
      cb();
    },
    final(cb) {
      console.log(label, parts.join("|"));
      cb();
    },
  });
}

function* letters() {
  yield "a";
  yield "b";
}

const sources = [
  () => ["one", "two"],
  () => letters(),
  () => Readable.from(["r1", "r2"]),
  () => "xyz",
  () => Buffer.from("buf"),
];

function run(i) {
  if (i === sources.length) return;
  pipeline(sources[i](), sink(`source ${i}`), (err) => {
    console.log(`source ${i} done`, err === undefined ? "ok" : err.code);
    run(i + 1);
  });
}
run(0);
