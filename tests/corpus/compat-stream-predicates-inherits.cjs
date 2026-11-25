// node:stream's utility predicates and the state getters on a stream built
// the pre-class way: a constructor function that calls the stream class and
// inherits from it.
const stream = require("node:stream");
const util = require("node:util");

function Source(options) {
  stream.Readable.call(this, options);
  this.sent = 0;
}
util.inherits(Source, stream.Readable);
Source.prototype._read = function () {
  this.sent += 1;
  this.push(this.sent > 2 ? null : `chunk ${this.sent}`);
};

function Sink(options) {
  stream.Writable.call(this, options);
  this.got = [];
}
util.inherits(Sink, stream.Writable);
Sink.prototype._write = function (chunk, _encoding, callback) {
  this.got.push(String(chunk));
  callback();
};

function all(value) {
  return [
    stream.isDestroyed(value),
    stream.isErrored(value),
    stream.isDisturbed(value),
    stream.isReadable(value),
    stream.isWritable(value),
  ].join(" ");
}

const source = new Source();
const sink = new Sink();
console.log("source new", all(source), stream.Readable.isDisturbed(source));
console.log("sink new", all(sink));
source.pipe(sink);
sink.on("finish", () => {
  console.log("sink finished", all(sink), sink.got.join(","));
  setImmediate(() => {
    console.log("source closed", all(source), stream.Readable.isDisturbed(source));
    console.log("sink closed", all(sink));
    const failing = new Source();
    failing.on("error", (error) => {
      console.log("error event", error.message, stream.isErrored(failing));
    });
    failing.destroy(new Error("boom"));
    console.log("after destroy(err)", all(failing));
    setImmediate(() => console.log("after error", all(failing)));
  });
});
