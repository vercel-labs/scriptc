// The stream implementer hooks through the checked-dynamic lane: the
// options-object callbacks a plain object supplies and the prototype
// methods of constructor-function subclasses, whose arguments arrive
// untyped. Each hook logs the arguments it receives — chunk shape,
// encoding spelling, the writev batch records — and the error each
// failure path reports.
"use strict";
const util = require("util");
const { Readable, Transform, Writable } = require("node:stream");

const describe = (error) => (error === null || error === undefined ? "none" : error.message);

// Options-object hooks on Writable: construct, write, writev, final and
// destroy, with both string and Buffer chunks.
{
  const sink = new Writable({
    construct(callback) {
      console.log("opts construct", typeof callback, callback.length);
      callback();
    },
    write(chunk, encoding, callback) {
      console.log("opts write", chunk.toString(), encoding, Buffer.isBuffer(chunk), callback.length);
      callback();
    },
    writev(chunks, callback) {
      console.log(
        "opts writev",
        chunks.length,
        chunks.map((e) => e.chunk.toString() + "/" + e.encoding).join(","),
        callback.length,
      );
      callback();
    },
    final(callback) {
      console.log("opts final", this.writableEnded, this.writableFinished);
      callback();
    },
    destroy(error, callback) {
      console.log("opts destroy", describe(error), typeof callback);
      callback();
    },
  });
  sink.on("finish", () => console.log("opts finish", sink.writableFinished));
  sink.on("close", () => console.log("opts close", describe(sink.errored)));
  sink.write("ab");
  sink.cork();
  sink.write(Buffer.from("cd"));
  sink.write("ef");
  sink.uncork();
  sink.end("gh");
}

// Options-object hooks on Readable and Transform, and the encoding the
// transform sees for a string write and for a Buffer write.
{
  let reads = 0;
  const source = new Readable({
    construct(callback) {
      console.log("opts readable construct");
      callback();
    },
    read(size) {
      reads += 1;
      console.log("opts read", reads, size, this.readableLength);
      if (reads === 1) this.push("ab");
      else if (reads === 2) this.push(Buffer.from("cd"));
      else this.push(null);
    },
    destroy(error, callback) {
      console.log("opts readable destroy", describe(error));
      callback();
    },
  });
  source.on("data", (chunk) => console.log("opts readable data", chunk.toString()));
  source.on("end", () => console.log("opts readable end"));
  source.on("close", () => console.log("opts readable close", describe(source.errored)));

  const upper = new Transform({
    transform(chunk, encoding, callback) {
      console.log("opts transform", chunk.toString(), encoding, callback.length);
      callback(null, chunk.toString().toUpperCase());
    },
    flush(callback) {
      console.log("opts flush", this.writableEnded, this.readableEnded);
      callback(null, "!");
    },
    destroy(error, callback) {
      console.log("opts transform destroy", describe(error));
      callback();
    },
  });
  upper.on("data", (chunk) => console.log("opts transform data", chunk.toString()));
  upper.on("end", () => console.log("opts transform end"));
  upper.on("close", () => console.log("opts transform close", describe(upper.errored)));
  upper.write("ab");
  upper.write(Buffer.from("cd"));
  upper.end();
}

