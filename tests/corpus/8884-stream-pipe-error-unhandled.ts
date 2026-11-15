// @exit: 1
// A piped destination that errors with no 'error' listener of the
// program's own: pipe()'s listener unpipes and emits the error again, and
// with nobody left to hear it the error is thrown, as without a pipe.
import { Readable, Writable } from "node:stream";

const src = new Readable({ read() {} });
src.on("pause", () => console.log("src pause"));
const dst = new Writable({
  write(_chunk, _enc, cb) {
    cb();
  },
});
dst.on("unpipe", (from) => console.log("unpipe", from === src));
dst.on("close", () => console.log("close (not reached)"));
src.pipe(dst);
src.push("a");
setTimeout(() => {
  console.log("destroying");
  dst.destroy(new Error("destination failed"));
}, 10);
setTimeout(() => console.log("not reached"), 200);
