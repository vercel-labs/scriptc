// The legacy Stream constructor as a constructor function's base: its
// EventEmitter state and the legacy pipe between two such streams. The
// stream classes take util.inherits, and instanceof follows the chain.
"use strict";
const util = require("util");
const Stream = require("stream");
const { Readable, Writable, Duplex, Transform, PassThrough } = require("stream");

function Source(items) {
  Stream.call(this);
  this.items = items;
  this.readable = true;
}
util.inherits(Source, Stream);
Source.prototype.start = function () {
  for (const item of this.items) this.emit("data", item);
  this.emit("end");
};

function Sink() {
  Stream.call(this);
  this.writable = true;
  this.chunks = [];
}
util.inherits(Sink, Stream);
Sink.prototype.write = function (chunk) {
  this.chunks.push(chunk);
  return true;
};
Sink.prototype.end = function () {
  console.log("sink end", this.chunks.join("+"));
};

const source = new Source(["a", "b", "c"]);
const sink = new Sink();
sink.on("pipe", (from) => console.log("piped", from === source));
console.log(source.pipe(sink) === sink, sink.listenerCount("pipe"));
source.start();
console.log("after end", source.listenerCount("data"), sink.listenerCount("drain"));

const kept = new Sink();
const second = new Source(["x"]);
second.pipe(kept, { end: false });
second.start();
console.log("kept open", kept.chunks);

function Reader() {}
util.inherits(Reader, Readable);
function Both() {}
util.inherits(Both, Duplex);
function Shift() {}
util.inherits(Shift, Transform);
function Through() {}
util.inherits(Through, PassThrough);
function Out() {}
util.inherits(Out, Writable);
console.log(Reader.super_ === Readable, Through.super_ === PassThrough, Out.super_ === Writable);
const reader = Object.create(Reader.prototype);
const through = Object.create(Through.prototype);
const out = Object.create(Out.prototype);
const both = Object.create(Both.prototype);
console.log(reader instanceof Readable, reader instanceof Writable);
console.log(through instanceof Transform, through instanceof Duplex, through instanceof Readable);
console.log(out instanceof Writable, out instanceof Readable, both instanceof Readable);
console.log(typeof Shift.prototype.constructor, Shift.prototype instanceof Duplex);
