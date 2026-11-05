// A write's saved completion called later inside another object's method:
// the write(chunk, callback) callback it runs is called unbound, so its
// `this` is undefined (module code is strict), and the next queued write's
// _write sees the stream as `this`.
import { Writable } from "node:stream";

let saved = null;
const seen = [];
const label = (self) => (self === undefined ? "undefined" : self === w ? "stream" : self === holder ? "holder" : typeof self);
const w = new Writable({
  objectMode: true,
  write(chunk, _enc, cb) {
    seen.push(`write ${chunk.n} this=${label(this)}`);
    if (chunk.n === 1) saved = cb;
    else cb();
  },
});
const holder = {
  run() {
    saved();
  },
};
w.write({ n: 1 }, function () {
  seen.push(`callback 1 this=${label(this)}`);
});
w.write({ n: 2 }, function () {
  seen.push(`callback 2 this=${label(this)}`);
});
setTimeout(() => {
  holder.run();
  w.end(() => {
    for (const line of seen) console.log(line);
  });
}, 0);
