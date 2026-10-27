// Assigning _construct after construction: Node reads it on the
// construction tick, so an assignment before that tick replaces the
// scheduled hook, and one after it, or on a stream without a hook, has no
// effect.
import { Readable, Writable } from "node:stream";

const w = new Writable({
  construct(cb) {
    console.log("original construct");
    cb();
  },
  write(chunk, _enc, cb) {
    console.log("write", chunk.toString());
    cb();
  },
});
w._construct = function (cb) {
  console.log("replacement construct");
  cb();
};
w.write("a");
w.end();
w.on("finish", () => {
  w._construct = function (cb) {
    console.log("late construct");
    cb();
  };
  console.log("finish");
  readable();
});

// A stream without a construct hook: the assignment has no effect.
function readable() {
  const r = new Readable({
    read() {
      this.push("x");
      this.push(null);
    },
  });
  r._construct = function (cb) {
    console.log("never");
    cb();
  };
  r.on("data", (d) => console.log("data", d.toString()));
  r.on("end", () => console.log("end"));
}
