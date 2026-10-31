// A CommonJS helper that passes its untyped parameters to pipeline(): the
// same call runs over streams, function stages and iterables, whichever
// each argument is at run time.
const { pipeline, Transform, Writable, Readable } = require("node:stream");

function run(label, source, middle, destination) {
  return new Promise((resolve) => {
    pipeline(source, middle, destination, (err, value) => {
      console.log(label, "done", err ? err.code || err.message : err, value);
      resolve(undefined);
    });
  });
}
function sink(label) {
  return new Writable({
    objectMode: true,
    write(chunk, _enc, cb) {
      console.log(label, "write", String(chunk));
      cb();
    },
  });
}
const double = new Transform({
  objectMode: true,
  transform(chunk, _enc, cb) {
    cb(null, String(chunk) + String(chunk));
  },
});
async function* exclaim(source) {
  for await (const chunk of source) yield `${chunk}!`;
}
async function count(source) {
  let n = 0;
  for await (const _ of source) n++;
  return n;
}

(async () => {
  await run("streams", Readable.from(["a", "b"]), double, sink("streams"));
  await run("function middle", Readable.from(["c"]), exclaim, sink("function middle"));
  await run("function ends", () => ["d", "e", "f"], exclaim, count);
  await run("iterable middle", Readable.from(["skipped"]), ["g"], sink("iterable middle"));
  await run("generator into stream", ["h"], exclaim, new Transform({
    objectMode: true,
    transform(chunk, _enc, cb) {
      console.log("transform saw", chunk);
      cb(null, chunk);
    },
  }).on("data", (d) => console.log("data", d)));
})();