// Prototype hooks on constructor-function streams: _construct, _read,
// _write, _writev, _final, _destroy, _transform and _flush.
{
  function Store(options) {
    Writable.call(this, options);
    this.entries = [];
  }
  util.inherits(Store, Writable);
  Store.prototype._construct = function (callback) {
    console.log("proto construct", this.writableLength);
    callback();
  };
  Store.prototype._write = function (chunk, encoding, callback) {
    console.log("proto write", chunk.toString(), encoding, Buffer.isBuffer(chunk));
    callback();
  };
  Store.prototype._writev = function (chunks, callback) {
    console.log("proto writev", chunks.map((e) => e.chunk.toString() + "/" + e.encoding).join(","));
    callback();
  };
  Store.prototype._final = function (callback) {
    console.log("proto final", this.writableEnded);
    callback();
  };
  Store.prototype._destroy = function (error, callback) {
    console.log("proto destroy", describe(error), this.destroyed);
    callback();
  };
  const store = new Store({ highWaterMark: 4 });
  store.on("finish", () => console.log("proto finish"));
  store.on("close", () => console.log("proto close", describe(store.errored)));
  store.write("a");
  store.cork();
  store.write("bb");
  store.write(Buffer.from("ccc"));
  store.uncork();
  store.end("dddd");

  function Words(options) {
    Readable.call(this, options);
    this.at = 0;
  }
  util.inherits(Words, Readable);
  Words.prototype._construct = function (callback) {
    console.log("words construct");
    callback();
  };
  Words.prototype._read = function (size) {
    console.log("words read", size, this.readableObjectMode);
    this.at += 1;
    if (this.at <= 2) this.push("w" + this.at);
    else this.push(null);
  };
  Words.prototype._destroy = function (error, callback) {
    console.log("words destroy", describe(error));
    callback();
  };
  const words = new Words();
  words.on("data", (chunk) => console.log("words data", String(chunk)));
  words.on("end", () => console.log("words end"));
  words.on("close", () => console.log("words close", describe(words.errored)));

  function Upper() {
    Transform.call(this);
    this.seen = 0;
  }
  util.inherits(Upper, Transform);
  Upper.prototype._transform = function (chunk, encoding, callback) {
    this.seen += 1;
    console.log("upper transform", chunk.toString(), encoding, this.seen);
    callback(null, chunk.toString().toUpperCase());
  };
  Upper.prototype._flush = function (callback) {
    console.log("upper flush", this.seen);
    callback(null, "#" + this.seen);
  };
  Upper.prototype._destroy = function (error, callback) {
    console.log("upper destroy", describe(error));
    callback();
  };
  const upper = new Upper();
  upper.on("data", (chunk) => console.log("upper data", chunk.toString()));
  upper.on("end", () => console.log("upper end"));
  upper.on("close", () => console.log("upper close", describe(upper.errored)));
  upper.write("ab", "utf8");
  upper.end(Buffer.from("cd"));
}

// The hooks' failure paths through the checked-dynamic lane: a write, a
// flush, a final, and a _destroy that reports its own error.
{
  const failing = new Writable({
    write(chunk, encoding, callback) {
      console.log("failing write", chunk.toString(), encoding);
      callback(new Error("write failed"));
    },
    final(callback) {
      console.log("failing final");
      callback(new Error("final failed"));
    },
    destroy(error, callback) {
      console.log("failing destroy", describe(error));
      callback();
    },
  });
  failing.on("error", (error) => console.log("failing error", describe(error)));
  failing.on("close", () => console.log("failing close", describe(failing.errored)));
  failing.write("x");
  failing.end();

  const stopped = new Transform({
    transform(chunk, encoding, callback) {
      console.log("stopped transform", chunk.toString(), encoding);
      callback(new Error("transform failed"));
    },
    flush(callback) {
      console.log("stopped flush");
      callback(new Error("flush failed"));
    },
    destroy(error, callback) {
      console.log("stopped destroy", describe(error));
      callback();
    },
  });
  stopped.on("error", (error) => console.log("stopped error", describe(error)));
  stopped.on("close", () => console.log("stopped close", describe(stopped.errored)));
  stopped.write("y");
  stopped.end();

  const replaced = new Writable({
    write(chunk, encoding, callback) {
      callback();
    },
    destroy(error, callback) {
      console.log("replaced destroy", describe(error));
      callback(new Error("replacement"));
    },
  });
  replaced.on("error", (error) => console.log("replaced error", describe(error)));
  replaced.on("close", () => console.log("replaced close", describe(replaced.errored)));
  replaced.destroy(new Error("original"));
}
