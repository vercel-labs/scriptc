// Readable streams built by constructor functions, the from2 pattern:
// util.inherits(Ctor, Readable), Readable.call(this, opts) and _read on
// the prototype.
const { Readable } = require("stream");
const util = require("util");

function Source(list, opts) {
  if (!(this instanceof Source)) return new Source(list, opts);
  this._list = list.slice();
  // Before Readable.call there is no state: Node's setter ignores this.
  this.destroyed = false;
  Readable.call(this, opts || {});
  this._reads = 0;
  console.log("hwm", this._readableState.highWaterMark, "objectMode", this._readableState.objectMode);
}
util.inherits(Source, Readable);
Source.prototype._read = function (size) {
  this._reads++;
  const item = this._list.shift();
  this.push(item === undefined ? null : Buffer.from(item));
};

const s = Source(["alpha", "beta", "gamma"]);
console.log("instanceof", s instanceof Source, s instanceof Readable, Source.super_ === Readable);
console.log("readable", s.readable, "ended", s.readableEnded, "destroyed", s.destroyed);
console.log("flowing", s.readableFlowing, s._readableState.flowing);
s.on("data", function (chunk) {
  console.log("data", this === s, Buffer.isBuffer(chunk), chunk.toString());
});
s.on("end", function () {
  console.log("end", this === s, s.readableEnded, s._readableState.ended, s._reads);
});
s.on("close", () => {
  console.log("close", s.destroyed, s.closed);
  paused();
});
console.log("sync after on('data')", s.readableFlowing);

// from2's callback-driven _read, asynchronous pushes and a small
// highWaterMark.
function From(read, opts) {
  if (!(this instanceof From)) return new From(read, opts);
  this._reading = false;
  this._callback = check;
  this.destroyed = false;
  Readable.call(this, opts);
  const self = this;
  const hwm = this._readableState.highWaterMark;
  function check(err, data) {
    if (self.destroyed) return;
    if (err) return self.destroy(err);
    if (data === null) return self.push(null);
    self._reading = false;
    if (self.push(data)) self._read(hwm);
  }
  this._from = read;
}
util.inherits(From, Readable);
From.prototype._read = function (size) {
  if (this._reading || this.destroyed) return;
  this._reading = true;
  this._from(size, this._callback);
};
From.prototype.destroy = function (err) {
  if (this.destroyed) return;
  this.destroyed = true;
  const self = this;
  process.nextTick(function () {
    if (err) self.emit("error", err);
    self.emit("close");
  });
};

function paused() {
  const parts = ["one ", "two ", "three"];
  const r = new From(function (size, next) {
    setImmediate(() => next(null, parts.length ? parts.shift() : null));
  }, { highWaterMark: 4 });
  console.log("from hwm", r._readableState.highWaterMark, r.readableHighWaterMark);
  r.setEncoding("utf8");
  let text = "";
  r.on("readable", () => {
    let chunk;
    while ((chunk = r.read()) !== null) text += chunk;
  });
  r.on("end", () => {
    console.log("paused text", JSON.stringify(text), typeof text);
    // From() without new runs outside the listener, where `this` is unset.
    setImmediate(failing);
  });
}

function failing() {
  let calls = 0;
  const r = From(function (size, next) {
    calls++;
    if (calls === 2) return next(new Error("source failed"));
    next(null, "chunk" + calls);
  });
  r.on("data", (d) => console.log("failing data", String(d)));
  r.on("error", (e) => console.log("failing error", e.message, r.destroyed));
  r.on("close", () => {
    console.log("failing close", calls);
    unshifted();
  });
}

function unshifted() {
  const r = new Source(["xyz"]);
  r.once("readable", () => {
    const first = r.read(1);
    console.log("read(1)", String(first), r.readableLength);
    r.unshift(first);
    console.log("after unshift", r.readableLength);
    r.pause();
    console.log("isPaused", r.isPaused());
    r.on("data", (d) => console.log("rest", String(d)));
    r.resume();
  });
  r.on("end", () => console.log("unshifted end"));
}
