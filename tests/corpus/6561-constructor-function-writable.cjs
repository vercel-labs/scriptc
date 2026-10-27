// Writable and Duplex streams built by constructor functions, the bl and
// tar-stream patterns: Writable.call(this, opts), Duplex.call(this),
// _write/_final/_read on the prototype, listeners added before the base
// constructor runs, and an end() override that calls the base's end.
const stream = require("stream");
const util = require("util");

function Sink(opts) {
  if (!(this instanceof Sink)) return new Sink(opts);
  stream.Writable.call(this, opts);
  this.chunks = [];
  this.finalized = false;
}
util.inherits(Sink, stream.Writable);
Sink.prototype._write = function (chunk, enc, cb) {
  console.log("_write", this instanceof Sink, enc, Buffer.isBuffer(chunk), chunk.toString());
  this.chunks.push(chunk);
  if (this.chunks.length === 2) setImmediate(cb);
  else cb();
};
Sink.prototype._final = function (cb) {
  console.log("_final", this.chunks.length);
  this.finalized = true;
  cb();
};

const sink = new Sink({ highWaterMark: 8 });
console.log("writable", sink.writable, sink.writableHighWaterMark, sink._writableState.highWaterMark);
console.log("write a", sink.write("first"));
console.log("write b", sink.write(Buffer.from("second"), () => console.log("write b callback")));
console.log("needDrain", sink.writableNeedDrain, sink.writableLength);
sink.on("drain", () => console.log("drain", sink.writableLength));
sink.on("finish", function () {
  console.log("finish", this === sink, sink.finalized, sink.writableFinished, Buffer.concat(sink.chunks).toString());
});
sink.on("close", () => {
  console.log("close", sink.destroyed, sink.closed);
  duplex();
});
sink.end("third", (err) => console.log("end callback", err, sink.writableEnded, sink._writableState.ended));
console.log("after end", sink.writableEnded, sink.writable);

// A bl-style list: a Duplex that collects writes and reads them back.
function BufferListStream(callback) {
  if (!(this instanceof BufferListStream)) return new BufferListStream(callback);
  if (typeof callback === "function") {
    this._callback = callback;
    const piper = function piper(err) {
      if (this._callback) {
        this._callback(err);
        this._callback = null;
      }
    }.bind(this);
    this.on("pipe", function onPipe(src) {
      console.log("pipe event", src instanceof stream.Readable);
      src.on("error", piper);
    });
    this.on("unpipe", function onUnpipe(src) {
      console.log("unpipe event");
      src.removeListener("error", piper);
    });
    callback = null;
  }
  this._bufs = [];
  this.length = 0;
  stream.Duplex.call(this);
}
util.inherits(BufferListStream, stream.Duplex);
BufferListStream.prototype._write = function (buf, encoding, callback) {
  this._bufs.push(buf);
  this.length += buf.length;
  callback();
};
BufferListStream.prototype._read = function (size) {
  if (!this.length) return this.push(null);
  const all = Buffer.concat(this._bufs);
  size = Math.min(size, this.length, 4);
  this.push(all.subarray(0, size));
  this._bufs = [all.subarray(size)];
  this.length -= size;
};
BufferListStream.prototype.end = function end(chunk) {
  stream.Duplex.prototype.end.call(this, chunk);
  if (this._callback) {
    this._callback(null, Buffer.concat(this._bufs));
    this._callback = null;
  }
};
BufferListStream.prototype.slice = function () {
  return Buffer.concat(this._bufs);
};

function Letters(text) {
  stream.Readable.call(this, { highWaterMark: 2 });
  this._text = text;
}
util.inherits(Letters, stream.Readable);
Letters.prototype._read = function () {
  const next = this._text.slice(0, 3);
  this._text = this._text.slice(3);
  this.push(next.length ? next : null);
};

function duplex() {
  const list = new BufferListStream((err, data) => {
    console.log("bl callback", err, data.toString(), data.length);
  });
  console.log("duplex", list.readable, list.writable, list.allowHalfOpen, list instanceof stream.Duplex);
  console.log("pre-constructor listeners", list.listenerCount("pipe"), list.listenerCount("unpipe"));
  list.write("hello ");
  list.write("constructor ");
  list.end("functions");
  list.on("finish", () => {
    const out = [];
    list.on("data", (d) => out.push(d.toString()));
    list.on("end", () => {
      console.log("read back", JSON.stringify(out));
      piping();
    });
  });
}

function piping() {
  const src = new Letters("abcdefghij");
  const dst = new Sink({ highWaterMark: 1 });
  dst.on("pipe", (from) => console.log("dst pipe", from === src));
  const returned = src.pipe(dst);
  console.log("pipe returns dest", returned === dst);
  dst.on("finish", () => {
    console.log("piped", Buffer.concat(dst.chunks).toString(), src.readableEnded);
    const keep = new Sink();
    const from = new Letters("xyz");
    from.pipe(keep, { end: false });
    from.on("end", () => {
      setImmediate(() => {
        console.log("end:false keeps the destination open", keep.writable, keep.writableEnded);
        keep.end();
      });
    });
  });
}
