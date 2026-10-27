// Class expressions extending Node builtin bases (a bundler's output shape).
"use strict";
const { Readable, Transform } = require("stream");
const { EventEmitter } = require("events");

const Wrap = class extends Readable {
  constructor(parts) {
    super();
    this.parts = parts;
  }
  _read() {
    const next = this.parts.shift();
    this.push(next === undefined ? null : next);
  }
};
const Bus = class extends EventEmitter {};
const Lower = class extends Transform {
  _transform(chunk, _enc, cb) {
    cb(null, chunk.toString().toLowerCase());
  }
};

const r = new Wrap(["a", "b"]);
const chunks = [];
r.on("data", (c) => chunks.push(c.toString()));
r.on("end", () => console.log("wrap", chunks.join("+"), r instanceof Readable));
const bus = new Bus();
bus.on("ping", (n) => console.log("ping", n));
bus.emit("ping", 1);
const l = new Lower();
l.on("data", (d) => console.log("lower", d.toString()));
l.end("HeLLo");
console.log(Wrap.name, Bus.name, typeof Lower);
{
  // A class declared in a block is collected like a class expression.
  class Once extends Readable {
    _read() {
      this.push(null);
    }
  }
  function onReadable() {
    console.log("block", stream.read() === null);
  }
  const stream = new Once();
  stream.once("readable", onReadable);
}
