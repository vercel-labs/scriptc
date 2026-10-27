// Stream hooks a constructor function assigns after the base constructor
// runs, and unpipe from the destination's 'pipe' listener.
const { Writable, Transform, PassThrough } = require("stream");
const util = require("util");

function Sink() {
  Writable.call(this);
  this.chunks = [];
  this._final = function (cb) {
    console.log("_final", this instanceof Sink, this.chunks.join(","));
    setImmediate(cb);
  };
}
util.inherits(Sink, Writable);
Sink.prototype._write = function (chunk, enc, cb) {
  this.chunks.push(String(chunk));
  cb();
};

const sink = new Sink();
sink.on("prefinish", () => console.log("sink prefinish"));
sink.on("finish", () => {
  console.log("sink finish");
  flushing();
});
sink.write("a");
sink.end("b");

function Summer() {
  Transform.call(this);
  this.total = 0;
  this._flush = function (cb) {
    console.log("_flush", this.total);
    cb(null, "total " + this.total);
  };
}
util.inherits(Summer, Transform);
Summer.prototype._transform = function (chunk, enc, cb) {
  this.total += Number(String(chunk));
  cb(null, "seen " + chunk + "\n");
};

function flushing() {
  const summer = new Summer();
  const out = [];
  summer.on("data", (chunk) => out.push(String(chunk)));
  summer.on("end", () => {
    console.log("summer end", JSON.stringify(out));
    passing();
  });
  summer.write("2");
  summer.write("3");
  summer.end();
}

function Upper() {
  PassThrough.call(this);
  this._transform = function (chunk, enc, cb) {
    cb(null, String(chunk).toUpperCase());
  };
}
util.inherits(Upper, PassThrough);

function passing() {
  const upper = new Upper();
  const out = [];
  upper.on("data", (chunk) => out.push(String(chunk)));
  upper.on("end", () => {
    console.log("upper end", JSON.stringify(out));
    plain();
  });
  upper.write("x");
  upper.end("y");
}

// Without late hooks the defaults still apply.
function Plain() {
  PassThrough.call(this);
}
util.inherits(Plain, PassThrough);

function plain() {
  const p = new Plain();
  const out = [];
  p.on("data", (chunk) => out.push(String(chunk)));
  p.on("finish", () => console.log("plain finish"));
  p.on("end", () => {
    console.log("plain end", JSON.stringify(out));
    unpiping();
  });
  p.end("same");
}

function Collector() {
  Writable.call(this);
  this.chunks = [];
}
util.inherits(Collector, Writable);
Collector.prototype._write = function (chunk, enc, cb) {
  this.chunks.push(String(chunk));
  cb();
};

function unpiping() {
  const source = new PassThrough();
  const collector = new Collector();
  collector.on("pipe", function (src) {
    console.log("pipe", typeof src.unpipe, this === collector);
    src.unpipe(this);
  });
  collector.on("unpipe", (src) => {
    console.log("unpipe", typeof src.pipe);
    source.write("after");
    setImmediate(() => console.log("collected", JSON.stringify(collector.chunks), source.readableFlowing));
  });
  source.pipe(collector);
}
