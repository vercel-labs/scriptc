// Native streams passed to untyped helpers: push, unshift, the listener
// members, setDefaultEncoding and readableFlowing answer through the
// untyped value as on the typed one, also for a program subclass and in
// object mode.
const { Readable, Writable } = require("stream");

function feed(s) {
  console.log("push", s.push("a"), s.push("b", "utf8"), s.unshift("z"));
  console.log("counts", s.listenerCount("data"), s.eventNames().join(","));
  s.on("custom", (x, y) => {
    console.log("custom", x, y);
  });
  s.emit("custom", 1, 2);
  s.removeAllListeners("custom");
  console.log("after removeAll", s.listenerCount("custom"), s.readableFlowing);
  s.push(null);
}

const r = new Readable({ read() {} });
const chunks = [];
r.on("data", (c) => chunks.push(String(c)));
r.on("end", () => console.log("end", chunks.join("|")));
feed(r);

class Source extends Readable {
  _read() {}
}
const sub = new Source();
sub.on("data", (c) => console.log("source data", String(c)));
console.log("source push", sub instanceof Readable);
(function (s) {
  console.log(s.push("from untyped"), s.readableLength);
  s.push(null);
})(sub);

const objects = new Readable({ objectMode: true, read() {} });
console.log("flowing before", objects.readableFlowing);
objects.on("data", (c) => console.log("object data", c));
(function (s) {
  console.log(s.push({ n: 1 }), s.push(undefined), s.push(2), s.readableFlowing);
  s.push(null);
})(objects);

function drain(w) {
  w.setDefaultEncoding("latin1");
  w.write("é");
  w.end();
}
const w = new Writable({
  write(c, e, cb) {
    console.log("wrote", c.length, e);
    cb();
  },
});
w.on("finish", () => console.log("finish"));
drain(w);
