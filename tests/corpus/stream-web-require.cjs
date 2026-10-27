// The undici shape: CommonJS code reads ReadableStream off
// require("stream/web") (lazily, and as a fallback for the global); the
// value is the global class.
let ReadableStream;
function getStream() {
  if (!ReadableStream) ReadableStream = require("stream/web").ReadableStream;
  return ReadableStream;
}
const Fallback = globalThis.ReadableStream || require("node:stream/web").ReadableStream;
console.log(getStream() === globalThis.ReadableStream, Fallback === getStream());
