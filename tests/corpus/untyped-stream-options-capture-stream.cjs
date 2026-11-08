// Stream options passed through an untyped value (a JavaScript parameter
// with no type), whose read() reaches the stream it belongs to through a
// captured object: the stream holds the callback, the callback holds the
// stream. The stream is dropped without ever being read or closed, so only
// the collector can free it, and it has to see through the callback to do
// so; the sanitized lane's RC audit fails on a leaked stream.
const { Readable } = require("node:stream");
function make(options) { return new Readable(options); }
function build() {
  const holder = {};
  holder.stream = make({ read() { holder.stream.push(null); } });
  return typeof holder.stream.read;
}
console.log(build());
