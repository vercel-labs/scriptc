// readable-stream 3.x compiles as Node's builtin stream module, a
// documented divergence: Node runs the package's own JavaScript streams (a
// copy of Node 10's), and the package's READABLE_STREAM=disable branch,
// which would hand out the builtin classes, throws on Node 24. This program
// keeps to behavior both share: piping through transforms, pipeline and
// finished callbacks, and error propagation, one step at a time.
// node_modules vendors readable-stream 3.6.2 and its dependencies,
// unmodified (MIT).
"use strict";
const rs = require("readable-stream");

console.log(
  typeof rs.Readable,
  typeof rs.Writable,
  typeof rs.Transform,
  typeof rs.PassThrough,
  typeof rs.pipeline,
  typeof rs.finished,
);

function piped(next) {
  const seen = [];
  const source = new rs.Readable({ read: function () {} });
  const upper = new rs.Transform({
    transform: function (chunk, encoding, callback) {
      callback(null, String(chunk).toUpperCase());
    },
  });
  const through = new rs.PassThrough();
  const sink = new rs.Writable({
    write: function (chunk, encoding, callback) {
      seen.push(String(chunk));
      callback();
    },
  });
  rs.pipeline(source, upper, through, sink, function (err) {
    console.log("pipeline", err ? err.message : "ok", seen.join("|"));
    next();
  });
  ["a", "bc", "def"].forEach(function (w) {
    source.push(w);
  });
  source.push(null);
}

function failed(next) {
  const source = new rs.Readable({ read: function () {} });
  const broken = new rs.Transform({
    transform: function (chunk, encoding, callback) {
      callback(new Error("boom on " + String(chunk)));
    },
  });
  const sink = new rs.Writable({
    write: function (chunk, encoding, callback) {
      callback();
    },
  });
  rs.pipeline(source, broken, sink, function (err) {
    console.log("pipeline", err ? err.message : "ok");
    next();
  });
  source.push("x");
  source.push(null);
}

function ended(next) {
  const sink = new rs.Writable({
    write: function (chunk, encoding, callback) {
      callback();
    },
  });
  rs.finished(sink, function (err) {
    console.log("finished", err ? err.message : "ok");
    next();
  });
  sink.end("last");
}

piped(function () {
  failed(function () {
    ended(function () {
      console.log("done");
    });
  });
});
console.log("sync done");
