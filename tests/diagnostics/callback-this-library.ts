// Node.js calls these callbacks with a receiver of its own: the timer
// object, `process`, the stream, an internal object. The native call passes
// none, so a callback that reads `this` is refused by name instead of
// reading `undefined`. A JSON.parse reviver that takes every argument is
// refused for the third argument Node passes it.
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { gzip } from "node:zlib";

setTimeout(function (this: unknown) {
  console.log(typeof this);
}, 0);
setImmediate(function (this: unknown) {
  console.log(typeof this);
});
const reads = function (this: unknown): void {
  console.log(typeof this);
};
setInterval(reads, 1000).unref();
process.on("exit", function (this: unknown) {
  console.log(typeof this);
});
randomBytes(4, function (this: unknown) {
  console.log(typeof this);
});
gzip(Buffer.from("x"), function (this: unknown) {
  console.log(typeof this);
});
new Readable({ read: reads }).read();
console.log(JSON.parse("1", function () {
  return arguments.length;
}));
console.log(JSON.parse("1", (...args: unknown[]) => args[1]));
