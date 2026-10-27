// The boot-path Node surface keeps its boundaries: process.send answers
// presence checks but stays fenced as a stored value, a stream hook must
// declare Node's argument type or a supertype of it, and util.promisify
// over a function value needs an Error-typed callback error.
import { promisify } from "node:util";
import { Writable } from "node:stream";

const send = process.send;
console.log(typeof send);

class Counter extends Writable {
  _write(chunk: number, _encoding: BufferEncoding, cb: (err?: Error | null) => void): void {
    console.log(chunk);
    cb();
  }
}
new Counter().end("x");

function legacy(cb: (code: number, value: string) => void): void {
  cb(0, "v");
}
const legacyAsync = promisify(legacy);
legacyAsync().then((v) => console.log(v));
