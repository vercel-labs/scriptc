// Batched writes in JavaScript: the writev option in a literal and in an
// options value, and _writev on a constructor function's prototype. The
// batch entries carry chunk, encoding and callback (Node's nop when the
// write passed none), allBuffers says whether every chunk is a Buffer,
// and a stream with only _writev sends a lone write as { chunk, encoding }.
const stream = require("node:stream");
const util = require("node:util");

const log = [];
const describe = (chunks) =>
  chunks
    .map((c) => {
      const chunk = Buffer.isBuffer(c.chunk) ? "B:" + c.chunk.toString() : `${typeof c.chunk}:${c.chunk}`;
      const callback = typeof c.callback === "function" ? c.callback.name || "fn" : String(c.callback);
      return `${chunk}/${c.encoding}/${callback}`;
    })
    .join(",") +
  ` all=${chunks.allBuffers} keys=${Object.keys(chunks[0]).join(".")}`;

function viaLiteral(next) {
  const w = new stream.Writable({
    write(chunk, enc, cb) {
      log.push("write " + chunk);
      setTimeout(cb, 1);
    },
    writev(chunks, cb) {
      log.push("writev " + describe(chunks));
      setTimeout(cb, 1);
    },
  });
  w.write("a", () => log.push("cb a"));
  w.write("b", () => log.push("cb b"));
  w.write("c");
  w.write(Buffer.from("d"), () => log.push("cb d"));
  w.end(() => log.push("end"));
  w.on("finish", () => {
    log.push("finish");
    next();
  });
}

function dyn(value) {
  return value;
}

function viaValue(next) {
  const options = {
    writev(chunks, cb) {
      log.push("value " + describe(chunks));
      cb();
    },
  };
  const v = new stream.Writable(dyn(options));
  v.cork();
  v.write("x");
  v.write("6869", "hex");
  v.uncork();
  v.write("z", () => log.push("z cb"));
  v.end();
  v.on("finish", () => {
    log.push("value finish");
    next();
  });
}

function Sink(opts) {
  stream.Writable.call(this, opts);
}
util.inherits(Sink, stream.Writable);
Sink.prototype._writev = function (chunks, cb) {
  log.push("sink " + (this instanceof Sink) + " " + describe(chunks));
  cb();
};

function viaConstructor(next) {
  const s = new Sink({ decodeStrings: false });
  s.cork();
  s.write("a");
  s.write("6869", "hex");
  s.write(Buffer.from("b"));
  s.uncork();
  s.write("lone");
  s.end(() => {
    log.push("sink end");
    next();
  });
}

// The writev option shadows the prototype's _writev: Node's constructor
// assigns it to the instance (this._writev = options.writev).
function viaOptionOverProto(next) {
  function W(opts) {
    stream.Writable.call(this, opts);
  }
  Object.setPrototypeOf(W.prototype, stream.Writable.prototype);
  Object.setPrototypeOf(W, stream.Writable);
  W.prototype._write = function (chunk, enc, cb) {
    log.push("proto _write " + String(chunk));
    cb();
  };
  W.prototype._writev = function (chunks, cb) {
    log.push("proto _writev " + chunks.length);
    cb();
  };
  // (built without a second `new` of a constructor function)
  const w = Object.create(W.prototype);
  W.call(w, {
    writev(chunks, cb) {
      log.push("option writev " + chunks.map((c) => String(c.chunk)).join(",") + " " + (this === w));
      cb();
    },
  });
  log.push("own _writev " + Object.prototype.hasOwnProperty.call(w, "_writev"));
  w.cork();
  w.write("a");
  w.write("b");
  w.uncork();
  w.end(() => {
    log.push("option end");
    next();
  });
}

viaLiteral(() =>
  viaValue(() => viaConstructor(() => viaOptionOverProto(() => console.log(log.join("\n"))))),
);
