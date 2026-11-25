// A writable made the JavaScript way: a constructor function with the
// methods on its prototype.
function Sink(lines) {
  this.lines = lines;
}
Sink.prototype.write = function (chunk) {
  this.lines.push(String(chunk).trimEnd());
  return true;
};
Sink.prototype.end = function () {};
Sink.prototype.on = function () {
  return this;
};

export function makeSink(lines) {
  return new Sink(lines);
}
