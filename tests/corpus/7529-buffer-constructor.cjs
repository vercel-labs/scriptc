// The deprecated Buffer constructor, called and constructed, as Node's
// Buffer function runs it: the arguments evaluate in order, the first call
// reports DEP0005 on the next tick (once), a number allocates zero-filled
// bytes, and other values convert as Buffer.from does.
// The program re-runs itself and prints the child's output with process
// ids normalized.
"use strict";
const { spawnSync } = require("node:child_process");
const { Buffer: Imported } = require("buffer");

function child() {
  process.on("warning", (w) => console.log("listener", w.name, w.code, w.message.length));
  const B = Buffer;

  const show = (label, fn) => {
    try {
      const b = fn();
      console.log(label, b, b.length, Buffer.isBuffer(b));
    } catch (e) {
      console.log(label, e.name, e.code, e.message);
    }
  };

  // The throwing form still reports the warning, after the catch.
  show("number+encoding", () => new Buffer(3, "utf8"));
  show("size", () => new Buffer(4));
  show("fraction", () => new Buffer(2.7));
  show("zero", () => Buffer(0));
  show("negative", () => new Buffer(-1));
  show("nan", () => new Buffer(NaN));
  show("string", () => new Buffer("héllo"));
  show("hex", () => new Buffer("6869", "hex"));
  show("base64", () => Buffer("aGk=", "base64"));
  show("empty encoding", () => new Buffer("x", ""));
  show("bad encoding", () => new Buffer("x", "nope"));
  show("array", () => new Buffer([1, 2, 300, -1]));
  show("array-like", () => new Buffer({ length: 2, 0: 7, 1: 8 }));
  show("buffer", () => new B(Buffer.from("copy")));
  show("typed", () => Buffer(new Uint16Array([1, 258])));
  const storage = new Uint8Array([10, 20, 30, 40, 50]).buffer;
  show("arraybuffer", () => new Buffer(storage));
  show("offset", () => new Buffer(storage, 1));
  show("range", () => Buffer(storage, 1, 3));
  show("range past end", () => new Buffer(storage, 6));
  show("string third", () => new Buffer("abc", "latin1", 1));
  show("undefined", () => new Buffer(undefined));
  show("null", () => Buffer(null));
  show("none", () => new Buffer());
  show("imported", () => new Imported("imp"));

  console.log(Buffer(2), Buffer("ab").length, Buffer("hi").toString("hex"), new Buffer([5]));
  console.log(Buffer.isBuffer(Buffer(1)), Buffer(1) instanceof Uint8Array, new Buffer(1) instanceof Uint8Array);

  // The view shares the ArrayBuffer's memory.
  const view = new Buffer(storage, 2, 2);
  new Uint8Array(storage)[2] = 99;
  console.log(view);

  const order = [];
  const arg = (v) => (order.push(v), v);
  new Buffer(arg("a"), arg("utf8"));
  Buffer(arg(2));
  console.log(order);

  console.log("sync end");
  process.nextTick(() => console.log("tick"));
  setTimeout(() => {
    new Buffer(1);
    console.log("timer");
  }, 0);
}

if (process.argv[2] === "child") {
  child();
} else {
  const run = spawnSync(process.execPath, [process.argv[1], "child"], { encoding: "utf8" });
  console.log(`status: ${run.status}`);
  console.log(run.stdout);
  console.log(run.stderr.replace(/\(node:\d+\)/g, "(node:<pid>)"));
}
