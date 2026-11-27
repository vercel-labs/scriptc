// A stream read through a checked-dynamic value answers
// [Symbol.asyncDispose](), which disposes it as the typed member does.
import { PassThrough, Readable } from "node:stream";

function disposeOf(s) {
  return s[Symbol.asyncDispose]();
}

const a = new PassThrough();
const pending = disposeOf(a);
console.log(`then ${typeof pending.then} destroyed ${a.destroyed}`);
await pending;
console.log(`after ${a.destroyed}`);

const b = Readable.from(["x"]);
await disposeOf(b);
console.log(`readable ${b.destroyed}`);
