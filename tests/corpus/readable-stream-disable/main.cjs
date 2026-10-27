// readable-stream 2.x compiles as Node's builtin stream module: the
// package's own READABLE_STREAM=disable behavior, which this program
// selects before its first require so Node takes the same branch. (Run
// without the variable, Node loads the package's JavaScript streams, whose
// output can differ: class identity, `instanceof` against the builtin
// classes, and error messages.) node_modules vendors readable-stream
// 2.3.8 and its dependencies, unmodified (MIT).
"use strict";
process.env.READABLE_STREAM = "disable";
var stream = require("stream");
var rs = require("readable-stream");
var Transform = require("readable-stream/transform");
var PassThrough = require("readable-stream/passthrough");
var Writable = require("readable-stream/writable");

console.log(rs.Readable === stream.Readable, rs.Writable === stream.Writable);
console.log(Transform === stream.Transform, PassThrough === stream.PassThrough);
console.log(Writable === stream.Writable, typeof rs.Stream);

function shout(words) {
  const source = new rs.Readable({ read: function () {} });
  const seen = [];
  const sink = new Writable({
    write: function (chunk, encoding, callback) {
      seen.push(String(chunk));
      callback();
    },
  });
  sink.on("finish", function () {
    console.log("piped", seen.join("|"));
  });
  source
    .pipe(
      new Transform({
        transform: function (chunk, encoding, callback) {
          callback(null, String(chunk).toUpperCase());
        },
      }),
    )
    .pipe(new PassThrough())
    .pipe(sink);
  words.forEach(function (w) {
    source.push(w);
  });
  source.push(null);
}

shout(["a", "bc", "def"]);
console.log("sync done");
