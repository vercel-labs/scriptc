// A stream disposed through a checked-dynamic value answers a promise even
// when the disposal call is the program's only async use.
import { PassThrough } from "node:stream";

function disposeOf(stream) {
  return stream[Symbol.asyncDispose]();
}

const stream = new PassThrough();
const pending = disposeOf(stream);
console.log(`promise ${typeof pending.then} destroyed ${stream.destroyed}`);
