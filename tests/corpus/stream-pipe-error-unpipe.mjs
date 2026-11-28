// A piped invalid chunk's type error is rendered through the chunk's own
// Symbol.toStringTag, which may unpipe and drop the destination while the
// error is still being handled.
import { Readable, Writable } from "node:stream";

let source;
let destination = new Writable({ write(chunk, encoding, callback) { callback(); } });
destination.on("error", (e) => console.log("destination", e.code));
const chunk = {
  get [Symbol.toStringTag]() {
    source.unpipe();
    return "Odd";
  },
};
source = Readable.from([chunk]);
source.pipe(destination);
destination = null;
setTimeout(() => console.log("done"), 10);
