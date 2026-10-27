// Transform and PassThrough streams built by constructor functions (the
// yazl and tar-stream patterns), piped together with runtime streams:
// zlib and fs.
const { Readable, Writable, Transform, PassThrough } = require("stream");
const util = require("util");
const zlib = require("zlib");
const fs = require("fs");
const os = require("os");
const path = require("path");

// yazl's ByteCounter
function ByteCounter(options) {
  Transform.call(this, options);
  this.byteCount = 0;
}
util.inherits(ByteCounter, Transform);
ByteCounter.prototype._transform = function (chunk, encoding, cb) {
  this.byteCount += chunk.length;
  cb(null, chunk);
};

// A transform with a flush that appends a trailer.
function Upper() {
  if (!(this instanceof Upper)) return new Upper();
  Transform.call(this);
  this.seen = 0;
}
util.inherits(Upper, Transform);
Upper.prototype._transform = function (chunk, encoding, cb) {
  this.seen++;
  this.push(chunk.toString().toUpperCase());
  cb();
};
Upper.prototype._flush = function (cb) {
  cb(null, "[" + this.seen + " chunks]");
};

// tar-stream's entry stream: a PassThrough with its own destroy.
function Source(parent, offset) {
  this._parent = parent;
  this.offset = offset;
  PassThrough.call(this, { autoDestroy: false });
}
util.inherits(Source, PassThrough);
Source.prototype.destroy = function (err) {
  console.log("Source.destroy forwarded", err && err.message);
  this._parent.destroyed = true;
};

// A PassThrough without its own _transform passes chunks through.
function Plain() {
  PassThrough.call(this);
}
util.inherits(Plain, PassThrough);

function Words(words) {
  Readable.call(this);
  this._words = words.slice();
}
util.inherits(Words, Readable);
Words.prototype._read = function () {
  this.push(this._words.length ? this._words.shift() : null);
};

function Collect() {
  Writable.call(this);
  this.parts = [];
}
util.inherits(Collect, Writable);
Collect.prototype._write = function (chunk, enc, cb) {
  this.parts.push(chunk);
  cb();
};
Collect.prototype.text = function () {
  return Buffer.concat(this.parts).toString();
};

const upper = Upper();
const words = [];
upper.on("data", (d) => words.push(d.toString()));
upper.on("end", () => {
  console.log("upper", JSON.stringify(words), upper.seen, upper._readableState.ended, upper._writableState.finished);
  counter();
});
upper.write("one ");
upper.write(Buffer.from("two "));
upper.end("three");

function counter() {
  const counterStream = new ByteCounter();
  const sink = new Collect();
  new Words(["hello ", "byte ", "counter"]).pipe(counterStream).pipe(sink);
  sink.on("finish", () => {
    console.log("counted", counterStream.byteCount, JSON.stringify(sink.text()));
    entry();
  });
}

function entry() {
  const parent = { destroyed: false };
  const source = new Source(parent, 512);
  const plain = new Plain();
  console.log("source", source.offset, source instanceof PassThrough, source instanceof Transform);
  let body = "";
  source.pipe(plain);
  plain.on("data", (d) => (body += d));
  plain.on("end", () => {
    console.log("entry body", JSON.stringify(body), source.destroyed);
    source.destroy(new Error("stop"));
    console.log("parent destroyed", parent.destroyed);
    gzip();
  });
  source.write("file ");
  source.end("contents");
}

function gzip() {
  const counted = new ByteCounter();
  const out = new Collect();
  new Words(["compressed ", "through ", "zlib"]).pipe(counted).pipe(zlib.createGzip()).pipe(out);
  out.on("finish", () => {
    const back = zlib.gunzipSync(Buffer.concat(out.parts)).toString();
    console.log("gzip roundtrip", JSON.stringify(back), counted.byteCount);
    toFile();
  });
}

function toFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctor-stream-"));
  const file = path.join(dir, "out.txt");
  const ws = fs.createWriteStream(file);
  new Words(["written ", "by ", "a ", "constructor"]).pipe(Upper()).pipe(ws);
  ws.on("finish", () => {
    console.log("file", JSON.stringify(fs.readFileSync(file, "utf8")));
    // A runtime stream piped into a constructor-function stream.
    const back = new Collect();
    fs.createReadStream(file).pipe(new ByteCounter()).pipe(back);
    back.on("finish", () => {
      console.log("read back", JSON.stringify(back.text()));
      fs.rmSync(dir, { recursive: true });
    });
  });
}
