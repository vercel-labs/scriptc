// A saved write completion called inside a class method, which JavaScript
// calls as holder.run(), runs the write(chunk, callback) callbacks unbound:
// a JavaScript callback sees `this` as undefined, not the method's
// receiver.
import { Writable } from "node:stream";
import { callRun, makeCallback } from "./label.js";

let saved: ((error?: Error | null) => void) | null = null;
const seen: string[] = [];
const w = new Writable({
  objectMode: true,
  write(chunk: { n: number }, _enc, cb) {
    seen.push(`write ${chunk.n}`);
    if (chunk.n === 1) saved = cb;
    else cb();
  },
});
class Holder {
  label = "holder";
  run(): void {
    if (saved !== null) saved();
  }
}
const holder = new Holder();
w.write({ n: 1 }, makeCallback(seen, "callback 1", holder));
w.write({ n: 2 }, makeCallback(seen, "callback 2", holder));
setTimeout(() => {
  callRun(holder);
  w.end(() => {
    for (const line of seen) console.log(line);
  });
}, 0);
