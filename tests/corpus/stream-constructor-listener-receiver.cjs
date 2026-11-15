// A stream built from a constructor function hands itself to listeners
// registered through an untyped value as `this`, the empty argument vector
// of 'end' included, so callbacks read their receiver's members. Node is
// the oracle.
const { Readable } = require("node:stream");
const util = require("node:util");

function Source() {
  Readable.call(this);
}
util.inherits(Source, Readable);
Source.prototype._read = function () {};

const source = new Source();
const anySource = source;
anySource.on("custom", function (value) {
  console.log("custom", this === source, typeof this.pipe, value);
});
anySource.on("data", function (chunk) {
  console.log("data", this === source, typeof this.pipe, this.readable, String(chunk));
});
anySource.on("end", function () {
  console.log("end", this === source, typeof this.push, this.readable);
});
source.push("x");
anySource.emit("custom", 1);
source.push(null);
