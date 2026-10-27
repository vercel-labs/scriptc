// Errors, destroy and custom events on constructor-function streams.
const { Readable, Writable, Duplex } = require("stream");
const util = require("util");

function Failing() {
  Writable.call(this);
}
util.inherits(Failing, Writable);
Failing.prototype._write = function (chunk, enc, cb) {
  const err = new Error("cannot store " + chunk);
  err.code = "E_STORE";
  this.lastError = err;
  cb(err);
};

const failing = new Failing();
failing.on("error", function (err) {
  console.log("write error", this === failing, err === failing.lastError, err.message, err.code);
  console.log("errored", failing.errored === err, failing.destroyed, failing.writable);
});
failing.on("close", () => {
  console.log("write close");
  destroying();
});
failing.write("x", (err) => console.log("write callback", err && err.code));

function Ticker() {
  Readable.call(this);
  this.n = 0;
}
util.inherits(Ticker, Readable);
Ticker.prototype._read = function () {
  this.push(String(this.n++));
};
Ticker.prototype._destroy = function (err, cb) {
  console.log("_destroy", err && err.message, this.n > 0);
  setImmediate(() => cb(err && new Error("wrapped: " + err.message)));
};

function destroying() {
  const t = new Ticker();
  const order = [];
  t.on("data", (d) => {
    if (d.toString() === "3") t.destroy(new Error("enough"), (e) => order.push("destroy callback " + (e && e.message)));
  });
  t.on("error", (e) => order.push("error " + e.message));
  t.on("close", () => {
    order.push("close");
    console.log(order.join(" | "), t.destroyed, t.readable);
    t.destroy(null, () => console.log("destroy after close calls back"));
    notImplemented();
  });
}

function Bare() {
  Readable.call(this);
}
util.inherits(Bare, Readable);

function Throws() {
  Readable.call(this);
}
util.inherits(Throws, Readable);
Throws.prototype._read = function () {
  throw new TypeError("read threw");
};

function notImplemented() {
  const bare = new Bare();
  bare.on("error", (e) => {
    console.log("bare", e.code, e.message);
    const thrower = new Throws();
    thrower.on("error", (err) => {
      console.log("throws", err instanceof TypeError, err.message, thrower.destroyed);
      afterEnd();
    });
    thrower.resume();
  });
  bare.resume();
}

function Quiet() {
  Writable.call(this);
}
util.inherits(Quiet, Writable);
Quiet.prototype._write = function (chunk, enc, cb) {
  cb();
};

function afterEnd() {
  const q = new Quiet();
  q.end("done");
  q.on("error", (e) => {
    console.log("after end", e.code, e.message);
    customEvents();
  });
  q.write("late");
}

// tar-stream's Extract emits 'entry' with three arguments.
function Extract() {
  if (!(this instanceof Extract)) return new Extract();
  Writable.call(this);
}
util.inherits(Extract, Writable);
Extract.prototype._write = function (data, enc, cb) {
  const header = { name: data.toString(), size: data.length };
  this.emit("entry", header, "stream-for-" + header.name, cb);
};

function customEvents() {
  const ex = Extract();
  const seen = [];
  function onEntry(header, s, next) {
    seen.push(header.name + ":" + header.size + ":" + s + ":" + (this === ex));
    next();
  }
  ex.on("entry", onEntry);
  ex.once("entry", (header) => seen.push("once " + header.name));
  ex.prependListener("entry", () => seen.push("first"));
  console.log("listenerCount", ex.listenerCount("entry"), ex.listenerCount("entry", onEntry));
  ex.write("a.txt");
  ex.removeListener("entry", onEntry);
  ex.write("b.txt");
  console.log(seen.join(" | "));
  console.log("emit returns", ex.emit("nothing"), ex.emit("entry", { name: "c", size: 0 }, "", () => {}));
  try {
    ex.emit("error", new RangeError("nobody listens"));
  } catch (e) {
    console.log("unhandled error rethrown", e instanceof RangeError, e.message);
  }
  ex.setMaxListeners(1);
  console.log("max listeners", ex.getMaxListeners());
  ex.removeAllListeners("entry");
  console.log("after removeAll", ex.listenerCount("entry"));
  console.log("Duplex prototype", typeof Duplex.prototype.write, typeof Duplex.prototype.push);
}
