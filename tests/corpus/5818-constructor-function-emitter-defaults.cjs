// EventEmitter.defaultMaxListeners read and written through the untyped
// EventEmitter constructor (Node's accessor and its validation), and a
// legacy pipe whose destination emits 'close' synchronously from end().
"use strict";
const util = require("util");
const EventEmitter = require("events");
const Stream = require("stream");

function Bus() {
  EventEmitter.call(this);
}
util.inherits(Bus, EventEmitter);

console.log(EventEmitter.defaultMaxListeners);
console.log(new Bus().getMaxListeners());
EventEmitter.defaultMaxListeners = 3;
console.log(EventEmitter.defaultMaxListeners, new Bus().getMaxListeners());
for (const value of [-1, "4", Number.NaN]) {
  try {
    EventEmitter.defaultMaxListeners = value;
  } catch (error) {
    console.log(error.name, error.code, error.message);
  }
}
console.log(EventEmitter.defaultMaxListeners);
EventEmitter.defaultMaxListeners = 10;

function Source() {
  Stream.call(this);
  this.readable = true;
}
util.inherits(Source, Stream);

function Sink() {
  Stream.call(this);
  this.writable = true;
}
util.inherits(Sink, Stream);
Sink.prototype.write = function (chunk) {
  console.log("write", chunk);
  return true;
};
Sink.prototype.end = function () {
  console.log("sink end");
  this.emit("close");
};

const source = new Source();
const sink = new Sink();
source.pipe(sink);
source.emit("data", "a");
console.log("emit end", source.emit("end"));
console.log("listeners", source.listenerCount("end"), source.listenerCount("data"), sink.listenerCount("close"));
