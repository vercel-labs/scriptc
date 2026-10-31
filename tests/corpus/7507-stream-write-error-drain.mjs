// A write whose callback fails synchronously: write() answers false and
// writableNeedDrain stays false, so no 'drain' follows the error, and a
// pipeline pumping a generator stops at the failed write.
import { pipeline, Writable } from "node:stream";

const w = new Writable({
  write(_chunk, _enc, cb) {
    cb(new Error("bad write"));
  },
});
w.on("error", (e) => console.log("error event", e.message));
w.on("drain", () => console.log("drain"));
const r = w.write("a");
console.log("returned", r, "needDrain", w.writableNeedDrain, "errored", w.errored.message);

function* source() {
  try {
    for (let i = 0; i < 4; i++) {
      console.log("yield", i);
      yield `c${i}`;
    }
  } finally {
    console.log("source finally");
  }
}
let writes = 0;
pipeline(
  source(),
  new Writable({
    write(chunk, _enc, cb) {
      writes++;
      console.log("write", String(chunk));
      cb(writes === 2 ? new Error("second write failed") : null);
    },
  }),
  (err) => console.log("pipeline done", err.message),
);
